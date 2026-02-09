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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if service.isConnected {
                    // Stats bar
                    StatsBar(stats: service.state?.stats)
                        .padding(.horizontal)
                        .padding(.top, 8)

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
                        AgentListView(agents: service.state?.agents ?? [])
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
