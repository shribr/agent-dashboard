# Agent Dashboard for VS Code

**Real-time visual monitoring for AI coding agents** -- GitHub Copilot, Claude Code, Codex, and more. Track every agent session, tool call, and token across all your VS Code windows, remote machines, and from your phone.

![VS Code](https://img.shields.io/badge/VS_Code-1.85+-blue?logo=visualstudiocode)
![License](https://img.shields.io/badge/License-MIT-green)
![Version](https://img.shields.io/badge/version-0.10.1-orange)

<p align="center">
  <img src="https://raw.githubusercontent.com/shribr/agent-dashboard/main/extension/images/icon.png" alt="Agent Dashboard Icon" width="128" />
</p>

---

## Screenshots

### Main Dashboard

See all your active AI agents at a glance — status, model, token usage, estimated cost, and task progress — all in one unified view.

![Main Dashboard](https://raw.githubusercontent.com/shribr/agent-dashboard/main/extension/images/dashboard-main.png)

### Session Chat History

Expand any agent to view the full conversation — user prompts, assistant responses, and every tool call with inputs and outputs.

![Session Chat History](https://raw.githubusercontent.com/shribr/agent-dashboard/main/extension/images/session-chat-history.png)

### Session Details

Drill into session details including active tools, modified files, process info, and real-time token breakdown.

![Session Details](https://raw.githubusercontent.com/shribr/agent-dashboard/main/extension/images/session-details.png)

---

## Why Agent Dashboard?

AI coding agents run in the background, sometimes for minutes. Without visibility you're left wondering: Is it still going? How many tokens has it burned? Did it error out?

Agent Dashboard gives you a **live control room** for every AI agent in your development environment:

- See all running agents at a glance with live status updates
- Track token usage and estimated costs in real time
- View tool calls, file edits, and conversation history as they happen
- Monitor agents across multiple VS Code windows and remote machines
- Check on your agents from your phone with the companion iOS app

---

## Features

### Live Agent Monitoring

Track every active AI coding agent across all your projects. Each agent card shows real-time status, model, token consumption, active tool calls, and elapsed time. The dashboard auto-refreshes every 3 seconds.

**Supported agents:**
- **GitHub Copilot** -- Chat sessions, inline completions, and workspace agents
- **Claude Code** -- CLI sessions with full JSONL transcript parsing
- **OpenAI Codex** -- Session monitoring via `~/.codex/sessions/`
- **Aider** -- Chat history monitoring
- **Custom agents** -- Define your own in `.github/agents/`

### Multi-Source Data Providers

Agent Dashboard uses **11 independent data providers** that can be individually toggled:

| Provider | What it detects |
|----------|----------------|
| Copilot Extension API | Active Copilot chat sessions via the extension API |
| Copilot Chat Sessions | Rich session data from VS Code's `workspaceStorage` |
| VS Code Chat Sessions | Sessions via the proposed Chat Sessions API |
| Chat Tools & Participants | MCP tools, chat participants, and workspace agents |
| Claude Code (JSONL) | Claude CLI sessions from `~/.claude/projects/` |
| Terminal Processes | Running `claude`, `codex`, `aider` processes |
| Custom Workspace Agents | Agent definitions in `.github/agents/` |
| GitHub Actions | Claude/Copilot workflows via `gh` CLI |
| Remote Connections | SSH, WSL, and container sessions |
| Workspace Activity | Git and file system activity signals |
| Peer Instances | Agents from other VS Code windows on the same machine |

### Token Usage & Cost Tracking

See exactly how many tokens each agent has consumed, broken down by input, output, cache creation, and cache read tokens. Estimated costs are calculated automatically based on the model.

### Conversation History

Expand any agent to view its full conversation history, including user prompts, assistant responses, and every tool call with inputs and outputs. Conversations load on-demand to keep the dashboard fast.

### Activity Feed

A live timeline of everything happening across all agents -- tool calls, file edits, commands, completions, and errors -- with relative timestamps.

### Agent Controls

For local agents with a known process ID:

| Control | Action |
|---------|--------|
| Pause | Sends `SIGSTOP` to suspend the agent process |
| Resume | Sends `SIGCONT` to resume execution |
| Stop | Sends `SIGTERM` with a confirmation dialog |
| Log | Opens the raw session file (JSONL/JSON) |

### Multi-Window Peer Sync

Running multiple VS Code windows? Agent Dashboard **auto-discovers peer instances** on the same machine and shows all agents in a unified view. Peer agents appear with a gold tag showing which window they belong to.

No configuration needed -- instances register themselves via a shared file at `~/.agent-dashboard/instances.json`. Just set a different `agentDashboard.apiPort` in each window.

### Mobile Monitoring (iOS Companion App)

Monitor your agents from anywhere with the companion iOS app. Two connection modes:

**Local Wi-Fi (zero setup):**
The extension runs a REST API server on port 19850. Point the iOS app at your Mac's IP address and you're connected.

**Cloud Relay (remote access):**
Deploy a free Cloudflare Worker to relay data from your machine to the iOS app over the internet. Works from anywhere -- coffee shop, commute, different building.

Run `Agent Dashboard: Setup Cloud Relay` from the command palette for automated one-click deployment.

### Multi-Instance Cloud Aggregation

When multiple machines push to the same cloud relay, the relay **aggregates all instances** into a single unified view. See agents from your desktop, laptop, and CI server all in one place on your phone.

Each instance is identified by hostname and workspace name. Stale instances are automatically pruned.

### Alerts & Notifications

Get notified when agents complete, error out, or when providers degrade:

- **Email** via SendGrid or SMTP
- **SMS** via Twilio
- **Webhooks** for Slack, Discord, or custom integrations

Configure alert rules per event type in settings.

### Diagnostics

Run `Agent Dashboard: Show Diagnostics` to see:
- All active providers and their health status
- Every detected agent with full metadata
- Copilot extension details and API availability
- Peer instance registry
- Chat session file scan results

---

## Quick Start

### 1. Install & Open

Install from the VS Code Marketplace, then:
- Press `Cmd+Shift+D` (Mac) or `Ctrl+Shift+D` (Windows/Linux)
- Or click the **Agents** button in the status bar
- Or run `Agent Dashboard: Open` from the command palette

### 2. Select Your Agent Source

Open settings and set `agentDashboard.primarySource`:
- **`copilot`** -- Monitor GitHub Copilot sessions
- **`claude-code`** -- Monitor Claude Code CLI sessions
- **`both`** -- Monitor everything simultaneously

### 3. Optional: Mobile Monitoring

**Local (same Wi-Fi):**
The REST API starts automatically. Install the iOS app and enter your Mac's IP.

**Remote (anywhere):**
1. Run `Agent Dashboard: Setup Cloud Relay` from the command palette
2. Follow the prompts to deploy a Cloudflare Worker (free account)
3. Settings are configured automatically -- no manual URL copying

---

## Commands

| Command | Description |
|---------|-------------|
| `Agent Dashboard: Open` | Open the dashboard panel (`Cmd+Shift+D`) |
| `Agent Dashboard: Refresh` | Force a manual refresh |
| `Agent Dashboard: Start Mobile API Server` | Start the REST API for iOS app |
| `Agent Dashboard: Stop Mobile API Server` | Stop the REST API |
| `Agent Dashboard: Setup Cloud Relay` | One-click Cloudflare Worker deployment |
| `Agent Dashboard: Show Diagnostics` | Detailed debug info for all providers |

---

## Settings

### General

| Setting | Default | Description |
|---------|---------|-------------|
| `agentDashboard.primarySource` | `copilot` | Agent source: `copilot`, `claude-code`, or `both` |
| `agentDashboard.pollInterval` | `3000` | Refresh interval in milliseconds |
| `agentDashboard.claudeHomePath` | *(auto)* | Override path to `~/.claude` directory |
| `agentDashboard.showRemoteAgents` | `true` | Show remote/cloud agent sessions |
| `agentDashboard.showTokenCost` | `true` | Show estimated token cost |
| `agentDashboard.enabledProviders` | *(all on)* | Toggle individual data providers |

### Peer Sync

| Setting | Default | Description |
|---------|---------|-------------|
| `agentDashboard.peerSync` | `true` | Auto-discover other VS Code instances on this machine |
| `agentDashboard.peerPorts` | `[]` | Manually specify peer API ports |

### Mobile API

| Setting | Default | Description |
|---------|---------|-------------|
| `agentDashboard.apiAutoStart` | `true` | Start API server on VS Code launch |
| `agentDashboard.apiPort` | `19850` | Local API server port |
| `agentDashboard.cloudRelayUrl` | *(empty)* | Cloudflare Worker URL for remote access |
| `agentDashboard.cloudRelayToken` | *(empty)* | Auth token for cloud relay |

### Alerts

| Setting | Default | Description |
|---------|---------|-------------|
| `agentDashboard.alerts.enabled` | `false` | Enable email/SMS/webhook alerts |
| `agentDashboard.alerts.email.provider` | `none` | `sendgrid` or `smtp` |
| `agentDashboard.alerts.sms.provider` | `none` | `twilio` |
| `agentDashboard.alerts.webhook.url` | *(empty)* | Slack/Discord/custom webhook URL |
| `agentDashboard.alerts.rules` | *(defaults)* | Per-event alert routing rules |

---

## REST API

The extension exposes a local REST API for the iOS app and integrations:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | `GET` | Current dashboard state (agents, activities, stats) |
| `/api/health` | `GET` | Health check with version and instance ID |
| `/api/agents/{id}/conversation` | `GET` | Full conversation history for an agent |

Default: `http://localhost:19850`

---

## Architecture

```
VS Code Extension
├── 11 Data Providers (polled every 3s in parallel)
│   ├── Copilot Extension API
│   ├── Copilot Chat Session Files
│   ├── Claude Code JSONL Parser
│   ├── Terminal Process Scanner
│   ├── Peer Instance Provider
│   └── ... (6 more)
├── DashboardProvider (orchestrates + deduplicates)
│   ├── Webview Panel (HTML/CSS/JS dashboard)
│   ├── REST API Server (port 19850)
│   └── Cloud Relay Push (Cloudflare Worker)
└── Alert Engine (email/SMS/webhook)

Cloud Relay (Cloudflare Worker)
├── Per-instance KV storage
├── Multi-instance aggregation
└── Conversation proxying

iOS Companion App
├── Local Wi-Fi or Cloud Relay connection
├── Real-time polling with offline cache
└── Push notifications for agent events
```

---

## Development

```bash
cd extension
npm install
npm run watch    # TypeScript watch mode
# Press F5 to launch Extension Development Host
```

### Relay Development

```bash
cd relay
npm install
npm run dev      # Local Cloudflare Worker dev server
npm run setup    # Create KV namespace + deploy to Cloudflare
```

---

## Requirements

- VS Code 1.85 or later
- For Claude Code monitoring: Claude CLI installed (`~/.claude` directory)
- For Copilot monitoring: GitHub Copilot extension installed
- For mobile monitoring: iOS companion app (App Store)
- For cloud relay: Free Cloudflare account (optional)
- For GitHub Actions monitoring: `gh` CLI installed (optional)

---

## License

MIT
