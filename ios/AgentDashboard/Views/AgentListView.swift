import SwiftUI

struct AgentListView: View {
    let agents: [AgentSession]
    @State private var filter: AgentStatus? = nil
    @State private var providerFilter: String? = nil
    @State private var expandedAgent: String? = nil
    @State private var detailAgent: AgentSession? = nil
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
                                isExpanded: expandedAgent == agent.id,
                                onToggleExpand: {
                                    withAnimation(.spring(response: 0.3)) {
                                        expandedAgent = expandedAgent == agent.id ? nil : agent.id
                                    }
                                },
                                onShowDetails: {
                                    detailAgent = agent
                                },
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
        .sheet(item: $detailAgent) { agent in
            AgentDetailPanel(agent: agent)
        }
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
    let isExpanded: Bool
    let onToggleExpand: () -> Void
    let onShowDetails: () -> Void
    var onFilterProvider: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack {
                // Status icon
                Image(systemName: agent.status.iconName)
                    .foregroundStyle(statusColor)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name)
                        .font(.headline)
                        .lineLimit(1)

                    HStack(spacing: 8) {
                        Label(agent.typeLabel, systemImage: agentTypeIcon)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Label(agent.location.rawValue.capitalized, systemImage: agent.location.iconName)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if let onFilterProvider = onFilterProvider {
                            Button {
                                onFilterProvider(agent.sourceProvider)
                            } label: {
                                Text(AgentListView.friendlyProviderName(agent.sourceProvider))
                                    .font(.caption2)
                                    .foregroundStyle(.cyan)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.cyan.opacity(0.1))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }

                Spacer()

                // Status badge + details button
                VStack(alignment: .trailing, spacing: 6) {
                    Text(agent.status.displayName)
                        .font(.caption)
                        .fontWeight(.medium)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())

                    Button(action: onShowDetails) {
                        Label("Details", systemImage: "chevron.right")
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color(.tertiarySystemFill))
                            .clipShape(Capsule())
                    }
                }
            }

            // Task description
            Text(agent.task)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(isExpanded ? nil : 2)

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

            // Expand/collapse button
            Button(action: onToggleExpand) {
                HStack(spacing: 4) {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                    if let tasks = agent.tasks, !tasks.isEmpty {
                        let completed = tasks.filter { $0.status == .completed }.count
                        Text("\(completed)/\(tasks.count) tasks")
                            .font(.caption2)
                    } else {
                        Text("More info")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color(.tertiarySystemFill))
                .clipShape(Capsule())
            }

            // Expanded inline details
            if isExpanded {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    DetailRow(label: "Model", value: agent.model)
                    DetailRow(label: "Provider", value: agent.sourceProvider)
                    DetailRow(label: "Elapsed", value: agent.elapsed)
                    DetailRow(label: "Tokens", value: formatTokens(agent.tokens))

                    if let pid = agent.pid {
                        DetailRow(label: "PID", value: "\(pid)")
                    }

                    if let host = agent.remoteHost {
                        DetailRow(label: "Host", value: host)
                    }

                    if let tool = agent.activeTool {
                        DetailRow(label: "Active Tool", value: tool)
                    }

                    // Task list (expanded)
                    if let tasks = agent.tasks, !tasks.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            let completed = tasks.filter { $0.status == .completed }.count
                            Text("Tasks (\(completed)/\(tasks.count) done)")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            ForEach(tasks) { task in
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: task.status.iconName)
                                        .font(.caption)
                                        .foregroundStyle(task.status.color)
                                        .frame(width: 16)

                                    Text(task.activeForm ?? task.content)
                                        .font(.caption)
                                        .foregroundStyle(task.status == .completed ? .secondary : .primary)
                                        .strikethrough(task.status == .completed)
                                        .fontWeight(task.status == .in_progress ? .semibold : .regular)
                                }
                            }
                        }
                    }

                    if !agent.tools.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Tools")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            FlowLayout(spacing: 4) {
                                ForEach(agent.tools, id: \.self) { tool in
                                    Text(tool)
                                        .font(.caption2)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Color(.tertiarySystemFill))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }

                    if !agent.files.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Files (\(agent.files.count))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            ForEach(agent.files.prefix(5), id: \.self) { file in
                                HStack(spacing: 4) {
                                    Image(systemName: "doc.text")
                                        .font(.caption2)
                                    Text(file)
                                        .font(.caption2)
                                        .lineLimit(1)
                                }
                                .foregroundStyle(.secondary)
                            }
                            if agent.files.count > 5 {
                                Text("+ \(agent.files.count - 5) more")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
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

    @Environment(\.dismiss) private var dismiss

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
                            Text(agent.name)
                                .font(.headline)
                            Text(agent.task)
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
                        DetailRow(label: "Elapsed", value: agent.elapsed)
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

                            ForEach(agent.files, id: \.self) { file in
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
                                ForEach(agent.tools, id: \.self) { tool in
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
