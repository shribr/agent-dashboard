import SwiftUI

struct ContentView: View {
    @EnvironmentObject var service: DashboardService
    @State private var selectedTab: Tab = .agents
    @State private var showSettings = false

    enum Tab: String, CaseIterable {
        case agents = "Agents"
        case activity = "Activity"
        case health = "Health"
    }

    private var hasDisplayableState: Bool {
        service.isConnected || (service.state != nil && service.isShowingCachedData)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if hasDisplayableState {
                    // Stats bar
                    StatsBar(stats: service.state?.stats)
                        .padding(.horizontal)
                        .padding(.top, 8)

                    // Stale data banner
                    if service.isShowingCachedData, let cachedAt = service.cachedAt {
                        HStack(spacing: 6) {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.caption2)
                            Text(service.isConnected ? "Showing cached data from" : "Offline — cached data from")
                                .font(.caption2)
                            Text(cachedAt, style: .relative)
                                .font(.caption2)
                                .fontWeight(.semibold)
                        }
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                        .padding(.horizontal)
                    }

                    // Tab picker
                    Picker("View", selection: $selectedTab) {
                        ForEach(Tab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.vertical, 8)

                    // Content
                    switch selectedTab {
                    case .agents:
                        AgentListView(agents: service.filteredAgents)
                    case .activity:
                        ActivityListView(activities: service.state?.activities ?? [])
                    case .health:
                        HealthView(sources: service.state?.dataSourceHealth ?? [])
                    }
                } else {
                    ConnectionView()
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Agent Dashboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionIndicator(
                        isConnected: service.isConnected,
                        lastUpdated: service.lastUpdated
                    )
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        .onAppear {
            if !service.localHost.isEmpty || !service.cloudURL.isEmpty {
                service.connect()
            }
        }
    }
}

// MARK: - Connection Indicator

struct ConnectionIndicator: View {
    let isConnected: Bool
    let lastUpdated: Date?

    var body: some View {
        Label {
            Text(isConnected ? "Live" : "Offline")
                .font(.caption2)
                .fontWeight(.semibold)
        } icon: {
            Image(systemName: isConnected ? "circle.fill" : "circle")
                .font(.system(size: 7))
                .foregroundStyle(isConnected ? .green : .secondary)
        }
        .foregroundStyle(isConnected ? .green : .secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule()
                .fill((isConnected ? Color.green : Color.secondary).opacity(0.12))
                .overlay(
                    Capsule()
                        .strokeBorder((isConnected ? Color.green : Color.secondary).opacity(0.25), lineWidth: 0.5)
                )
        )
    }
}

// MARK: - Stats Bar

struct StatsBar: View {
    let stats: DashboardStats?

    var body: some View {
        let s = stats ?? DashboardStats(total: 0, active: 0, completed: 0, tokens: 0, estimatedCost: 0, avgDuration: "—")

        HStack(spacing: 0) {
            StatCell(label: "Active", value: "\(s.active)", color: .blue)
            Divider().frame(height: 30)
            StatCell(label: "Total", value: "\(s.total)", color: .primary)
            Divider().frame(height: 30)
            StatCell(label: "Done", value: "\(s.completed)", color: .green)
            Divider().frame(height: 30)
            StatCell(label: "Cost", value: String(format: "$%.2f", s.estimatedCost), color: .orange)
        }
        .padding(.vertical, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct StatCell: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.title3, design: .rounded, weight: .bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    ContentView()
        .environmentObject(DashboardService())
}
