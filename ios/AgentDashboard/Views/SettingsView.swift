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
                            TextField("19850", value: $service.localPort, format: .number)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
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
                        dismiss()
                    }
                }
            }
        }
    }
}
