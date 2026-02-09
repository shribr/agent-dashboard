import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import * as http from 'http';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentTask {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface AgentAction {
  tool: string;        // e.g. "Read", "Edit", "Bash", "Subagent"
  detail: string;      // e.g. "menu.service.ts, lines 700-900"
  timestamp: number;
  status: 'running' | 'done' | 'error';
}

interface AgentSession {
  id: string;
  name: string;
  type: 'copilot' | 'claude' | 'codex' | 'custom';
  typeLabel: string;
  model: string;
  status: 'running' | 'thinking' | 'paused' | 'done' | 'error' | 'queued';
  task: string;
  tokens: number;
  startTime: number;
  elapsed: string;
  progress: number;
  progressLabel: string;
  tools: string[];
  activeTool: string | null;
  files: string[];
  location: 'local' | 'remote' | 'cloud';
  remoteHost?: string;
  pid?: number;
  sourceProvider: string;
  tasks?: AgentTask[];
  recentActions?: AgentAction[];
  parentId?: string;
  conversationPreview?: string[];  // Recent conversation snippets for the detail panel
}

interface ActivityItem {
  agent: string;
  desc: string;
  type: 'tool_use' | 'file_edit' | 'command' | 'thinking' | 'complete' | 'error' | 'start' | 'info';
  timestamp: number;
  timeLabel: string;
}

interface DashboardState {
  agents: AgentSession[];
  activities: ActivityItem[];
  stats: {
    total: number;
    active: number;
    completed: number;
    tokens: number;
    estimatedCost: number;
    avgDuration: string;
  };
  dataSourceHealth: DataSourceStatus[];
}

// ─── Data Source Health System ────────────────────────────────────────────────

type HealthState = 'connected' | 'degraded' | 'unavailable' | 'checking';

interface DataSourceStatus {
  name: string;
  id: string;
  state: HealthState;
  message: string;
  lastChecked: number;
  agentCount: number;
}

/**
 * Base class for all data providers. Each provider is an independent module
 * that can fail without affecting other providers.
 */
abstract class DataProvider {
  abstract readonly name: string;
  abstract readonly id: string;

  protected _state: HealthState = 'checking';
  protected _message: string = 'Initializing...';
  protected _lastChecked: number = 0;
  protected _agents: AgentSession[] = [];
  protected _activities: ActivityItem[] = [];
  protected _outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  get status(): DataSourceStatus {
    return {
      name: this.name,
      id: this.id,
      state: this._state,
      message: this._message,
      lastChecked: this._lastChecked,
      agentCount: this._agents.length
    };
  }

  get agents(): AgentSession[] { return this._agents; }
  get activities(): ActivityItem[] { return this._activities; }

  /**
   * Safely fetch data. ALL errors are caught here — providers never throw.
   */
  async safeFetch(): Promise<void> {
    this._lastChecked = Date.now();
    try {
      await this.fetch();
    } catch (err: any) {
      this._agents = [];
      this._activities = [];

      const errMsg = err?.message || String(err);
      this._outputChannel.appendLine(`[${this.id}] Error: ${errMsg}`);

      // Detect API changes vs simple unavailability
      if (this.isApiChangeError(err)) {
        this._state = 'degraded';
        this._message = `API has changed — "${this.name}" needs to be updated to support the new format. Error: ${this.summarizeError(errMsg)}`;
      } else if (this.isUnavailableError(err)) {
        this._state = 'unavailable';
        this._message = this.getUnavailableMessage();
      } else {
        this._state = 'degraded';
        this._message = `Unexpected error: ${this.summarizeError(errMsg)}`;
      }
    }
  }

  protected abstract fetch(): Promise<void>;

  protected isApiChangeError(err: any): boolean {
    const msg = err?.message || '';
    return msg.includes('is not a function') ||
           msg.includes('is not iterable') ||
           msg.includes('Cannot read propert') ||
           msg.includes('undefined is not') ||
           msg.includes('has no method') ||
           msg.includes('is not defined');
  }

  protected isUnavailableError(err: any): boolean {
    const msg = err?.message || '';
    return msg.includes('ENOENT') ||
           msg.includes('not found') ||
           msg.includes('not installed') ||
           msg.includes('command not found') ||
           msg.includes('EACCES');
  }

  protected getUnavailableMessage(): string {
    return `${this.name} is not available on this system.`;
  }

  protected summarizeError(msg: string): string {
    // Truncate long error messages for the UI
    if (msg.length > 120) return msg.substring(0, 117) + '...';
    return msg;
  }

  protected formatElapsed(ms: number): string {
    if (ms < 1000) return '<1s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  protected execCommand(cmd: string, args: string[], timeoutMs: number = 5000): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const proc = cp.spawn(cmd, args, {
          timeout: timeoutMs,
          shell: process.platform === 'win32'
        });
        let output = '';
        let stderr = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', (code) => {
          if (code === 0 || output.trim()) {
            resolve(output.trim() || null);
          } else {
            resolve(null);
          }
        });
        proc.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }
}

// ─── Provider: VS Code Chat Sessions (Proposed API) ─────────────────────────

class VSCodeChatSessionsProvider extends DataProvider {
  readonly name = 'VS Code Chat Sessions';
  readonly id = 'vscode-chat-sessions';

  protected async fetch(): Promise<void> {
    // The chatSessionsProvider API is proposed (VS Code 1.109+).
    // We access it dynamically so if it doesn't exist or changes, we degrade cleanly.
    const chatApi = (vscode as any).chat;

    if (!chatApi) {
      this._state = 'unavailable';
      this._message = 'VS Code Chat API not available. Requires VS Code 1.109+ with proposed APIs enabled.';
      return;
    }

    // Try to access session-related APIs
    let sessions: any[] | undefined;

    // Attempt 1: chatSessionsProvider (proposed in 1.109)
    if (typeof chatApi.getSessions === 'function') {
      sessions = await chatApi.getSessions();
    }
    // Attempt 2: alternative accessor pattern
    else if (typeof chatApi.sessions === 'object' && chatApi.sessions) {
      sessions = Array.isArray(chatApi.sessions) ? chatApi.sessions : Object.values(chatApi.sessions);
    }
    // Attempt 3: command-based access
    else {
      try {
        sessions = await vscode.commands.executeCommand('workbench.action.chat.getSessions');
      } catch { /* command may not exist */ }
    }

    if (!sessions || !Array.isArray(sessions)) {
      this._state = 'unavailable';
      this._message = 'Chat Sessions API not yet available. This feature requires VS Code 1.109+ with the proposed chatSessionsProvider API. The dashboard will use other data sources in the meantime.';
      return;
    }

    this._agents = [];
    for (const session of sessions) {
      try {
        this._agents.push({
          id: session.id || `chat-${Date.now()}-${Math.random()}`,
          name: session.title || session.name || 'Chat Session',
          type: this.inferType(session),
          typeLabel: this.inferTypeLabel(session),
          model: session.model || session.agent || 'unknown',
          status: this.mapStatus(session.status || session.state),
          task: session.title || session.lastMessage || '',
          tokens: session.tokenCount || session.tokens || 0,
          startTime: session.createdAt ? new Date(session.createdAt).getTime() : Date.now(),
          elapsed: session.createdAt ? this.formatElapsed(Date.now() - new Date(session.createdAt).getTime()) : '—',
          progress: this.estimateProgress(session),
          progressLabel: session.status || '',
          tools: session.tools || [],
          activeTool: null,
          files: session.changedFiles || [],
          location: session.location || 'local',
          remoteHost: session.remoteHost,
          sourceProvider: this.id
        });
      } catch (e: any) {
        this._outputChannel.appendLine(`[${this.id}] Skipped session: ${e?.message}`);
      }
    }

    this._state = 'connected';
    this._message = `Monitoring ${this._agents.length} chat session(s)`;
  }

  private inferType(session: any): AgentSession['type'] {
    const agent = (session.agent || session.provider || '').toLowerCase();
    if (agent.includes('copilot')) return 'copilot';
    if (agent.includes('claude')) return 'claude';
    if (agent.includes('codex')) return 'codex';
    return 'custom';
  }

  private inferTypeLabel(session: any): string {
    const agent = (session.agent || session.provider || '').toLowerCase();
    if (agent.includes('copilot')) return 'Copilot';
    if (agent.includes('claude')) return 'Claude';
    if (agent.includes('codex')) return 'Codex';
    return session.agent || 'Agent';
  }

  private mapStatus(status: string | undefined): AgentSession['status'] {
    if (!status) return 'done';
    const s = status.toLowerCase();
    if (s.includes('run') || s.includes('active') || s.includes('progress')) return 'running';
    if (s.includes('think') || s.includes('wait') || s.includes('pend')) return 'thinking';
    if (s.includes('paus')) return 'paused';
    if (s.includes('done') || s.includes('complet') || s.includes('finish')) return 'done';
    if (s.includes('err') || s.includes('fail')) return 'error';
    if (s.includes('queue')) return 'queued';
    return 'done';
  }

  private estimateProgress(session: any): number {
    if (session.progress !== undefined) return session.progress;
    const status = (session.status || '').toLowerCase();
    if (status.includes('done') || status.includes('complet')) return 100;
    if (status.includes('run') || status.includes('active')) return 50;
    return 0;
  }
}

// ─── Provider: GitHub Copilot Extension ──────────────────────────────────────

class CopilotExtensionProvider extends DataProvider {
  readonly name = 'GitHub Copilot';
  readonly id = 'copilot-extension';

  protected async fetch(): Promise<void> {
    this._agents = [];

    // Check for Copilot Chat extension
    const copilotChat = vscode.extensions.getExtension('GitHub.copilot-chat');
    const copilot = vscode.extensions.getExtension('GitHub.copilot');

    if (!copilotChat && !copilot) {
      this._state = 'unavailable';
      this._message = 'GitHub Copilot extension not installed.';
      return;
    }

    if (copilotChat && !copilotChat.isActive) {
      this._state = 'unavailable';
      this._message = 'GitHub Copilot Chat extension is installed but not active.';
      return;
    }

    // Try to get session info from the Copilot extension's exported API
    try {
      const api = copilotChat?.exports;

      if (api && typeof api === 'object') {
        // Try to access sessions — the exact shape depends on the Copilot version
        let sessions: any[] | undefined;

        if (typeof api.getSessions === 'function') {
          sessions = await api.getSessions();
        } else if (typeof api.getConversations === 'function') {
          sessions = await api.getConversations();
        } else if (api.sessions && Array.isArray(api.sessions)) {
          sessions = api.sessions;
        }

        if (sessions && Array.isArray(sessions)) {
          for (const s of sessions) {
            try {
              this._agents.push({
                id: s.id || `copilot-${Date.now()}`,
                name: s.title || 'Copilot Chat',
                type: 'copilot',
                typeLabel: 'Copilot',
                model: s.model || 'GPT-4o',
                status: this.mapCopilotStatus(s),
                task: s.title || s.lastMessage || 'Chat session',
                tokens: s.tokenCount || 0,
                startTime: s.createdAt ? new Date(s.createdAt).getTime() : Date.now(),
                elapsed: s.createdAt ? this.formatElapsed(Date.now() - new Date(s.createdAt).getTime()) : '—',
                progress: 50,
                progressLabel: 'Active',
                tools: [],
                activeTool: null,
                files: [],
                location: 'local',
                sourceProvider: this.id
              });
            } catch { /* skip individual session */ }
          }
          this._state = 'connected';
          this._message = `Found ${this._agents.length} Copilot session(s)`;
          return;
        }
      }

      // If we got here, the extension is active but doesn't expose session details
      this._state = 'connected';
      this._message = 'Copilot Chat is active. Session-level details (tokens, tasks) are not yet available through its API.';

      // Add a single entry representing the active Copilot instance
      this._agents.push({
        id: 'copilot-active',
        name: 'GitHub Copilot Chat',
        type: 'copilot',
        typeLabel: 'Copilot',
        model: '—',
        status: 'running',
        task: 'Copilot Chat is active',
        tokens: 0,
        startTime: Date.now(),
        elapsed: '—',
        progress: 0,
        progressLabel: 'Active',
        tools: [],
        activeTool: null,
        files: [],
        location: 'local',
        sourceProvider: this.id
      });

    } catch (err: any) {
      // Don't throw — let the base class error handling deal with it
      throw err;
    }

    // ── Additional detection: Copilot-related extensions that add agent capabilities ──
    try {
      const agentExtensions = [
        { id: 'GitHub.copilot-chat', label: 'Copilot Chat' },
        { id: 'GitHub.copilot', label: 'Copilot' },
        { id: 'GitHub.copilot-labs', label: 'Copilot Labs' },
        { id: 'GitHub.copilot-nightly', label: 'Copilot Nightly' },
      ];

      // Check if Agent Mode is enabled via settings
      const chatConfig = vscode.workspace.getConfiguration('chat');
      const agentEnabled = chatConfig.get<boolean>('agent.enabled');
      if (agentEnabled !== undefined) {
        this._outputChannel.appendLine(`[${this.id}] Chat agent mode enabled: ${agentEnabled}`);
      }

      // Check for MCP servers configured in VS Code (these appear as tools in agent mode)
      const mcpConfig = chatConfig.get<any>('mcp');
      if (mcpConfig && typeof mcpConfig === 'object') {
        const servers = mcpConfig.servers || mcpConfig;
        const serverNames = Object.keys(servers).filter(k => k !== 'servers');
        if (serverNames.length > 0) {
          for (const serverName of serverNames) {
            const server = servers[serverName];
            const isDisabled = server?.disabled === true;
            if (isDisabled) continue;

            this._agents.push({
              id: `mcp-server-${serverName}`,
              name: `MCP: ${serverName}`,
              type: 'custom',
              typeLabel: 'MCP Server',
              model: '—',
              status: 'running',
              task: `MCP tool server: ${serverName}`,
              tokens: 0,
              startTime: Date.now(),
              elapsed: '—',
              progress: 0,
              progressLabel: 'MCP Connected',
              tools: Array.isArray(server?.tools) ? server.tools : [],
              activeTool: null,
              files: [],
              location: 'local',
              sourceProvider: this.id
            });
          }
        }
      }

      // Check for workspace-level MCP configuration (.vscode/mcp.json)
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        for (const folder of workspaceFolders) {
          const mcpJsonPath = path.join(folder.uri.fsPath, '.vscode', 'mcp.json');
          if (fs.existsSync(mcpJsonPath)) {
            try {
              const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
              const servers = mcpJson.servers || mcpJson.mcpServers || {};
              for (const [name, config] of Object.entries(servers)) {
                const serverId = `mcp-ws-${folder.name}-${name}`;
                if (!this._agents.some(a => a.id === serverId)) {
                  this._agents.push({
                    id: serverId,
                    name: `MCP: ${name}`,
                    type: 'custom',
                    typeLabel: 'MCP Server',
                    model: '—',
                    status: 'running',
                    task: `Workspace MCP server: ${name}`,
                    tokens: 0,
                    startTime: Date.now(),
                    elapsed: '—',
                    progress: 0,
                    progressLabel: 'MCP Connected',
                    tools: [],
                    activeTool: null,
                    files: [],
                    location: 'local',
                    sourceProvider: this.id
                  });
                }
              }
            } catch { /* invalid mcp.json */ }
          }
        }
      }
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Additional detection error: ${err?.message}`);
    }
  }

  private mapCopilotStatus(session: any): AgentSession['status'] {
    if (session.isActive || session.status === 'active') return 'running';
    return 'done';
  }
}

// ─── Provider: Copilot Chat Session Files ────────────────────────────────────

class CopilotChatSessionProvider extends DataProvider {
  readonly name = 'Copilot Chat Sessions';
  readonly id = 'copilot-chat-sessions';

  private context: vscode.ExtensionContext;

  constructor(outputChannel: vscode.OutputChannel, context: vscode.ExtensionContext) {
    super(outputChannel);
    this.context = context;
  }

  protected async fetch(): Promise<void> {
    this._agents = [];
    this._activities = [];

    // ── Find chat session files ──
    // VS Code stores chat sessions as JSON files in workspaceStorage/<id>/chatSessions/
    const sessionFiles = this.findChatSessionFiles();

    if (sessionFiles.length === 0) {
      this._state = 'connected';
      this._message = 'No session files found. Check Output → Agent Dashboard for path details.';
      return;
    }

    this._outputChannel.appendLine(`[${this.id}] Processing ${sessionFiles.length} session file(s)...`);
    const now = Date.now();
    // Use a generous 24-hour window — show sessions from the whole day
    const RECENT_MS = 24 * 60 * 60 * 1000;
    let skippedOld = 0;
    let parsed = 0;
    let errors = 0;

    for (const filePath of sessionFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > RECENT_MS) { skippedOld++; continue; }

        const raw = fs.readFileSync(filePath, 'utf-8');
        // Guard against very large files (> 5MB) that could slow down polling
        if (raw.length > 5 * 1024 * 1024) {
          this._outputChannel.appendLine(`[${this.id}] Skipping large file (${(raw.length/1024/1024).toFixed(1)}MB): ${filePath}`);
          continue;
        }

        const data = JSON.parse(raw);
        this.parseSessionData(data, filePath, stat.mtimeMs);
        parsed++;
      } catch (err: any) {
        errors++;
        this._outputChannel.appendLine(`[${this.id}] Error parsing ${filePath}: ${err?.message}`);
      }
    }

    this._outputChannel.appendLine(`[${this.id}] Results: ${parsed} parsed, ${skippedOld} skipped (old), ${errors} errors → ${this._agents.length} agents`);

    this._state = 'connected';
    if (this._agents.length > 0) {
      this._message = `${this._agents.length} session(s) with detailed activity (from ${parsed} files)`;
    } else {
      this._message = `Found ${sessionFiles.length} files (${parsed} recent) but no agent activity detected.`;
    }
  }

  private findChatSessionFiles(): string[] {
    const files: string[] = [];
    const searchedPaths: string[] = [];

    try {
      // ── Build list of candidate User directories ──
      // Primary: derive from our extension's globalStorageUri
      const globalStoragePath = this.context.globalStorageUri.fsPath;
      this._outputChannel.appendLine(`[${this.id}] globalStorageUri: ${globalStoragePath}`);
      const primaryUserDir = path.resolve(globalStoragePath, '..', '..');
      const userDirs = new Set<string>([primaryUserDir]);

      // Fallback: explicit platform paths for stable + Insiders
      const home = os.homedir();
      if (process.platform === 'darwin') {
        userDirs.add(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
        userDirs.add(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
        userDirs.add(path.join(home, 'Library', 'Application Support', 'Cursor', 'User'));
      } else if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        userDirs.add(path.join(appData, 'Code', 'User'));
        userDirs.add(path.join(appData, 'Code - Insiders', 'User'));
      } else {
        userDirs.add(path.join(home, '.config', 'Code', 'User'));
        userDirs.add(path.join(home, '.config', 'Code - Insiders', 'User'));
      }

      for (const userDir of userDirs) {
        const workspaceStorageDir = path.join(userDir, 'workspaceStorage');
        if (!fs.existsSync(workspaceStorageDir)) {
          this._outputChannel.appendLine(`[${this.id}] Not found: ${workspaceStorageDir}`);
          continue;
        }

        this._outputChannel.appendLine(`[${this.id}] Scanning: ${workspaceStorageDir}`);
        searchedPaths.push(workspaceStorageDir);
        let foundInDir = 0;

        const workspaceDirs = fs.readdirSync(workspaceStorageDir);
        for (const wsDir of workspaceDirs) {
          const wsPath = path.join(workspaceStorageDir, wsDir);

          // Path 1: chatSessions/ subdirectory (VS Code core chat storage)
          const chatSessionsDir = path.join(wsPath, 'chatSessions');
          if (fs.existsSync(chatSessionsDir)) {
            try {
              const sessionFiles = fs.readdirSync(chatSessionsDir)
                .filter(f => f.endsWith('.json'))
                .map(f => path.join(chatSessionsDir, f));

              const withStats = sessionFiles.map(f => {
                try { return { path: f, mtime: fs.statSync(f).mtimeMs }; }
                catch { return null; }
              }).filter(Boolean) as { path: string; mtime: number }[];

              withStats.sort((a, b) => b.mtime - a.mtime);
              const taken = withStats.slice(0, 10).map(f => f.path);
              files.push(...taken);
              foundInDir += taken.length;
            } catch { /* skip */ }
          }

          // Path 2: GitHub.copilot-chat/ subdirectory (Copilot extension data)
          const copilotChatDir = path.join(wsPath, 'GitHub.copilot-chat');
          if (fs.existsSync(copilotChatDir)) {
            try {
              const copilotFiles = this.findJsonRecursive(copilotChatDir, 2);
              files.push(...copilotFiles);
              foundInDir += copilotFiles.length;
            } catch { /* skip */ }
          }

          // Path 3: github.copilot-chat/ (lowercase variant)
          const copilotChatDirLower = path.join(wsPath, 'github.copilot-chat');
          if (copilotChatDirLower !== copilotChatDir && fs.existsSync(copilotChatDirLower)) {
            try {
              const copilotFiles = this.findJsonRecursive(copilotChatDirLower, 2);
              files.push(...copilotFiles);
              foundInDir += copilotFiles.length;
            } catch { /* skip */ }
          }
        }

        this._outputChannel.appendLine(`[${this.id}]   → Found ${foundInDir} session file(s) across ${workspaceDirs.length} workspace(s)`);

        // Also check global Copilot Chat storage
        for (const copilotDirName of ['github.copilot-chat', 'GitHub.copilot-chat']) {
          const copilotGlobalStorage = path.join(userDir, 'globalStorage', copilotDirName);
          if (fs.existsSync(copilotGlobalStorage)) {
            try {
              const copilotFiles = this.findJsonRecursive(copilotGlobalStorage, 3);
              files.push(...copilotFiles);
              this._outputChannel.appendLine(`[${this.id}]   → Found ${copilotFiles.length} file(s) in globalStorage/${copilotDirName}/`);
            } catch { /* skip */ }
          }
        }
      }

    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Error scanning storage: ${err?.message}`);
    }

    // Deduplicate
    const uniqueFiles = [...new Set(files)];
    this._outputChannel.appendLine(`[${this.id}] Total: ${uniqueFiles.length} unique session files found (searched ${searchedPaths.length} storage root(s))`);
    return uniqueFiles;
  }

  private findJsonRecursive(dir: string, maxDepth: number): string[] {
    if (maxDepth <= 0) return [];
    const results: string[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
          results.push(full);
        } else if (entry.isDirectory() && maxDepth > 1) {
          results.push(...this.findJsonRecursive(full, maxDepth - 1));
        }
      }
    } catch { /* permission denied etc */ }

    return results;
  }

  private parseSessionData(data: any, filePath: string, mtime: number): void {
    const sessionId = path.basename(filePath, '.json');

    // ── Copilot Chat primary format: { requests: [...] } ──
    const requests = data.requests || data.turns || data.messages || data.exchanges
      || data.history || data.conversation || (Array.isArray(data) ? data : []);

    if (!Array.isArray(requests) || requests.length === 0) {
      if (data && typeof data === 'object') {
        const topKeys = Object.keys(data).slice(0, 10).join(', ');
        this._outputChannel.appendLine(`[${this.id}] Session ${sessionId.substring(0, 12)}: 0 requests. Keys: [${topKeys}]`);
      }
      return;
    }

    this._outputChannel.appendLine(`[${this.id}] Parsing session ${sessionId.substring(0, 12)}: ${requests.length} turns, title="${data.title || '(none)'}"`);


    const recentActions: AgentAction[] = [];
    const filesAccessed = new Set<string>();
    const toolsUsed = new Set<string>();
    const subagents: { id: string; name: string; task: string; actions: AgentAction[]; status: string }[] = [];
    let currentSubagent: typeof subagents[0] | null = null;
    let lastUserMessage = '';
    const conversationSnippets: string[] = [];

    for (const req of requests) {
      try {
        // ── Extract user prompt ──
        // Copilot Chat format: req.prompt is a string
        const prompt = typeof req.prompt === 'string' ? req.prompt
          : (req.prompt?.text || req.prompt?.value || req.message?.text || req.message?.value
            || (typeof req.message === 'string' ? req.message : '')
            || req.text || req.query || req.input || '');
        if (typeof prompt === 'string' && prompt.length > 0) {
          lastUserMessage = prompt.substring(0, 300);
          if (conversationSnippets.length < 10) {
            conversationSnippets.push('👤 ' + prompt.substring(0, 150));
          }
        }

        // ── Parse response parts ──
        // Copilot Chat format: req.response is an ARRAY of typed parts:
        //   { type: "markdown", markdown: { value: "..." } }
        //   { type: "inlineReference", inlineReference: { name, uri, kind } }
        //   { type: "contentReference", contentReference: { name, uri, range } }
        //   { type: "toolCall", toolCall: { id, toolName, toolInput, toolResult } }
        //   { type: "progressMessage", progressMessage: { message } }
        const responseParts = Array.isArray(req.response) ? req.response : [];

        // Collect markdown text from response
        let responseText = '';
        for (const part of responseParts) {
          try {
            if (!part || !part.type) continue;

            // Markdown content — the actual assistant response text
            if (part.type === 'markdown' && part.markdown?.value) {
              responseText += part.markdown.value + '\n';
            }

            // Tool calls — the actual tool invocations in agent mode
            if (part.type === 'toolCall' && part.toolCall) {
              const tc = part.toolCall;
              const toolName = this.normalizeToolName(tc.toolName || tc.name || 'Tool');
              const toolInput = tc.toolInput || tc.input || tc.arguments || {};
              const toolResult = tc.toolResult;
              const isError = toolResult?.exitCode ? toolResult.exitCode !== 0 : false;

              const detail = this.formatToolDetail(toolName, toolInput);
              const action: AgentAction = {
                tool: toolName,
                detail,
                timestamp: mtime,
                status: isError ? 'error' : 'done'
              };
              recentActions.push(action);
              toolsUsed.add(toolName);

              // Extract file path from tool input
              const fp = toolInput.file_path || toolInput.filePath || toolInput.path || toolInput.uri || '';
              if (typeof fp === 'string' && fp.length > 0) {
                filesAccessed.add(path.basename(fp));
              }

              // Detect subagent spawns
              if (toolName === 'Subagent' || toolName === 'Task' || detail.toLowerCase().includes('subagent')) {
                const subId = `sub-${sessionId}-${subagents.length}`;
                currentSubagent = {
                  id: subId,
                  name: detail.substring(0, 80) || `Subagent ${subagents.length + 1}`,
                  task: detail,
                  actions: [],
                  status: 'done'
                };
                subagents.push(currentSubagent);
              }

              if (currentSubagent) {
                currentSubagent.actions.push(action);
              }

              // Add to conversation snippets
              if (conversationSnippets.length < 20) {
                const statusEmoji = isError ? '❌' : '✅';
                conversationSnippets.push(`🔧 ${toolName}: ${detail.substring(0, 100)} ${statusEmoji}`);
              }
            }

            // Inline file references
            if (part.type === 'inlineReference' && part.inlineReference) {
              const ref = part.inlineReference;
              const uri = ref.uri?.path || ref.uri?.fsPath || ref.uri || '';
              const name = ref.name || (typeof uri === 'string' ? path.basename(uri) : '');
              if (name && name.includes('.')) {
                filesAccessed.add(name);
                recentActions.push({ tool: 'Read', detail: name, timestamp: mtime, status: 'done' });
                toolsUsed.add('Read');
              }
            }

            // Content references (file with range)
            if (part.type === 'contentReference' && part.contentReference) {
              const cref = part.contentReference;
              const uri = cref.uri?.path || cref.uri?.fsPath || cref.uri || '';
              const name = cref.name || (typeof uri === 'string' ? path.basename(uri) : '');
              if (name && name.includes('.')) {
                filesAccessed.add(name);
                let detail = name;
                if (cref.range) {
                  const startLine = cref.range.start?.line ?? cref.range.startLineNumber;
                  const endLine = cref.range.end?.line ?? cref.range.endLineNumber;
                  if (startLine != null) {
                    detail = `${name}, lines ${startLine}${endLine != null ? '-' + endLine : ''}`;
                  }
                }
                recentActions.push({ tool: 'Read', detail, timestamp: mtime, status: 'done' });
                toolsUsed.add('Read');
              }
            }

            // Progress messages (agent thinking/status updates)
            if (part.type === 'progressMessage' && part.progressMessage?.message) {
              if (conversationSnippets.length < 20) {
                conversationSnippets.push('⏳ ' + part.progressMessage.message.substring(0, 120));
              }
            }

          } catch { /* skip individual part */ }
        }

        // Add response text snippet to conversation
        if (responseText.length > 0 && conversationSnippets.length < 20) {
          // Truncate and clean up for preview
          const cleaned = responseText.replace(/```[\s\S]*?```/g, '[code block]').replace(/\n{2,}/g, '\n').trim();
          conversationSnippets.push('🤖 ' + cleaned.substring(0, 200));
        }

        // ── Also handle the older format where response is an object, not array ──
        if (!Array.isArray(req.response) && req.response) {
          const resp = req.response;
          // Object-style response with value array
          this.extractFromObjectResponse(resp, mtime, recentActions, filesAccessed, toolsUsed, conversationSnippets, subagents, sessionId, currentSubagent);
        }

        // ── Check result object too ──
        if (req.result) {
          const resultMsg = req.result.message;
          if (Array.isArray(resultMsg)) {
            for (const part of resultMsg) {
              if (part.kind === 'inlineReference' && part.inlineReference?.uri) {
                const uri = part.inlineReference.uri.path || part.inlineReference.uri;
                const fileName = typeof uri === 'string' ? path.basename(uri) : '';
                if (fileName && fileName.includes('.')) {
                  filesAccessed.add(fileName);
                }
              }
            }
          }
        }

        // ── Parse tool references from markdown text ──
        if (responseText.length > 0) {
          this.extractToolRefsFromText(responseText, mtime, recentActions, filesAccessed, toolsUsed, subagents, sessionId, currentSubagent);
        }

      } catch { /* skip individual request */ }
    }

    if (requests.length === 0) return;

    // Determine if session is active (modified recently)
    const now = Date.now();
    const ageMs = now - mtime;
    const isActive = ageMs < 5 * 60 * 1000; // Active if modified in last 5 min

    // Create main session agent
    this._agents.push({
      id: `copilot-session-${sessionId.substring(0, 12)}`,
      name: data.title || `Copilot Chat ${sessionId.substring(0, 8)}`,
      type: 'copilot',
      typeLabel: subagents.length > 0 ? 'Agent Swarm' : 'Copilot Chat',
      model: data.model || '—',
      status: isActive ? 'running' : 'done',
      task: lastUserMessage || data.title || 'Chat session',
      tokens: data.tokenCount || data.totalTokens || 0,
      startTime: data.createdAt ? new Date(data.createdAt).getTime() : mtime,
      elapsed: '—',
      progress: isActive ? 0 : 100,
      progressLabel: isActive
        ? (recentActions.length > 0 ? recentActions[recentActions.length - 1].detail : 'Active')
        : `${recentActions.length} tool calls`,
      tools: Array.from(toolsUsed),
      activeTool: isActive && recentActions.length > 0
        ? `${recentActions[recentActions.length - 1].tool}: ${recentActions[recentActions.length - 1].detail}`
        : null,
      files: Array.from(filesAccessed).slice(0, 20),
      location: 'local',
      sourceProvider: this.id,
      recentActions: recentActions.slice(-30), // Last 30 actions
      conversationPreview: conversationSnippets.slice(-15), // Last 15 conversation lines
    });

    // Create entries for each detected subagent
    for (const sub of subagents) {
      const subFiles = new Set<string>();
      const subTools = new Set<string>();
      for (const a of sub.actions) {
        subTools.add(a.tool);
        if (a.detail.includes('.')) {
          // Try to extract filename from detail
          const fileMatch = a.detail.match(/([a-zA-Z0-9_.-]+\.\w{1,6})/);
          if (fileMatch) subFiles.add(fileMatch[1]);
        }
      }

      this._agents.push({
        id: `copilot-${sub.id}`,
        name: sub.name,
        type: 'copilot',
        typeLabel: 'Subagent',
        model: data.model || '—',
        status: isActive ? 'running' : 'done',
        task: sub.task,
        tokens: 0,
        startTime: mtime,
        elapsed: '—',
        progress: 0,
        progressLabel: `${sub.actions.length} actions`,
        tools: Array.from(subTools),
        activeTool: sub.actions.length > 0 ? sub.actions[sub.actions.length - 1].detail : null,
        files: Array.from(subFiles),
        location: 'local',
        sourceProvider: this.id,
        recentActions: sub.actions.slice(-20),
        parentId: `copilot-session-${sessionId.substring(0, 12)}`,
      });
    }

    // Generate activity items for tool calls
    for (const action of recentActions.slice(-10)) {
      this._activities.push({
        agent: data.title || `Copilot ${sessionId.substring(0, 8)}`,
        desc: `${action.tool}: ${action.detail}`,
        type: action.tool === 'Edit' || action.tool === 'Write' ? 'file_edit' :
              action.tool === 'Bash' || action.tool === 'Command' ? 'command' :
              action.tool === 'Subagent' ? 'start' : 'tool_use',
        timestamp: action.timestamp,
        timeLabel: ''
      });
    }
  }

  /**
   * Extract tool calls and content from an object-shaped response (older format / fallback)
   */
  private extractFromObjectResponse(
    resp: any, mtime: number,
    recentActions: AgentAction[], filesAccessed: Set<string>, toolsUsed: Set<string>,
    conversationSnippets: string[],
    subagents: { id: string; name: string; task: string; actions: AgentAction[]; status: string }[],
    sessionId: string, currentSubagent: typeof subagents[0] | null
  ): void {
    // Object response with value array (legacy format)
    const blocks = resp.value || resp.parts || resp.content || [];
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        try {
          if (block.kind === 'toolCall' || block.type === 'tool_use' || block.toolCallId) {
            const toolName = this.normalizeToolName(block.toolName || block.tool || block.name || 'Tool');
            const input = block.input || block.arguments || block.toolInput || {};
            const detail = this.formatToolDetail(toolName, input);
            recentActions.push({ tool: toolName, detail, timestamp: mtime, status: 'done' });
            toolsUsed.add(toolName);
          }
          if ((block.kind === 'inlineReference' || block.type === 'inlineReference') && block.inlineReference?.uri) {
            const uri = block.inlineReference.uri.path || block.inlineReference.uri.fsPath || block.inlineReference.uri;
            const fileName = typeof uri === 'string' ? path.basename(uri) : '';
            if (fileName && fileName.includes('.')) {
              filesAccessed.add(fileName);
            }
          }
        } catch { /* skip */ }
      }
    }

    // Text content
    const text = typeof resp.value === 'string' ? resp.value : (resp.text || resp.message || '');
    if (typeof text === 'string' && text.length > 0 && conversationSnippets.length < 20) {
      conversationSnippets.push('🤖 ' + text.substring(0, 200));
    }

    // Content references
    if (resp.contentReferences && Array.isArray(resp.contentReferences)) {
      for (const ref of resp.contentReferences) {
        const uri = ref.uri?.path || ref.uri?.fsPath || ref.uri || '';
        const fileName = typeof uri === 'string' ? path.basename(uri) : '';
        if (fileName && fileName.includes('.')) {
          filesAccessed.add(fileName);
        }
      }
    }

    // Agent tool results
    if (resp.agentToolResults && Array.isArray(resp.agentToolResults)) {
      for (const result of resp.agentToolResults) {
        const tName = this.normalizeToolName(result.toolName || 'Tool');
        const detail = this.formatToolDetail(tName, result.input || result);
        recentActions.push({ tool: tName, detail, timestamp: mtime, status: 'done' });
        toolsUsed.add(tName);
      }
    }
  }

  /**
   * Parse tool-like references from response markdown text
   */
  private extractToolRefsFromText(
    text: string, mtime: number,
    recentActions: AgentAction[], filesAccessed: Set<string>, toolsUsed: Set<string>,
    subagents: { id: string; name: string; task: string; actions: AgentAction[]; status: string }[],
    sessionId: string, currentSubagent: typeof subagents[0] | null
  ): void {
    const addPath = path;  // closure reference
    // "Reading <filename>" / "Read <filename>, lines X-Y"
    const readMatches = text.matchAll(/(?:Reading|Read)\s+[`"]?([a-zA-Z0-9_/.-]+\.\w{1,6})[`"]?(?:,?\s*lines?\s+(\d+)(?:\s*[-\u2013to]+\s*(\d+))?)?/gi);
    for (const m of readMatches) {
      const fn = addPath.basename(m[1]);
      const detail = m[2] ? `${fn}, lines ${m[2]}${m[3] ? '-' + m[3] : ''}` : fn;
      if (!recentActions.some(a => a.detail === detail)) {
        recentActions.push({ tool: 'Read', detail, timestamp: mtime, status: 'done' });
        toolsUsed.add('Read');
        filesAccessed.add(fn);
      }
    }
    // "Editing/Wrote <filename>"
    const editMatches = text.matchAll(/(?:Editing|Edit(?:ed)?|Writing|Wrote)\s+[`"]?([a-zA-Z0-9_/.-]+\.\w{1,6})[`"]?/gi);
    for (const m of editMatches) {
      const fn = addPath.basename(m[1]);
      if (!recentActions.some(a => a.detail === fn && a.tool === 'Edit')) {
        recentActions.push({ tool: 'Edit', detail: fn, timestamp: mtime, status: 'done' });
        toolsUsed.add('Edit');
        filesAccessed.add(fn);
      }
    }
    // "Subagent: Agent XX - name"
    const subMatches = text.matchAll(/Subagent:?\s*(?:Agent\s*)?(\d+)?[\s:\u2013-]+(.+?)(?:\n|$)/gi);
    for (const m of subMatches) {
      const name = m[2]?.trim() || `Agent ${m[1] || '?'}`;
      recentActions.push({ tool: 'Subagent', detail: `Agent ${m[1] || ''} \u2014 ${name}`, timestamp: mtime, status: 'done' });
      toolsUsed.add('Subagent');
    }
    // "Running command: ..."
    const cmdMatches = text.matchAll(/(?:Running|Ran|Executing)\s+(?:command:?\s*)?[`"](.+?)[`"]/gi);
    for (const m of cmdMatches) {
      recentActions.push({ tool: 'Bash', detail: m[1].substring(0, 80), timestamp: mtime, status: 'done' });
      toolsUsed.add('Bash');
    }
  }

  /**
   * Format a tool call detail string from the tool input object
   */
  private formatToolDetail(toolName: string, input: any): string {
    if (!input || typeof input !== 'object') return typeof input === 'string' ? input.substring(0, 80) : toolName;

    const fp = input.file_path || input.filePath || input.path || input.uri;
    if (fp && typeof fp === 'string') {
      const fileName = path.basename(fp);
      if (input.offset || input.limit || input.lineStart) {
        const start = input.offset || input.lineStart || 1;
        const end = input.limit ? start + input.limit : (input.lineEnd || '');
        return `${fileName}, lines ${start}${end ? '-' + end : ''}`;
      }
      return fileName;
    }
    if (input.command) return String(input.command).substring(0, 80);
    if (input.old_string || input.new_string) return (fp ? path.basename(fp) : '') || 'file edit';
    if (input.prompt || input.description) return String(input.description || input.prompt).substring(0, 80);
    if (typeof input === 'string') return input.substring(0, 80);

    try { return JSON.stringify(input).substring(0, 60); } catch { return toolName; }
  }

  private normalizeToolName(name: string): string {
    const n = (name || '').toLowerCase();
    if (n.includes('read') || n.includes('get_file') || n.includes('view_file')) return 'Read';
    if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return 'Edit';
    if (n.includes('write') || n.includes('create_file') || n.includes('save')) return 'Write';
    if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('terminal') || n.includes('run_command')) return 'Bash';
    if (n.includes('search') || n.includes('grep') || n.includes('find') || n.includes('glob')) return 'Search';
    if (n.includes('subagent') || n.includes('task') || n.includes('delegate') || n.includes('spawn')) return 'Subagent';
    if (n.includes('list') || n.includes('ls') || n.includes('dir')) return 'List';
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// ─── Provider: Terminal Process Monitor ──────────────────────────────────────

class TerminalProcessProvider extends DataProvider {
  readonly name = 'Terminal Processes';
  readonly id = 'terminal-processes';

  protected async fetch(): Promise<void> {
    this._agents = [];

    // Scan VS Code terminals for known agent processes
    const terminals = vscode.window.terminals;

    if (terminals.length === 0) {
      this._state = 'connected';
      this._message = 'No active terminals.';
      return;
    }

    for (const terminal of terminals) {
      try {
        const name = terminal.name.toLowerCase();
        const isAgent = name.includes('claude') ||
                       name.includes('copilot') ||
                       name.includes('agent') ||
                       name.includes('codex') ||
                       name.includes('aider') ||
                       name.includes('cursor');

        if (isAgent) {
          // terminal.processId is Thenable<number | undefined> — must be awaited
          let pid: number | undefined;
          try { pid = await terminal.processId; } catch { /* may not be available */ }

          this._agents.push({
            id: `terminal-${terminal.name}-${pid || Date.now()}`,
            name: terminal.name,
            type: this.inferTerminalType(name),
            typeLabel: this.inferTerminalTypeLabel(name),
            model: '—',
            status: 'running',
            task: `Running in terminal: ${terminal.name}`,
            tokens: 0,
            startTime: Date.now(),
            elapsed: '—',
            progress: 0,
            progressLabel: 'Active in terminal',
            tools: [],
            activeTool: null,
            files: [],
            location: 'local',
            pid,
            sourceProvider: this.id
          });
        }
      } catch { /* skip terminal */ }
    }

    // Also check for CLI agent processes via ps command
    // Only match actual CLI tool invocations, not desktop apps
    try {
      const psOutput = await this.execCommand('ps', ['aux']);
      if (psOutput) {
        const agentPatterns = [
          // Match "claude code" or "claude --" CLI invocations, NOT Claude Desktop/Electron
          { pattern: /node.*claude.*--?(chat|code|task|agent)/i, type: 'claude' as const, label: 'Claude Code' },
          { pattern: /aider\s/i, type: 'custom' as const, label: 'Aider' },
          { pattern: /codex\s/i, type: 'codex' as const, label: 'Codex' },
        ];

        for (const { pattern, type, label } of agentPatterns) {
          const matches = psOutput.split('\n').filter(line => {
            // Must match the pattern AND must NOT be an Electron/desktop app
            return pattern.test(line) &&
                   !line.includes('Electron') &&
                   !line.includes('.app/') &&
                   !line.includes('Code Helper') &&
                   !line.includes('desktop');
          });
          for (const line of matches) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1]);
            if (pid && !this._agents.some(a => a.pid === pid)) {
              this._agents.push({
                id: `process-${pid}`,
                name: `${label} (PID ${pid})`,
                type,
                typeLabel: label,
                model: '—',
                status: 'running',
                task: `CLI process (PID ${pid})`,
                tokens: 0,
                startTime: Date.now(),
                elapsed: '—',
                progress: 0,
                progressLabel: 'Running',
                tools: [],
                activeTool: null,
                files: [],
                location: 'local',
                pid,
                sourceProvider: this.id
              });
            }
          }
        }
      }
    } catch { /* ps not available */ }

    this._state = 'connected';
    this._message = this._agents.length > 0
      ? `Found ${this._agents.length} agent process(es)`
      : 'Monitoring terminals — no agent processes detected.';
  }

  private inferTerminalType(name: string): AgentSession['type'] {
    if (name.includes('claude')) return 'claude';
    if (name.includes('copilot')) return 'copilot';
    if (name.includes('codex')) return 'codex';
    return 'custom';
  }

  private inferTerminalTypeLabel(name: string): string {
    if (name.includes('claude')) return 'Claude';
    if (name.includes('copilot')) return 'Copilot';
    if (name.includes('codex')) return 'Codex';
    return 'Agent';
  }
}

// ─── Provider: GitHub Actions Workflows ──────────────────────────────────────

class GitHubActionsProvider extends DataProvider {
  readonly name = 'GitHub Actions';
  readonly id = 'github-actions';

  protected async fetch(): Promise<void> {
    this._agents = [];

    // Check if gh CLI is available
    const ghVersion = await this.execCommand('gh', ['--version']);
    if (!ghVersion) {
      this._state = 'unavailable';
      this._message = 'GitHub CLI (gh) not installed. Install it to monitor GitHub Actions agent workflows.';
      return;
    }

    // Check if we're in a git repo
    const gitRoot = await this.execCommand('git', ['rev-parse', '--show-toplevel']);
    if (!gitRoot) {
      this._state = 'unavailable';
      this._message = 'Not in a git repository. Open a repo to monitor GitHub Actions.';
      return;
    }

    // Look for agent-related workflows
    const workflowNames = ['claude.yml', 'claude.yaml', 'copilot.yml', 'agent.yml', 'ai-agent.yml'];
    let foundWorkflow = false;

    for (const workflow of workflowNames) {
      try {
        const result = await this.execCommand('gh', [
          'run', 'list',
          '--json', 'databaseId,displayTitle,status,conclusion,createdAt,updatedAt',
          '--limit', '5',
          '--workflow', workflow
        ]);

        if (result) {
          foundWorkflow = true;
          const runs = JSON.parse(result);
          for (const run of runs) {
            const isActive = run.status === 'in_progress' || run.status === 'queued';
            // Only show actively running/queued workflows — skip completed history
            if (!isActive) continue;

            this._agents.push({
              id: `gh-${run.databaseId}`,
              name: run.displayTitle || `Workflow #${run.databaseId}`,
              type: 'claude',
              typeLabel: 'Claude',
              model: '—',
              status: run.status === 'queued' ? 'queued' : 'running',
              task: `${workflow}: ${run.displayTitle || ''}`,
              tokens: 0,
              startTime: new Date(run.createdAt).getTime(),
              elapsed: this.formatElapsed(Date.now() - new Date(run.createdAt).getTime()),
              progress: 50,
              progressLabel: run.status,
              tools: [],
              activeTool: null,
              files: [],
              location: 'cloud',
              remoteHost: 'GitHub Actions',
              sourceProvider: this.id
            });
          }
        }
      } catch { /* workflow doesn't exist, skip */ }
    }

    if (!foundWorkflow) {
      this._state = 'connected';
      this._message = 'No agent workflows found (looked for claude.yml, copilot.yml, agent.yml).';
    } else {
      this._state = 'connected';
      const activeCount = this._agents.filter(a => a.status === 'running' || a.status === 'queued').length;
      this._message = `${this._agents.length} workflow run(s), ${activeCount} active`;
    }
  }
}

// ─── Provider: VS Code Remote Connection ─────────────────────────────────────

class RemoteConnectionProvider extends DataProvider {
  readonly name = 'Remote Connections';
  readonly id = 'remote-connections';

  protected async fetch(): Promise<void> {
    this._agents = [];

    if (vscode.env.remoteName) {
      this._agents.push({
        id: `remote-${vscode.env.remoteName}`,
        name: `Remote: ${vscode.env.remoteName}`,
        type: 'custom',
        typeLabel: 'Remote',
        model: '—',
        status: 'running',
        task: `Connected to ${vscode.env.remoteName} environment`,
        tokens: 0,
        startTime: Date.now(),
        elapsed: '—',
        progress: 0,
        progressLabel: 'Connected',
        tools: [],
        activeTool: null,
        files: [],
        location: 'remote',
        remoteHost: vscode.env.remoteName,
        sourceProvider: this.id
      });

      this._state = 'connected';
      this._message = `Connected to ${vscode.env.remoteName}`;
    } else {
      this._state = 'connected';
      this._message = 'No remote connection active.';
    }
  }
}

// ─── Provider: Claude Desktop Todos ──────────────────────────────────────────

class ClaudeDesktopTodosProvider extends DataProvider {
  readonly name = 'Claude Desktop';
  readonly id = 'claude-desktop-todos';

  private todosDir: string;

  constructor(outputChannel: vscode.OutputChannel) {
    super(outputChannel);
    this.todosDir = path.join(os.homedir(), '.claude', 'todos');
  }

  protected async fetch(): Promise<void> {
    this._agents = [];
    this._activities = [];

    if (!fs.existsSync(this.todosDir)) {
      this._state = 'unavailable';
      this._message = 'Claude Desktop todos directory not found (~/.claude/todos).';
      return;
    }

    const files = fs.readdirSync(this.todosDir).filter(f => f.endsWith('.json'));

    if (files.length === 0) {
      this._state = 'connected';
      this._message = 'No Claude Desktop todo files found.';
      return;
    }

    // Sort files by modification time (newest first) and only look at recent ones
    const fileStats = files.map(f => {
      try {
        const filePath = path.join(this.todosDir, f);
        return { file: f, stat: fs.statSync(filePath), path: filePath };
      } catch { return null; }
    }).filter(Boolean) as { file: string; stat: fs.Stats; path: string }[];

    fileStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    const ACTIVE_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes = actively running
    const RECENT_WINDOW_MS = 30 * 60 * 1000;  // 30 minutes = show as completed
    const now = Date.now();
    let activeCount = 0;
    let recentCount = 0;

    for (const { file, stat, path: filePath } of fileStats.slice(0, 30)) {
      try {
        const ageMs = now - stat.mtimeMs;

        // Skip files older than 30 minutes — they're stale
        if (ageMs > RECENT_WINDOW_MS) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Skip empty arrays/objects
        if (Array.isArray(data) && data.length === 0) continue;
        if (typeof data === 'object' && Object.keys(data).length === 0) continue;

        recentCount++;

        // Extract agent UUID from filename pattern: {uuid}-agent-{uuid}.json
        const uuidMatch = file.match(/^([a-f0-9-]+)-agent-/);
        const agentId = uuidMatch ? uuidMatch[1].substring(0, 8) : file.substring(0, 8);

        // Parse todos
        const todos = Array.isArray(data) ? data : (data.todos || []);
        const activeTodos = todos.filter((t: any) => t.status === 'in_progress');
        const completedTodos = todos.filter((t: any) => t.status === 'completed');

        // Only running if modified within the last 5 minutes AND has in_progress tasks
        const isActive = ageMs < ACTIVE_WINDOW_MS && activeTodos.length > 0;
        let status: AgentSession['status'] = isActive ? 'running' : 'done';
        let progressLabel = isActive
          ? (activeTodos[0]?.activeForm || activeTodos[0]?.content || 'Working...')
          : `${completedTodos.length}/${todos.length} tasks done`;

        if (isActive) activeCount++;

        const progress = todos.length > 0
          ? Math.round((completedTodos.length / todos.length) * 100)
          : 0;

        const taskName = activeTodos[0]?.activeForm ||
                        activeTodos[0]?.content ||
                        todos[0]?.content ||
                        'Claude Desktop session';

        // Build task list for expandable detail view
        const taskList: AgentTask[] = todos.map((t: any) => ({
          content: t.content || 'Unknown task',
          status: t.status || 'pending',
          activeForm: t.activeForm
        }));

        this._agents.push({
          id: `claude-todo-${agentId}`,
          name: `Claude Session ${agentId}`,
          type: 'claude',
          typeLabel: 'Claude',
          model: 'Claude',
          status,
          task: taskName,
          tokens: 0,
          startTime: stat.birthtimeMs || stat.mtimeMs,
          elapsed: this.formatElapsed(now - (stat.birthtimeMs || stat.mtimeMs)),
          progress,
          progressLabel,
          tools: [],
          activeTool: activeTodos[0]?.activeForm || null,
          files: [],
          location: 'local',
          sourceProvider: this.id,
          tasks: taskList
        });

        // Only generate activity items for active sessions
        if (isActive) {
          for (const todo of todos) {
            this._activities.push({
              agent: `Claude ${agentId}`,
              desc: todo.content || 'Unknown task',
              type: todo.status === 'completed' ? 'complete' : (todo.status === 'in_progress' ? 'tool_use' : 'info'),
              timestamp: stat.mtimeMs,
              timeLabel: ''
            });
          }
        }
      } catch (e: any) {
        this._outputChannel.appendLine(`[${this.id}] Skipped ${file}: ${e?.message}`);
      }
    }

    // ── Also scan Claude Code JSONL sessions from ~/.claude/projects/ ──
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(projectsDir)) {
      try {
        const projectDirs = fs.readdirSync(projectsDir);
        for (const projDir of projectDirs) {
          const projPath = path.join(projectsDir, projDir);
          try {
            const stat2 = fs.statSync(projPath);
            if (!stat2.isDirectory()) continue;

            const jsonlFiles = fs.readdirSync(projPath)
              .filter(f => f.endsWith('.jsonl'))
              .map(f => ({ name: f, path: path.join(projPath, f) }));

            for (const jf of jsonlFiles) {
              try {
                const jstat = fs.statSync(jf.path);
                const age = now - jstat.mtimeMs;
                if (age > 24 * 60 * 60 * 1000) continue; // Last 24 hours

                // Read JSONL (one JSON object per line)
                const raw = fs.readFileSync(jf.path, 'utf-8');
                if (raw.length > 5 * 1024 * 1024) continue; // Skip files > 5MB

                const lines = raw.split('\n').filter(l => l.trim().length > 0);
                if (lines.length === 0) continue;

                const sessionId = path.basename(jf.name, '.jsonl').substring(0, 12);
                const actions: AgentAction[] = [];
                const files2 = new Set<string>();
                const tools2 = new Set<string>();
                const convoSnippets: string[] = [];
                let lastTask = '';
                let totalInputTokens = 0;
                let totalOutputTokens = 0;

                for (const line of lines) {
                  try {
                    const msg = JSON.parse(line);
                    const content = msg.message?.content;
                    if (!Array.isArray(content)) continue;

                    for (const block of content) {
                      // User text
                      if (msg.type === 'user' && block.type === 'text' && block.text) {
                        lastTask = block.text.substring(0, 300);
                        if (convoSnippets.length < 15) {
                          convoSnippets.push('\uD83D\uDC64 ' + block.text.substring(0, 150));
                        }
                      }
                      // Assistant text
                      if (msg.type === 'assistant' && block.type === 'text' && block.text) {
                        if (convoSnippets.length < 15) {
                          convoSnippets.push('\uD83E\uDD16 ' + block.text.substring(0, 200));
                        }
                      }
                      // Tool use
                      if (block.type === 'tool_use') {
                        const toolName = this.normalizeClaudeToolName(block.name || 'Tool');
                        const input = block.input || {};
                        let detail = '';
                        const fp = input.file_path || input.filePath || '';
                        if (fp) {
                          const fn = path.basename(fp);
                          files2.add(fn);
                          detail = input.offset ? `${fn}, lines ${input.offset}` : fn;
                        } else if (input.command) {
                          detail = String(input.command).substring(0, 80);
                        } else if (input.pattern) {
                          detail = `pattern: ${input.pattern}`;
                        } else if (input.query) {
                          detail = String(input.query).substring(0, 80);
                        } else {
                          detail = toolName;
                        }
                        actions.push({ tool: toolName, detail, timestamp: jstat.mtimeMs, status: 'done' });
                        tools2.add(toolName);
                        if (convoSnippets.length < 20) {
                          convoSnippets.push('\uD83D\uDD27 ' + toolName + ': ' + detail.substring(0, 100));
                        }
                      }
                      // Tool result (check for errors)
                      if (block.type === 'tool_result' && block.is_error && actions.length > 0) {
                        actions[actions.length - 1].status = 'error';
                      }
                    }

                    // Token usage
                    if (msg.usage) {
                      totalInputTokens += msg.usage.input_tokens || 0;
                      totalOutputTokens += msg.usage.output_tokens || 0;
                    }
                  } catch { /* skip line */ }
                }

                if (actions.length === 0 && lines.length < 2) continue;

                const isActive2 = (now - jstat.mtimeMs) < 5 * 60 * 1000;
                const totalTokens = totalInputTokens + totalOutputTokens;

                this._agents.push({
                  id: `claude-code-${sessionId}`,
                  name: `Claude Code ${sessionId}`,
                  type: 'claude',
                  typeLabel: 'Claude Code',
                  model: 'Claude',
                  status: isActive2 ? 'running' : 'done',
                  task: lastTask || 'Claude Code session',
                  tokens: totalTokens,
                  startTime: jstat.birthtimeMs || jstat.mtimeMs,
                  elapsed: this.formatElapsed(now - (jstat.birthtimeMs || jstat.mtimeMs)),
                  progress: isActive2 ? 0 : 100,
                  progressLabel: isActive2 ? (actions.length > 0 ? actions[actions.length - 1].detail : 'Active') : `${actions.length} tool calls`,
                  tools: Array.from(tools2),
                  activeTool: isActive2 && actions.length > 0 ? actions[actions.length - 1].detail : null,
                  files: Array.from(files2).slice(0, 20),
                  location: 'local',
                  sourceProvider: this.id,
                  recentActions: actions.slice(-30),
                  conversationPreview: convoSnippets.slice(-15),
                });

                if (isActive2) activeCount++;
                recentCount++;
              } catch { /* skip file */ }
            }
          } catch { /* skip project dir */ }
        }
      } catch (err: any) {
        this._outputChannel.appendLine(`[${this.id}] Error scanning Claude Code projects: ${err?.message}`);
      }
    }

    this._state = 'connected';
    this._message = activeCount > 0
      ? `${activeCount} active session(s), ${recentCount} recent`
      : recentCount > 0
        ? `${recentCount} recent session(s), none currently active`
        : 'No active Claude sessions.';
  }

  private normalizeClaudeToolName(name: string): string {
    const n = (name || '').toLowerCase();
    if (n === 'read' || n === 'view') return 'Read';
    if (n === 'edit' || n === 'str_replace_editor') return 'Edit';
    if (n === 'write' || n === 'create') return 'Write';
    if (n === 'bash' || n === 'execute' || n === 'shell') return 'Bash';
    if (n === 'glob' || n === 'find') return 'Search';
    if (n === 'grep' || n === 'search') return 'Search';
    if (n === 'task' || n === 'dispatch_agent') return 'Subagent';
    if (n === 'todowrite' || n === 'todo') return 'Todo';
    if (n === 'ls' || n === 'list') return 'List';
    if (n === 'webfetch' || n === 'websearch') return 'Web';
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// ─── Provider: Workspace Activity Monitor ────────────────────────────────────

class WorkspaceActivityProvider extends DataProvider {
  readonly name = 'Workspace Activity';
  readonly id = 'workspace-activity';

  private watcher: vscode.FileSystemWatcher | undefined;
  private recentChanges: { uri: string; time: number }[] = [];
  private recentSaves: { uri: string; time: number }[] = [];

  constructor(outputChannel: vscode.OutputChannel) {
    super(outputChannel);
    this.setupWatchers();
  }

  private setupWatchers() {
    // Watch for all file changes in the workspace
    if (vscode.workspace.workspaceFolders?.length) {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.watcher.onDidChange(uri => {
        this.recentChanges.push({ uri: uri.fsPath, time: Date.now() });
        // Keep only last 5 minutes of changes
        const cutoff = Date.now() - 300000;
        this.recentChanges = this.recentChanges.filter(c => c.time > cutoff);
      });
      this.watcher.onDidCreate(uri => {
        this.recentChanges.push({ uri: uri.fsPath, time: Date.now() });
      });
    }

    // Track document saves
    vscode.workspace.onDidSaveTextDocument(doc => {
      this.recentSaves.push({ uri: doc.uri.fsPath, time: Date.now() });
      const cutoff = Date.now() - 300000;
      this.recentSaves = this.recentSaves.filter(s => s.time > cutoff);
    });
  }

  protected async fetch(): Promise<void> {
    this._agents = [];
    this._activities = [];

    const now = Date.now();
    const cutoff = now - 300000; // 5 minutes

    // Clean old entries
    this.recentChanges = this.recentChanges.filter(c => c.time > cutoff);
    this.recentSaves = this.recentSaves.filter(s => s.time > cutoff);

    // Generate activity items from recent file changes
    const uniqueFiles = new Set<string>();
    for (const change of this.recentChanges.slice(-20)) {
      const fileName = path.basename(change.uri);
      if (!uniqueFiles.has(fileName)) {
        uniqueFiles.add(fileName);
        this._activities.push({
          agent: 'Workspace',
          desc: `File modified: ${fileName}`,
          type: 'file_edit',
          timestamp: change.time,
          timeLabel: ''
        });
      }
    }

    for (const save of this.recentSaves.slice(-10)) {
      const fileName = path.basename(save.uri);
      this._activities.push({
        agent: 'Workspace',
        desc: `File saved: ${fileName}`,
        type: 'file_edit',
        timestamp: save.time,
        timeLabel: ''
      });
    }

    const changeCount = this.recentChanges.length;
    const saveCount = this.recentSaves.length;
    const fileCount = new Set([
      ...this.recentChanges.map(c => c.uri),
      ...this.recentSaves.map(s => s.uri)
    ]).size;

    this._state = 'connected';
    if (changeCount > 0 || saveCount > 0) {
      this._message = `${fileCount} file(s) active: ${changeCount} changes, ${saveCount} saves in last 5 min`;
    } else {
      this._message = 'Monitoring workspace — no recent file activity.';
    }
  }

  dispose() {
    this.watcher?.dispose();
  }
}

// ─── Provider: Chat Tools & Participants Discovery ───────────────────────────

class ChatToolsParticipantsProvider extends DataProvider {
  readonly name = 'Chat Tools & Agents';
  readonly id = 'chat-tools-participants';

  protected async fetch(): Promise<void> {
    this._agents = [];

    // ── 1. Log registered LM tools for diagnostics (don't create agent cards for every tool) ──
    let totalToolCount = 0;
    try {
      const lmApi = (vscode as any).lm;
      if (lmApi && Array.isArray(lmApi.tools) && lmApi.tools.length > 0) {
        totalToolCount = lmApi.tools.length;
        // Group by namespace for logging only
        const toolsByNamespace = new Map<string, string[]>();
        for (const tool of lmApi.tools) {
          const toolName: string = tool.name || '';
          const ns = toolName.includes('_') ? toolName.split('_')[0] : (toolName.includes('.') ? toolName.split('.')[0] : 'default');
          if (!toolsByNamespace.has(ns)) { toolsByNamespace.set(ns, []); }
          toolsByNamespace.get(ns)!.push(toolName);
        }
        // Log discovery for debugging but don't clutter the dashboard
        for (const [ns, tools] of toolsByNamespace) {
          this._outputChannel.appendLine(`[${this.id}] LM tool namespace "${ns}": ${tools.length} tool(s)`);
        }
      }
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] lm.tools error: ${err?.message}`);
    }

    // ── 2. Only surface non-built-in chat participants that are ACTIVE ──
    let participantCount = 0;
    try {
      // Built-in / default participant IDs we should skip (these are always present and not "agents")
      const builtInIds = new Set([
        'copilot', 'github.copilot', 'github.copilot-chat',
        'vscode', 'workspace', 'terminal',
        'github.copilot.terminal', 'github.copilot.workspace', 'github.copilot.vscode',
      ]);

      for (const ext of vscode.extensions.all) {
        try {
          const pkg = ext.packageJSON;
          if (!pkg || !pkg.contributes) continue;

          const participants = pkg.contributes.chatParticipants;
          if (!Array.isArray(participants)) continue;

          for (const p of participants) {
            const pId = p.id || p.name || '';
            participantCount++;

            // Skip built-in participants — they're always present and aren't workspace-specific
            if (builtInIds.has(pId) || builtInIds.has(ext.id)) continue;
            // Skip if the parent extension isn't active
            if (!ext.isActive) continue;

            this._agents.push({
              id: `chat-participant-${pId}`,
              name: p.fullName || p.name || pId,
              type: ext.id.toLowerCase().includes('copilot') ? 'copilot' :
                    ext.id.toLowerCase().includes('claude') ? 'claude' : 'custom',
              typeLabel: 'Chat Agent',
              model: '—',
              status: 'running',
              task: p.description || `Chat participant @${pId}`,
              tokens: 0,
              startTime: Date.now(),
              elapsed: '—',
              progress: 0,
              progressLabel: 'Available',
              tools: Array.isArray(p.commands) ? p.commands.map((c: any) => c.name || c) : [],
              activeTool: null,
              files: [],
              location: 'local',
              sourceProvider: this.id
            });
          }
        } catch { /* skip */ }
      }
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Extension scan error: ${err?.message}`);
    }

    // ── 3. Try command-based chat session discovery ──
    try {
      const chatCommands = await vscode.commands.getCommands(true);
      for (const cmd of ['workbench.action.chat.listSessions', 'workbench.action.chat.getSessions']) {
        if (chatCommands.includes(cmd)) {
          try {
            const result = await vscode.commands.executeCommand(cmd);
            if (result && Array.isArray(result)) {
              for (const session of result) {
                const sid = session.id || `chat-session-${Date.now()}`;
                if (!this._agents.some(a => a.id === sid)) {
                  this._agents.push({
                    id: sid,
                    name: session.title || session.name || 'Chat Session',
                    type: 'copilot',
                    typeLabel: 'Chat',
                    model: session.model || '—',
                    status: 'running',
                    task: session.title || 'Active chat session',
                    tokens: session.tokenCount || 0,
                    startTime: session.createdAt ? new Date(session.createdAt).getTime() : Date.now(),
                    elapsed: '—',
                    progress: 50,
                    progressLabel: 'Active',
                    tools: [],
                    activeTool: null,
                    files: [],
                    location: 'local',
                    sourceProvider: this.id
                  });
                }
              }
            }
          } catch { /* command not available */ }
        }
      }
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Command discovery error: ${err?.message}`);
    }

    this._state = 'connected';
    const parts: string[] = [];
    if (totalToolCount > 0) parts.push(`${totalToolCount} LM tools`);
    if (participantCount > 0) parts.push(`${participantCount} participants`);
    if (this._agents.length > 0) parts.push(`${this._agents.length} active agent(s)`);
    this._message = parts.length > 0
      ? `Detected: ${parts.join(', ')}`
      : 'No chat participants or LM tools detected.';
  }
}

// ─── Provider: Custom Workspace Agents (.github/agents/) ─────────────────────

class CustomAgentsProvider extends DataProvider {
  readonly name = 'Custom Agents';
  readonly id = 'custom-workspace-agents';

  protected async fetch(): Promise<void> {
    this._agents = [];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._state = 'connected';
      this._message = 'No workspace open.';
      return;
    }

    let totalAgents = 0;

    for (const folder of workspaceFolders) {
      const agentsDir = path.join(folder.uri.fsPath, '.github', 'agents');

      if (!fs.existsSync(agentsDir)) continue;

      try {
        const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));

        for (const file of files) {
          try {
            const filePath = path.join(agentsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const agentName = path.basename(file, '.md');

            // Parse front matter or first lines for description
            let description = '';
            let model = '—';
            let tools: string[] = [];

            // Check for YAML front matter
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const fm = fmMatch[1];
              const descMatch = fm.match(/description:\s*(.+)/);
              if (descMatch) description = descMatch[1].trim();
              const modelMatch = fm.match(/model:\s*(.+)/);
              if (modelMatch) model = modelMatch[1].trim();
              const toolsMatch = fm.match(/tools:\s*\[([^\]]+)\]/);
              if (toolsMatch) tools = toolsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
            }

            // If no front matter description, use first non-empty line
            if (!description) {
              const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
              description = firstLine?.trim().substring(0, 100) || `Custom agent: ${agentName}`;
            }

            // Check if content mentions "infer" capability (subagent support)
            const canInfer = content.toLowerCase().includes('"infer"') || content.toLowerCase().includes('subagent');

            this._agents.push({
              id: `custom-agent-${folder.name}-${agentName}`,
              name: `@${agentName}`,
              type: 'custom',
              typeLabel: canInfer ? 'Subagent' : 'Custom',
              model,
              status: 'running', // Custom agents are always available when defined
              task: description,
              tokens: 0,
              startTime: Date.now(),
              elapsed: '—',
              progress: 0,
              progressLabel: canInfer ? 'Subagent capable' : 'Available',
              tools,
              activeTool: null,
              files: [filePath],
              location: 'local',
              sourceProvider: this.id
            });

            totalAgents++;
          } catch { /* skip individual agent file */ }
        }
      } catch { /* skip folder */ }
    }

    this._state = 'connected';
    this._message = totalAgents > 0
      ? `Found ${totalAgents} custom agent(s) in .github/agents/`
      : 'No custom agents found in .github/agents/.';
  }
}

// ─── Alert Engine ────────────────────────────────────────────────────────────

type AlertEvent = 'agent-completed' | 'agent-error' | 'agent-started' | 'provider-degraded';

interface AlertRule {
  event: AlertEvent;
  channels: ('email' | 'sms' | 'webhook')[];
  enabled: boolean;
}

class AlertEngine {
  private outputChannel: vscode.OutputChannel;
  private previousAgentStates: Map<string, string> = new Map();
  private previousProviderStates: Map<string, string> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private readonly COOLDOWN_MS = 60000; // Don't repeat same alert within 60s

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Check for state changes and fire alerts. Called each refresh cycle.
   * All operations are wrapped in try/catch — alerts never crash the dashboard.
   */
  async checkAndAlert(agents: AgentSession[], providerHealth: DataSourceStatus[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('agentDashboard.alerts');
    if (!config.get<boolean>('enabled', false)) return;

    const rules = config.get<AlertRule[]>('rules', []);
    const enabledRules = rules.filter(r => r.enabled && r.channels.length > 0);
    if (enabledRules.length === 0) return;

    try {
      // Check agent state changes
      for (const agent of agents) {
        const prevStatus = this.previousAgentStates.get(agent.id);

        if (prevStatus && prevStatus !== agent.status) {
          // Agent completed
          if (agent.status === 'done' && prevStatus !== 'done') {
            await this.fireAlert('agent-completed', enabledRules, {
              title: `Agent completed: ${agent.name}`,
              body: `"${agent.task}" finished successfully.\nElapsed: ${agent.elapsed} | Tokens: ${agent.tokens}`,
              agentName: agent.name
            });
          }
          // Agent errored
          if (agent.status === 'error' && prevStatus !== 'error') {
            await this.fireAlert('agent-error', enabledRules, {
              title: `Agent error: ${agent.name}`,
              body: `"${agent.task}" encountered an error.\nLast status: ${prevStatus}`,
              agentName: agent.name
            });
          }
        }

        // Agent started (new agent we haven't seen before)
        if (!prevStatus && (agent.status === 'running' || agent.status === 'thinking')) {
          await this.fireAlert('agent-started', enabledRules, {
            title: `Agent started: ${agent.name}`,
            body: `New agent session: "${agent.task}"\nModel: ${agent.model} | Source: ${agent.sourceProvider}`,
            agentName: agent.name
          });
        }

        this.previousAgentStates.set(agent.id, agent.status);
      }

      // Check provider health changes
      for (const provider of providerHealth) {
        const prevState = this.previousProviderStates.get(provider.id);
        if (prevState && prevState !== 'degraded' && provider.state === 'degraded') {
          await this.fireAlert('provider-degraded', enabledRules, {
            title: `Data source degraded: ${provider.name}`,
            body: `${provider.message}\n\nSwitch data sources in the dashboard or check the extension log for details.`,
            agentName: provider.name
          });
        }
        this.previousProviderStates.set(provider.id, provider.state);
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[alerts] Error in check cycle: ${err?.message}`);
    }
  }

  private async fireAlert(event: AlertEvent, rules: AlertRule[], payload: { title: string; body: string; agentName: string }): Promise<void> {
    const rule = rules.find(r => r.event === event);
    if (!rule) return;

    // Cooldown check
    const cooldownKey = `${event}:${payload.agentName}`;
    const lastFired = this.cooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastFired < this.COOLDOWN_MS) return;
    this.cooldowns.set(cooldownKey, Date.now());

    this.outputChannel.appendLine(`[alerts] Firing ${event}: ${payload.title}`);

    // Also show VS Code notification
    if (event === 'agent-error' || event === 'provider-degraded') {
      vscode.window.showWarningMessage(`Agent Dashboard: ${payload.title}`);
    } else {
      vscode.window.showInformationMessage(`Agent Dashboard: ${payload.title}`);
    }

    // Send to configured channels in parallel
    const sends: Promise<void>[] = [];
    for (const channel of rule.channels) {
      switch (channel) {
        case 'email':
          sends.push(this.sendEmail(payload));
          break;
        case 'sms':
          sends.push(this.sendSMS(payload));
          break;
        case 'webhook':
          sends.push(this.sendWebhook(event, payload));
          break;
      }
    }
    await Promise.allSettled(sends);
  }

  private async sendEmail(payload: { title: string; body: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('agentDashboard.alerts.email');
    const provider = config.get<string>('provider', 'none');
    const to = config.get<string>('to', '');

    if (provider === 'none' || !to) {
      this.outputChannel.appendLine('[alerts] Email not configured — skipping');
      return;
    }

    try {
      if (provider === 'sendgrid') {
        const apiKey = config.get<string>('sendgridApiKey', '');
        const from = config.get<string>('from', 'agent-dashboard@localhost');
        if (!apiKey) { this.outputChannel.appendLine('[alerts] SendGrid API key missing'); return; }

        // Use Node.js https module to call SendGrid API
        await this.httpPost('https://api.sendgrid.com/v3/mail/send', {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject: payload.title,
          content: [{ type: 'text/plain', value: payload.body }]
        }, { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

        this.outputChannel.appendLine(`[alerts] Email sent to ${to} via SendGrid`);

      } else if (provider === 'smtp') {
        // For SMTP, we shell out to a Node script or use the `mail` command
        // This keeps the extension dependency-free
        const host = config.get<string>('smtpHost', '');
        const port = config.get<number>('smtpPort', 587);
        const user = config.get<string>('smtpUser', '');
        const pass = config.get<string>('smtpPass', '');
        const from = config.get<string>('from', '');

        if (!host) { this.outputChannel.appendLine('[alerts] SMTP host missing'); return; }

        // Use a temporary Node.js script to send via SMTP (no npm dependencies needed)
        const script = `
          const net = require('net');
          const tls = require('tls');
          const sock = net.createConnection(${port}, '${host}', () => {
            // Basic SMTP — in production, use nodemailer
            console.log('SMTP connected');
          });
          sock.on('error', (e) => { console.error('SMTP error:', e.message); process.exit(1); });
          setTimeout(() => process.exit(0), 5000);
        `;
        // For now, log that SMTP would be sent — full SMTP implementation would use nodemailer
        this.outputChannel.appendLine(`[alerts] SMTP email would be sent to ${to} via ${host}:${port} (install nodemailer for full SMTP support)`);
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[alerts] Email error: ${err?.message}`);
    }
  }

  private async sendSMS(payload: { title: string; body: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('agentDashboard.alerts.sms');
    const provider = config.get<string>('provider', 'none');

    if (provider === 'none') {
      this.outputChannel.appendLine('[alerts] SMS not configured — skipping');
      return;
    }

    try {
      if (provider === 'twilio') {
        const accountSid = config.get<string>('twilioAccountSid', '');
        const authToken = config.get<string>('twilioAuthToken', '');
        const from = config.get<string>('twilioFrom', '');
        const to = config.get<string>('to', '');

        if (!accountSid || !authToken || !from || !to) {
          this.outputChannel.appendLine('[alerts] Twilio credentials incomplete');
          return;
        }

        const body = `${payload.title}\n${payload.body}`.substring(0, 1500);
        const formData = `To=${encodeURIComponent(to)}&From=${encodeURIComponent(from)}&Body=${encodeURIComponent(body)}`;

        await this.httpPost(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          formData,
          {
            'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        );

        this.outputChannel.appendLine(`[alerts] SMS sent to ${to} via Twilio`);
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[alerts] SMS error: ${err?.message}`);
    }
  }

  private async sendWebhook(event: string, payload: { title: string; body: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('agentDashboard.alerts.webhook');
    const url = config.get<string>('url', '');

    if (!url) {
      this.outputChannel.appendLine('[alerts] Webhook URL not configured — skipping');
      return;
    }

    try {
      await this.httpPost(url, {
        event,
        title: payload.title,
        body: payload.body,
        timestamp: new Date().toISOString(),
        source: 'agent-dashboard'
      }, { 'Content-Type': 'application/json' });

      this.outputChannel.appendLine(`[alerts] Webhook sent to ${url}`);
    } catch (err: any) {
      this.outputChannel.appendLine(`[alerts] Webhook error: ${err?.message}`);
    }
  }

  private httpPost(url: string, body: any, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const https = require('https');
        const http = require('http');
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const data = typeof body === 'string' ? body : JSON.stringify(body);

        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
          timeout: 10000
        };

        const req = (isHttps ? https : http).request(options, (res: any) => {
          let responseData = '';
          res.on('data', (d: any) => responseData += d);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 200)}`));
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(data);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

// ─── Dashboard Provider (orchestrates everything) ────────────────────────────

class DashboardProvider {
  private panel: vscode.WebviewPanel | undefined;
  private allProviders: { provider: DataProvider; group: 'copilot' | 'claude-code' | 'both' }[] = [];
  private providers: DataProvider[] = [];
  private alertEngine: AlertEngine;
  private pollTimer: NodeJS.Timeout | undefined;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private apiServer: http.Server | undefined;
  private lastState: DashboardState | undefined;
  private agentFirstSeen: Map<string, number> = new Map();
  private previousAgentStatuses: Map<string, string> = new Map();
  private previousProviderStates: Map<string, HealthState> = new Map();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel('Agent Dashboard');

    // Register all providers with their source group
    this.allProviders = [
      { provider: new VSCodeChatSessionsProvider(this.outputChannel), group: 'copilot' },
      { provider: new CopilotExtensionProvider(this.outputChannel), group: 'copilot' },
      { provider: new CopilotChatSessionProvider(this.outputChannel, context), group: 'copilot' },
      { provider: new ChatToolsParticipantsProvider(this.outputChannel), group: 'copilot' },
      { provider: new CustomAgentsProvider(this.outputChannel), group: 'both' },
      { provider: new TerminalProcessProvider(this.outputChannel), group: 'both' },
      { provider: new ClaudeDesktopTodosProvider(this.outputChannel), group: 'claude-code' },
      { provider: new GitHubActionsProvider(this.outputChannel), group: 'both' },
      { provider: new RemoteConnectionProvider(this.outputChannel), group: 'both' },
      { provider: new WorkspaceActivityProvider(this.outputChannel), group: 'both' },
    ];
    this.providers = this.getActiveProviders();
    this.alertEngine = new AlertEngine(this.outputChannel);
  }

  open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'agentDashboard',
      'Agent Dashboard',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = getWebviewContent(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopPolling();
    });

    this.startPolling();
    this.refresh();
  }

  /**
   * Returns only the providers that match the current primarySource config.
   * If a specific provider is disabled via enabledProviders, it's excluded.
   */
  private getActiveProviders(): DataProvider[] {
    const config = vscode.workspace.getConfiguration('agentDashboard');
    const primarySource = config.get<string>('primarySource', 'copilot');
    const enabledProviders = config.get<Record<string, boolean>>('enabledProviders', {});

    return this.allProviders
      .filter(({ provider, group }) => {
        // Check if this provider matches the selected primary source
        const matchesSource = primarySource === 'both' || group === 'both' || group === primarySource;
        // Check if this specific provider is individually enabled
        const isEnabled = enabledProviders[provider.id] !== false; // default to true
        return matchesSource && isEnabled;
      })
      .map(({ provider }) => provider);
  }

  private async handleMessage(msg: any) {
    switch (msg.command) {
      case 'refresh':
        await this.refresh();
        break;
      case 'openLog':
        this.outputChannel.show();
        break;
      case 'switchSource':
        // Switch between copilot / claude-code / both
        if (msg.source) {
          const config = vscode.workspace.getConfiguration('agentDashboard');
          await config.update('primarySource', msg.source, vscode.ConfigurationTarget.Global);
          this.providers = this.getActiveProviders();
          this.outputChannel.appendLine(`[dashboard] Switched primary source to: ${msg.source}`);
          await this.refresh();
        }
        break;
      case 'toggleProvider':
        // Toggle a specific provider on/off
        if (msg.providerId) {
          const config = vscode.workspace.getConfiguration('agentDashboard');
          const current = config.get<Record<string, boolean>>('enabledProviders', {});
          current[msg.providerId] = !current[msg.providerId];
          await config.update('enabledProviders', current, vscode.ConfigurationTarget.Global);
          this.providers = this.getActiveProviders();
          await this.refresh();
        }
        break;
      case 'pause':
      case 'resume':
      case 'stop':
        vscode.window.showInformationMessage(
          `Agent control (${msg.command}) requires the proposed Chat Sessions API. ` +
          `This will be available when VS Code exposes agent process control.`
        );
        break;
    }
  }

  async refresh() {
    this.outputChannel.appendLine(`[dashboard] Refreshing all providers at ${new Date().toISOString()}`);

    // Fetch all providers in parallel — each one handles its own errors
    await Promise.all(this.providers.map(p => p.safeFetch()));

    // Collect all agents and activities, deduplicating by ID
    const agentMap = new Map<string, AgentSession>();
    const allActivities: ActivityItem[] = [];

    for (const provider of this.providers) {
      for (const agent of provider.agents) {
        if (!agentMap.has(agent.id)) {
          agentMap.set(agent.id, agent);
        }
      }
      allActivities.push(...provider.activities);
    }

    // Persist first-seen times and update elapsed for each agent
    const now = Date.now();
    for (const [, agent] of agentMap) {
      if (!this.agentFirstSeen.has(agent.id)) {
        this.agentFirstSeen.set(agent.id, agent.startTime || now);
      }
      const firstSeen = this.agentFirstSeen.get(agent.id)!;
      agent.startTime = firstSeen;
      const elapsedMs = now - firstSeen;
      if (elapsedMs < 1000) { agent.elapsed = '<1s'; }
      else if (elapsedMs < 60000) { agent.elapsed = `${Math.floor(elapsedMs / 1000)}s`; }
      else if (elapsedMs < 3600000) { agent.elapsed = `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`; }
      else { agent.elapsed = `${Math.floor(elapsedMs / 3600000)}h ${Math.floor((elapsedMs % 3600000) / 60000)}m`; }

      // Generate activity events for status changes
      const prevStatus = this.previousAgentStatuses.get(agent.id);
      if (prevStatus && prevStatus !== agent.status) {
        allActivities.push({
          agent: agent.name,
          desc: `Status changed: ${prevStatus} → ${agent.status}`,
          type: agent.status === 'error' ? 'error' : agent.status === 'done' ? 'complete' : 'info',
          timestamp: now,
          timeLabel: 'just now'
        });
      } else if (!prevStatus) {
        allActivities.push({
          agent: agent.name,
          desc: `Agent detected (${agent.typeLabel}, ${agent.location})`,
          type: 'start',
          timestamp: firstSeen,
          timeLabel: 'just now'
        });
      }
      this.previousAgentStatuses.set(agent.id, agent.status);
    }

    const agents = Array.from(agentMap.values());
    const activeAgents = agents.filter(a => a.status === 'running' || a.status === 'thinking' || a.status === 'paused');
    const completedAgents = agents.filter(a => a.status === 'done');
    const totalTokens = agents.reduce((s, a) => s + a.tokens, 0);

    // Sort activities by timestamp
    allActivities.sort((a, b) => b.timestamp - a.timestamp);
    for (const act of allActivities) {
      const ago = now - act.timestamp;
      if (ago < 5000) act.timeLabel = 'just now';
      else if (ago < 60000) act.timeLabel = `${Math.floor(ago / 1000)}s ago`;
      else if (ago < 3600000) act.timeLabel = `${Math.floor(ago / 60000)}m ago`;
      else act.timeLabel = `${Math.floor(ago / 3600000)}h ago`;
    }

    const config = vscode.workspace.getConfiguration('agentDashboard');
    const primarySource = config.get<string>('primarySource', 'copilot');

    const state: DashboardState = {
      agents,
      activities: allActivities.slice(0, 50),
      stats: {
        total: agents.length,
        active: activeAgents.length,
        completed: completedAgents.length,
        tokens: totalTokens,
        estimatedCost: (totalTokens / 1000000) * 6,
        avgDuration: '—'
      },
      dataSourceHealth: this.providers.map(p => p.status),
      primarySource
    } as any;

    this.outputChannel.appendLine(`[dashboard] Found ${agents.length} agents from ${this.providers.filter(p => p.status.state === 'connected').length} connected providers`);

    // Generate activity events for provider health changes
    for (const h of state.dataSourceHealth) {
      const prevState = this.previousProviderStates.get(h.id);
      if (prevState && prevState !== h.state) {
        allActivities.push({
          agent: h.name,
          desc: `Data source ${h.state}: ${h.message}`,
          type: h.state === 'connected' ? 'info' : h.state === 'degraded' ? 'error' : 'info',
          timestamp: now,
          timeLabel: 'just now'
        });
      }
      this.previousProviderStates.set(h.id, h.state);
    }
    // Re-sort after adding provider activities
    allActivities.sort((a, b) => b.timestamp - a.timestamp);
    state.activities = allActivities.slice(0, 50);

    // Check for alert-worthy state changes (never throws)
    await this.alertEngine.checkAndAlert(agents, state.dataSourceHealth);

    // Store state for API consumers (iOS app, etc.)
    this.lastState = state;

    // Push to cloud relay if configured (fire-and-forget)
    this.pushToCloudRelay(state);

    if (this.panel) {
      this.outputChannel.appendLine(`[dashboard] Posting state to webview: ${agents.length} agents, ${allActivities.length} activities`);
      this.panel.webview.postMessage({ type: 'update', state });
    } else {
      this.outputChannel.appendLine(`[dashboard] WARNING: No panel open, skipping webview update`);
    }
  }

  private async pushToCloudRelay(state: DashboardState) {
    try {
      const config = vscode.workspace.getConfiguration('agentDashboard');
      const relayUrl = config.get<string>('cloudRelayUrl', '');
      const relayToken = config.get<string>('cloudRelayToken', '');
      if (!relayUrl) { return; }

      const url = relayUrl.replace(/\/$/, '') + '/api/state';
      const https = await import('https');
      const httpModule = url.startsWith('https') ? https : await import('http');

      const parsed = new URL(url);
      const postData = JSON.stringify(state);

      const req = httpModule.request({
        hostname: parsed.hostname,
        port: parsed.port || (url.startsWith('https') ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...(relayToken ? { 'Authorization': `Bearer ${relayToken}` } : {}),
        },
      }, (res: any) => {
        // Drain response
        res.resume();
      });

      req.on('error', () => { /* silent — cloud relay is best-effort */ });
      req.write(postData);
      req.end();
    } catch {
      // Cloud relay push is best-effort — never interrupt the main flow
    }
  }

  private startPolling() {
    const config = vscode.workspace.getConfiguration('agentDashboard');
    const interval = config.get<number>('pollInterval', 3000);
    this.pollTimer = setInterval(() => this.refresh(), interval);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ─── Local REST API for mobile / external clients ───────────────────────────

  startApiServer() {
    const config = vscode.workspace.getConfiguration('agentDashboard');
    const port = config.get<number>('apiPort', 19850);

    if (this.apiServer) { return; }

    this.apiServer = http.createServer((req, res) => {
      // CORS headers so iOS / web clients can connect
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/api/state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.lastState ?? { agents: [], activities: [], stats: { total: 0, active: 0, completed: 0, tokens: 0, estimatedCost: 0, avgDuration: '—' }, dataSourceHealth: [] }));
        return;
      }

      if (req.url === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.9.1', uptime: process.uptime() }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/api/state', '/api/health'] }));
    });

    this.apiServer.listen(port, '0.0.0.0', () => {
      this.outputChannel.appendLine(`[api] REST API server listening on http://0.0.0.0:${port}`);
      vscode.window.showInformationMessage(`Agent Dashboard API running on port ${port}. Connect your iOS app to http://<your-ip>:${port}/api/state`);
    });

    this.apiServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.outputChannel.appendLine(`[api] Port ${port} is already in use`);
        this.apiServer = undefined;
        vscode.window.showWarningMessage(`Agent Dashboard API: Port ${port} is already in use. Change agentDashboard.apiPort in settings.`);
      } else {
        this.outputChannel.appendLine(`[api] Server error: ${err.message}`);
      }
    });
  }

  stopApiServer() {
    if (this.apiServer) {
      this.apiServer.close();
      this.apiServer = undefined;
      this.outputChannel.appendLine('[api] REST API server stopped');
    }
  }

  dispose() {
    this.panel?.dispose();
    this.stopPolling();
    this.stopApiServer();
    this.outputChannel.dispose();
  }
}

// ─── Activation ──────────────────────────────────────────────────────────────

let dashboardProvider: DashboardProvider;

export function activate(context: vscode.ExtensionContext) {
  dashboardProvider = new DashboardProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentDashboard.open', () => dashboardProvider.open()),
    vscode.commands.registerCommand('agentDashboard.refresh', () => dashboardProvider.refresh()),
    vscode.commands.registerCommand('agentDashboard.startApi', () => dashboardProvider.startApiServer()),
    vscode.commands.registerCommand('agentDashboard.stopApi', () => dashboardProvider.stopApiServer())
  );

  // Auto-start API server if configured
  const config = vscode.workspace.getConfiguration('agentDashboard');
  if (config.get<boolean>('apiAutoStart', true)) {
    dashboardProvider.startApiServer();
  }

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agentDashboard.open';
  statusBarItem.text = '$(pulse) Agents';
  statusBarItem.tooltip = 'Open Agent Dashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {
  dashboardProvider?.dispose();
}

// ─── Webview HTML ────────────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getWebviewContent(webview: vscode.Webview): string {
  const nonce = getNonce();
  return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Agent Dashboard</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #0f1117);
    --surface: var(--vscode-sideBar-background, #1a1d27);
    --surface2: var(--vscode-input-background, #232736);
    --border: var(--vscode-panel-border, #2e3347);
    --text: var(--vscode-editor-foreground, #e4e6f0);
    --text-dim: var(--vscode-descriptionForeground, #8b8fa3);
    --accent: #6c5ce7;
    --accent-glow: rgba(108,92,231,0.15);
    --green: #00b894; --green-glow: rgba(0,184,148,0.15);
    --orange: #f39c12; --orange-glow: rgba(243,156,18,0.15);
    --red: #e74c3c; --red-glow: rgba(231,76,60,0.15);
    --blue: #0984e3; --blue-glow: rgba(9,132,227,0.15);
    --cyan: #00cec9;
    --yellow: #fdcb6e; --yellow-glow: rgba(253,203,110,0.15);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); background:var(--bg); color:var(--text); min-height:100vh; font-size:13px; }
  .dashboard { max-width:1400px; margin:0 auto; padding:20px; }

  .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
  .header-left { display:flex; align-items:center; gap:12px; }
  .logo { width:34px; height:34px; background:linear-gradient(135deg,var(--accent),var(--cyan)); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:17px; font-weight:700; color:#fff; }
  .header h1 { font-size:17px; font-weight:600; }
  .header h1 span { color:var(--text-dim); font-weight:400; font-size:11px; margin-left:6px; }
  .header-right { display:flex; align-items:center; gap:8px; }
  .live-badge { display:flex; align-items:center; gap:5px; background:var(--green-glow); border:1px solid rgba(0,184,148,0.3); color:var(--green); padding:3px 10px; border-radius:14px; font-size:10px; font-weight:600; }
  .live-dot { width:6px; height:6px; background:var(--green); border-radius:50%; animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  .btn { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border-radius:5px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:10px; cursor:pointer; font-weight:500; transition:all 0.15s; font-family:inherit; }
  .btn:hover { border-color:var(--accent); color:var(--text); }

  .stats-row { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:18px; }
  .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:9px; padding:12px; position:relative; overflow:hidden; }
  .stat-card::after { content:''; position:absolute; top:0; left:0; right:0; height:2px; }
  .stat-card:nth-child(1)::after { background:linear-gradient(90deg,var(--accent),transparent); }
  .stat-card:nth-child(2)::after { background:linear-gradient(90deg,var(--green),transparent); }
  .stat-card:nth-child(3)::after { background:linear-gradient(90deg,var(--blue),transparent); }
  .stat-card:nth-child(4)::after { background:linear-gradient(90deg,var(--orange),transparent); }
  .stat-card:nth-child(5)::after { background:linear-gradient(90deg,var(--cyan),transparent); }
  .stat-label { font-size:9px; text-transform:uppercase; letter-spacing:0.7px; color:var(--text-dim); margin-bottom:5px; }
  .stat-value { font-size:22px; font-weight:700; letter-spacing:-0.5px; }
  .stat-sub { font-size:9px; color:var(--text-dim); margin-top:2px; }

  .main-grid { display:grid; grid-template-columns:1fr 280px; gap:14px; }
  .section-header { font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-dim); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; }
  .agent-list { display:flex; flex-direction:column; gap:8px; }

  .agent-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; transition:border-color 0.15s; }
  .agent-card:hover { border-color:rgba(108,92,231,0.4); }
  .agent-card.expanded { border-color:var(--accent); }
  .agent-card.st-running { border-left:3px solid var(--green); }
  .agent-card.st-thinking { border-left:3px solid var(--orange); }
  .agent-card.st-paused { border-left:3px solid var(--yellow); }
  .agent-card.st-done { border-left:3px solid var(--blue); }
  .agent-card.st-error { border-left:3px solid var(--red); }
  .agent-card.st-queued { border-left:3px solid var(--text-dim); }
  .agent-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:8px; }
  .agent-info { flex:1; min-width:0; }
  .agent-name { font-weight:600; font-size:13px; margin-bottom:2px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .agent-task { font-size:11px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .agent-right { display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0; }
  .agent-toggle-btn { display:flex; align-items:center; gap:3px; padding:2px 7px; border-radius:4px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:9px; cursor:pointer; font-family:inherit; transition:all 0.15s; }
  .agent-toggle-btn:hover { border-color:var(--accent); color:var(--text); }
  .agent-toggle-btn .arrow { font-size:10px; transition:transform 0.2s; }
  .agent-card.expanded .agent-toggle-btn .arrow { transform:rotate(90deg); }
  .agent-details { display:none; margin-top:10px; border-top:1px solid var(--border); padding-top:10px; }
  .agent-card.expanded .agent-details { display:block; }

  /* Slide-out detail panel */
  .detail-overlay { display:none; position:fixed; top:0; right:0; bottom:0; left:0; z-index:99; }
  .detail-overlay.open { display:block; }
  .detail-panel { position:fixed; top:0; right:0; bottom:0; width:340px; background:var(--surface); border-left:1px solid var(--border); z-index:100; transform:translateX(100%); transition:transform 0.25s ease; overflow-y:auto; box-shadow:-4px 0 20px rgba(0,0,0,0.3); }
  .detail-panel.open { transform:translateX(0); }
  .detail-panel-header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface); z-index:1; }
  .detail-panel-header h3 { font-size:13px; font-weight:600; margin:0; }
  .detail-panel-close { padding:4px 8px; border-radius:4px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:14px; cursor:pointer; font-family:inherit; line-height:1; }
  .detail-panel-close:hover { border-color:var(--accent); color:var(--text); }
  .detail-panel-body { padding:14px 16px; }
  .detail-section { margin-bottom:14px; }
  .detail-section-title { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-dim); margin-bottom:8px; font-weight:600; }
  .panel-toggle-btn { display:inline-flex; align-items:center; gap:3px; padding:2px 7px; border-radius:4px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:9px; cursor:pointer; font-family:inherit; transition:all 0.15s; margin-top:4px; }
  .panel-toggle-btn:hover { border-color:var(--accent); color:var(--text); }
  .panel-toggle-btn .arrow { font-size:10px; }
  .task-list { list-style:none; padding:0; margin:0; }
  .task-item { display:flex; align-items:flex-start; gap:8px; padding:4px 0; font-size:11px; }
  .task-icon { flex-shrink:0; width:16px; height:16px; display:flex; align-items:center; justify-content:center; font-size:10px; }
  .task-icon.completed { color:var(--green); }
  .task-icon.in_progress { color:var(--orange); }
  .task-icon.pending { color:var(--text-dim); opacity:0.4; }
  .task-text { flex:1; color:var(--text); }
  .task-text.completed { text-decoration:line-through; opacity:0.6; }
  .task-text.in_progress { font-weight:600; }
  .detail-row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; }
  .detail-label { color:var(--text-dim); min-width:60px; }
  .detail-value { color:var(--text); }

  /* Activity Timeline */
  .action-timeline { display:flex; flex-direction:column; gap:1px; }
  .action-item { display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; font-size:10px; transition:background 0.1s; border-left:2px solid var(--border); }
  .action-item:hover { background:var(--surface2); }
  .action-icon { width:16px; text-align:center; font-size:11px; flex-shrink:0; }
  .action-body { flex:1; min-width:0; display:flex; gap:6px; align-items:baseline; }
  .action-tool { font-weight:600; font-size:9px; text-transform:uppercase; letter-spacing:0.3px; flex-shrink:0; }
  .action-detail { color:var(--text-dim); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .action-status { font-size:10px; flex-shrink:0; }
  .file-list { margin-top:6px; }
  .file-item { font-size:10px; color:var(--text-dim); padding:2px 0; display:flex; align-items:center; gap:4px; }
  .tag { font-size:8px; padding:2px 6px; border-radius:3px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; }
  .tag-copilot { background:var(--green-glow); color:var(--green); border:1px solid rgba(0,184,148,0.3); }
  .tag-claude { background:var(--accent-glow); color:var(--accent); border:1px solid rgba(108,92,231,0.3); }
  .tag-codex { background:var(--blue-glow); color:var(--blue); border:1px solid rgba(9,132,227,0.3); }
  .tag-custom { background:var(--surface2); color:var(--text-dim); border:1px solid var(--border); }
  .tag-local { background:var(--surface2); color:var(--text-dim); border:1px solid var(--border); }
  .tag-remote { background:var(--orange-glow); color:var(--orange); border:1px solid rgba(243,156,18,0.3); }
  .tag-cloud { background:var(--blue-glow); color:var(--cyan); border:1px solid rgba(0,206,201,0.3); }
  .sb { font-size:9px; padding:3px 8px; border-radius:4px; font-weight:600; }
  .sb-running { background:var(--green-glow); color:var(--green); }
  .sb-thinking { background:var(--orange-glow); color:var(--orange); }
  .sb-paused { background:var(--yellow-glow); color:var(--yellow); }
  .sb-done { background:var(--blue-glow); color:var(--blue); }
  .sb-error { background:var(--red-glow); color:var(--red); }
  .sb-queued { background:var(--surface2); color:var(--text-dim); }
  .agent-meta { display:flex; gap:12px; margin:6px 0; font-size:10px; color:var(--text-dim); flex-wrap:wrap; }
  /* Determinate progress bar (real percentage) */
  .progress-bar { width:100%; height:4px; background:var(--surface2); border-radius:2px; overflow:hidden; margin-top:8px; }
  .pf { height:100%; border-radius:2px; transition:width 0.6s; }
  .pf-green { background:linear-gradient(90deg,var(--green),var(--cyan)); }
  .pf-orange { background:linear-gradient(90deg,var(--orange),#e67e22); }
  .pf-blue { background:linear-gradient(90deg,var(--blue),var(--accent)); }
  .pf-yellow { background:var(--yellow); }
  .pf-gray { background:var(--text-dim); }
  .pf-red { background:var(--red); }

  /* Activity indicator (indeterminate — continuous gradient sweep) */
  .activity-indicator { width:100%; height:4px; border-radius:2px; overflow:hidden; margin-top:8px; background:linear-gradient(90deg, var(--surface2) 0%, var(--green) 20%, var(--cyan) 40%, var(--surface2) 60%); background-size:300% 100%; animation:sweep 3s linear infinite; }
  @keyframes sweep { 0%{background-position:100% 0} 100%{background-position:-100% 0} }

  .progress-label { display:flex; justify-content:space-between; font-size:9px; color:var(--text-dim); margin-top:3px; }

  .right-panel { display:flex; flex-direction:column; gap:14px; }
  .panel-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .panel-card.scrollable { max-height:350px; overflow-y:auto; }
  .panel-card::-webkit-scrollbar { width:3px; }
  .panel-card::-webkit-scrollbar-thumb { background:var(--border); border-radius:2px; }

  .act-item { display:flex; gap:8px; padding:6px 0; border-bottom:1px solid rgba(46,51,71,0.3); }
  .act-item:last-child { border-bottom:none; }
  .act-dot { width:6px; height:6px; border-radius:50%; margin-top:5px; flex-shrink:0; }
  .d-green { background:var(--green); } .d-orange { background:var(--orange); } .d-blue { background:var(--blue); }
  .d-accent { background:var(--accent); } .d-red { background:var(--red); } .d-gray { background:var(--text-dim); }
  .act-content { flex:1; min-width:0; }
  .act-agent { font-size:10px; font-weight:600; }
  .act-desc { font-size:10px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .act-time { font-size:8px; color:var(--text-dim); opacity:0.5; white-space:nowrap; }

  /* Data source health */
  .ds-list { display:flex; flex-direction:column; gap:6px; }
  .ds-item { display:flex; align-items:center; gap:8px; padding:5px 0; font-size:10px; cursor:pointer; border-radius:4px; padding:5px 4px; transition:background 0.15s; }
  .ds-item:hover { background:var(--surface2); }
  .ds-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .ds-connected { background:var(--green); box-shadow:0 0 4px rgba(0,184,148,0.4); }
  .ds-degraded { background:var(--orange); box-shadow:0 0 4px rgba(243,156,18,0.4); }
  .ds-unavailable { background:var(--text-dim); opacity:0.4; }
  .ds-checking { background:var(--blue); animation:pulse 1s infinite; }
  .ds-name { font-weight:500; color:var(--text); }
  .ds-msg { color:var(--text-dim); font-size:9px; margin-top:1px; line-height:1.3; }
  .ds-msg.warn { color:var(--orange); }
  .ds-count { margin-left:auto; font-size:9px; color:var(--text-dim); }

  .empty-state { text-align:center; padding:30px 16px; color:var(--text-dim); }
  .empty-state .icon { font-size:30px; margin-bottom:10px; opacity:0.3; }
  .empty-state p { font-size:12px; }
  .empty-state .hint { font-size:10px; opacity:0.6; margin-top:4px; }

  /* Search & Filter */
  .search-filter-bar { display:flex; gap:8px; margin-bottom:6px; align-items:center; flex-wrap:wrap; }
  .search-input { flex:1; min-width:140px; padding:6px 10px 6px 30px; border-radius:7px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-size:11px; font-family:inherit; outline:none; transition:border-color 0.15s; }
  .search-input:focus { border-color:var(--accent); }
  .search-wrap { position:relative; flex:1; min-width:140px; }
  .search-icon { position:absolute; left:9px; top:50%; transform:translateY(-50%); font-size:12px; color:var(--text-dim); pointer-events:none; }
  .filter-chips { display:flex; gap:4px; flex-wrap:wrap; }
  .filter-chip { padding:3px 9px; border-radius:12px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:9px; cursor:pointer; font-weight:500; transition:all 0.15s; font-family:inherit; white-space:nowrap; }
  .filter-chip:hover { border-color:var(--accent); color:var(--text); }
  .filter-chip.active { background:var(--accent-glow); border-color:var(--accent); color:var(--accent); font-weight:600; }
  .filter-chip .chip-count { display:inline-block; margin-left:3px; padding:0 5px; background:rgba(255,255,255,0.08); border-radius:8px; font-size:8px; }
  .filter-chip.active .chip-count { background:rgba(108,92,231,0.25); }
  .provider-filter-bar { display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap; align-items:center; }
  .provider-filter-label { font-size:9px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.4px; margin-right:2px; }
  .provider-chip { padding:2px 8px; border-radius:10px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:8px; cursor:pointer; font-weight:500; transition:all 0.15s; font-family:inherit; white-space:nowrap; }
  .provider-chip:hover { border-color:var(--accent); color:var(--text); }
  .provider-chip.active { background:var(--cyan); background:rgba(0,206,201,0.12); border-color:var(--cyan); color:var(--cyan); font-weight:600; }

  @media (max-width:900px) { .main-grid { grid-template-columns:1fr; } .stats-row { grid-template-columns:repeat(3,1fr); } }
</style>
</head>
<body>
<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <div class="logo">A</div>
      <h1>Agent Dashboard <span>v0.9.1</span></h1>
    </div>
    <div class="header-right">
      <div class="live-badge"><div class="live-dot"></div> <span id="live-time">Live</span></div>
      <select id="source-select" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:10px;font-family:inherit;cursor:pointer;">
        <option value="copilot">Copilot</option>
        <option value="claude-code">Claude Code</option>
        <option value="both">Both</option>
      </select>
      <button class="btn" id="btn-refresh">&#8635; Refresh</button>
      <button class="btn" id="btn-log">&#128196; Log</button>
    </div>
  </div>
  <div class="stats-row" id="stats"></div>
  <div class="main-grid">
    <div>
      <div class="section-header">Agent Sessions <span id="agent-count"></span></div>
      <div class="search-filter-bar">
        <div class="search-wrap">
          <span class="search-icon">&#128269;</span>
          <input class="search-input" id="search-input" type="text" placeholder="Search agents by name, task, model...">
        </div>
        <div class="filter-chips" id="filter-chips"></div>
      </div>
      <div class="provider-filter-bar" id="provider-filter-bar"></div>
      <div class="agent-list" id="agents"></div>
    </div>
    <div class="right-panel">
      <div class="panel-card scrollable">
        <div class="section-header">Activity Feed</div>
        <div id="activity"></div>
      </div>
      <div class="panel-card">
        <div class="section-header">Data Sources</div>
        <div class="ds-list" id="datasources"></div>
      </div>
    </div>
  </div>
</div>
<div class="detail-overlay" id="detail-overlay"></div>
<div class="detail-panel" id="detail-panel">
  <div class="detail-panel-header">
    <h3 id="detail-panel-title">Agent Details</h3>
    <button class="detail-panel-close" id="detail-panel-close">&#10005;</button>
  </div>
  <div class="detail-panel-body" id="detail-panel-body"></div>
</div>
<script nonce="${nonce}">
(function() {
  // Global error handler — display errors visibly in the webview
  window.onerror = function(msg, url, line, col, err) {
    document.body.innerHTML = '<div style="padding:30px;color:#e74c3c;font-family:monospace;"><h2 style="color:#e74c3c;">Agent Dashboard Error</h2><p>'+msg+'</p><p>Line: '+line+', Col: '+col+'</p><pre style="background:#1a1d27;padding:12px;border-radius:6px;overflow:auto;color:#e4e6f0;font-size:11px;">'+(err&&err.stack?err.stack:'No stack trace')+'</pre><p style="color:#8b8fa3;font-size:11px;">Please check Developer Tools (Ctrl+Shift+I) for more details.</p></div>';
  };
  var vscode = acquireVsCodeApi();
  function send(cmd, data) { vscode.postMessage(Object.assign({ command: cmd }, data || {})); }
  function fmt(n) { return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n); }
  function sc(s) { return {running:'green',thinking:'orange',paused:'yellow',done:'blue',error:'red',queued:'gray'}[s]||'gray'; }
  function dc(t) { return {tool_use:'d-green',file_edit:'d-accent',command:'d-blue',thinking:'d-orange',complete:'d-blue',error:'d-red',start:'d-gray',info:'d-gray'}[t]||'d-gray'; }

  var lastUpdate = null;
  var currentState = null;
  var activeStatusFilter = null;
  var activeProviderFilter = null;

  // ── Event listeners for static elements (replacing inline handlers) ──
  document.getElementById('btn-refresh').addEventListener('click', function() { send('refresh'); });
  document.getElementById('btn-log').addEventListener('click', function() { send('openLog'); });
  document.getElementById('source-select').addEventListener('change', function() { send('switchSource', { source: this.value }); });
  document.getElementById('search-input').addEventListener('input', function() { applyFilter(); });

  // ── Event delegation for dynamic elements (filter chips & agent cards) ──
  document.getElementById('filter-chips').addEventListener('click', function(e) {
    var btn = e.target.closest('.filter-chip');
    if (!btn) return;
    var status = btn.getAttribute('data-status') || null;
    activeStatusFilter = (status === activeStatusFilter) ? null : status;
    applyFilter();
  });
  // Provider filter chips (event delegation)
  document.getElementById('provider-filter-bar').addEventListener('click', function(e) {
    var btn = e.target.closest('.provider-chip');
    if (!btn) return;
    var provider = btn.getAttribute('data-provider') || null;
    activeProviderFilter = (provider === activeProviderFilter) ? null : provider;
    applyFilter();
  });

  // Expand/collapse inline details
  document.getElementById('agents').addEventListener('click', function(e) {
    // Toggle expand on the expand button only
    var expandBtn = e.target.closest('.agent-toggle-btn');
    if (expandBtn) {
      var card = expandBtn.closest('.agent-card');
      if (card) card.classList.toggle('expanded');
      return;
    }
    // Open slide-out panel on the panel toggle button
    var panelBtn = e.target.closest('.panel-toggle-btn');
    if (panelBtn) {
      var agentId = panelBtn.getAttribute('data-agent-id');
      if (agentId) openDetailPanel(agentId);
      return;
    }
  });

  // Data source click → filter by that provider
  document.getElementById('datasources').addEventListener('click', function(e) {
    var item = e.target.closest('.ds-item');
    if (!item) return;
    var providerId = item.getAttribute('data-provider-id');
    if (!providerId) return;
    activeProviderFilter = (providerId === activeProviderFilter) ? null : providerId;
    applyFilter();
  });

  // Close detail panel
  document.getElementById('detail-panel-close').addEventListener('click', function() { closeDetailPanel(); });
  document.getElementById('detail-overlay').addEventListener('click', function() { closeDetailPanel(); });

  // Parent link click in detail panel
  document.getElementById('detail-panel-body').addEventListener('click', function(e) {
    var parentLink = e.target.closest('.parent-link');
    if (parentLink) {
      var parentId = parentLink.getAttribute('data-parent-id');
      if (parentId) openDetailPanel(parentId);
    }
  });

  var activePanelAgentId = null;

  function openDetailPanel(agentId) {
    if (!currentState) return;
    var agents = currentState.agents || [];
    var agent = null;
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].id === agentId) { agent = agents[i]; break; }
    }
    if (!agent) return;
    activePanelAgentId = agentId;

    document.getElementById('detail-panel-title').textContent = agent.name;
    var body = document.getElementById('detail-panel-body');
    var html = '';

    // Status & meta
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Status</div>';
    html += '<div style="margin-bottom:6px;"><span class="sb sb-'+agent.status+'">'+agent.status.charAt(0).toUpperCase()+agent.status.slice(1)+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Task</span><span class="detail-value" style="white-space:normal;">'+agent.task+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">'+agent.model+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">'+agent.sourceProvider+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Elapsed</span><span class="detail-value">'+agent.elapsed+'</span></div>';
    var loc = agent.remoteHost || (agent.location.charAt(0).toUpperCase()+agent.location.slice(1));
    html += '<div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">'+loc+'</span></div>';
    if (agent.pid) html += '<div class="detail-row"><span class="detail-label">PID</span><span class="detail-value">'+agent.pid+'</span></div>';
    if (agent.activeTool) html += '<div class="detail-row"><span class="detail-label">Active Tool</span><span class="detail-value">'+agent.activeTool+'</span></div>';
    if (agent.tokens) html += '<div class="detail-row"><span class="detail-label">Tokens</span><span class="detail-value">'+fmt(agent.tokens)+'</span></div>';
    html += '</div>';

    // Tasks / Todos
    var tasks = agent.tasks || [];
    if (tasks.length > 0) {
      var completed = 0;
      for (var ti = 0; ti < tasks.length; ti++) { if (tasks[ti].status === 'completed') completed++; }
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Tasks &amp; Todos ('+completed+'/'+tasks.length+' done)</div>';
      html += '<ul class="task-list">';
      var taskIcons = { completed:'&#10003;', in_progress:'&#9654;', pending:'&#9675;' };
      for (var tj = 0; tj < tasks.length; tj++) {
        var t = tasks[tj];
        var icon = taskIcons[t.status] || '&#9675;';
        html += '<li class="task-item"><span class="task-icon '+t.status+'">'+icon+'</span><span class="task-text '+t.status+'">'+(t.activeForm || t.content)+'</span></li>';
      }
      html += '</ul>';
      html += '</div>';
    }

    // Files
    if (agent.files && agent.files.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Files ('+agent.files.length+')</div>';
      for (var fi = 0; fi < agent.files.length; fi++) {
        html += '<div class="file-item">&#128196; '+agent.files[fi]+'</div>';
      }
      html += '</div>';
    }

    // Tools
    if (agent.tools && agent.tools.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Tools</div>';
      html += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
      for (var tl = 0; tl < agent.tools.length; tl++) {
        html += '<span style="font-size:9px;padding:2px 6px;background:var(--surface2);border-radius:3px;color:var(--text-dim);">'+agent.tools[tl]+'</span>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Activity Timeline (recentActions)
    var actions = agent.recentActions || [];
    if (actions.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Activity Timeline ('+actions.length+')</div>';
      html += '<div class="action-timeline">';
      // Show most recent first
      var showActions = actions.slice().reverse().slice(0, 20);
      var toolIcons = { Read:'&#128196;', Edit:'&#9998;', Write:'&#128221;', Bash:'&#9881;', Search:'&#128269;', Subagent:'&#9654;', List:'&#128194;' };
      var toolColors = { Read:'var(--blue)', Edit:'var(--orange)', Write:'var(--green)', Bash:'var(--cyan)', Search:'var(--accent)', Subagent:'var(--yellow)', List:'var(--text-dim)' };
      for (var ai = 0; ai < showActions.length; ai++) {
        var act = showActions[ai];
        var tIcon = toolIcons[act.tool] || '&#9679;';
        var tColor = toolColors[act.tool] || 'var(--text-dim)';
        var statusIcon = act.status === 'done' ? '&#10003;' : act.status === 'error' ? '&#10007;' : '&#8987;';
        var statusColor = act.status === 'done' ? 'var(--green)' : act.status === 'error' ? 'var(--red)' : 'var(--orange)';
        html += '<div class="action-item">';
        html += '<div class="action-icon" style="color:'+tColor+'">'+tIcon+'</div>';
        html += '<div class="action-body">';
        html += '<span class="action-tool" style="color:'+tColor+'">'+act.tool+'</span>';
        html += '<span class="action-detail">'+act.detail+'</span>';
        html += '</div>';
        html += '<div class="action-status" style="color:'+statusColor+'">'+statusIcon+'</div>';
        html += '</div>';
      }
      if (actions.length > 20) {
        html += '<div style="text-align:center;font-size:9px;color:var(--text-dim);padding:4px 0;">+ '+(actions.length - 20)+' earlier actions</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Conversation Preview (human-readable chat content)
    var convo = agent.conversationPreview || [];
    if (convo.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Conversation Preview ('+convo.length+' entries)</div>';
      html += '<div style="display:flex;flex-direction:column;gap:3px;">';
      for (var ci = 0; ci < convo.length; ci++) {
        var line = convo[ci];
        var bgColor = 'transparent';
        var borderColor = 'var(--border)';
        if (line.indexOf('\uD83D\uDC64') === 0) { bgColor = 'rgba(108,92,231,0.06)'; borderColor = 'var(--accent)'; }
        else if (line.indexOf('\uD83E\uDD16') === 0) { bgColor = 'rgba(0,184,148,0.06)'; borderColor = 'var(--green)'; }
        else if (line.indexOf('\uD83D\uDD27') === 0) { bgColor = 'rgba(0,206,201,0.06)'; borderColor = 'var(--cyan)'; }
        else if (line.indexOf('\u23F3') === 0) { bgColor = 'rgba(243,156,18,0.06)'; borderColor = 'var(--orange)'; }
        html += '<div style="font-size:10px;padding:4px 6px;background:'+bgColor+';border-left:2px solid '+borderColor+';border-radius:2px;word-break:break-word;line-height:1.4;color:var(--text);">'+line+'</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Parent/subagent relationship
    if (agent.parentId) {
      html += '<div class="detail-section">';
      html += '<div class="detail-row"><span class="detail-label">Parent</span><span class="detail-value parent-link" style="color:var(--accent);cursor:pointer;" data-parent-id="'+agent.parentId+'">&#8593; View parent agent</span></div>';
      html += '</div>';
    }

    body.innerHTML = html;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-overlay').classList.add('open');
  }

  function closeDetailPanel() {
    activePanelAgentId = null;
    document.getElementById('detail-panel').classList.remove('open');
    document.getElementById('detail-overlay').classList.remove('open');
  }

  function applyFilter() {
    if (currentState) renderAgents(currentState.agents || []);
  }

  function renderFilterChips(agents) {
    // Status filter chips
    var counts = {};
    for (var i = 0; i < agents.length; i++) counts[agents[i].status] = (counts[agents[i].status]||0) + 1;
    var statuses = ['running','thinking','paused','done','error','queued'];
    var labels = {running:'Running',thinking:'Thinking',paused:'Paused',done:'Done',error:'Error',queued:'Queued'};
    var html = '<button class="filter-chip'+(activeStatusFilter===null?' active':'')+'" data-status="">All <span class="chip-count">'+agents.length+'</span></button>';
    for (var j = 0; j < statuses.length; j++) {
      var s = statuses[j];
      if (counts[s]) {
        html += '<button class="filter-chip'+(activeStatusFilter===s?' active':'')+'" data-status="'+s+'">'+labels[s]+' <span class="chip-count">'+counts[s]+'</span></button>';
      }
    }
    document.getElementById('filter-chips').innerHTML = html;

    // Provider / source filter chips
    var provCounts = {};
    var provNames = {};
    for (var pi = 0; pi < agents.length; pi++) {
      var sp = agents[pi].sourceProvider;
      provCounts[sp] = (provCounts[sp]||0) + 1;
      // Friendly short names
      if (!provNames[sp]) {
        var nameMap = {
          'copilot-extension': 'Copilot',
          'vscode-chat-sessions': 'Chat Sessions',
          'chat-tools-participants': 'Chat Agents',
          'custom-workspace-agents': 'Custom Agents',
          'terminal-processes': 'Terminals',
          'claude-desktop-todos': 'Claude Desktop',
          'github-actions': 'GitHub Actions',
          'remote-connections': 'Remote',
          'workspace-activity': 'Workspace'
        };
        provNames[sp] = nameMap[sp] || sp;
      }
    }
    var provKeys = Object.keys(provCounts).sort(function(a, b) { return provCounts[b] - provCounts[a]; });

    // Only show provider filter if there are 2+ providers with agents
    var provBar = document.getElementById('provider-filter-bar');
    if (provKeys.length >= 2) {
      var phtml = '<span class="provider-filter-label">Source:</span>';
      phtml += '<button class="provider-chip'+(activeProviderFilter===null?' active':'')+'" data-provider="">All</button>';
      for (var pk = 0; pk < provKeys.length; pk++) {
        var key = provKeys[pk];
        phtml += '<button class="provider-chip'+(activeProviderFilter===key?' active':'')+'" data-provider="'+key+'">'+provNames[key]+' ('+provCounts[key]+')</button>';
      }
      provBar.innerHTML = phtml;
      provBar.style.display = '';
    } else {
      provBar.innerHTML = '';
      provBar.style.display = 'none';
    }
  }

  function renderAgents(agents) {
    var searchEl = document.getElementById('search-input');
    var searchTerm = (searchEl.value || '').toLowerCase().trim();
    renderFilterChips(agents);

    var filtered = agents;
    if (activeProviderFilter) filtered = filtered.filter(function(a) { return a.sourceProvider === activeProviderFilter; });
    if (activeStatusFilter) filtered = filtered.filter(function(a) { return a.status === activeStatusFilter; });
    if (searchTerm) filtered = filtered.filter(function(a) {
      return a.name.toLowerCase().indexOf(searchTerm) !== -1 ||
        a.task.toLowerCase().indexOf(searchTerm) !== -1 ||
        a.model.toLowerCase().indexOf(searchTerm) !== -1 ||
        a.typeLabel.toLowerCase().indexOf(searchTerm) !== -1 ||
        a.sourceProvider.toLowerCase().indexOf(searchTerm) !== -1 ||
        (a.tasks||[]).some(function(t) { return (t.content||'').toLowerCase().indexOf(searchTerm) !== -1 || (t.activeForm||'').toLowerCase().indexOf(searchTerm) !== -1; });
    });

    document.getElementById('agent-count').textContent = filtered.length !== agents.length
      ? filtered.length+' of '+agents.length
      : (agents.length ? agents.length+' total' : '');

    var el = document.getElementById('agents');
    if (!filtered.length) {
      el.innerHTML = agents.length
        ? '<div class="empty-state"><div class="icon">&#128269;</div><p>No agents match your filter</p><div class="hint">Try a different search term or clear the filter</div></div>'
        : '<div class="empty-state"><div class="icon">&#9881;</div><p>No agent sessions detected</p><div class="hint">Check Data Sources below for connection status</div></div>';
      return;
    }

    el.innerHTML = filtered.map(function(a) {
      var color = sc(a.status);
      var active = a.status==='running'||a.status==='thinking';
      var loc = a.remoteHost || (a.location.charAt(0).toUpperCase()+a.location.slice(1));
      var tasks = a.tasks || [];
      var hasTasks = tasks.length > 0;
      var taskIcons = { completed:'&#10003;', in_progress:'&#9654;', pending:'&#9675;' };

      var detailsHtml = '<div class="agent-details">';
      detailsHtml += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">'+a.model+'</span></div>';
      detailsHtml += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">'+a.sourceProvider+'</span></div>';
      detailsHtml += '<div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">'+loc+'</span></div>';
      if (a.pid) detailsHtml += '<div class="detail-row"><span class="detail-label">PID</span><span class="detail-value">'+a.pid+'</span></div>';
      if (a.activeTool) detailsHtml += '<div class="detail-row"><span class="detail-label">Active</span><span class="detail-value">'+a.activeTool+'</span></div>';

      if (hasTasks) {
        var completed = tasks.filter(function(t) { return t.status==='completed'; }).length;
        detailsHtml += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);margin-bottom:4px;">Tasks ('+completed+'/'+tasks.length+' done)</div>';
        detailsHtml += '<ul class="task-list">';
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti];
          var icon = taskIcons[t.status] || '&#9675;';
          detailsHtml += '<li class="task-item"><span class="task-icon '+t.status+'">'+icon+'</span><span class="task-text '+t.status+'">'+(t.activeForm || t.content)+'</span></li>';
        }
        detailsHtml += '</ul>';
      }

      if (a.files && a.files.length > 0) {
        detailsHtml += '<div class="file-list"><div style="font-size:10px;color:var(--text-dim);margin:6px 0 4px;">Files ('+a.files.length+')</div>';
        var showFiles = a.files.slice(0,8);
        for (var fi = 0; fi < showFiles.length; fi++) {
          detailsHtml += '<div class="file-item">&#128196; '+showFiles[fi]+'</div>';
        }
        if (a.files.length > 8) detailsHtml += '<div class="file-item" style="opacity:0.5">+ '+(a.files.length-8)+' more</div>';
        detailsHtml += '</div>';
      }

      if (a.tools && a.tools.length > 0) {
        detailsHtml += '<div style="margin-top:6px;font-size:10px;color:var(--text-dim);margin-bottom:4px;">Tools</div>';
        detailsHtml += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
        for (var tl = 0; tl < a.tools.length; tl++) {
          detailsHtml += '<span style="font-size:9px;padding:2px 6px;background:var(--surface2);border-radius:3px;color:var(--text-dim);">'+a.tools[tl]+'</span>';
        }
        detailsHtml += '</div>';
      }

      // Compact recent actions in inline view
      var inlineActions = a.recentActions || [];
      if (inlineActions.length > 0) {
        var recent5 = inlineActions.slice(-5).reverse();
        detailsHtml += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);margin-bottom:4px;">Recent Activity</div>';
        var tIcons = { Read:'&#128196;', Edit:'&#9998;', Write:'&#128221;', Bash:'&#9881;', Search:'&#128269;', Subagent:'&#9654;' };
        for (var ra = 0; ra < recent5.length; ra++) {
          var ract = recent5[ra];
          detailsHtml += '<div style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:9px;"><span>'+(tIcons[ract.tool]||'&#9679;')+'</span><span style="font-weight:600;opacity:0.7;">'+ract.tool+'</span><span style="color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+ract.detail+'</span></div>';
        }
        if (inlineActions.length > 5) {
          detailsHtml += '<div style="font-size:8px;color:var(--text-dim);opacity:0.6;padding-top:2px;">+ '+(inlineActions.length - 5)+' more — open Details for full timeline</div>';
        }
      }

      detailsHtml += '</div>';

      return '<div class="agent-card st-'+a.status+'">'+
        '<div class="agent-top">'+
          '<div class="agent-info">'+
            '<div class="agent-name">'+a.name+' <span class="tag tag-'+a.type+'">'+a.typeLabel+'</span> <span class="tag tag-'+a.location+'">'+loc+'</span></div>'+
            '<div class="agent-task">'+a.task+'</div>'+
          '</div>'+
          '<div class="agent-right">'+
            '<span class="sb sb-'+a.status+'">'+a.status.charAt(0).toUpperCase()+a.status.slice(1)+'</span>'+
            '<button class="panel-toggle-btn" data-agent-id="'+a.id+'"><span class="arrow">&#9656;</span> Details</button>'+
          '</div>'+
        '</div>'+
        '<div class="agent-meta">'+
          '<span>'+a.model+'</span>'+
          '<span>'+a.elapsed+'</span>'+
          (a.tokens?'<span>'+fmt(a.tokens)+' tokens</span>':'')+
          (hasTasks?'<span>'+tasks.filter(function(t) { return t.status==='completed'; }).length+'/'+tasks.length+' tasks</span>':'')+
          '<span style="opacity:0.5">via '+a.sourceProvider+'</span>'+
        '</div>'+
        (a.progress > 0
          ? '<div class="progress-bar"><div class="pf pf-'+color+'" style="width:'+a.progress+'%"></div></div><div class="progress-label"><span>'+a.progressLabel+'</span><span>'+a.progress+'%</span></div>'
          : active
            ? '<div class="activity-indicator"></div><div class="progress-label"><span>'+a.progressLabel+'</span><span>'+a.elapsed+'</span></div>'
            : ''
        )+
        '<div style="margin-top:6px;"><button class="agent-toggle-btn"><span class="arrow">&#9662;</span> '+(hasTasks ? tasks.filter(function(t){return t.status==="completed";}).length+'/'+tasks.length+' tasks' : 'More info')+'</button></div>'+
        detailsHtml+
      '</div>';
    }).join('');
  }

  function render(state) {
    try {
    currentState = state;
    var agents = state.agents || [];
    var activities = state.activities || [];
    var stats = state.stats || {};
    var health = state.dataSourceHealth || [];

    lastUpdate = new Date();
    var lt = document.getElementById('live-time');
    if (lt) lt.textContent = 'Updated ' + lastUpdate.toLocaleTimeString();

    document.getElementById('stats').innerHTML =
      '<div class="stat-card"><div class="stat-label">Total Agents</div><div class="stat-value">'+stats.total+'</div><div class="stat-sub">across '+health.filter(function(h) { return h.state==='connected'; }).length+' sources</div></div>'+
      '<div class="stat-card"><div class="stat-label">Active Now</div><div class="stat-value" style="color:var(--green)">'+stats.active+'</div><div class="stat-sub">running + thinking</div></div>'+
      '<div class="stat-card"><div class="stat-label">Completed</div><div class="stat-value" style="color:var(--blue)">'+stats.completed+'</div><div class="stat-sub">this session</div></div>'+
      '<div class="stat-card"><div class="stat-label">Tokens</div><div class="stat-value">'+fmt(stats.tokens)+'</div><div class="stat-sub">~$'+(stats.estimatedCost||0).toFixed(2)+'</div></div>'+
      '<div class="stat-card"><div class="stat-label">Data Sources</div><div class="stat-value" style="color:var(--cyan)">'+health.filter(function(h) { return h.state==='connected'; }).length+'/'+health.length+'</div><div class="stat-sub">connected</div></div>';

    renderAgents(agents);

    var actEl = document.getElementById('activity');
    if (!activities.length) {
      actEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:10px;">Waiting for activity...</div>';
    } else {
      actEl.innerHTML = activities.slice(0,20).map(function(a) {
        return '<div class="act-item"><div class="act-dot '+dc(a.type)+'"></div><div class="act-content"><div class="act-agent">'+a.agent+'</div><div class="act-desc">'+a.desc+'</div></div><div class="act-time">'+a.timeLabel+'</div></div>';
      }).join('');
    }

    var sel = document.getElementById('source-select');
    if (sel && state.primarySource) sel.value = state.primarySource;

    document.getElementById('datasources').innerHTML = health.map(function(h) {
      var isWarn = h.state === 'degraded';
      var isSelected = activeProviderFilter === h.id;
      return '<div class="ds-item" data-provider-id="'+h.id+'" style="'+(isSelected?'background:var(--accent-glow);border:1px solid rgba(108,92,231,0.3);':'')+'">'+
        '<div class="ds-dot ds-'+h.state+'"></div>'+
        '<div style="flex:1;min-width:0">'+
          '<div class="ds-name" style="'+(isSelected?'color:var(--accent);':'')+'">'+h.name+'</div>'+
          '<div class="ds-msg'+(isWarn?' warn':'')+'">'+h.message+'</div>'+
        '</div>'+
        (h.agentCount?'<div class="ds-count">'+h.agentCount+'</div>':'')+
      '</div>';
    }).join('');
    } catch (err) {
      document.getElementById('agents').innerHTML = '<div class="empty-state"><div class="icon" style="color:var(--red);">&#9888;</div><p>Render error: '+(err.message||err)+'</p><div class="hint" style="word-break:break-all;font-size:9px;">'+(err.stack||'')+'</div></div>';
    }
  }

  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'update') {
      try {
        render(e.data.state);
      } catch (err) {
        document.getElementById('agents').innerHTML = '<div class="empty-state"><div class="icon" style="color:var(--red);">&#9888;</div><p>Render error: '+err.message+'</p><div class="hint">'+err.stack+'</div></div>';
      }
    }
  });

  // Initial render with empty state
  render({ agents:[], activities:[], stats:{total:0,active:0,completed:0,tokens:0,estimatedCost:0,avgDuration:'---'}, dataSourceHealth:[] });
  document.getElementById('agents').innerHTML = '<div class="empty-state"><div class="icon">&#9203;</div><p>Waiting for data from providers...</p><div class="hint">Requesting data...</div></div>';
  send('refresh');
  // Mark that the script loaded successfully
  var dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;bottom:4px;left:4px;font-size:8px;color:rgba(139,143,163,0.3);pointer-events:none;z-index:999;';
  dbg.textContent = 'v0.9.1 loaded';
  document.body.appendChild(dbg);
})();
</script>
</body>
</html>`;
}
