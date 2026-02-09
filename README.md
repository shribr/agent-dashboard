# Agent Dashboard

Real-time visual monitoring for AI coding agents — GitHub Copilot, Claude Code, Aider, and more.

## Structure

```
agent-dashboard/
├── extension/   VS Code extension (TypeScript)
├── ios/         iOS companion app (SwiftUI)
└── relay/       Cloudflare Worker for remote access
```

## Extension

The VS Code extension provides a live dashboard showing active agent sessions, task progress, activity feed, and data source health. It aggregates data from multiple providers:

- **Copilot Extension** — detects GitHub Copilot Chat sessions
- **Terminal Processes** — monitors CLI agents (Claude Code, Aider, Codex) via `ps aux`
- **Claude Desktop Todos** — reads `.claude/todos` files for task lists
- **GitHub Actions** — shows active CI workflow runs
- **Workspace Activity** — real-time file system watcher
- **Remote Connections** — detects SSH and container sessions

Features: search and filter agents, expandable agent cards with task lists, animated activity indicators, email/SMS/webhook alerts.

### Install

```bash
cd extension
npm install
npm run compile
npx @vscode/vsce package
# Install the .vsix in VS Code: Cmd+Shift+P → "Extensions: Install from VSIX"
```

Open with `Cmd+Shift+D`.

## iOS App

SwiftUI companion app for iPhone and iPad. Connects to the extension over local Wi-Fi or via the Cloudflare relay for remote access.

Open `ios/AgentDashboard.xcodeproj` in Xcode, select your signing team, build and run.

## Cloud Relay

A Cloudflare Worker that bridges the VS Code extension and the iOS app when they're not on the same network.

```bash
cd relay
npm install
# Edit wrangler.toml — set AUTH_TOKEN to a random secret
npx wrangler deploy
```

Then configure the relay URL and token in both the VS Code extension settings and the iOS app.

## License

MIT
