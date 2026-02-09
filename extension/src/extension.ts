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
  }

  private mapCopilotStatus(session: any): AgentSession['status'] {
    if (session.isActive || session.status === 'active') return 'running';
    return 'done';
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

    this._state = 'connected';
    this._message = activeCount > 0
      ? `${activeCount} active session(s), ${recentCount} recent`
      : recentCount > 0
        ? `${recentCount} recent session(s), none currently active`
        : 'No active Claude Desktop sessions.';
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

    this.panel.webview.html = getWebviewContent();

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

    this.panel?.webview.postMessage({ type: 'update', state });
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
        res.end(JSON.stringify({ status: 'ok', version: '0.4.0', uptime: process.uptime() }));
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

function getWebviewContent(): string {
  return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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

  .agent-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; transition:border-color 0.15s; cursor:pointer; }
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
  .agent-expand-icon { font-size:10px; color:var(--text-dim); transition:transform 0.2s; }
  .agent-card.expanded .agent-expand-icon { transform:rotate(90deg); }
  .agent-task { font-size:11px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .agent-details { display:none; margin-top:10px; border-top:1px solid var(--border); padding-top:10px; }
  .agent-card.expanded .agent-details { display:block; }
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
  .activity-indicator { width:100%; height:4px; border-radius:2px; overflow:hidden; margin-top:8px; background:linear-gradient(90deg, var(--surface2) 0%, var(--green) 20%, var(--cyan) 40%, var(--surface2) 60%); background-size:300% 100%; animation:sweep 1.8s linear infinite; }
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
  .ds-item { display:flex; align-items:center; gap:8px; padding:5px 0; font-size:10px; }
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
  .search-filter-bar { display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap; }
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

  @media (max-width:900px) { .main-grid { grid-template-columns:1fr; } .stats-row { grid-template-columns:repeat(3,1fr); } }
</style>
</head>
<body>
<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <div class="logo">A</div>
      <h1>Agent Dashboard <span>v0.5.0</span></h1>
    </div>
    <div class="header-right">
      <div class="live-badge"><div class="live-dot"></div> <span id="live-time">Live</span></div>
      <select id="source-select" onchange="send('switchSource',{source:this.value})" style="padding:3px 8px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:10px;font-family:inherit;cursor:pointer;">
        <option value="copilot">Copilot</option>
        <option value="claude-code">Claude Code</option>
        <option value="both">Both</option>
      </select>
      <button class="btn" onclick="send('refresh')">&#8635; Refresh</button>
      <button class="btn" onclick="send('openLog')">&#128196; Log</button>
    </div>
  </div>
  <div class="stats-row" id="stats"></div>
  <div class="main-grid">
    <div>
      <div class="section-header">Agent Sessions <span id="agent-count"></span></div>
      <div class="search-filter-bar">
        <div class="search-wrap">
          <span class="search-icon">&#128269;</span>
          <input class="search-input" id="search-input" type="text" placeholder="Search agents by name, task, model..." oninput="applyFilter()">
        </div>
        <div class="filter-chips" id="filter-chips"></div>
      </div>
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
<script>
const vscode = acquireVsCodeApi();
function send(command, data) { vscode.postMessage({ command, ...data }); }
function fmt(n) { return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':String(n); }
function sc(s) { return {running:'green',thinking:'orange',paused:'yellow',done:'blue',error:'red',queued:'gray'}[s]||'gray'; }
function dc(t) { return {tool_use:'d-green',file_edit:'d-accent',command:'d-blue',thinking:'d-orange',complete:'d-blue',error:'d-red',start:'d-gray',info:'d-gray'}[t]||'d-gray'; }
function toggleAgent(el) { el.classList.toggle('expanded'); }
let lastUpdate = null;
let currentState = null;
let activeStatusFilter = null;

function applyFilter() {
  if (currentState) renderAgents(currentState.agents || []);
}

function setStatusFilter(status) {
  activeStatusFilter = activeStatusFilter === status ? null : status;
  applyFilter();
}

function renderFilterChips(agents) {
  const counts = {};
  for (const a of agents) counts[a.status] = (counts[a.status]||0) + 1;
  const statuses = ['running','thinking','paused','done','error','queued'];
  const labels = {running:'Running',thinking:'Thinking',paused:'Paused',done:'Done',error:'Error',queued:'Queued'};
  let html = '<button class="filter-chip'+(activeStatusFilter===null?' active':'')+'" onclick="setStatusFilter(null)">All <span class="chip-count">'+agents.length+'</span></button>';
  for (const s of statuses) {
    if (counts[s]) {
      html += '<button class="filter-chip'+(activeStatusFilter===s?' active':'')+'" onclick="setStatusFilter(\''+s+'\')">'+labels[s]+' <span class="chip-count">'+counts[s]+'</span></button>';
    }
  }
  document.getElementById('filter-chips').innerHTML = html;
}

function renderAgents(agents) {
  const searchTerm = (document.getElementById('search-input').value || '').toLowerCase().trim();
  renderFilterChips(agents);

  let filtered = agents;
  if (activeStatusFilter) filtered = filtered.filter(a => a.status === activeStatusFilter);
  if (searchTerm) filtered = filtered.filter(a =>
    a.name.toLowerCase().includes(searchTerm) ||
    a.task.toLowerCase().includes(searchTerm) ||
    a.model.toLowerCase().includes(searchTerm) ||
    a.typeLabel.toLowerCase().includes(searchTerm) ||
    a.sourceProvider.toLowerCase().includes(searchTerm) ||
    (a.tasks||[]).some(t => (t.content||'').toLowerCase().includes(searchTerm) || (t.activeForm||'').toLowerCase().includes(searchTerm))
  );

  document.getElementById('agent-count').textContent = filtered.length !== agents.length
    ? filtered.length+' of '+agents.length
    : (agents.length ? agents.length+' total' : '');

  const el = document.getElementById('agents');
  if (!filtered.length) {
    el.innerHTML = agents.length
      ? '<div class="empty-state"><div class="icon">&#128269;</div><p>No agents match your filter</p><div class="hint">Try a different search term or clear the filter</div></div>'
      : '<div class="empty-state"><div class="icon">&#9881;</div><p>No agent sessions detected</p><div class="hint">Check Data Sources below for connection status</div></div>';
    return;
  }

  el.innerHTML = filtered.map(a => {
    const color = sc(a.status);
    const active = a.status==='running'||a.status==='thinking';
    const loc = a.remoteHost || (a.location.charAt(0).toUpperCase()+a.location.slice(1));
    const tasks = a.tasks || [];
    const hasTasks = tasks.length > 0;
    const taskIcons = { completed:'&#10003;', in_progress:'&#9654;', pending:'&#9675;' };

    let detailsHtml = '<div class="agent-details">';

    // Meta details
    detailsHtml += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">'+a.model+'</span></div>';
    detailsHtml += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">'+a.sourceProvider+'</span></div>';
    detailsHtml += '<div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">'+loc+'</span></div>';
    if (a.pid) detailsHtml += '<div class="detail-row"><span class="detail-label">PID</span><span class="detail-value">'+a.pid+'</span></div>';
    if (a.activeTool) detailsHtml += '<div class="detail-row"><span class="detail-label">Active</span><span class="detail-value">'+a.activeTool+'</span></div>';

    // Task list
    if (hasTasks) {
      const completed = tasks.filter(t=>t.status==='completed').length;
      detailsHtml += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);margin-bottom:4px;">Tasks ('+completed+'/'+tasks.length+' done)</div>';
      detailsHtml += '<ul class="task-list">';
      for (const t of tasks) {
        const icon = taskIcons[t.status] || '&#9675;';
        detailsHtml += '<li class="task-item"><span class="task-icon '+t.status+'">'+icon+'</span><span class="task-text '+t.status+'">'+(t.activeForm || t.content)+'</span></li>';
      }
      detailsHtml += '</ul>';
    }

    // Files
    if (a.files && a.files.length > 0) {
      detailsHtml += '<div class="file-list"><div style="font-size:10px;color:var(--text-dim);margin:6px 0 4px;">Files ('+a.files.length+')</div>';
      for (const f of a.files.slice(0,8)) {
        detailsHtml += '<div class="file-item">&#128196; '+f+'</div>';
      }
      if (a.files.length > 8) detailsHtml += '<div class="file-item" style="opacity:0.5">+ '+(a.files.length-8)+' more</div>';
      detailsHtml += '</div>';
    }

    // Tools
    if (a.tools && a.tools.length > 0) {
      detailsHtml += '<div style="margin-top:6px;font-size:10px;color:var(--text-dim);margin-bottom:4px;">Tools</div>';
      detailsHtml += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
      for (const t of a.tools) {
        detailsHtml += '<span style="font-size:9px;padding:2px 6px;background:var(--surface2);border-radius:3px;color:var(--text-dim);">'+t+'</span>';
      }
      detailsHtml += '</div>';
    }

    detailsHtml += '</div>';

    return '<div class="agent-card st-'+a.status+'" onclick="toggleAgent(this)">'+
      '<div class="agent-top">'+
        '<div class="agent-info">'+
          '<div class="agent-name"><span class="agent-expand-icon">&#9656;</span> '+a.name+' <span class="tag tag-'+a.type+'">'+a.typeLabel+'</span> <span class="tag tag-'+a.location+'">'+loc+'</span></div>'+
          '<div class="agent-task">'+a.task+'</div>'+
        '</div>'+
        '<span class="sb sb-'+a.status+'">'+a.status.charAt(0).toUpperCase()+a.status.slice(1)+'</span>'+
      '</div>'+
      '<div class="agent-meta">'+
        '<span>'+a.model+'</span>'+
        '<span>'+a.elapsed+'</span>'+
        (a.tokens?'<span>'+fmt(a.tokens)+' tokens</span>':'')+
        (hasTasks?'<span>'+tasks.filter(t=>t.status==='completed').length+'/'+tasks.length+' tasks</span>':'')+
        '<span style="opacity:0.5">via '+a.sourceProvider+'</span>'+
      '</div>'+
      (a.progress > 0
        ? '<div class="progress-bar"><div class="pf pf-'+color+'" style="width:'+a.progress+'%"></div></div><div class="progress-label"><span>'+a.progressLabel+'</span><span>'+a.progress+'%</span></div>'
        : active
          ? '<div class="activity-indicator"></div><div class="progress-label"><span>'+a.progressLabel+'</span><span>'+a.elapsed+'</span></div>'
          : ''
      )+
      detailsHtml+
    '</div>';
  }).join('');
}

function render(state) {
  currentState = state;
  const agents = state.agents || [];
  const activities = state.activities || [];
  const stats = state.stats || {};
  const health = state.dataSourceHealth || [];

  // Update live timestamp
  lastUpdate = new Date();
  const lt = document.getElementById('live-time');
  if (lt) lt.textContent = 'Updated ' + lastUpdate.toLocaleTimeString();

  // Stats
  document.getElementById('stats').innerHTML =
    '<div class="stat-card"><div class="stat-label">Total Agents</div><div class="stat-value">'+stats.total+'</div><div class="stat-sub">across '+health.filter(h=>h.state==='connected').length+' sources</div></div>'+
    '<div class="stat-card"><div class="stat-label">Active Now</div><div class="stat-value" style="color:var(--green)">'+stats.active+'</div><div class="stat-sub">running + thinking</div></div>'+
    '<div class="stat-card"><div class="stat-label">Completed</div><div class="stat-value" style="color:var(--blue)">'+stats.completed+'</div><div class="stat-sub">this session</div></div>'+
    '<div class="stat-card"><div class="stat-label">Tokens</div><div class="stat-value">'+fmt(stats.tokens)+'</div><div class="stat-sub">~$'+(stats.estimatedCost||0).toFixed(2)+'</div></div>'+
    '<div class="stat-card"><div class="stat-label">Data Sources</div><div class="stat-value" style="color:var(--cyan)">'+health.filter(h=>h.state==='connected').length+'/'+health.length+'</div><div class="stat-sub">connected</div></div>';

  // Agents (with search & filter)
  renderAgents(agents);

  // Activity
  const actEl = document.getElementById('activity');
  if (!activities.length) {
    actEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:10px;">Waiting for activity...</div>';
  } else {
    actEl.innerHTML = activities.slice(0,20).map(a =>
      '<div class="act-item"><div class="act-dot '+dc(a.type)+'"></div><div class="act-content"><div class="act-agent">'+a.agent+'</div><div class="act-desc">'+a.desc+'</div></div><div class="act-time">'+a.timeLabel+'</div></div>'
    ).join('');
  }

  // Source toggle
  const sel = document.getElementById('source-select');
  if (sel && state.primarySource) sel.value = state.primarySource;

  // Data sources
  document.getElementById('datasources').innerHTML = health.map(h => {
    const isWarn = h.state === 'degraded';
    return '<div class="ds-item">'+
      '<div class="ds-dot ds-'+h.state+'"></div>'+
      '<div style="flex:1;min-width:0">'+
        '<div class="ds-name">'+h.name+'</div>'+
        '<div class="ds-msg'+(isWarn?' warn':'')+'">'+h.message+'</div>'+
      '</div>'+
      (h.agentCount?'<div class="ds-count">'+h.agentCount+'</div>':'')+
    '</div>';
  }).join('');
}

window.addEventListener('message', e => {
  if (e.data.type === 'update') render(e.data.state);
});

render({ agents:[], activities:[], stats:{total:0,active:0,completed:0,tokens:0,estimatedCost:0,avgDuration:'—'}, dataSourceHealth:[] });
</script>
</body>
</html>`;
}
