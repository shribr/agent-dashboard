import SwiftUI

struct ActivityListView: View {
    let activities: [ActivityItem]

    var body: some View {
        ScrollView {
            if activities.isEmpty {
                EmptyStateView(
                    icon: "list.bullet.rectangle",
                    title: "No Activity Yet",
                    subtitle: "Agent actions will appear here in real time"
                )
                .padding(.top, 60)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(Array(activities.enumerated()), id: \.offset) { index, activity in
                        ActivityRow(activity: activity, isLast: index == activities.count - 1)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 20)
            }
        }
    }
}

struct ActivityRow: View {
    let activity: ActivityItem
    let isLast: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Timeline
            VStack(spacing: 0) {
                Circle()
                    .fill(activityColor)
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: activity.type.iconName)
                            .font(.caption2)
                            .fontWeight(.bold)
                            .foregroundStyle(.white)
                    }

                if !isLast {
                    Rectangle()
                        .fill(Color(.separator))
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 28)

            // Content
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(activity.agent)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Spacer()
                    Text(activity.timeLabel)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Text(activity.desc)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, 16)
        }
    }

    private var activityColor: Color {
        switch activity.type {
        case .tool_use: return .blue
        case .file_edit: return .indigo
        case .command: return .cyan
        case .thinking: return .purple
        case .complete: return .green
        case .error: return .red
        case .start: return .mint
        case .info: return .gray
        }
    }
}
