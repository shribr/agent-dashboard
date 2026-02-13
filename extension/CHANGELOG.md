# Changelog

## [0.9.4] - 2026-02-12

### Added

- **Peer Instance Sync**: Auto-discover and sync agents across multiple VS Code windows on the same machine
- **Multi-Instance Cloud Relay**: Multiple machines can push to the same Cloudflare Worker relay with aggregated views
- **Setup Cloud Relay command**: One-click automated Cloudflare Worker deployment from the command palette
- **First-run welcome notification**: Explains local Wi-Fi and cloud relay mobile monitoring options on install
- **Diagnostics: Peer Discovery section**: Shows instance registry, heartbeat status, and connected peers
- **`/api/instances` relay endpoint**: Lists all connected instances with metadata
- Dynamic version display in dashboard header (reads from `package.json` instead of hardcoded)

### Changed

- Cloud relay now stores state per-instance with KV TTL-based cleanup instead of single-slot overwrite
- REST API `/api/state` and `/api/health` responses now include `instanceId`
- Relay worker version bumped to 0.5.0

## [0.9.3] - 2026-02-10

### Added

- Notification settings and diagnostics view with agent and provider summaries
- Workspace and project description fields on agent sessions
- Enhanced agent detection and deduplication across providers with workspace scoping

## [0.9.2] - 2026-02-08

### Added

- Alert engine with email (SendGrid/SMTP), SMS (Twilio), and webhook support
- Configurable alert rules per event type
- Cloud relay for remote iOS app access via Cloudflare Workers
- REST API server for local iOS app connections

## [0.9.1] - 2026-02-05

### Added

- Conversation history viewer with on-demand loading
- Token usage breakdown (input, output, cache creation, cache read)
- Estimated cost calculation per agent
- Activity feed with relative timestamps

## [0.9.0] - 2026-02-01

### Added

- Initial release
- Live monitoring for GitHub Copilot, Claude Code, Codex, and Aider
- 10 independent data providers with individual toggle controls
- Agent cards with status, model, tokens, tools, and files
- Agent controls (pause/resume/stop) for local processes
- Multi-source filtering (Copilot, Claude Code, or Both)
- VS Code theme integration
- Status bar indicator
- iOS companion app REST API
