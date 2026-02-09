import SwiftUI

struct HealthView: View {
    let sources: [DataSourceStatus]

    var body: some View {
        ScrollView {
            if sources.isEmpty {
                EmptyStateView(
                    icon: "heart.text.square",
                    title: "No Data Sources",
                    subtitle: "Data source health will appear when connected"
                )
                .padding(.top, 60)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(sources) { source in
                        DataSourceCard(source: source)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 20)
            }
        }
    }
}

struct DataSourceCard: View {
    let source: DataSourceStatus

    var body: some View {
        HStack(spacing: 14) {
            // Health indicator
            ZStack {
                Circle()
                    .fill(healthColor.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: source.state.iconName)
                    .font(.title3)
                    .foregroundStyle(healthColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(source.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Spacer()
                    Text(source.state.displayName)
                        .font(.caption)
                        .fontWeight(.medium)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(healthColor.opacity(0.12))
                        .foregroundStyle(healthColor)
                        .clipShape(Capsule())
                }

                Text(source.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                HStack(spacing: 12) {
                    Label("\(source.agentCount) agent\(source.agentCount == 1 ? "" : "s")", systemImage: "cpu")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)

                    if source.lastChecked > 0 {
                        let date = Date(timeIntervalSince1970: source.lastChecked / 1000)
                        Text(date, style: .relative)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var healthColor: Color {
        switch source.state {
        case .connected: return .green
        case .degraded: return .orange
        case .unavailable: return .red
        case .checking: return .gray
        }
    }
}
