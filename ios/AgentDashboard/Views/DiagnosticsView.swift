import SwiftUI

struct DiagnosticsView: View {
    @EnvironmentObject var service: DashboardService
    @State private var reportText: String = ""
    @State private var showCopied: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Data source health
                VStack(alignment: .leading, spacing: 10) {
                    Text("DATA SOURCE HEALTH")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .tracking(0.5)

                    if let sources = service.state?.dataSourceHealth, !sources.isEmpty {
                        ForEach(sources) { source in
                            HStack(spacing: 10) {
                                Image(systemName: source.state.iconName)
                                    .foregroundStyle(healthColor(source.state))
                                    .frame(width: 20)
                                Text(source.name)
                                    .font(.subheadline)
                                Spacer()
                                Text("\(source.agentCount) agents")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(source.state.displayName)
                                    .font(.caption2)
                                    .fontWeight(.medium)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(healthColor(source.state).opacity(0.12))
                                    .foregroundStyle(healthColor(source.state))
                                    .clipShape(Capsule())
                            }
                        }
                    } else {
                        Text("No data sources available")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }

                Divider()

                // Agent summary
                VStack(alignment: .leading, spacing: 10) {
                    Text("AGENT SUMMARY")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .tracking(0.5)

                    if let agents = service.state?.agents, !agents.isEmpty {
                        let byStatus = Dictionary(grouping: agents, by: { $0.status })
                        ForEach(AgentStatus.allCases, id: \.self) { status in
                            if let group = byStatus[status] {
                                HStack {
                                    Image(systemName: status.iconName)
                                        .font(.caption)
                                        .foregroundStyle(statusColor(status))
                                        .frame(width: 20)
                                    Text(status.displayName)
                                        .font(.subheadline)
                                    Spacer()
                                    Text("\(group.count)")
                                        .font(.subheadline)
                                        .fontWeight(.semibold)
                                }
                            }
                        }

                        Divider()

                        Text("BY PROVIDER")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundStyle(.tertiary)
                            .tracking(0.5)

                        let byProvider = Dictionary(grouping: agents, by: { $0.sourceProvider })
                        ForEach(byProvider.keys.sorted(), id: \.self) { provider in
                            HStack {
                                Text(AgentListView.friendlyProviderName(provider))
                                    .font(.subheadline)
                                Spacer()
                                Text("\(byProvider[provider]?.count ?? 0)")
                                    .font(.subheadline)
                                    .fontWeight(.semibold)
                            }
                        }
                    } else {
                        Text("No agents")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }

                Divider()

                // Connection details
                VStack(alignment: .leading, spacing: 10) {
                    Text("CONNECTION DETAILS")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .tracking(0.5)

                    diagRow("Mode", service.connectionMode.rawValue)
                    diagRow("Base URL", service.baseURL)
                    diagRow("Poll Interval", "\(Int(service.pollInterval))s")
                    if let version = service.serverVersion {
                        diagRow("Server", "v\(version)")
                    }
                    if let date = service.lastUpdated {
                        HStack {
                            Text("Last Update")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 100, alignment: .leading)
                            Text(date, style: .relative)
                                .font(.caption)
                            Spacer()
                        }
                    }
                }

                Divider()

                // Copy report
                Button {
                    reportText = service.generateDiagnosticReport()
                    UIPasteboard.general.string = reportText
                    showCopied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        showCopied = false
                    }
                } label: {
                    HStack {
                        Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                        Text(showCopied ? "Copied to Clipboard" : "Copy Diagnostic Report")
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(showCopied ? .green : .accentColor)

                if !reportText.isEmpty {
                    Text(reportText)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding()
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding()
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func diagRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 100, alignment: .leading)
            Text(value)
                .font(.caption)
            Spacer()
        }
    }

    private func healthColor(_ state: HealthState) -> Color {
        switch state {
        case .connected: return .green
        case .degraded: return .orange
        case .unavailable: return .red
        case .checking: return .gray
        }
    }

    private func statusColor(_ status: AgentStatus) -> Color {
        switch status {
        case .running: return .blue
        case .thinking: return .purple
        case .paused: return .orange
        case .done: return .green
        case .error: return .red
        case .queued: return .gray
        }
    }
}
