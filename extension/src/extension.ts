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

interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;       // Full message text — no truncation
  timestamp?: number;
  toolCalls?: { name: string; detail: string; result?: string; isError?: boolean }[];
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
  hasConversationHistory?: boolean; // True if full conversation history can be loaded on demand
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
  protected _agentFilePaths: Map<string, string> = new Map();

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
  get agentFilePaths(): Map<string, string> { return this._agentFilePaths; }

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

  /**
   * Load full conversation history for an agent.
   * Override in providers that support conversation history (Copilot Chat, Claude Code).
   */
  async getConversationHistory(_agentId: string): Promise<ConversationTurn[]> {
    return [];
  }

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
      // Enrich with workspace and MCP tool info so the detail pane isn't empty
      const wsInfo: string[] = [];
      const detectedTools: string[] = [];
      const conversationHints: string[] = [];

      // Gather workspace info
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        for (const wf of workspaceFolders) {
          wsInfo.push(path.basename(wf.uri.fsPath));
        }
        conversationHints.push('📂 Workspace: ' + wsInfo.join(', '));
      }

      // Gather configured MCP servers
      const chatConfig = vscode.workspace.getConfiguration('chat');
      const mcpCfg = chatConfig.get<any>('mcp');
      if (mcpCfg && typeof mcpCfg === 'object') {
        const servers = mcpCfg.servers || mcpCfg;
        const serverNames = Object.keys(servers).filter(k => k !== 'servers');
        for (const sn of serverNames) {
          const server = servers[sn];
          if (server?.disabled !== true) {
            detectedTools.push(`MCP:${sn}`);
            conversationHints.push(`🔌 MCP Server: ${sn}`);
          }
        }
      }

      // Check for agent mode
      const agentEnabled = chatConfig.get<boolean>('agent.enabled');
      if (agentEnabled) {
        conversationHints.push('🤖 Agent Mode: enabled');
      }

      // Detect chat participants
      try {
        const allExtensions = vscode.extensions.all;
        const chatExts = allExtensions.filter(ext =>
          ext.packageJSON?.contributes?.chatParticipants?.length > 0
        );
        for (const ext of chatExts) {
          const participants = ext.packageJSON.contributes.chatParticipants;
          for (const p of participants) {
            if (p.name && p.name !== 'copilot') {
              detectedTools.push(`@${p.name}`);
              conversationHints.push(`💬 Participant: @${p.name} — ${p.description || ''}`);
            }
          }
        }
      } catch { /* skip participant detection */ }

      // Copilot extension version
      const copilotVersion = copilotChat?.packageJSON?.version || copilot?.packageJSON?.version;
      if (copilotVersion) {
        conversationHints.push(`📦 Copilot version: ${copilotVersion}`);
      }

      conversationHints.push('ℹ️ Detailed conversation data available for completed chat sessions (saved to disk)');

      this._agents.push({
        id: 'copilot-active',
        name: 'GitHub Copilot Chat',
        type: 'copilot',
        typeLabel: 'Copilot',
        model: '—',
        status: 'running',
        task: 'Copilot Chat is active' + (wsInfo.length > 0 ? ` in ${wsInfo[0]}` : ''),
        tokens: 0,
        startTime: Date.now(),
        elapsed: '—',
        progress: 0,
        progressLabel: detectedTools.length > 0 ? `${detectedTools.length} tools` : 'Active',
        tools: detectedTools,
        activeTool: null,
        files: [],
        location: 'local',
        sourceProvider: this.id,
        conversationPreview: conversationHints,
        hasConversationHistory: conversationHints.length > 0  // Enable chat button when we have context to show
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
    const ACTIVE_MS = 5 * 60 * 1000;       // 5 min → considered "running"
    const MAX_PARSE = 15;                    // Parse up to 15 most recent files per poll
    let parsed = 0;
    let errors = 0;

    // Sort all session files by modification time (most recent first)
    const filesWithStats: { path: string; mtime: number; size: number }[] = [];
    for (const filePath of sessionFiles) {
      try {
        const stat = fs.statSync(filePath);
        filesWithStats.push({ path: filePath, mtime: stat.mtimeMs, size: stat.size });
      } catch { /* skip */ }
    }
    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    // ALWAYS store file paths for ALL session files (enables on-demand conversation loading)
    // This is critical — even old files have browsable conversation history
    for (const f of filesWithStats) {
      const sessionId = path.basename(f.path, '.json');
      const agentId = `copilot-session-${sessionId.substring(0, 12)}`;
      this._agentFilePaths.set(agentId, f.path);
    }
    this._outputChannel.appendLine(`[${this.id}] Stored ${filesWithStats.length} file path(s) for conversation history`);

    // Parse the most recent files for agent cards and activity data
    for (const f of filesWithStats.slice(0, MAX_PARSE)) {
      try {
        if (f.size > 5 * 1024 * 1024) {
          this._outputChannel.appendLine(`[${this.id}] Skipping large file (${(f.size/1024/1024).toFixed(1)}MB): ${f.path}`);
          continue;
        }

        const raw = fs.readFileSync(f.path, 'utf-8');
        const data = JSON.parse(raw);
        this.parseSessionData(data, f.path, f.mtime);
        parsed++;
      } catch (err: any) {
        errors++;
        this._outputChannel.appendLine(`[${this.id}] Error parsing ${f.path}: ${err?.message}`);
      }
    }

    this._outputChannel.appendLine(`[${this.id}] Results: ${parsed} parsed, ${errors} errors → ${this._agents.length} agents (${filesWithStats.length} total files on disk)`);

    this._state = 'connected';
    if (this._agents.length > 0) {
      this._message = `${this._agents.length} session(s) from ${parsed} files (${filesWithStats.length} total on disk)`;
    } else if (filesWithStats.length > 0) {
      this._message = `${filesWithStats.length} session files on disk — conversation history available via Chat button`;
    } else {
      this._message = `No session files found.`;
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

  /**
   * Build a concise task summary from the first few user messages.
   * If the first message is too short/vague, incorporate subsequent messages.
   */
  private summarizeConversation(userMessages: string[], title?: string): string {
    if (userMessages.length === 0) return title || '';

    const first = userMessages[0].trim();

    // If the first message is descriptive enough (>30 chars), use it directly
    if (first.length > 30) {
      return first.substring(0, 200);
    }

    // First message is short/vague — combine the first few for more context
    const combined: string[] = [first];
    let totalLen = first.length;
    for (let i = 1; i < userMessages.length && i < 3; i++) {
      const msg = userMessages[i].trim();
      if (msg.length > 0 && totalLen + msg.length < 200) {
        combined.push(msg);
        totalLen += msg.length;
      }
      // Stop once we have enough context
      if (totalLen > 80) break;
    }

    return combined.join(' → ').substring(0, 200);
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
    let firstUserMessage = '';
    const userMessages: string[] = [];
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
          if (!firstUserMessage) {
            firstUserMessage = prompt.substring(0, 300);
          }
          if (userMessages.length < 5) {
            userMessages.push(prompt.substring(0, 300));
          }
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
    const agentId = `copilot-session-${sessionId.substring(0, 12)}`;

    // Store file path mapping for on-demand conversation loading
    this._agentFilePaths.set(agentId, filePath);

    // Normalize name: strip GUID suffixes from titles like "Copilot Chat 832ec648"
    let sessionName = data.title || 'Copilot Chat';
    if (/^Copilot Chat\b/i.test(sessionName)) {
      sessionName = 'Copilot Chat';
    }

    this._agents.push({
      id: agentId,
      name: sessionName,
      type: 'copilot',
      typeLabel: subagents.length > 0 ? 'Agent Swarm' : 'Copilot Chat',
      model: data.model || '—',
      status: isActive ? 'running' : 'done',
      task: this.summarizeConversation(userMessages, data.title) || 'Chat session',
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
      recentActions: recentActions.slice(-30),
      conversationPreview: conversationSnippets.slice(-15),
      hasConversationHistory: true,
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

  /**
   * Load FULL conversation history from a Copilot Chat session file.
   * Called on-demand when the user clicks "Chat" on an agent card.
   */
  async getConversationHistory(agentId: string): Promise<ConversationTurn[]> {
    const filePath = this._agentFilePaths.get(agentId);
    if (!filePath) {
      this._outputChannel.appendLine(`[${this.id}] No file path for agent ${agentId}`);
      return [];
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const requests = data.requests || data.turns || data.messages || data.exchanges || [];
      if (!Array.isArray(requests)) return [];

      const turns: ConversationTurn[] = [];
      const sessionMtime = fs.statSync(filePath).mtimeMs;

      for (const req of requests) {
        // ── User message ──
        const prompt = typeof req.prompt === 'string' ? req.prompt
          : (req.prompt?.text || req.prompt?.value || req.message?.text || req.message?.value
            || (typeof req.message === 'string' ? req.message : '') || req.text || req.query || '');
        if (prompt) {
          turns.push({ role: 'user', content: prompt, timestamp: sessionMtime });
        }

        // ── Assistant response ──
        let responseParts: any[] = [];
        let assistantText = '';
        const toolCalls: ConversationTurn['toolCalls'] = [];

        // Handle various response formats
        if (Array.isArray(req.response)) {
          responseParts = req.response;
        } else if (req.response && typeof req.response === 'object') {
          // Response might be an object with value/text/message
          const resp = req.response;
          if (typeof resp.value === 'string') {
            assistantText = resp.value;
          } else if (Array.isArray(resp.value)) {
            responseParts = resp.value;
          }
          if (resp.text) assistantText += resp.text;
          if (resp.message && typeof resp.message === 'string') assistantText += resp.message;
          if (resp.content && typeof resp.content === 'string') assistantText += resp.content;
          // Check for parts array
          if (Array.isArray(resp.parts)) responseParts = resp.parts;
          if (Array.isArray(resp.content)) responseParts = resp.content;
        } else if (typeof req.response === 'string') {
          assistantText = req.response;
        }

        for (const part of responseParts) {
          if (!part) continue;

          // Handle parts without type (direct text)
          if (typeof part === 'string') {
            assistantText += part;
            continue;
          }
          if (part.value && typeof part.value === 'string' && !part.type) {
            assistantText += part.value;
            continue;
          }
          if (!part.type) continue;

          if (part.type === 'markdown' && part.markdown?.value) {
            assistantText += part.markdown.value;
          }

          if (part.type === 'toolCall' && part.toolCall) {
            const tc = part.toolCall;
            const toolName = tc.toolName || tc.name || 'Tool';
            const input = tc.toolInput || tc.input || tc.arguments || {};
            const result = tc.toolResult;
            const detail = this.formatToolDetail(this.normalizeToolName(toolName), input);
            let resultText = '';
            if (result) {
              if (typeof result === 'string') resultText = result;
              else if (result.output) resultText = String(result.output);
              else if (result.stdout) resultText = String(result.stdout);
              else { try { resultText = JSON.stringify(result).substring(0, 500); } catch { /* skip */ } }
            }
            toolCalls.push({
              name: toolName,
              detail,
              result: resultText || undefined,
              isError: result?.exitCode ? result.exitCode !== 0 : false
            });
          }

          if (part.type === 'progressMessage' && part.progressMessage?.message) {
            // Include progress as part of assistant text
            assistantText += `\n[${part.progressMessage.message}]\n`;
          }
        }

        // Extract tool calls from object-style blocks (for older formats)
        if (!Array.isArray(req.response) && req.response) {
          const resp = req.response;
          const blocks = resp.value || resp.parts || resp.content || [];
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if ((block.kind === 'toolCall' || block.type === 'tool_use') && (block.toolName || block.name)) {
                toolCalls.push({
                  name: block.toolName || block.name || 'Tool',
                  detail: this.formatToolDetail(block.toolName || block.name || 'Tool', block.input || block.arguments || {}),
                });
              }
            }
          }
        }

        // Check result object too
        if (req.result?.message) {
          const resultMsg = req.result.message;
          if (typeof resultMsg === 'string') assistantText += '\n' + resultMsg;
          else if (Array.isArray(resultMsg)) {
            for (const p of resultMsg) {
              if (p.value) assistantText += '\n' + p.value;
            }
          }
        }

        if (assistantText.trim() || toolCalls.length > 0) {
          turns.push({
            role: 'assistant',
            content: assistantText.trim(),
            timestamp: sessionMtime,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined
          });
        }
      }

      this._outputChannel.appendLine(`[${this.id}] Loaded ${turns.length} conversation turns for ${agentId}`);
      return turns;
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Error loading conversation for ${agentId}: ${err?.message}`);
      return [];
    }
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

                const claudeAgentId = `claude-code-${sessionId}`;
                this._agentFilePaths.set(claudeAgentId, jf.path);

                this._agents.push({
                  id: claudeAgentId,
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
                  hasConversationHistory: true,
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

  /**
   * Load FULL conversation history from a Claude Code JSONL session file.
   * Called on-demand when the user clicks "Chat" on an agent card.
   */
  async getConversationHistory(agentId: string): Promise<ConversationTurn[]> {
    const filePath = this._agentFilePaths.get(agentId);
    if (!filePath) {
      this._outputChannel.appendLine(`[${this.id}] No file path for agent ${agentId}`);
      return [];
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      const turns: ConversationTurn[] = [];

      let currentAssistantText = '';
      let currentToolCalls: ConversationTurn['toolCalls'] = [];
      let lastTimestamp = Date.now();

      // Helper to flush any accumulated assistant content
      const flushAssistant = () => {
        if (currentAssistantText.trim() || (currentToolCalls && currentToolCalls.length > 0)) {
          turns.push({
            role: 'assistant',
            content: currentAssistantText.trim(),
            timestamp: lastTimestamp,
            toolCalls: currentToolCalls && currentToolCalls.length > 0 ? currentToolCalls : undefined
          });
          currentAssistantText = '';
          currentToolCalls = [];
        }
      };

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          const content = msg.message?.content;
          if (!Array.isArray(content)) continue;

          const msgTimestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : lastTimestamp;
          lastTimestamp = msgTimestamp;

          if (msg.type === 'user') {
            // Flush any previous assistant content
            flushAssistant();

            // Collect all text blocks from user message
            let userText = '';
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                userText += (userText ? '\n' : '') + block.text;
              }
            }
            if (userText) {
              turns.push({ role: 'user', content: userText, timestamp: msgTimestamp });
            }
          }

          if (msg.type === 'assistant') {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                currentAssistantText += (currentAssistantText ? '\n' : '') + block.text;
              }
              if (block.type === 'tool_use') {
                const toolName = block.name || 'Tool';
                const input = block.input || {};
                let detail = '';
                const fp = input.file_path || input.filePath || '';
                if (fp) {
                  detail = path.basename(fp);
                  if (input.offset) detail += `, line ${input.offset}`;
                } else if (input.command) {
                  detail = String(input.command).substring(0, 200);
                } else if (input.pattern) {
                  detail = `pattern: ${input.pattern}`;
                } else if (input.query) {
                  detail = String(input.query).substring(0, 200);
                } else if (input.content) {
                  detail = '(file content)';
                } else {
                  detail = toolName;
                }
                if (!currentToolCalls) currentToolCalls = [];
                currentToolCalls.push({
                  name: toolName,
                  detail,
                  isError: false
                });
              }
              if (block.type === 'tool_result') {
                // Attach result to the most recent tool call
                if (currentToolCalls && currentToolCalls.length > 0) {
                  const lastTool = currentToolCalls[currentToolCalls.length - 1];
                  if (block.is_error) lastTool.isError = true;
                  if (block.content) {
                    if (typeof block.content === 'string') {
                      lastTool.result = block.content.substring(0, 1000);
                    } else if (Array.isArray(block.content)) {
                      const texts = block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
                      lastTool.result = texts.join('\n').substring(0, 1000);
                    }
                  }
                }
              }
            }
          }
        } catch { /* skip malformed line */ }
      }

      // Flush remaining assistant content
      flushAssistant();

      this._outputChannel.appendLine(`[${this.id}] Loaded ${turns.length} conversation turns for ${agentId}`);
      return turns;
    } catch (err: any) {
      this._outputChannel.appendLine(`[${this.id}] Error loading conversation for ${agentId}: ${err?.message}`);
      return [];
    }
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
      case 'loadConversation':
        if (msg.agentId) {
          await this.loadConversationHistory(msg.agentId);
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

  /**
   * Load full conversation history for an agent and send it to the webview.
   */
  private async loadConversationHistory(agentId: string): Promise<void> {
    try {
      // Find which provider owns this agent
      let turns: ConversationTurn[] = [];
      for (const provider of this.providers) {
        if (provider.agents.some(a => a.id === agentId)) {
          turns = await provider.getConversationHistory(agentId);
          break;
        }
      }

      // If no provider found by agent ID, try checking the merged agent case
      // (basic copilot-active may have conversation from session provider)
      if (turns.length === 0) {
        for (const provider of this.providers) {
          const providerTurns = await provider.getConversationHistory(agentId);
          if (providerTurns.length > 0) {
            turns = providerTurns;
            break;
          }
        }
      }

      this.outputChannel.appendLine(`[dashboard] Sending ${turns.length} conversation turns for ${agentId}`);
      this.panel?.webview.postMessage({ type: 'conversation', agentId, turns });
    } catch (err: any) {
      this.outputChannel.appendLine(`[dashboard] Error loading conversation: ${err?.message}`);
      this.panel?.webview.postMessage({
        type: 'conversationError',
        agentId,
        error: err?.message || 'Failed to load conversation'
      });
    }
  }

  /** Conversation lookup for the REST API (same logic as loadConversationHistory but returns data) */
  private async getConversationForApi(agentId: string): Promise<ConversationTurn[]> {
    let turns: ConversationTurn[] = [];
    for (const provider of this.providers) {
      if (provider.agents.some(a => a.id === agentId)) {
        turns = await provider.getConversationHistory(agentId);
        break;
      }
    }
    if (turns.length === 0) {
      for (const provider of this.providers) {
        const t = await provider.getConversationHistory(agentId);
        if (t.length > 0) { turns = t; break; }
      }
    }
    return turns;
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

    // ── Enrichment pass: merge rich session data into basic Copilot agents ──
    // The CopilotExtensionProvider creates a basic "copilot-active" agent with minimal info.
    // The CopilotChatSessionProvider (or VSCodeChatSessionsProvider) may create richer agents
    // with conversation data, tool calls, etc. If both exist, merge the rich data into the
    // basic agent so the user sees everything in one place.
    const basicCopilotIds: string[] = [];
    const richCopilotAgents: AgentSession[] = [];
    for (const [id, agent] of agentMap) {
      if (agent.sourceProvider === 'copilot-extension' &&
          !(agent.recentActions && agent.recentActions.length > 0)) {
        basicCopilotIds.push(id);
      }
      if ((agent.sourceProvider === 'copilot-chat-sessions' || agent.sourceProvider === 'vscode-chat-sessions') &&
          ((agent.recentActions && agent.recentActions.length > 0) ||
           (agent.conversationPreview && agent.conversationPreview.length > 0) ||
           (agent.files && agent.files.length > 0))) {
        richCopilotAgents.push(agent);
      }
    }

    if (basicCopilotIds.length > 0 && richCopilotAgents.length > 0) {
      // Sort rich agents by startTime descending to get most recent
      richCopilotAgents.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
      const mostRecent = richCopilotAgents[0];
      const basicAgent = agentMap.get(basicCopilotIds[0])!;

      // Merge rich data into the basic agent
      if (mostRecent.recentActions && mostRecent.recentActions.length > 0) {
        basicAgent.recentActions = mostRecent.recentActions;
      }
      if (mostRecent.conversationPreview && mostRecent.conversationPreview.length > 0) {
        basicAgent.conversationPreview = mostRecent.conversationPreview;
      }
      if (mostRecent.tools && mostRecent.tools.length > 0) {
        basicAgent.tools = mostRecent.tools;
      }
      if (mostRecent.files && mostRecent.files.length > 0) {
        basicAgent.files = mostRecent.files;
      }
      if (mostRecent.task && mostRecent.task !== 'Chat session') {
        basicAgent.task = mostRecent.task;
      }
      if (mostRecent.tokens > 0) {
        basicAgent.tokens = mostRecent.tokens;
      }
      if (mostRecent.activeTool) {
        basicAgent.activeTool = mostRecent.activeTool;
      }
      if (mostRecent.progressLabel && mostRecent.progressLabel !== 'Active') {
        basicAgent.progressLabel = mostRecent.progressLabel;
      }
      if (mostRecent.model && mostRecent.model !== '—') {
        basicAgent.model = mostRecent.model;
      }
      if (mostRecent.typeLabel) {
        basicAgent.typeLabel = mostRecent.typeLabel;
      }

      this.outputChannel.appendLine(`[dashboard] Merged rich session data (${mostRecent.recentActions?.length || 0} actions, ${mostRecent.conversationPreview?.length || 0} convo lines) into basic agent "${basicAgent.name}"`);

      // Remove the standalone rich agent since its data has been merged
      agentMap.delete(mostRecent.id);

      // Also keep any remaining rich agents (older sessions) as separate cards
    }

    // ── Conversation history availability pass ──
    // Set hasConversationHistory on basic copilot agents when ANY provider has session file paths.
    // This ensures the Chat button is enabled even when session files are old.
    for (const provider of this.providers) {
      const filePaths = provider.agentFilePaths;
      if (filePaths && filePaths.size > 0) {
        // This provider has conversation data available
        for (const [, agent] of agentMap) {
          if ((agent.type === 'copilot' || agent.type === 'claude') && !agent.hasConversationHistory) {
            // Find the most recent file path from this provider
            const firstEntry = filePaths.entries().next().value;
            if (firstEntry) {
              agent.hasConversationHistory = true;
              // Also store a file path mapping for this agent so loadConversation works
              filePaths.set(agent.id, firstEntry[1]);
            }
          }
        }
      }
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
      dataSourceHealth: this.providers.map(p => {
        const s = p.status;
        // Recalculate agent count post-enrichment (enrichment may merge/delete agents)
        s.agentCount = agents.filter(a => a.sourceProvider === s.id).length;
        return s;
      }),
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
        res.end(JSON.stringify({ status: 'ok', version: '0.9.3', uptime: process.uptime() }));
        return;
      }

      // Conversation history endpoint: /api/agents/{agentId}/conversation
      const convoMatch = req.url?.match(/^\/api\/agents\/([^/]+)\/conversation$/);
      if (convoMatch && req.method === 'GET') {
        const agentId = decodeURIComponent(convoMatch[1]);
        this.outputChannel.appendLine(`[api] Conversation request for ${agentId}`);
        this.getConversationForApi(agentId).then(turns => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ agentId, turns }));
        }).catch((err: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err?.message || 'Failed to load conversation' }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/api/state', '/api/health', '/api/agents/{id}/conversation'] }));
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

  /**
   * Run diagnostics to help debug session discovery issues.
   * Shows a detailed report in a new editor tab.
   */
  async runDiagnostics() {
    const lines: string[] = [];
    lines.push('=== Agent Dashboard Diagnostics ===');
    lines.push(`Time: ${new Date().toISOString()}`);
    lines.push(`Platform: ${process.platform}`);
    lines.push(`VS Code version: ${vscode.version}`);
    lines.push('');

    // Show active providers
    lines.push('── Active Providers ──');
    for (const p of this.providers) {
      const s = p.status;
      lines.push(`  ${s.id}: ${s.state} — ${s.message} (${p.agents.length} agents)`);
    }
    lines.push('');

    // Show all agents
    lines.push('── Current Agents ──');
    await this.refresh();
    for (const p of this.providers) {
      for (const a of p.agents) {
        lines.push(`  [${a.sourceProvider}] ${a.name} (id=${a.id})`);
        lines.push(`    status=${a.status}, model=${a.model}, tokens=${a.tokens}`);
        lines.push(`    tools=${JSON.stringify(a.tools)}`);
        lines.push(`    files=${JSON.stringify(a.files?.slice(0, 5))}`);
        lines.push(`    recentActions=${a.recentActions?.length || 0} items`);
        lines.push(`    conversationPreview=${a.conversationPreview?.length || 0} lines`);
      }
    }
    lines.push('');

    // Show Copilot extension info
    lines.push('── Copilot Extensions ──');
    const copilotChat = vscode.extensions.getExtension('GitHub.copilot-chat');
    const copilot = vscode.extensions.getExtension('GitHub.copilot');
    lines.push(`  GitHub.copilot-chat: ${copilotChat ? `v${copilotChat.packageJSON?.version}, active=${copilotChat.isActive}` : 'NOT INSTALLED'}`);
    lines.push(`  GitHub.copilot: ${copilot ? `v${copilot.packageJSON?.version}, active=${copilot.isActive}` : 'NOT INSTALLED'}`);

    if (copilotChat?.exports) {
      const api = copilotChat.exports;
      const exportKeys = Object.keys(api).slice(0, 20);
      lines.push(`  Copilot Chat exports: [${exportKeys.join(', ')}]`);
      if (typeof api.getSessions === 'function') lines.push(`  Has getSessions() method`);
      if (typeof api.getConversations === 'function') lines.push(`  Has getConversations() method`);
      if (api.sessions) lines.push(`  Has sessions property`);
    }
    lines.push('');

    // Scan for chat session files
    lines.push('── Chat Session File Scan ──');
    const home = os.homedir();
    const candidateDirs: string[] = [];
    const globalStoragePath = this.context.globalStorageUri.fsPath;
    const primaryUserDir = path.resolve(globalStoragePath, '..', '..');
    candidateDirs.push(primaryUserDir);

    if (process.platform === 'darwin') {
      candidateDirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
      candidateDirs.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
      candidateDirs.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User'));
    }

    for (const userDir of [...new Set(candidateDirs)]) {
      const wsStorage = path.join(userDir, 'workspaceStorage');
      lines.push(`  User dir: ${userDir}`);
      lines.push(`    workspaceStorage exists: ${fs.existsSync(wsStorage)}`);

      if (fs.existsSync(wsStorage)) {
        try {
          const wsDirs = fs.readdirSync(wsStorage);
          lines.push(`    ${wsDirs.length} workspace folders`);

          let totalChatSessions = 0;
          let totalCopilotChat = 0;
          const recentFiles: { path: string; mtime: number; size: number }[] = [];

          for (const wd of wsDirs) {
            const wsPath = path.join(wsStorage, wd);

            // Check chatSessions/
            const csDir = path.join(wsPath, 'chatSessions');
            if (fs.existsSync(csDir)) {
              try {
                const jsons = fs.readdirSync(csDir).filter(f => f.endsWith('.json'));
                totalChatSessions += jsons.length;
                for (const j of jsons.slice(0, 5)) {
                  try {
                    const fPath = path.join(csDir, j);
                    const st = fs.statSync(fPath);
                    recentFiles.push({ path: fPath, mtime: st.mtimeMs, size: st.size });
                  } catch { /* skip */ }
                }
              } catch { /* skip */ }
            }

            // Check GitHub.copilot-chat/
            for (const copDir of ['GitHub.copilot-chat', 'github.copilot-chat']) {
              const cpDir = path.join(wsPath, copDir);
              if (fs.existsSync(cpDir)) {
                try {
                  const jsons = this.countJsonFiles(cpDir, 2);
                  totalCopilotChat += jsons;
                } catch { /* skip */ }
              }
            }
          }

          lines.push(`    chatSessions/ JSON files: ${totalChatSessions}`);
          lines.push(`    GitHub.copilot-chat/ JSON files: ${totalCopilotChat}`);

          // Show most recent files
          recentFiles.sort((a, b) => b.mtime - a.mtime);
          if (recentFiles.length > 0) {
            lines.push(`    Most recent session files:`);
            for (const rf of recentFiles.slice(0, 5)) {
              const age = Date.now() - rf.mtime;
              const ageStr = age < 60000 ? `${Math.floor(age / 1000)}s` :
                             age < 3600000 ? `${Math.floor(age / 60000)}m` :
                             `${Math.floor(age / 3600000)}h`;
              lines.push(`      ${path.basename(rf.path)} (${(rf.size / 1024).toFixed(1)}KB, ${ageStr} ago)`);

              // Try to read and show structure of most recent file
              if (rf === recentFiles[0] && rf.size < 500000) {
                try {
                  const content = JSON.parse(fs.readFileSync(rf.path, 'utf-8'));
                  const topKeys = Object.keys(content).slice(0, 15);
                  lines.push(`      Top-level keys: [${topKeys.join(', ')}]`);
                  if (content.requests) lines.push(`      requests: ${content.requests.length} entries`);
                  if (content.turns) lines.push(`      turns: ${content.turns.length} entries`);
                  if (content.messages) lines.push(`      messages: ${Array.isArray(content.messages) ? content.messages.length : typeof content.messages} entries`);
                  if (content.title) lines.push(`      title: "${content.title}"`);
                  if (content.model) lines.push(`      model: "${content.model}"`);

                  // Check first request structure
                  const reqs = content.requests || content.turns || [];
                  if (reqs.length > 0) {
                    const firstReq = reqs[0];
                    lines.push(`      First request keys: [${Object.keys(firstReq).join(', ')}]`);
                    if (firstReq.response) {
                      lines.push(`      response type: ${Array.isArray(firstReq.response) ? `array[${firstReq.response.length}]` : typeof firstReq.response}`);
                      if (Array.isArray(firstReq.response) && firstReq.response.length > 0) {
                        lines.push(`      response[0] keys: [${Object.keys(firstReq.response[0]).join(', ')}]`);
                        lines.push(`      response[0].type: ${firstReq.response[0].type}`);
                      }
                    }
                  }
                } catch (err: any) {
                  lines.push(`      Parse error: ${err?.message}`);
                }
              }
            }
          } else {
            lines.push(`    No session files found in any workspace`);
          }

          // Check globalStorage for copilot data
          for (const copDir of ['GitHub.copilot-chat', 'github.copilot-chat']) {
            const gDir = path.join(userDir, 'globalStorage', copDir);
            if (fs.existsSync(gDir)) {
              const count = this.countJsonFiles(gDir, 3);
              lines.push(`    globalStorage/${copDir}/: ${count} JSON files`);
            }
          }
        } catch (err: any) {
          lines.push(`    Error scanning: ${err?.message}`);
        }
      }
    }

    // MCP Configuration
    lines.push('');
    lines.push('── MCP Configuration ──');
    const chatConfig = vscode.workspace.getConfiguration('chat');
    const mcpCfg = chatConfig.get<any>('mcp');
    if (mcpCfg) {
      const servers = mcpCfg.servers || mcpCfg;
      const names = Object.keys(servers).filter(k => k !== 'servers');
      lines.push(`  Configured MCP servers: ${names.join(', ') || '(none)'}`);
    } else {
      lines.push(`  No MCP configuration found`);
    }
    lines.push(`  chat.agent.enabled: ${chatConfig.get<boolean>('agent.enabled')}`);

    // Workspace folders
    lines.push('');
    lines.push('── Workspace ──');
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders) {
      for (const wf of wsFolders) {
        lines.push(`  ${wf.name}: ${wf.uri.fsPath}`);
      }
    } else {
      lines.push(`  No workspace folders open`);
    }

    // Show the report
    const doc = await vscode.workspace.openTextDocument({
      content: lines.join('\n'),
      language: 'text'
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  }

  private countJsonFiles(dir: string, maxDepth: number): number {
    if (maxDepth <= 0) return 0;
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) count++;
        else if (entry.isDirectory() && maxDepth > 1) {
          count += this.countJsonFiles(path.join(dir, entry.name), maxDepth - 1);
        }
      }
    } catch { /* skip */ }
    return count;
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
    vscode.commands.registerCommand('agentDashboard.stopApi', () => dashboardProvider.stopApiServer()),
    vscode.commands.registerCommand('agentDashboard.diagnostics', () => dashboardProvider.runDiagnostics())
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
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); background:var(--bg); color:var(--text); min-height:100vh; font-size:13px; overflow-x:hidden; }
  .dashboard { max-width:1400px; margin:0 auto; padding:20px; overflow:hidden; }

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
  .btn-refreshing { opacity:0.6; pointer-events:none; }
  @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
  .btn-refreshing .refresh-icon { display:inline-block; animation:spin 0.8s linear infinite; }
  .refresh-toast { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:var(--surface); border:1px solid var(--accent); border-radius:8px; padding:12px 20px; font-size:11px; color:var(--accent); z-index:999; display:none; box-shadow:0 4px 20px rgba(0,0,0,0.4); }
  .refresh-toast.show { display:flex; align-items:center; gap:8px; animation:fadeInOut 1.5s ease-in-out forwards; }
  @keyframes fadeInOut { 0%{opacity:0;transform:translate(-50%,-50%) scale(0.9)} 15%{opacity:1;transform:translate(-50%,-50%) scale(1)} 85%{opacity:1} 100%{opacity:0} }

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

  .main-grid { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:14px; }
  .agents-column { width:100%; min-width:0; overflow:hidden; }
  .section-header { font-size:11px; text-transform:uppercase; letter-spacing:0.6px; color:var(--text-dim); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; }
  .agent-list { display:flex; flex-direction:column; gap:8px; width:100%; min-width:0; }

  .agent-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; transition:border-color 0.15s; overflow:hidden; width:100%; box-sizing:border-box; }
  .agent-card:hover { border-color:rgba(108,92,231,0.4); }
  .agent-card.st-running { border-left:3px solid var(--green); }
  .agent-card.st-thinking { border-left:3px solid var(--orange); }
  .agent-card.st-paused { border-left:3px solid var(--yellow); }
  .agent-card.st-done { border-left:3px solid var(--blue); }
  .agent-card.st-error { border-left:3px solid var(--red); }
  .agent-card.st-queued { border-left:3px solid var(--text-dim); }
  .agent-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:8px; }
  .agent-info { flex:1; min-width:0; overflow:hidden; }
  .agent-name { font-weight:600; font-size:13px; margin-bottom:2px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; overflow:hidden; max-width:100%; word-break:break-word; }
  .agent-task { font-size:11px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .agent-right { display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0; }

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
  .search-filter-bar { display:flex; gap:8px; margin-bottom:6px; align-items:center; flex-wrap:wrap; width:100%; overflow:hidden; }
  .search-input { flex:1; min-width:140px; padding:6px 10px 6px 30px; border-radius:7px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-size:11px; font-family:inherit; outline:none; transition:border-color 0.15s; box-sizing:border-box; }
  .search-input:focus { border-color:var(--accent); }
  .search-wrap { position:relative; flex:1; min-width:140px; max-width:100%; overflow:hidden; }
  .search-icon { position:absolute; left:9px; top:50%; transform:translateY(-50%); font-size:12px; color:var(--text-dim); pointer-events:none; }
  .filter-chips { display:flex; gap:4px; flex-wrap:wrap; }
  .filter-chip { padding:3px 9px; border-radius:12px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:9px; cursor:pointer; font-weight:500; transition:all 0.15s; font-family:inherit; white-space:nowrap; }
  .filter-chip:hover { border-color:var(--accent); color:var(--text); }
  .filter-chip.active { background:var(--accent-glow); border-color:var(--accent); color:var(--accent); font-weight:600; }
  .filter-chip .chip-count { display:inline-block; margin-left:3px; padding:0 5px; background:rgba(255,255,255,0.08); border-radius:8px; font-size:8px; }
  .filter-chip.active .chip-count { background:rgba(108,92,231,0.25); }
  .provider-filter-bar { display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap; align-items:center; width:100%; overflow:hidden; }
  .provider-filter-label { font-size:9px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.4px; margin-right:2px; }
  .provider-chip { padding:2px 8px; border-radius:10px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:8px; cursor:pointer; font-weight:500; transition:all 0.15s; font-family:inherit; white-space:nowrap; }
  .provider-chip:hover { border-color:var(--accent); color:var(--text); }
  .provider-chip.active { background:var(--cyan); background:rgba(0,206,201,0.12); border-color:var(--cyan); color:var(--cyan); font-weight:600; }

  @media (max-width:900px) { .main-grid { grid-template-columns:1fr; } .stats-row { grid-template-columns:repeat(3,1fr); } }

  /* ─── Conversation History Modal ─── */
  .convo-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:200; display:none; align-items:center; justify-content:center; }
  .convo-overlay.open { display:flex; }
  .convo-panel { background:var(--surface); border:1px solid var(--border); border-radius:12px; width:88%; max-width:920px; height:82vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.4); }
  .convo-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; gap:12px; }
  .convo-title-row { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
  .convo-title-row h3 { font-size:13px; font-weight:600; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .convo-back-btn { display:inline-flex; align-items:center; padding:4px 10px; border-radius:5px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:10px; cursor:pointer; font-family:inherit; transition:all 0.15s; flex-shrink:0; }
  .convo-back-btn:hover { border-color:var(--accent); color:var(--text); }
  .convo-controls { display:flex; gap:8px; align-items:center; flex-shrink:0; }
  .convo-search { padding:4px 10px; border-radius:5px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-size:10px; width:150px; font-family:inherit; outline:none; }
  .convo-search:focus { border-color:var(--accent); }
  .convo-close-x { padding:4px 8px; border-radius:4px; border:1px solid var(--border); background:var(--surface2); color:var(--text-dim); font-size:13px; cursor:pointer; font-family:inherit; line-height:1; }
  .convo-close-x:hover { border-color:var(--accent); color:var(--text); }
  .convo-body { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .convo-body::-webkit-scrollbar { width:5px; }
  .convo-body::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  .convo-loading { display:flex; flex-direction:column; align-items:center; gap:12px; padding:40px; color:var(--text-dim); font-size:12px; }
  .convo-spinner { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { 100% { transform:rotate(360deg); } }
  .convo-empty { text-align:center; padding:40px; color:var(--text-dim); font-size:12px; }
  .msg { display:flex; gap:10px; align-items:flex-start; }
  .msg.msg-user { flex-direction:row-reverse; }
  .msg-avatar { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex-shrink:0; }
  .msg.msg-assistant .msg-avatar { background:var(--accent-glow); color:var(--accent); }
  .msg.msg-user .msg-avatar { background:var(--green-glow); color:var(--green); }
  .msg-bubble { max-width:75%; border-radius:10px; padding:10px 14px; border:1px solid var(--border); }
  .msg.msg-assistant .msg-bubble { background:var(--surface2); border-top-left-radius:2px; }
  .msg.msg-user .msg-bubble { background:rgba(0,184,148,0.08); border-color:rgba(0,184,148,0.25); border-top-right-radius:2px; }
  .msg-role { font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px; display:flex; align-items:center; gap:8px; }
  .msg.msg-assistant .msg-role { color:var(--accent); }
  .msg.msg-user .msg-role { color:var(--green); }
  .msg-time { font-size:8px; font-weight:400; text-transform:none; letter-spacing:0; color:var(--text-dim); }
  .msg-text { font-size:12px; line-height:1.55; color:var(--text); white-space:pre-wrap; word-break:break-word; }
  .msg-text pre { background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--accent); padding:8px 10px; margin:8px 0; border-radius:4px; overflow-x:auto; font-size:11px; line-height:1.4; font-family:'Cascadia Code','Fira Code',Consolas,monospace; white-space:pre-wrap; }
  .msg-text code { background:var(--surface2); padding:1px 4px; border-radius:3px; font-family:'Cascadia Code','Fira Code',Consolas,monospace; font-size:0.9em; }
  .msg-tools { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
  .msg-tool { background:var(--bg); border:1px solid var(--border); border-left:3px solid var(--green); border-radius:4px; padding:6px 10px; font-size:10px; }
  .msg-tool-header { display:flex; align-items:center; gap:6px; cursor:pointer; }
  .msg-tool-name { color:var(--green); font-weight:600; }
  .msg-tool-detail { color:var(--text-dim); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .msg-tool-status { font-size:9px; }
  .msg-tool-result { margin-top:4px; padding-top:4px; border-top:1px solid var(--border); font-size:10px; color:var(--text-dim); white-space:pre-wrap; max-height:120px; overflow-y:auto; font-family:'Cascadia Code','Fira Code',Consolas,monospace; }
  .msg-tool.error { border-left-color:var(--red); }
  .msg-tool.error .msg-tool-name { color:var(--red); }
  .convo-btn { background:var(--accent-glow); border-color:rgba(108,92,231,0.3); color:var(--accent); }
  .convo-btn:hover:not(.convo-disabled) { background:rgba(108,92,231,0.2); border-color:var(--accent); color:var(--text); }
  .convo-btn.convo-disabled { opacity:0.35; cursor:default; }
  /* Awaiting user input — red pulse */
  @keyframes awaiting-pulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,60,60,0); } 50% { box-shadow:0 0 12px 3px rgba(255,60,60,0.35); } }
  .bubble-awaiting { border-color:rgba(255,60,60,0.5) !important; animation:awaiting-pulse 2s ease-in-out infinite; }
  .msg-awaiting-badge { display:inline-flex; align-items:center; gap:4px; margin-top:8px; padding:4px 10px; font-size:10px; font-weight:600; color:#ff3c3c; background:rgba(255,60,60,0.08); border:1px solid rgba(255,60,60,0.25); border-radius:12px; }
</style>
</head>
<body>
<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <div class="logo">A</div>
      <h1>Agent Dashboard <span>v0.9.3</span></h1>
    </div>
    <div class="header-right">
      <div class="live-badge"><div class="live-dot"></div> <span id="live-time">Live</span></div>
      <select id="source-select" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:10px;font-family:inherit;cursor:pointer;">
        <option value="copilot">Copilot</option>
        <option value="claude-code">Claude Code</option>
        <option value="both">Both</option>
      </select>
      <button class="btn" id="btn-refresh"><span class="refresh-icon">&#8635;</span> Refresh</button>
      <button class="btn" id="btn-log">&#128196; Log</button>
    </div>
  </div>
  <div class="stats-row" id="stats"></div>
  <div class="main-grid">
    <div class="agents-column">
      <div class="section-header">Agent Sessions <span id="agent-count"></span></div>
      <div class="search-filter-bar">
        <div class="search-wrap">
          <span class="search-icon">&#128269;</span>
          <input class="search-input" id="search-input" type="text" placeholder="Search...">
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
<div id="refresh-toast" class="refresh-toast"><span class="refresh-icon" style="animation:spin 0.8s linear infinite;">&#8635;</span> Refreshing...</div>
<div class="detail-overlay" id="detail-overlay"></div>
<div class="detail-panel" id="detail-panel">
  <div class="detail-panel-header">
    <h3 id="detail-panel-title">Agent Details</h3>
    <button class="detail-panel-close" id="detail-panel-close">&#10005;</button>
  </div>
  <div class="detail-panel-body" id="detail-panel-body"></div>
</div>
<div class="convo-overlay" id="convo-overlay">
  <div class="convo-panel">
    <div class="convo-header">
      <div class="convo-title-row">
        <button class="convo-back-btn" id="convo-close-btn">&#8592; Back</button>
        <h3 id="convo-title">Conversation</h3>
      </div>
      <div class="convo-controls">
        <input type="text" id="convo-search" class="convo-search" placeholder="Search messages..." />
        <button class="convo-close-x" id="convo-close-x">&#10005;</button>
      </div>
    </div>
    <div class="convo-body" id="convo-body">
      <div class="convo-loading">
        <div class="convo-spinner"></div>
        <div>Loading conversation...</div>
      </div>
    </div>
  </div>
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
  document.getElementById('btn-refresh').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true;
    btn.classList.add('btn-refreshing');
    // Show refresh toast instead of changing button text
    var toast = document.getElementById('refresh-toast');
    if (toast) { toast.classList.add('show'); setTimeout(function() { toast.classList.remove('show'); }, 1500); }
    send('refresh');
    // Re-enable after data arrives or timeout
    setTimeout(function() { btn.disabled = false; btn.classList.remove('btn-refreshing'); }, 4000);
  });
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
    // Open conversation history modal (skip if disabled)
    var convoBtn = e.target.closest('.convo-btn');
    if (convoBtn) {
      if (convoBtn.classList.contains('convo-disabled')) return;
      var agentId = convoBtn.getAttribute('data-agent-id');
      var agentName = convoBtn.getAttribute('data-agent-name') || 'Conversation';
      var startTime = convoBtn.getAttribute('data-start-time');
      if (agentId) openConversation(agentId, agentName, startTime);
      return;
    }
    // Open slide-out panel on the panel toggle button
    var panelBtn = e.target.closest('.panel-toggle-btn');
    if (panelBtn) {
      var agentId2 = panelBtn.getAttribute('data-agent-id');
      if (agentId2) openDetailPanel(agentId2);
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

  // Close conversation modal
  document.getElementById('convo-close-btn').addEventListener('click', function() { closeConversation(); });
  document.getElementById('convo-close-x').addEventListener('click', function() { closeConversation(); });
  document.getElementById('convo-overlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('convo-overlay')) closeConversation();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && convoOpen) closeConversation();
  });
  // Conversation search
  document.getElementById('convo-search').addEventListener('input', function() { filterConversation(this.value); });

  // Parent link click in detail panel
  document.getElementById('detail-panel-body').addEventListener('click', function(e) {
    var parentLink = e.target.closest('.parent-link');
    if (parentLink) {
      var parentId = parentLink.getAttribute('data-parent-id');
      if (parentId) openDetailPanel(parentId);
    }
    // View full chat history link
    var chatLink = e.target.closest('.view-chat-link');
    if (chatLink) {
      var agentId = chatLink.getAttribute('data-agent-id');
      var agentName = chatLink.getAttribute('data-agent-name');
      var startTime = chatLink.getAttribute('data-start-time');
      if (agentId) {
        closeDetailPanel();
        openConversation(agentId, agentName, startTime);
      }
    }
  });

  var activePanelAgentId = null;

  // ── Conversation History Modal ──
  var convoOpen = false;
  var convoTurns = [];
  var convoAgentId = null;
  var convoAgentStatus = null; // Track agent status for "awaiting input" detection

  function escHtml(t) {
    return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function stripGuid(name) {
    // Remove GUID suffixes like "Copilot Chat 832ec648" or "Claude Code abc123..."
    // Handles trailing whitespace and various separators (space, underscore, dash)
    var s = String(name || '').trim();
    // Match space + hex GUID (6+ chars) at end, with optional trailing dots/whitespace
    s = s.replace(/\s+[a-fA-F0-9]{6,}\.{0,3}\s*$/, '');
    // Also try with underscore/dash separators
    s = s.replace(/[_-]+[a-fA-F0-9]{6,}\.{0,3}\s*$/, '');
    return s.trim();
  }

  function formatConversationDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleDateString([], opts);
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) {
      return timeStr;
    } else {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
    }
  }

  function formatMsgText(text) {
    var html = escHtml(text);
    // Fenced code blocks: three-backtick blocks
    var codeBlockRe = new RegExp(String.fromCharCode(96,96,96)+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+String.fromCharCode(96,96,96), 'g');
    html = html.replace(codeBlockRe, function(m, lang, code) {
      return '<pre>' + code + '</pre>';
    });
    // Inline code: single backtick
    var inlineRe = new RegExp(String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96), 'g');
    html = html.replace(inlineRe, '<code>$1</code>');
    return html;
  }

  function openConversation(agentId, agentName, startTime) {
    convoAgentId = agentId;
    convoOpen = true;
    convoTurns = [];
    // Look up agent status for "awaiting input" detection
    convoAgentStatus = null;
    var agentStartTime = startTime ? parseInt(startTime, 10) : null;
    if (currentState && currentState.agents) {
      for (var ai = 0; ai < currentState.agents.length; ai++) {
        if (currentState.agents[ai].id === agentId) {
          convoAgentStatus = currentState.agents[ai].status;
          if (!agentStartTime) agentStartTime = currentState.agents[ai].startTime;
          break;
        }
      }
    }
    var titleText = stripGuid(agentName) || 'Conversation';
    if (agentStartTime) {
      titleText += ' — ' + formatConversationDate(agentStartTime);
    }
    document.getElementById('convo-title').textContent = titleText;
    document.getElementById('convo-search').value = '';
    document.getElementById('convo-body').innerHTML = '<div class="convo-loading"><div class="convo-spinner"></div><div>Loading conversation...</div></div>';
    document.getElementById('convo-overlay').classList.add('open');
    send('loadConversation', { agentId: agentId });
  }

  function closeConversation() {
    convoOpen = false;
    convoAgentId = null;
    convoTurns = [];
    document.getElementById('convo-overlay').classList.remove('open');
  }

  function renderConversation(turns) {
    convoTurns = turns;
    var container = document.getElementById('convo-body');
    if (!turns || turns.length === 0) {
      container.innerHTML = '<div class="convo-empty"><div style="font-size:24px;margin-bottom:8px;">&#128172;</div>No conversation history found.<br/><span style="font-size:10px;color:var(--text-dim);">Session files may not contain chat data, or the session may still be active in memory.</span></div>';
      return;
    }
    renderConversationTurns(turns, container);
    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function renderConversationTurns(turns, container) {
    var html = '';
    // Detect if agent is awaiting user input: status is running/thinking AND last message is from assistant
    var isLive = convoAgentStatus === 'running' || convoAgentStatus === 'thinking';
    var lastAssistantIdx = -1;
    if (isLive) {
      for (var li = turns.length - 1; li >= 0; li--) {
        if (turns[li].role === 'assistant') { lastAssistantIdx = li; break; }
      }
      // Only mark "awaiting" if the very last message is from the assistant (not user)
      if (lastAssistantIdx >= 0 && lastAssistantIdx !== turns.length - 1) lastAssistantIdx = -1;
    }

    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      var roleClass = t.role === 'user' ? 'msg-user' : 'msg-assistant';
      var avatar = t.role === 'user' ? '&#128100;' : '&#129302;';
      var roleLabel = t.role === 'user' ? 'You' : 'Assistant';
      var tsStr = t.timestamp ? formatTimestamp(t.timestamp) : '';
      var isAwaiting = (i === lastAssistantIdx);
      html += '<div class="msg ' + roleClass + (isAwaiting ? ' msg-awaiting' : '') + '">';
      html += '<div class="msg-avatar">' + avatar + '</div>';
      html += '<div class="msg-bubble' + (isAwaiting ? ' bubble-awaiting' : '') + '">';
      html += '<div class="msg-role">' + roleLabel + (tsStr ? '<span class="msg-time">' + tsStr + '</span>' : '') + '</div>';
      html += '<div class="msg-text">' + formatMsgText(t.content) + '</div>';

      // "Awaiting input" banner
      if (isAwaiting) {
        html += '<div class="msg-awaiting-badge">&#9888; Agent is waiting for your input</div>';
      }

      // Tool calls
      if (t.toolCalls && t.toolCalls.length > 0) {
        html += '<div class="msg-tools">';
        for (var j = 0; j < t.toolCalls.length; j++) {
          var tc = t.toolCalls[j];
          var errClass = tc.isError ? ' error' : '';
          var statusIcon = tc.isError ? '&#10007;' : '&#10003;';
          html += '<div class="msg-tool' + errClass + '">';
          html += '<div class="msg-tool-header">';
          html += '<span class="msg-tool-name">&#9881; ' + escHtml(tc.name) + '</span>';
          html += '<span class="msg-tool-detail">' + escHtml(tc.detail) + '</span>';
          html += '<span class="msg-tool-status">' + statusIcon + '</span>';
          html += '</div>';
          if (tc.result) {
            html += '<div class="msg-tool-result">' + escHtml(tc.result) + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</div>'; // .msg-bubble
      html += '</div>'; // .msg
    }
    container.innerHTML = html;
  }

  function filterConversation(query) {
    if (!convoTurns || convoTurns.length === 0) return;
    var container = document.getElementById('convo-body');
    if (!query) {
      renderConversationTurns(convoTurns, container);
      return;
    }
    var q = query.toLowerCase();
    var filtered = [];
    for (var i = 0; i < convoTurns.length; i++) {
      var t = convoTurns[i];
      if (t.content && t.content.toLowerCase().indexOf(q) !== -1) {
        filtered.push(t);
      } else if (t.toolCalls) {
        for (var j = 0; j < t.toolCalls.length; j++) {
          var tc = t.toolCalls[j];
          if ((tc.name && tc.name.toLowerCase().indexOf(q) !== -1) ||
              (tc.detail && tc.detail.toLowerCase().indexOf(q) !== -1) ||
              (tc.result && tc.result.toLowerCase().indexOf(q) !== -1)) {
            filtered.push(t);
            break;
          }
        }
      }
    }
    if (filtered.length === 0) {
      container.innerHTML = '<div class="convo-empty">No messages match &ldquo;' + escHtml(query) + '&rdquo;</div>';
    } else {
      renderConversationTurns(filtered, container);
    }
  }

  function openDetailPanel(agentId) {
    if (!currentState) return;
    var agents = currentState.agents || [];
    var agent = null;
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].id === agentId) { agent = agents[i]; break; }
    }
    if (!agent) return;
    activePanelAgentId = agentId;

    document.getElementById('detail-panel-title').textContent = stripGuid(agent.name);
    var body = document.getElementById('detail-panel-body');
    var html = '';

    // Status & meta
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title" style="display:flex;justify-content:space-between;align-items:center;">Status <span class="sb sb-'+agent.status+'">'+agent.status.charAt(0).toUpperCase()+agent.status.slice(1)+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Task</span><span class="detail-value" style="white-space:normal;">'+escHtml(agent.task || '-')+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">'+agent.model+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">'+agent.sourceProvider+'</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Date</span><span class="detail-value">'+(agent.startTime ? formatConversationDate(agent.startTime) : agent.elapsed)+'</span></div>';
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

    // Conversation Summary (AI-generated overview)
    var convo = agent.conversationPreview || [];
    if (convo.length > 0 || agent.hasConversationHistory) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Conversation</div>';
      if (agent.startTime) {
        html += '<div style="font-size:9px;color:var(--text-dim);margin-bottom:6px;">'+formatConversationDate(agent.startTime)+'</div>';
      }
      // Show the task/topic as summary
      var summaryText = agent.task && agent.task !== '\u2014' ? agent.task : 'Chat session available';
      if (summaryText.length > 120) summaryText = summaryText.substring(0, 120) + '...';
      html += '<div style="font-size:11px;line-height:1.5;color:var(--text);padding:8px 10px;background:var(--surface2);border-radius:6px;margin-bottom:10px;">'+escHtml(summaryText)+'</div>';
      // View full chat history link
      if (agent.hasConversationHistory) {
        html += '<a class="view-chat-link" data-agent-id="'+agent.id+'" data-agent-name="'+escHtml(stripGuid(agent.name))+'" data-start-time="'+(agent.startTime||'')+'" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--accent);cursor:pointer;text-decoration:none;">&#128172; View full chat history &rarr;</a>';
      }
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

      return '<div class="agent-card st-'+a.status+'">'+
        '<div class="agent-top">'+
          '<div class="agent-info">'+
            '<div class="agent-name">'+stripGuid(a.name)+' <span class="tag tag-'+a.type+'">'+a.typeLabel+'</span> <span class="tag tag-'+a.location+'">'+loc+'</span></div>'+
            '<div class="agent-task">'+escHtml(a.task || 'Chat session')+'</div>'+
          '</div>'+
          '<div class="agent-right">'+
            '<span class="sb sb-'+a.status+'">'+a.status.charAt(0).toUpperCase()+a.status.slice(1)+'</span>'+
            ((a.type==='copilot'||a.type==='claude') ? '<button class="panel-toggle-btn convo-btn'+(a.hasConversationHistory?'':' convo-disabled')+'" data-agent-id="'+a.id+'" data-agent-name="'+escHtml(stripGuid(a.name))+'" data-start-time="'+(a.startTime||'')+'"'+(a.hasConversationHistory?'':' title="No saved conversation history yet"')+'>&#128172; Chat</button>' : '')+
            '<button class="panel-toggle-btn" data-agent-id="'+a.id+'"><span class="arrow">&#9656;</span> Details</button>'+
          '</div>'+
        '</div>'+
        '<div class="agent-meta">'+
          '<span>'+a.model+'</span>'+
          '<span>'+(a.startTime ? formatConversationDate(a.startTime).split(' at ')[0] : a.elapsed)+'</span>'+
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
      // Reset refresh button when data arrives
      var rb = document.getElementById('btn-refresh');
      if (rb) { rb.disabled = false; rb.classList.remove('btn-refreshing'); }
      try {
        render(e.data.state);
      } catch (err) {
        document.getElementById('agents').innerHTML = '<div class="empty-state"><div class="icon" style="color:var(--red);">&#9888;</div><p>Render error: '+err.message+'</p><div class="hint">'+err.stack+'</div></div>';
      }
    }
    // Conversation history response
    if (e.data && e.data.type === 'conversation') {
      if (convoOpen && e.data.agentId === convoAgentId) {
        renderConversation(e.data.turns || []);
      }
    }
    if (e.data && e.data.type === 'conversationError') {
      if (convoOpen && e.data.agentId === convoAgentId) {
        document.getElementById('convo-body').innerHTML = '<div class="convo-empty" style="color:var(--red);">&#9888; '+escHtml(e.data.error||'Failed to load conversation')+'</div>';
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
  dbg.textContent = 'v0.9.3 loaded';
  document.body.appendChild(dbg);
})();
</script>
</body>
</html>`;
}
