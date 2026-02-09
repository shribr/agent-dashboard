# Agent Dashboard for iOS

Companion iOS app for the [Agent Dashboard VS Code extension](../agent-dashboard-ext). Monitor your AI coding agents from your iPhone or iPad.

## Features

- **Real-time monitoring** — See all running agents, token usage, costs, and progress
- **Agent cards** — Expandable cards with full details (tools, files, PID, model)
- **Activity feed** — Timeline of agent actions with color-coded categories
- **Data source health** — See which providers are connected, degraded, or unavailable
- **Two connection modes:**
  - **Local Network** — Direct connection over Wi-Fi (no cloud needed)
  - **Cloud Relay** — Access from anywhere via Cloudflare Worker

## Requirements

- iOS 17.0+ / iPadOS 17.0+
- Xcode 15.4+
- Agent Dashboard VS Code Extension v0.3.0+

## Setup

### 1. VS Code Extension (already installed)

The extension auto-starts a REST API server on port `19850`. Verify it's running:

```
curl http://localhost:19850/api/health
```

### 2. Local Network (same Wi-Fi)

1. Open the iOS app
2. Enter your Mac's local IP address (find it in System Settings > Network)
3. Tap **Connect**

### 3. Cloud Relay (remote access)

For access from anywhere, deploy the Cloudflare Worker relay:

```bash
cd agent-dashboard-relay
npm install
npx wrangler login     # one-time auth
npx wrangler deploy    # deploys to your-worker.your-subdomain.workers.dev
```

Then configure both sides:

**VS Code settings:**
```json
{
  "agentDashboard.cloudRelayUrl": "https://agent-dashboard-relay.YOUR-SUBDOMAIN.workers.dev",
  "agentDashboard.cloudRelayToken": "your-secret-token"
}
```

**iOS app:** Settings > Cloud Relay > paste the same worker URL

## Building

1. Open `AgentDashboard.xcodeproj` in Xcode
2. Select your team in Signing & Capabilities
3. Build and run on your device or simulator

## Architecture

```
AgentDashboard/
├── AgentDashboardApp.swift     # App entry point
├── Models/
│   └── DashboardModels.swift   # Data types (mirrors VS Code extension)
├── Services/
│   └── DashboardService.swift  # Networking, polling, discovery
└── Views/
    ├── ContentView.swift       # Main tab view with stats bar
    ├── AgentListView.swift     # Agent cards with filters
    ├── ActivityListView.swift  # Timeline activity feed
    ├── HealthView.swift        # Data source health cards
    ├── ConnectionView.swift    # Initial setup / connection screen
    └── SettingsView.swift      # Connection & polling settings
```

## API Endpoints

The VS Code extension serves these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Full dashboard state (agents, activities, stats, health) |
| `/api/health` | GET | Server version, uptime, status |
