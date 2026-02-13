import Foundation
import SwiftUI

// MARK: - Dashboard State (mirrors VS Code extension types)

struct DashboardState: Codable {
    let agents: [AgentSession]
    let activities: [ActivityItem]
    let stats: DashboardStats
    let dataSourceHealth: [DataSourceStatus]
    let primarySource: String?
    let _relay: RelayMeta?
}

struct RelayMeta: Codable {
    let updatedAt: String?
    let source: String?
    let instanceCount: Int?
}

struct AgentTask: Codable, Identifiable {
    let content: String
    let status: AgentTaskStatus
    let activeForm: String?

    var id: String { "\(content)-\(status.rawValue)" }
}

enum AgentTaskStatus: String, Codable {
    case pending, in_progress, completed

    var displayName: String {
        switch self {
        case .pending: return "Pending"
        case .in_progress: return "In Progress"
        case .completed: return "Completed"
        }
    }

    var iconName: String {
        switch self {
        case .pending: return "circle"
        case .in_progress: return "play.circle.fill"
        case .completed: return "checkmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .pending: return .secondary
        case .in_progress: return .orange
        case .completed: return .green
        }
    }
}

struct AgentAction: Codable, Identifiable {
    let tool: String
    let detail: String
    let timestamp: Double
    let status: AgentActionStatus

    var id: String { "\(tool)-\(detail)-\(timestamp)" }

    var iconName: String {
        switch tool {
        case "Read": return "doc.text"
        case "Edit": return "pencil"
        case "Write": return "doc.badge.plus"
        case "Bash": return "terminal"
        case "Search": return "magnifyingglass"
        case "Subagent": return "arrow.triangle.branch"
        case "List": return "folder"
        default: return "circle.fill"
        }
    }

    var iconColor: Color {
        switch tool {
        case "Read": return .blue
        case "Edit": return .orange
        case "Write": return .green
        case "Bash": return .cyan
        case "Search": return .purple
        case "Subagent": return .yellow
        case "List": return .secondary
        default: return .secondary
        }
    }
}

enum AgentActionStatus: String, Codable {
    case running, done, error

    var iconName: String {
        switch self {
        case .running: return "ellipsis.circle"
        case .done: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .running: return .orange
        case .done: return .green
        case .error: return .red
        }
    }
}

struct AgentSession: Codable, Identifiable {
    let id: String
    let name: String
    let type: AgentType
    let typeLabel: String
    let model: String
    let status: AgentStatus
    let task: String
    let tokens: Int
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheCreationTokens: Int?
    let cacheReadTokens: Int?
    let estimatedCost: Double?
    let startTime: Double
    let elapsed: String
    let progress: Double
    let progressLabel: String
    let tools: [String]
    let activeTool: String?
    let files: [String]
    let location: AgentLocation
    let remoteHost: String?
    let pid: Int?
    let sourceProvider: String
    let tasks: [AgentTask]?
    let recentActions: [AgentAction]?
    let parentId: String?
    let workspace: String?
    let projectDescription: String?
    let conversationPreview: [String]?
    let hasConversationHistory: Bool?
}

enum AgentType: String, Codable {
    case copilot, claude, codex, custom
}

enum AgentStatus: String, Codable, CaseIterable {
    case running, thinking, paused, done, error, queued

    var displayName: String {
        switch self {
        case .running: return "Running"
        case .thinking: return "Thinking"
        case .paused: return "Paused"
        case .done: return "Done"
        case .error: return "Error"
        case .queued: return "Queued"
        }
    }

    var color: String {
        switch self {
        case .running: return "statusRunning"
        case .thinking: return "statusThinking"
        case .paused: return "statusPaused"
        case .done: return "statusDone"
        case .error: return "statusError"
        case .queued: return "statusQueued"
        }
    }

    var iconName: String {
        switch self {
        case .running: return "play.circle.fill"
        case .thinking: return "brain.head.profile"
        case .paused: return "pause.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .queued: return "clock.fill"
        }
    }
}

enum AgentLocation: String, Codable {
    case local, remote, cloud, peer

    var iconName: String {
        switch self {
        case .local: return "desktopcomputer"
        case .remote: return "network"
        case .cloud: return "cloud"
        case .peer: return "rectangle.on.rectangle"
        }
    }
}

struct ActivityItem: Codable, Identifiable {
    let agent: String
    let desc: String
    let type: ActivityType
    let timestamp: Double
    let timeLabel: String

    var id: String { "\(agent)-\(timestamp)" }
}

enum ActivityType: String, Codable {
    case tool_use, file_edit, command, thinking, complete, error, start, info

    var iconName: String {
        switch self {
        case .tool_use: return "wrench.fill"
        case .file_edit: return "doc.text.fill"
        case .command: return "terminal.fill"
        case .thinking: return "brain.head.profile"
        case .complete: return "checkmark.circle.fill"
        case .error: return "xmark.circle.fill"
        case .start: return "play.fill"
        case .info: return "info.circle.fill"
        }
    }

    var color: String {
        switch self {
        case .tool_use: return "activityTool"
        case .file_edit: return "activityFile"
        case .command: return "activityCommand"
        case .thinking: return "activityThinking"
        case .complete: return "statusDone"
        case .error: return "statusError"
        case .start: return "statusRunning"
        case .info: return "activityInfo"
        }
    }
}

struct DashboardStats: Codable {
    let total: Int
    let active: Int
    let completed: Int
    let tokens: Int
    let estimatedCost: Double
    let avgDuration: String
}

struct DataSourceStatus: Codable, Identifiable {
    let name: String
    let id: String
    let state: HealthState
    let message: String
    let lastChecked: Double
    let agentCount: Int
}

enum HealthState: String, Codable {
    case connected, degraded, unavailable, checking

    var displayName: String {
        switch self {
        case .connected: return "Connected"
        case .degraded: return "Degraded"
        case .unavailable: return "Unavailable"
        case .checking: return "Checking"
        }
    }

    var color: String {
        switch self {
        case .connected: return "healthConnected"
        case .degraded: return "healthDegraded"
        case .unavailable: return "healthUnavailable"
        case .checking: return "healthChecking"
        }
    }

    var iconName: String {
        switch self {
        case .connected: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .unavailable: return "xmark.circle.fill"
        case .checking: return "arrow.clockwise"
        }
    }
}

// MARK: - Conversation History

struct ConversationToolCall: Codable, Identifiable {
    let name: String
    let detail: String
    let result: String?
    let isError: Bool?

    var id: String { "\(name)-\(detail.prefix(40))" }
}

struct ConversationTurn: Codable, Identifiable {
    let role: String       // "user", "assistant", "system"
    let content: String
    let timestamp: Double?
    let toolCalls: [ConversationToolCall]?

    var id: String { "\(role)-\(content.prefix(30))-\(timestamp ?? 0)" }

    var isUser: Bool { role == "user" }
    var isAssistant: Bool { role == "assistant" }
    var isSystem: Bool { role == "system" }
}

struct ConversationResponse: Codable {
    let agentId: String
    let turns: [ConversationTurn]
    let error: String?
}

// MARK: - Health Check Response

struct HealthCheckResponse: Codable {
    let status: String
    let version: String
    let uptime: Double
}

// MARK: - Notification Models

enum NotificationEvent: String, CaseIterable, Codable {
    case agentCompleted = "agent-completed"
    case agentError = "agent-error"
    case agentStarted = "agent-started"
    case providerDegraded = "provider-degraded"

    var displayName: String {
        switch self {
        case .agentCompleted: return "Agent Completed"
        case .agentError: return "Agent Error"
        case .agentStarted: return "Agent Started"
        case .providerDegraded: return "Provider Degraded"
        }
    }

    var iconName: String {
        switch self {
        case .agentCompleted: return "checkmark.circle.fill"
        case .agentError: return "exclamationmark.triangle.fill"
        case .agentStarted: return "play.circle.fill"
        case .providerDegraded: return "exclamationmark.triangle.fill"
        }
    }

    var defaultEnabled: Bool {
        switch self {
        case .agentCompleted: return true
        case .agentError: return true
        case .agentStarted: return false
        case .providerDegraded: return true
        }
    }
}

struct NotificationSettings: Codable {
    var enabled: Bool = false
    var eventToggles: [String: Bool] = [:]

    func isEventEnabled(_ event: NotificationEvent) -> Bool {
        eventToggles[event.rawValue] ?? event.defaultEnabled
    }

    mutating func setEventEnabled(_ event: NotificationEvent, _ enabled: Bool) {
        eventToggles[event.rawValue] = enabled
    }
}

// MARK: - Provider Settings

struct ProviderSettings: Codable {
    var primarySource: String = "both"
    var enabledProviders: [String: Bool] = [:]

    func isProviderEnabled(_ id: String) -> Bool {
        enabledProviders[id] ?? true
    }

    mutating func toggleProvider(_ id: String) {
        enabledProviders[id] = !(enabledProviders[id] ?? true)
    }
}

// MARK: - Cached State

struct CachedDashboardState: Codable {
    let state: DashboardState
    let cachedAt: Double
    let serverVersion: String?
}
