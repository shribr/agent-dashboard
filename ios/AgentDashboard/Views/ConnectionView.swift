import SwiftUI

struct ConnectionView: View {
    @EnvironmentObject var service: DashboardService
    @State private var isScanning = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Hero
                VStack(spacing: 12) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 56))
                        .foregroundStyle(.blue)
                        .symbolEffect(.pulse)

                    Text("Connect to VS Code")
                        .font(.title2)
                        .fontWeight(.bold)

                    Text("Your Agent Dashboard extension runs a local API server. Connect from the same Wi-Fi or use a cloud relay for remote access.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding(.top, 40)

                // Connection mode picker
                Picker("Mode", selection: $service.connectionMode) {
                    ForEach(ConnectionMode.allCases, id: \.self) { mode in
                        Label(mode.rawValue, systemImage: mode.iconName)
                            .tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)

                // Mode-specific settings
                VStack(spacing: 16) {
                    switch service.connectionMode {
                    case .local:
                        localSettings
                    case .cloud:
                        cloudSettings
                    }
                }
                .padding(.horizontal)

                // Error message
                if let error = service.connectionError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                }

                // Connect button
                Button {
                    service.saveSettings()
                    service.connect()
                } label: {
                    Label("Connect", systemImage: "link")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)

                // Help text
                VStack(alignment: .leading, spacing: 12) {
                    Text("Setup Guide")
                        .font(.headline)

                    HelpStep(number: 1, text: "Install the Agent Dashboard extension in VS Code")
                    HelpStep(number: 2, text: "The API server starts automatically on port 19850")
                    HelpStep(number: 3, text: "Make sure your Mac and iPhone are on the same Wi-Fi")
                    HelpStep(number: 4, text: "Enter your Mac's IP address above, or tap Scan")
                }
                .padding()
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal)
            }
            .padding(.bottom, 40)
        }
    }

    // MARK: - Local Settings

    private var localSettings: some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Host / IP Address")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("e.g. 192.168.1.42", text: $service.localHost)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Port")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("19850", value: $service.localPort, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(width: 80)
                }
            }

            // Scan button
            Button {
                isScanning = true
                Task {
                    await service.scanLocalNetwork()
                    isScanning = false
                }
            } label: {
                HStack {
                    if isScanning {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "magnifyingglass")
                    }
                    Text(isScanning ? "Scanning..." : "Scan Local Network")
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(isScanning)

            // Discovered hosts
            if !service.discoveredHosts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Found Servers:")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ForEach(Array(service.discoveredHosts.enumerated()), id: \.offset) { _, host in
                        Button {
                            service.localHost = host
                        } label: {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                Text(host)
                                    .font(.subheadline)
                                Spacer()
                                if host == service.localHost {
                                    Text("Selected")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
                .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    // MARK: - Cloud Settings

    private var cloudSettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Cloud Relay URL")
                .font(.caption)
                .foregroundStyle(.secondary)

            TextField("https://your-worker.your-subdomain.workers.dev", text: $service.cloudURL)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            Text("Set up a Cloudflare Worker or Firebase relay to access your dashboard from anywhere. See the README for instructions.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Help Step

struct HelpStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.caption)
                .fontWeight(.bold)
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Color.accentColor, in: Circle())

            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}
