import SwiftUI

enum AgentSheetType: Identifiable {
    case detail(AgentSession)
    case conversation(AgentSession)

    var id: String {
        switch self {
        case .detail(let a): return "detail-\(a.id)"
        case .conversation(let a): return "convo-\(a.id)"
        }
    }
}

struct AgentListView: View {
    let agents: [AgentSession]
    @EnvironmentObject var service: DashboardService
    @State private var filter: AgentStatus? = nil
    @State private var providerFilter: String? = nil
    @State private var presentedSheet: AgentSheetType? = nil
    @State private var searchText: String = ""

    var filteredAgents: [AgentSession] {
        var result = agents
        if let providerFilter = providerFilter {
            result = result.filter { $0.sourceProvider == providerFilter }
        }
        if let filter = filter {
            result = result.filter { $0.status == filter }
        }
        if !searchText.isEmpty {
            let term = searchText.lowercased()
            result = result.filter { agent in
                agent.name.lowercased().contains(term) ||
                agent.task.lowercased().contains(term) ||
                agent.model.lowercased().contains(term) ||
                agent.typeLabel.lowercased().contains(term) ||
                agent.sourceProvider.lowercased().contains(term) ||
                (agent.tasks ?? []).contains(where: {
                    ($0.content).lowercased().contains(term) ||
                    ($0.activeForm ?? "").lowercased().contains(term)
                })
            }
        }
        return result
    }

    /// Unique source providers present in the agent list, sorted by count descending
    private var activeProviders: [(id: String, name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for agent in agents {
            counts[agent.sourceProvider, default: 0] += 1
        }
        return counts
            .sorted { $0.value > $1.value }
            .map { (id: $0.key, name: Self.friendlyProviderName($0.key), count: $0.value) }
    }

    /// Maps internal provider IDs to short friendly names
    static func friendlyProviderName(_ id: String) -> String {
        switch id {
        case "copilot-extension": return "Copilot"
        case "copilot-chat-sessions": return "Copilot Sessions"
        case "vscode-chat-sessions": return "Chat Sessions"
        case "chat-tools-participants": return "Chat Agents"
        case "custom-workspace-agents": return "Custom Agents"
        case "terminal-processes": return "Terminals"
        case "claude-desktop-todos": return "Claude Desktop"
        case "github-actions": return "GitHub Actions"
        case "remote-connections": return "Remote"
        case "workspace-activity": return "Workspace"
        default: return id
        }
    }

    var body: some View {
        ScrollView {
            if agents.isEmpty {
                EmptyStateView(
                    icon: "cpu",
                    title: "No Agents Running",
                    subtitle: "Start an AI agent in VS Code and it will appear here"
                )
                .padding(.top, 60)
            } else {
                VStack(spacing: 0) {
                    // Search bar
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                        TextField("Search agents...", text: $searchText)
                            .textFieldStyle(.plain)
                            .font(.subheadline)
                        if !searchText.isEmpty {
                            Button {
                                searchText = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(10)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                    .padding(.top, 4)

                    // Status filter chips
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            FilterChip(label: "All", count: agents.count, isSelected: filter == nil) {
                                filter = nil
                            }
                            ForEach(activeStatuses, id: \.self) { status in
                                let count = agents.filter { $0.status == status }.count
                                if count > 0 {
                                    FilterChip(label: status.displayName, count: count, isSelected: filter == status) {
                                        filter = status
                                    }
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                    .padding(.top, 8)

                    // Source / provider filter chips (only show if 2+ providers)
                    if activeProviders.count >= 2 {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                Text("Source:")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .textCase(.uppercase)

                                ProviderChip(label: "All", isSelected: providerFilter == nil) {
                                    providerFilter = nil
                                }
                                ForEach(activeProviders, id: \.id) { provider in
                                    ProviderChip(
                                        label: "\(provider.name) (\(provider.count))",
                                        isSelected: providerFilter == provider.id
                                    ) {
                                        providerFilter = providerFilter == provider.id ? nil : provider.id
                                    }
                                }
                            }
                            .padding(.horizontal)
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(.bottom, 8)

                // Active filter summary + clear button
                if filter != nil || providerFilter != nil || !searchText.isEmpty {
                    HStack {
                        HStack(spacing: 6) {
                            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text("\(filteredAgents.count) of \(agents.count) agents")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                filter = nil
                                providerFilter = nil
                                searchText = ""
                            }
                        } label: {
                            Text("Clear Filters")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 4)
                }

                if filteredAgents.isEmpty {
                    EmptyStateView(
                        icon: "magnifyingglass",
                        title: "No Matching Agents",
                        subtitle: "Try a different search term or clear the filters"
                    )
                    .padding(.top, 40)
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(filteredAgents) { agent in
                            AgentCard(
                                agent: agent,
                                onShowDetails: {
                                    presentedSheet = .detail(agent)
                                },
                                onShowConversation: Self.conversationAction(for: agent, setter: { self.presentedSheet = $0 }),
                                onFilterProvider: { providerId in
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        providerFilter = providerFilter == providerId ? nil : providerId
                                    }
                                }
                            )
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 20)
                }
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .detail(let agent):
                AgentDetailPanel(agent: agent, onShowConversation: {
                    presentedSheet = .conversation(agent)
                })
            case .conversation(let agent):
                ConversationView(agent: agent, service: service)
            }
        }
    }

    /// Returns a conversation action closure for agents that support chat, or nil otherwise
    private static func conversationAction(for agent: AgentSession, setter: @escaping (AgentSheetType) -> Void) -> (() -> Void)? {
        guard agent.type == .copilot || agent.type == .claude else { return nil }
        return { setter(.conversation(agent)) }
    }

    private var activeStatuses: [AgentStatus] {
        [.running, .thinking, .paused, .done, .error, .queued]
    }
}

// MARK: - Filter Chip

struct FilterChip: View {
    let label: String
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption)
                    .fontWeight(isSelected ? .semibold : .regular)
                Text("\(count)")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(isSelected ? Color.white.opacity(0.3) : Color.secondary.opacity(0.2))
                    .clipShape(Capsule())
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isSelected ? Color.accentColor : Color(.secondarySystemFill))
            .foregroundStyle(isSelected ? .white : .primary)
            .clipShape(Capsule())
        }
    }
}

// MARK: - Provider Chip

struct ProviderChip: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption2)
                .fontWeight(isSelected ? .semibold : .regular)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(isSelected ? Color.cyan.opacity(0.15) : Color(.tertiarySystemFill))
                .foregroundStyle(isSelected ? .cyan : .secondary)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .strokeBorder(isSelected ? Color.cyan.opacity(0.4) : Color.clear, lineWidth: 1)
                )
        }
    }
}

// MARK: - Agent Card

struct AgentCard: View {
    let agent: AgentSession
    let onShowDetails: () -> Void
    var onShowConversation: (() -> Void)? = nil
    var onFilterProvider: ((String) -> Void)? = nil

    /// Normalizes agent display name — Copilot Chat sessions just show "Copilot Chat"
    private var displayName: String {
        let name = agent.name.trimmingCharacters(in: .whitespaces)
        if name.lowercased().hasPrefix("copilot chat") {
            return "Copilot Chat"
        }
        return name
    }

    /// Task summary — uses server-provided smart summary, falls back to cleaning raw text
    private var cardSummary: String {
        let text = agent.task.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text == "Chat session" {
            return "Chat session"
        }
        // Clean up any remaining technical artifacts
        var cleaned = text
        cleaned = cleaned.replacingOccurrences(of: #"\(?[Ii]d\s*=\s*[a-fA-F0-9\-]+,?\s*(accessMode\s*=\s*\d+)?\)?"#, with: "", options: .regularExpression)
        cleaned = cleaned.replacingOccurrences(of: #"\b[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\b"#, with: "", options: .regularExpression)
        cleaned = cleaned.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? "Chat session" : cleaned
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header row 1: Status icon, name, and status badge
            HStack(alignment: .top) {
                // Status icon
                Image(systemName: agent.status.iconName)
                    .foregroundStyle(statusColor)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 4) {
                    // Agent name
                    Text(displayName)
                        .font(.headline)
                        .lineLimit(1)

                    // Type and location labels
                    HStack(spacing: 6) {
                        Label(agent.typeLabel, systemImage: agentTypeIcon)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)

                        Label(agent.location.rawValue.capitalized, systemImage: agent.location.iconName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                // Status badge (right side)
                Text(agent.status.displayName)
                    .font(.caption)
                    .fontWeight(.medium)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor.opacity(0.15))
                    .foregroundStyle(statusColor)
                    .clipShape(Capsule())
                    .lineLimit(1)
                    .fixedSize()
            }

            // Header row 2: Action buttons (Chat, Details) + Source provider chip
            HStack(spacing: 8) {
                // Source provider chip
                if let onFilterProvider = onFilterProvider {
                    Button {
                        onFilterProvider(agent.sourceProvider)
                    } label: {
                        Text(AgentListView.friendlyProviderName(agent.sourceProvider))
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundStyle(.cyan)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.cyan.opacity(0.1))
                            .clipShape(Capsule())
                            .lineLimit(1)
                            .fixedSize()
                    }
                }

                Spacer()

                // Action buttons
                HStack(spacing: 6) {
                    if let onConvo = onShowConversation {
                        let hasHistory = agent.hasConversationHistory ?? false
                        Button(action: onConvo) {
                            Label("Chat", systemImage: "bubble.left.and.bubble.right")
                                .font(.caption2)
                                .fontWeight(.medium)
                                .foregroundStyle(hasHistory ? .blue : .secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(hasHistory ? Color.blue.opacity(0.1) : Color(.tertiarySystemFill))
                                .clipShape(Capsule())
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .disabled(!hasHistory)
                        .opacity(hasHistory ? 1.0 : 0.5)
                    }

                    Button(action: onShowDetails) {
                        Label("Details", systemImage: "chevron.right")
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.tertiarySystemFill))
                            .clipShape(Capsule())
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }

            // Task description (cleaned summary from conversation or task)
            Text(cardSummary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            // Task summary (compact — shows X/Y tasks done)
            if let tasks = agent.tasks, !tasks.isEmpty {
                let completed = tasks.filter { $0.status == .completed }.count
                HStack(spacing: 4) {
                    Image(systemName: "checklist")
                        .font(.caption2)
                    Text("\(completed)/\(tasks.count) tasks done")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
            }

            // Progress bar (if active)
            if agent.status == .running || agent.status == .thinking {
                VStack(alignment: .leading, spacing: 4) {
                    if agent.progress > 0 {
                        ProgressView(value: agent.progress / 100)
                            .tint(statusColor)
                    } else {
                        IndeterminateProgressBar(color: statusColor)
                    }

                    HStack {
                        Text(agent.progressLabel)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Spacer()
                        if agent.progress > 0 {
                            Text("\(Int(agent.progress))%")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        } else {
                            Text(agent.elapsed)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    private var statusColor: Color {
        switch agent.status {
        case .running: return .blue
        case .thinking: return .purple
        case .paused: return .orange
        case .done: return .green
        case .error: return .red
        case .queued: return .gray
        }
    }

    private var agentTypeIcon: String {
        switch agent.type {
        case .copilot: return "sparkle"
        case .claude: return "brain"
        case .codex: return "curlybraces"
        case .custom: return "cpu"
        }
    }

    private func formatTokens(_ tokens: Int) -> String {
        if tokens >= 1_000_000 {
            return String(format: "%.1fM", Double(tokens) / 1_000_000)
        } else if tokens >= 1_000 {
            return String(format: "%.1fK", Double(tokens) / 1_000)
        }
        return "\(tokens)"
    }
}

// MARK: - Agent Detail Panel (slide-out sheet)

struct AgentDetailPanel: View {
    let agent: AgentSession
    var onShowConversation: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    /// Normalizes agent display name — Copilot Chat sessions just show "Copilot Chat"
    private var displayName: String {
        let name = agent.name.trimmingCharacters(in: .whitespaces)
        if name.lowercased().hasPrefix("copilot chat") {
            return "Copilot Chat"
        }
        return name
    }

    /// Task summary for display
    private var taskSummary: String {
        let text = agent.task.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text == "Chat session" {
            return "Chat session"
        }
        return text
    }

    /// Format conversation date for display
    private var conversationDateString: String {
        let date = Date(timeIntervalSince1970: TimeInterval(agent.startTime) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Status header
                    HStack {
                        Image(systemName: agent.status.iconName)
                            .foregroundStyle(statusColor)
                            .font(.title2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(displayName)
                                .font(.headline)
                            Text(taskSummary)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(agent.status.displayName)
                            .font(.caption)
                            .fontWeight(.semibold)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(statusColor.opacity(0.15))
                            .foregroundStyle(statusColor)
                            .clipShape(Capsule())
                    }

                    Divider()

                    // Info section
                    VStack(alignment: .leading, spacing: 10) {
                        Text("INFO")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(.secondary)
                            .tracking(0.5)

                        DetailRow(label: "Model", value: agent.model)
                        DetailRow(label: "Provider", value: agent.sourceProvider)
                        DetailRow(label: "Date", value: conversationDateString)
                        DetailRow(label: "Tokens", value: formatTokens(agent.tokens))
                        DetailRow(label: "Location", value: agent.remoteHost ?? agent.location.rawValue.capitalized)

                        if let pid = agent.pid {
                            DetailRow(label: "PID", value: "\(pid)")
                        }
                        if let tool = agent.activeTool {
                            DetailRow(label: "Active Tool", value: tool)
                        }
                    }

                    // Tasks & Todos section
                    if let tasks = agent.tasks, !tasks.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: 10) {
                            let completed = tasks.filter { $0.status == .completed }.count
                            Text("TASKS & TODOS (\(completed)/\(tasks.count) done)")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            ForEach(tasks) { task in
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: task.status.iconName)
                                        .font(.subheadline)
                                        .foregroundStyle(task.status.color)
                                        .frame(width: 20)

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(task.activeForm ?? task.content)
                                            .font(.subheadline)
                                            .foregroundStyle(task.status == .completed ? .secondary : .primary)
                                            .strikethrough(task.status == .completed)
                                            .fontWeight(task.status == .in_progress ? .semibold : .regular)

                                        Text(task.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                                            .font(.caption2)
                                            .foregroundStyle(task.status.color)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }

                    // Files section
                    if !agent.files.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: 10) {
                            Text("FILES (\(agent.files.count))")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            ForEach(Array(agent.files.enumerated()), id: \.offset) { _, file in
                                HStack(spacing: 6) {
                                    Image(systemName: "doc.text")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(file)
                                        .font(.caption)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }

                    // Tools section
                    if !agent.tools.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: 10) {
                            Text("TOOLS")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            FlowLayout(spacing: 6) {
                                ForEach(Array(agent.tools.enumerated()), id: \.offset) { _, tool in
                                    Text(tool)
                                        .font(.caption)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(Color(.tertiarySystemFill))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }

                    // Activity Timeline section
                    if let actions = agent.recentActions, !actions.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: 10) {
                            Text("ACTIVITY TIMELINE (\(actions.count))")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            ForEach(actions.reversed()) { action in
                                HStack(spacing: 10) {
                                    // Tool icon
                                    Image(systemName: action.iconName)
                                        .font(.caption)
                                        .foregroundStyle(action.iconColor)
                                        .frame(width: 20)

                                    // Tool name + detail
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(action.tool)
                                            .font(.caption2)
                                            .fontWeight(.semibold)
                                            .foregroundStyle(action.iconColor)
                                            .textCase(.uppercase)

                                        Text(action.detail)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }

                                    Spacer()

                                    // Status icon
                                    Image(systemName: action.status.iconName)
                                        .font(.caption2)
                                        .foregroundStyle(action.status.color)
                                }
                                .padding(.vertical, 4)
                                .padding(.horizontal, 8)
                                .background(Color(.tertiarySystemFill).opacity(0.5))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }

                    // Conversation Summary
                    if agent.hasConversationHistory == true {
                        Divider()

                        VStack(alignment: .leading, spacing: 8) {
                            Text("CONVERSATION")
                                .font(.caption2)
                                .fontWeight(.semibold)
                                .foregroundStyle(.secondary)
                                .tracking(0.5)

                            // Show task summary as conversation context
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "bubble.left.and.bubble.right")
                                    .font(.caption)
                                    .foregroundStyle(.purple)
                                Text(taskSummary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                            .padding(8)
                            .background(Color.purple.opacity(0.05))
                            .clipShape(RoundedRectangle(cornerRadius: 6))

                            // Conversation stats if preview data available
                            if let convo = agent.conversationPreview, !convo.isEmpty {
                                let userCount = convo.filter { $0.hasPrefix("\u{1F464}") }.count
                                let botCount = convo.filter { $0.hasPrefix("\u{1F916}") }.count
                                let toolCount = convo.filter { $0.hasPrefix("\u{1F527}") }.count

                                HStack(spacing: 12) {
                                    if userCount > 0 {
                                        Label("\(userCount) prompts", systemImage: "person.fill")
                                            .font(.caption2)
                                            .foregroundStyle(.purple)
                                    }
                                    if botCount > 0 {
                                        Label("\(botCount) responses", systemImage: "sparkles")
                                            .font(.caption2)
                                            .foregroundStyle(.green)
                                    }
                                    if toolCount > 0 {
                                        Label("\(toolCount) tool calls", systemImage: "wrench")
                                            .font(.caption2)
                                            .foregroundStyle(.cyan)
                                    }
                                }
                            }

                            // Tappable link to open full conversation
                            Button {
                                dismiss()
                                // Small delay to let detail sheet dismiss before opening conversation
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                    onShowConversation?()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "bubble.left.and.bubble.right.fill")
                                        .font(.caption2)
                                    Text("View full chat history")
                                        .font(.caption2)
                                        .fontWeight(.medium)
                                }
                                .foregroundStyle(.blue)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color.blue.opacity(0.08))
                                .clipShape(Capsule())
                            }
                        }
                    }

                    // Parent agent link
                    if let parentId = agent.parentId, !parentId.isEmpty {
                        Divider()

                        HStack(spacing: 6) {
                            Image(systemName: "arrow.turn.left.up")
                                .font(.caption)
                                .foregroundStyle(.purple)
                            Text("Subagent of parent session")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Agent Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case .running: return .blue
        case .thinking: return .purple
        case .paused: return .orange
        case .done: return .green
        case .error: return .red
        case .queued: return .gray
        }
    }

    private func formatTokens(_ tokens: Int) -> String {
        if tokens >= 1_000_000 {
            return String(format: "%.1fM", Double(tokens) / 1_000_000)
        } else if tokens >= 1_000 {
            return String(format: "%.1fK", Double(tokens) / 1_000)
        }
        return "\(tokens)"
    }
}

// MARK: - Conversation History View

struct ConversationView: View {
    let agent: AgentSession
    let service: DashboardService

    @Environment(\.dismiss) private var dismiss
    @State private var turns: [ConversationTurn] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var searchText: String = ""

    /// Normalizes agent display name — Copilot Chat sessions just show "Copilot Chat"
    private var displayAgentName: String {
        let name = agent.name.trimmingCharacters(in: .whitespaces)
        if name.lowercased().hasPrefix("copilot chat") {
            return "Copilot Chat"
        }
        return name
    }

    /// Format conversation date for title
    private var conversationDateString: String {
        let date = Date(timeIntervalSince1970: TimeInterval(agent.startTime) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// Detect if the agent is likely waiting for user input:
    /// status is running/thinking AND the last message is from the assistant (not user).
    private var isAwaitingInput: Bool {
        guard agent.status == .running || agent.status == .thinking else { return false }
        guard let lastTurn = turns.last else { return false }
        return lastTurn.isAssistant
    }

    var filteredTurns: [ConversationTurn] {
        if searchText.isEmpty { return turns }
        let term = searchText.lowercased()
        return turns.filter { turn in
            turn.content.lowercased().contains(term) ||
            (turn.toolCalls ?? []).contains(where: { $0.name.lowercased().contains(term) || $0.detail.lowercased().contains(term) })
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    VStack(spacing: 16) {
                        ProgressView()
                            .scaleEffect(1.2)
                        Text("Loading conversation...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = errorMessage {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if turns.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("No conversation history found")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(filteredTurns.enumerated()), id: \.offset) { index, turn in
                                    ConversationBubble(
                                        turn: turn,
                                        isAwaitingInput: isAwaitingInput && index == filteredTurns.count - 1
                                    )
                                    .id(index)
                                }
                            }
                            .padding()
                        }
                        .onAppear {
                            if !filteredTurns.isEmpty {
                                proxy.scrollTo(filteredTurns.count - 1, anchor: .bottom)
                            }
                        }
                    }
                }
            }
            .navigationTitle(displayAgentName)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search messages...")
            .toolbar {
                // Show date in header
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text(displayAgentName)
                            .font(.headline)
                        Text(conversationDateString)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await loadConversation()
        }
    }

    private func loadConversation() async {
        isLoading = true
        errorMessage = nil
        do {
            let result = try await service.fetchConversationHistory(agentId: agent.id)
            if result.isEmpty {
                errorMessage = "No conversation history found for this session."
            }
            turns = result
        } catch let error as DecodingError {
            print("[ConversationView] Decode error: \(error)")
            errorMessage = "Failed to decode conversation data. The server response format may be incompatible."
            turns = []
        } catch {
            print("[ConversationView] Fetch error: \(error)")
            errorMessage = "Failed to load conversation: \(error.localizedDescription)"
            turns = []
        }
        isLoading = false
    }
}

// MARK: - Conversation Bubble

struct ConversationBubble: View {
    let turn: ConversationTurn
    let isAwaitingInput: Bool

    @State private var showToolCalls = false
    @State private var pulseOpacity: Double = 0.0

    var body: some View {
        VStack(alignment: turn.isUser ? .trailing : .leading, spacing: 4) {
            // Role label
            HStack(spacing: 4) {
                Image(systemName: turn.isUser ? "person.fill" : turn.isSystem ? "gear" : "sparkles")
                    .font(.caption2)
                    .foregroundStyle(turn.isUser ? .purple : turn.isSystem ? .orange : .green)
                Text(turn.isUser ? "You" : turn.isSystem ? "System" : "Assistant")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(turn.isUser ? .purple : turn.isSystem ? .orange : .green)

                if let ts = turn.timestamp, ts > 0 {
                    Text(formatTimestamp(ts))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Message bubble
            Text(turn.content)
                .font(.callout)
                .foregroundStyle(turn.isUser ? .white : .primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(turn.isUser ? Color.purple : Color(.secondarySystemFill))
                )
                .overlay(
                    // "Waiting for input" red pulse border
                    Group {
                        if isAwaitingInput && !turn.isUser {
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.red, lineWidth: 2)
                                .opacity(pulseOpacity)
                                .onAppear {
                                    withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                                        pulseOpacity = 0.8
                                    }
                                }
                        }
                    }
                )
                .frame(maxWidth: 320, alignment: turn.isUser ? .trailing : .leading)

            // "Awaiting input" badge
            if isAwaitingInput && !turn.isUser {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.bubble.fill")
                        .font(.caption2)
                    Text("Agent is waiting for your input")
                        .font(.caption2)
                        .fontWeight(.medium)
                }
                .foregroundStyle(.red)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.red.opacity(0.1))
                .clipShape(Capsule())
            }

            // Tool calls (collapsible)
            if let tools = turn.toolCalls, !tools.isEmpty {
                Button {
                    withAnimation(.spring(response: 0.25)) {
                        showToolCalls.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: showToolCalls ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                            .font(.caption2)
                        Text("\(tools.count) tool call\(tools.count == 1 ? "" : "s")")
                            .font(.caption2)
                            .fontWeight(.medium)
                        Image(systemName: showToolCalls ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8))
                    }
                    .foregroundStyle(.cyan)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.cyan.opacity(0.1))
                    .clipShape(Capsule())
                }

                if showToolCalls {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 4) {
                                    Image(systemName: toolIcon(tool.name))
                                        .font(.caption2)
                                        .foregroundStyle(.cyan)
                                    Text(tool.name)
                                        .font(.caption)
                                        .fontWeight(.semibold)
                                        .foregroundStyle(.primary)
                                    if tool.isError == true {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.caption2)
                                            .foregroundStyle(.red)
                                    }
                                }

                                if !tool.detail.isEmpty {
                                    Text(tool.detail)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(4)
                                }

                                if let result = tool.result, !result.isEmpty {
                                    Text(result)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(3)
                                        .padding(.leading, 8)
                                }
                            }
                            .padding(8)
                            .background(Color(.tertiarySystemFill))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                    .padding(.leading, 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: turn.isUser ? .trailing : .leading)
    }

    private func formatTimestamp(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000.0)
        let formatter = DateFormatter()
        // Show date if not today, otherwise just time
        if Calendar.current.isDateInToday(date) {
            formatter.timeStyle = .short
            formatter.dateStyle = .none
        } else {
            formatter.timeStyle = .short
            formatter.dateStyle = .short
        }
        return formatter.string(from: date)
    }

    private func toolIcon(_ name: String) -> String {
        switch name.lowercased() {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "write": return "doc.badge.plus"
        case "bash": return "terminal"
        case "search", "grep", "glob": return "magnifyingglass"
        case "task": return "arrow.triangle.branch"
        default: return "wrench"
        }
    }
}

// MARK: - Indeterminate Progress Bar

struct IndeterminateProgressBar: View {
    let color: Color
    @State private var phase: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            Capsule()
                .fill(color.opacity(0.15))
                .frame(height: 4)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [color.opacity(0.3), color, color.opacity(0.3)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: width * 0.3, height: 4)
                        .offset(x: -width * 0.3 + phase * (width * 1.3))
                }
                .clipShape(Capsule())
        }
        .frame(height: 4)
        .onAppear {
            withAnimation(
                .linear(duration: 3.0)
                .repeatForever(autoreverses: false)
            ) {
                phase = 1.0
            }
        }
    }
}

// MARK: - Detail Row

struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.caption)
                .foregroundStyle(.primary)
            Spacer()
        }
    }
}

// MARK: - Flow Layout (for tool tags)

struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layoutSubviews(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layoutSubviews(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
        }
    }

    private func layoutSubviews(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            totalHeight = y + rowHeight
        }

        return (CGSize(width: maxWidth, height: totalHeight), positions)
    }
}

// MARK: - Empty State

struct EmptyStateView: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.headline)
                .foregroundStyle(.secondary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}
