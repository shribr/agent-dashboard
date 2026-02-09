import SwiftUI

struct AgentListView: View {
    let agents: [AgentSession]
    @State private var filter: AgentStatus? = nil
    @State private var expandedAgent: String? = nil
    @State private var searchText: String = ""

    var filteredAgents: [AgentSession] {
        var result = agents
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

                    // Filter chips
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
                    .padding(.vertical, 8)
                }

                if filteredAgents.isEmpty {
                    EmptyStateView(
                        icon: "magnifyingglass",
                        title: "No Matching Agents",
                        subtitle: "Try a different search term or clear the filter"
                    )
                    .padding(.top, 40)
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(filteredAgents) { agent in
                            AgentCard(agent: agent, isExpanded: expandedAgent == agent.id)
                                .onTapGesture {
                                    withAnimation(.spring(response: 0.3)) {
                                        expandedAgent = expandedAgent == agent.id ? nil : agent.id
                                    }
                                }
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 20)
                }
            }
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

// MARK: - Agent Card

struct AgentCard: View {
    let agent: AgentSession
    let isExpanded: Bool

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
                    }
                }

                Spacer()

                // Status badge
                Text(agent.status.displayName)
                    .font(.caption)
                    .fontWeight(.medium)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor.opacity(0.15))
                    .foregroundStyle(statusColor)
                    .clipShape(Capsule())
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

            // Expanded details
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

// MARK: - Indeterminate Progress Bar

struct IndeterminateProgressBar: View {
    let color: Color
    @State private var offset: CGFloat = -0.3

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .leading) {
                // Track
                Capsule()
                    .fill(color.opacity(0.15))
                    .frame(height: 4)

                // Sliding bar
                Capsule()
                    .fill(color)
                    .frame(width: width * 0.3, height: 4)
                    .offset(x: offset * width)
            }
        }
        .frame(height: 4)
        .onAppear {
            withAnimation(
                .easeInOut(duration: 1.4)
                .repeatForever(autoreverses: true)
            ) {
                offset = 0.7
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
