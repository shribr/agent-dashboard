import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var service: DashboardService
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            Form {
                // Connection
                Section {
                    Picker("Connection Mode", selection: $service.connectionMode) {
                        ForEach(ConnectionMode.allCases, id: \.self) { mode in
                            Label(mode.rawValue, systemImage: mode.iconName)
                                .tag(mode)
                        }
                    }

                    if service.connectionMode == .local {
                        HStack {
                            Text("Host")
                            Spacer()
                            TextField("IP Address", text: $service.localHost)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Text("Port")
                            Spacer()
                            TextField("19850", value: $service.localPort, formatter: NumberFormatter())
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
                                .keyboardType(.numberPad)
                                .frame(width: 80)
                        }
                    } else {
                        HStack {
                            Text("Cloud URL")
                            Spacer()
                            TextField("https://...", text: $service.cloudURL)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Connection")
                }

                // Polling
                Section {
                    HStack {
                        Text("Refresh Interval")
                        Spacer()
                        Picker("", selection: $service.pollInterval) {
                            Text("1s").tag(1.0 as TimeInterval)
                            Text("2s").tag(2.0 as TimeInterval)
                            Text("3s").tag(3.0 as TimeInterval)
                            Text("5s").tag(5.0 as TimeInterval)
                            Text("10s").tag(10.0 as TimeInterval)
                        }
                        .pickerStyle(.menu)
                    }
                } header: {
                    Text("Refresh")
                } footer: {
                    Text("How often to fetch updates from VS Code. Lower values use more battery.")
                }

                // Notifications
                Section {
                    Toggle("Enable Notifications", isOn: $service.notificationSettings.enabled)
                        .onChange(of: service.notificationSettings.enabled) { _, newValue in
                            if newValue {
                                service.requestNotificationPermission()
                            }
                            service.saveNotificationSettings()
                        }

                    if service.notificationSettings.enabled {
                        ForEach(NotificationEvent.allCases, id: \.self) { event in
                            Toggle(isOn: Binding(
                                get: { service.notificationSettings.isEventEnabled(event) },
                                set: { newValue in
                                    service.notificationSettings.setEventEnabled(event, newValue)
                                    service.saveNotificationSettings()
                                }
                            )) {
                                Label(event.displayName, systemImage: event.iconName)
                            }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Get notified when agents complete, error, start, or when a data source degrades. 60-second cooldown per event.")
                }

                // Providers
                Section {
                    Picker("Primary Source", selection: $service.providerSettings.primarySource) {
                        Text("Copilot").tag("copilot")
                        Text("Claude Code").tag("claude-code")
                        Text("Both").tag("both")
                    }
                    .onChange(of: service.providerSettings.primarySource) { _, _ in
                        service.saveProviderSettings()
                    }

                    if let sources = service.state?.dataSourceHealth, !sources.isEmpty {
                        ForEach(sources) { source in
                            Toggle(isOn: Binding(
                                get: { service.providerSettings.isProviderEnabled(source.id) },
                                set: { _ in
                                    service.providerSettings.toggleProvider(source.id)
                                    service.saveProviderSettings()
                                }
                            )) {
                                HStack(spacing: 8) {
                                    Image(systemName: source.state.iconName)
                                        .foregroundStyle(providerHealthColor(source.state))
                                        .font(.caption)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(source.name)
                                        Text("\(source.agentCount) agents")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                } header: {
                    Text("Providers")
                } footer: {
                    Text("Filter which agent providers are shown. These are client-side filters only.")
                }

                // Status
                Section {
                    HStack {
                        Text("Status")
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(service.isConnected ? Color.green : Color.red)
                                .frame(width: 8, height: 8)
                            Text(service.isConnected ? "Connected" : "Disconnected")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let version = service.serverVersion {
                        HStack {
                            Text("Server Version")
                            Spacer()
                            Text(version)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let date = service.lastUpdated {
                        HStack {
                            Text("Last Update")
                            Spacer()
                            Text(date, style: .relative)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let error = service.connectionError {
                        HStack(alignment: .top) {
                            Text("Error")
                            Spacer()
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                } header: {
                    Text("Status")
                }

                // Actions
                Section {
                    Button("Reconnect") {
                        service.saveSettings()
                        service.connect()
                    }

                    Button("Check Server Health") {
                        Task {
                            await service.checkHealth()
                        }
                    }

                    NavigationLink("Diagnostics") {
                        DiagnosticsView()
                    }

                    Button("Disconnect", role: .destructive) {
                        service.disconnect()
                    }
                }

                // About
                Section {
                    HStack {
                        Text("App Version")
                        Spacer()
                        Text("1.0.0")
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Extension Required")
                        Spacer()
                        Text("v0.3.0+")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text("Agent Dashboard for iOS — companion app for the VS Code Agent Dashboard extension.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        service.saveSettings()
                        service.saveNotificationSettings()
                        service.saveProviderSettings()
                        dismiss()
                    }
                }
            }
        }
    }

    private func providerHealthColor(_ state: HealthState) -> Color {
        switch state {
        case .connected: return .green
        case .degraded: return .orange
        case .unavailable: return .red
        case .checking: return .gray
        }
    }
}
