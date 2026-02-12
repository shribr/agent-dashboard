# Agent Instructions — Agent Dashboard

## Project Overview

Agent Dashboard is a real-time visual monitoring system for AI coding agents (GitHub Copilot, Claude Code, Aider, Codex). It has three components:

| Component | Tech | Path | Entry Point |
|-----------|------|------|-------------|
| VS Code Extension | TypeScript | `extension/` | `extension/src/extension.ts` |
| iOS Companion App | SwiftUI (iOS 17+) | `ios/` | `ios/AgentDashboard/AgentDashboardApp.swift` |
| Cloud Relay | Cloudflare Workers (JS) | `relay/` | `relay/src/worker.js` |

## Architecture

### Extension (core)

The extension is a single-file TypeScript module (`extension/src/extension.ts`, ~4,500 lines). All types, providers, and logic live in this one file.

**Data Provider pattern** — The abstract `DataProvider` class defines the contract. Each provider independently fetches data and can fail without affecting others. Providers return `AgentSession[]` and `ActivityItem[]`.

Current providers:
- `CopilotExtensionProvider` — GitHub Copilot extension API
- `CopilotChatSessionProvider` — Copilot Chat sessions, MCP servers, swarms
- `VSCodeChatSessionsProvider` — Native VS Code Chat Sessions API
- `ChatToolsParticipantsProvider` — Chat tool participants and custom agents
- `CustomAgentsProvider` — Custom workspace agents
- `TerminalProcessProvider` — CLI agents via `ps aux`
- `GitHubActionsProvider` — CI workflow runs via `gh` CLI
- `ClaudeDesktopTodosProvider` — Claude Desktop `~/.claude/todos` files
- `RemoteConnectionProvider` — SSH and container sessions
- `WorkspaceActivityProvider` — Real-time filesystem watcher

**REST API server** — `DashboardProvider` hosts an HTTP server (default port 19850) that serves the aggregated `DashboardState` JSON to the iOS app and optionally pushes it to the cloud relay.

**Alert system** — `AlertEngine` sends email (SendGrid/SMTP), SMS (Twilio), and webhook notifications based on configurable rules.

### iOS App

SwiftUI app with `DashboardService` (ObservableObject) managing state. Polls the extension's REST API or cloud relay on a timer. Models in `DashboardModels.swift` mirror the TypeScript interfaces exactly — keep them in sync.

### Cloud Relay

Stateless Cloudflare Worker. Stores dashboard state in memory and optional KV. The extension POSTs state; the iOS app GETs it. Bearer token auth on write endpoints.

## Key Types

These types are the shared contract across all three components. When modifying them, update all three:

1. **`extension/src/extension.ts`** — TypeScript interfaces (source of truth)
2. **`ios/AgentDashboard/Models/DashboardModels.swift`** — Swift Codable structs
3. **`relay/src/worker.js`** — passthrough, but must handle any new fields

```
AgentSession    — an active agent (id, name, type, status, tokens, tasks, etc.)
AgentTask       — a todo item (content, status: pending/in_progress/completed)
AgentAction     — a recent tool invocation (tool, detail, timestamp, status)
ConversationTurn — a conversation message (role, content, toolCalls)
ActivityItem    — a feed entry (agent, desc, type, timestamp)
DashboardState  — root state: agents, activities, stats, dataSourceHealth
DataSourceStatus — provider health (name, id, state, message, agentCount)
```

## Coding Conventions

### TypeScript (Extension)
- Target: ES2020, Module: CommonJS, Strict mode enabled
- All code lives in `extension/src/extension.ts` — do not split into separate files without explicit request
- Use `// ─── Section ───` comment banners to separate major sections
- Providers extend `abstract class DataProvider` and implement `safeFetch()`
- Use the shared `vscode.OutputChannel` (`this._outputChannel`) for logging, never `console.log`
- Configuration reads: `vscode.workspace.getConfiguration('agentDashboard')`
- Build: `cd extension && npm run compile`
- Package: `cd extension && npm run package`

### Swift (iOS)
- SwiftUI, iOS 17.0+ deployment target
- `// MARK: -` comments for section organization
- Models use `Codable` and mirror TypeScript interfaces field-for-field
- `DashboardService` is the single `@Observable`/`@StateObject` service class
- Enums use `rawValue` strings matching the TypeScript union types exactly (e.g., `"in_progress"`)
- Build via Xcode: open `ios/AgentDashboard.xcodeproj`

### JavaScript (Relay)
- Plain JavaScript, no TypeScript, no build step
- Single file: `relay/src/worker.js`
- Deploy: `cd relay && npx wrangler deploy`
- Always return JSON via the `jsonResponse()` helper
- CORS headers on every response
- Auth via `Authorization: Bearer <token>` header

## API Endpoints

### Extension Local API (port 19850)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full dashboard state |
| GET | `/api/agents/:id/conversation` | Conversation history for agent |
| GET | `/api/health` | Health check with version |

### Cloud Relay

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/state` | No | Pull latest state |
| POST | `/api/state` | Bearer | Push state from extension |
| GET | `/api/agents/:id/conversation` | No | Pull conversation |
| POST | `/api/conversations` | Bearer | Push conversation data |
| GET | `/api/health` | No | Health check |

## Adding a New Data Provider

1. Create a new class extending `DataProvider` in `extension/src/extension.ts`
2. Implement `name`, `id`, and the `safeFetch()` method
3. Populate `this._agents` and `this._activities` in `safeFetch()`
4. Set `this._state` and `this._message` for health reporting
5. Register the provider in the `DashboardProvider` constructor's providers array
6. Add a toggle entry in `package.json` under `agentDashboard.enabledProviders`
7. Test that the provider fails gracefully (sets state to `'unavailable'`) when its data source is absent

## Adding a New Field to AgentSession

1. Add the field to the `AgentSession` interface in `extension/src/extension.ts`
2. Populate it in any relevant providers
3. Add the matching property to `AgentSession` struct in `ios/AgentDashboard/Models/DashboardModels.swift` (make it optional with `?` if not always present)
4. Update any views that should display the new field
5. The relay passes through JSON transparently — no changes needed unless you add a new endpoint

## Configuration

All extension settings are prefixed `agentDashboard.*` and defined in `extension/package.json` under `contributes.configuration`. Current version: **0.9.4**.

Key settings:
- `primarySource`: `"copilot"` | `"claude-code"` | `"both"`
- `pollInterval`: polling frequency in ms (default 3000)
- `enabledProviders`: object toggling each provider on/off
- `apiPort`: local API port (default 19850)
- `cloudRelayUrl` / `cloudRelayToken`: remote relay configuration
- `alerts.*`: email, SMS, webhook alert configuration

## Common Tasks

| Task | Command |
|------|---------|
| Build extension | `cd extension && npm run compile` |
| Watch mode | `cd extension && npm run watch` |
| Package .vsix | `cd extension && npm run package` |
| Deploy relay | `cd relay && npx wrangler deploy` |
| Build iOS | Open `ios/AgentDashboard.xcodeproj` in Xcode, build and run |
| Open dashboard | `Cmd+Shift+D` in VS Code |

## Important Notes

- **No test suite exists yet.** When adding tests, use the VS Code extension testing framework for the extension and XCTest for iOS.
- **No CI/CD pipeline exists yet.** The project is built and deployed manually.
- The extension is a single large file by design. Do not refactor it into multiple files unless explicitly asked.
- The relay is intentionally minimal. Keep it stateless and simple.
- Secrets (API keys, tokens) must never be committed. They belong in `.env` files (gitignored) or environment variables.
- When bumping the version, update both `extension/package.json` (version field) and the health endpoint version strings in the extension and relay.
