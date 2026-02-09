# Agent Dashboard for VS Code

Real-time visual monitoring dashboard for Claude Code agents — local, remote, and cloud sessions.

![Dashboard](https://img.shields.io/badge/VS_Code-Extension-blue)

## Features

- **Live monitoring** of all Claude Code agent sessions with auto-refresh
- **Pause / Resume / Stop** controls for local agents
- **Remote & cloud agents** — GitHub Actions workflows, SSH remotes, Copilot agents
- **Activity feed** with timestamped tool usage, file edits, and completions
- **Token usage chart** with estimated cost
- **Filter tabs** — filter by status (running, paused, done) or location (local, remote, cloud)
- **VS Code theme integration** — adapts to your light/dark theme
- **File watcher** — auto-refreshes when Claude Code writes new session data

## How It Works

The extension reads Claude Code's session data from `~/.claude/`:

- **`~/.claude/projects/`** — JSONL session transcripts per project
- **`~/.claude/tasks/`** — Task coordination files for multi-agent workflows

It also checks for:

- VS Code remote connections (SSH, WSL, containers)
- GitHub Copilot agent sessions
- GitHub Actions Claude agent workflows (via `gh` CLI)
- Cloud Claude Code sessions (via `claude tasks --json`)

## Installation

```bash
cd agent-dashboard-ext
npm install
npm run compile
npm run package
```

Then install the `.vsix` file:

```
code --install-extension agent-dashboard-0.1.0.vsix
```

Or press `Ctrl+Shift+P` → "Extensions: Install from VSIX..."

## Usage

- **Open:** `Ctrl+Shift+D` (or `Cmd+Shift+D` on Mac)
- **Command Palette:** "Agent Dashboard: Open"
- **Status Bar:** Click the "Agents" item in the bottom-right

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentDashboard.pollInterval` | `3000` | Refresh interval in ms |
| `agentDashboard.claudeHomePath` | `~/.claude` | Override Claude data directory |
| `agentDashboard.showRemoteAgents` | `true` | Show remote/cloud agent sessions |
| `agentDashboard.showTokenCost` | `true` | Show estimated token cost |

## Agent Controls

| Control | Action |
|---------|--------|
| ⏸ Pause | Sends SIGSTOP to the agent process |
| ▶ Resume | Sends SIGCONT to resume |
| ⏹ Stop | Sends SIGTERM (with confirmation dialog) |
| 📄 Log | Opens the raw JSONL session file |
| ⏩ Terminal | Opens a terminal with `claude --resume` |

> Note: Pause/Resume/Stop only work for local agents with a known PID.
> Remote and cloud agents show status but controls are read-only.

## Architecture

```
extension.ts
├── ClaudeSessionParser   — Reads ~/.claude JSONL session files
├── RemoteAgentMonitor    — Checks remote/cloud/GitHub agent sessions
├── AgentController       — Sends signals to pause/resume/stop processes
└── DashboardProvider     — Manages the webview panel and data flow
    └── Webview (HTML)    — Renders the dashboard UI
        └── postMessage   — Two-way communication with extension host
```

## Development

```bash
npm run watch    # Watch mode for TypeScript compilation
# Press F5 in VS Code to launch Extension Development Host
```

## License

MIT
