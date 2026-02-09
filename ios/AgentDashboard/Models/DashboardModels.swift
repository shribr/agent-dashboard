import Foundation
import SwiftUI

// MARK: - Dashboard State (mirrors VS Code extension types)

struct DashboardState: Codable {
    let agents: [AgentSession]
    let activities: [ActivityItem]
    let stats: DashboardStats
    let dataSourceHealth: [DataSourceStatus]
    let primarySource: String?
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

struct AgentSession: Codable, Identifiable {
    let id: String
    let name: String
    let type: AgentType
    let typeLabel: String
    let model: String
    let status: AgentStatus
    let task: String
    let tokens: Int
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
}

enum AgentType: String, Codable {
    case copilot, claude, codex, custom
}

enum AgentStatus: String, Codable {
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
    case local, remote, cloud

    var iconName: String {
        switch self {
        case .local: return "desktopcomputer"
        case .remote: return "network"
        case .cloud: return "cloud"
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

// MARK: - Health Check Response

struct HealthCheckResponse: Codable {
    let status: String
    let version: String
    let uptime: Double
}
