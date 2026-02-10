import Foundation
import Combine

// MARK: - Connection Mode

enum ConnectionMode: String, CaseIterable {
    case local = "Local Network"
    case cloud = "Cloud Relay"

    var iconName: String {
        switch self {
        case .local: return "wifi"
        case .cloud: return "icloud"
        }
    }
}

// MARK: - Dashboard Service

@MainActor
class DashboardService: ObservableObject {
    // Connection settings
    @Published var connectionMode: ConnectionMode = .local
    @Published var localHost: String = ""  // Auto-discovered or manual
    @Published var localPort: Int = 19850
    @Published var cloudURL: String = ""

    // State
    @Published var state: DashboardState?
    @Published var isConnected: Bool = false
    @Published var connectionError: String?
    @Published var lastUpdated: Date?
    @Published var serverVersion: String?

    // Polling
    @Published var pollInterval: TimeInterval = 3.0
    private var pollTimer: Timer?
    private var session: URLSession

    // Discovery
    @Published var discoveredHosts: [String] = []

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        self.session = URLSession(configuration: config)

        // Load saved settings
        loadSettings()
    }

    // MARK: - Connection

    var baseURL: String {
        switch connectionMode {
        case .local:
            let host = localHost.isEmpty ? "localhost" : localHost
            return "http://\(host):\(localPort)"
        case .cloud:
            return cloudURL
        }
    }

    func connect() {
        connectionError = nil
        startPolling()
    }

    func disconnect() {
        stopPolling()
        isConnected = false
        state = nil
    }

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        // Immediate fetch
        Task { await fetchState() }
        // Then poll
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            Task { @MainActor in
                await self.fetchState()
            }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Networking

    func fetchState() async {
        let urlString = "\(baseURL)/api/state"
        guard let url = URL(string: urlString) else {
            connectionError = "Invalid URL: \(urlString)"
            isConnected = false
            return
        }

        do {
            let (data, response) = try await session.data(from: url)

            guard let httpResponse = response as? HTTPURLResponse else {
                connectionError = "Invalid response"
                isConnected = false
                return
            }

            guard httpResponse.statusCode == 200 else {
                connectionError = "HTTP \(httpResponse.statusCode)"
                isConnected = false
                return
            }

            let decoder = JSONDecoder()
            let dashboardState = try decoder.decode(DashboardState.self, from: data)

            self.state = dashboardState
            self.isConnected = true
            self.connectionError = nil
            self.lastUpdated = Date()
        } catch let error as DecodingError {
            connectionError = "Data format error: \(error.localizedDescription)"
            isConnected = false
        } catch {
            connectionError = "Connection failed: \(error.localizedDescription)"
            isConnected = false
        }
    }

    func checkHealth() async {
        let urlString = "\(baseURL)/api/health"
        guard let url = URL(string: urlString) else { return }

        do {
            let (data, _) = try await session.data(from: url)
            let health = try JSONDecoder().decode(HealthCheckResponse.self, from: data)
            serverVersion = health.version
        } catch {
            serverVersion = nil
        }
    }

    // MARK: - Conversation History

    func fetchConversationHistory(agentId: String) async throws -> [ConversationTurn] {
        let encoded = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        let urlString = "\(baseURL)/api/agents/\(encoded)/conversation"
        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        let (data, response) = try await session.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard httpResponse.statusCode == 200 else {
            print("[DashboardService] Conversation HTTP \(httpResponse.statusCode) for \(agentId)")
            throw URLError(.badServerResponse)
        }

        // Log raw response for debugging
        if let rawString = String(data: data, encoding: .utf8) {
            let preview = rawString.prefix(300)
            print("[DashboardService] Conversation response (\(data.count) bytes): \(preview)...")
        }

        let decoder = JSONDecoder()
        let result = try decoder.decode(ConversationResponse.self, from: data)
        print("[DashboardService] Decoded \(result.turns.count) turns for \(agentId)")
        return result.turns
    }

    // MARK: - Discovery (scan local network for API server)

    func scanLocalNetwork() async {
        discoveredHosts = []

        // Try common addresses
        let candidates = [
            "localhost",
            "127.0.0.1",
            getLocalIPAddress() ?? ""
        ].filter { !$0.isEmpty }

        for host in candidates {
            let urlString = "http://\(host):\(localPort)/api/health"
            guard let url = URL(string: urlString) else { continue }

            do {
                let (_, response) = try await session.data(from: url)
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    if !discoveredHosts.contains(host) {
                        discoveredHosts.append(host)
                    }
                }
            } catch {
                // Host not available
            }
        }

        // If we found exactly one, auto-connect
        if let first = discoveredHosts.first, localHost.isEmpty {
            localHost = first
        }
    }

    // MARK: - Settings Persistence

    func saveSettings() {
        UserDefaults.standard.set(connectionMode.rawValue, forKey: "connectionMode")
        UserDefaults.standard.set(localHost, forKey: "localHost")
        UserDefaults.standard.set(localPort, forKey: "localPort")
        UserDefaults.standard.set(cloudURL, forKey: "cloudURL")
        UserDefaults.standard.set(pollInterval, forKey: "pollInterval")
    }

    func loadSettings() {
        if let mode = UserDefaults.standard.string(forKey: "connectionMode"),
           let m = ConnectionMode(rawValue: mode) {
            connectionMode = m
        }
        let host = UserDefaults.standard.string(forKey: "localHost") ?? ""
        if !host.isEmpty { localHost = host }

        let port = UserDefaults.standard.integer(forKey: "localPort")
        if port > 0 { localPort = port }

        let cloud = UserDefaults.standard.string(forKey: "cloudURL") ?? ""
        if !cloud.isEmpty { cloudURL = cloud }

        let interval = UserDefaults.standard.double(forKey: "pollInterval")
        if interval > 0 { pollInterval = interval }
    }

    // MARK: - Helpers

    private func getLocalIPAddress() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family
            if addrFamily == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                if name == "en0" || name == "en1" {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                               &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                    address = String(cString: hostname)
                }
            }
        }
        freeifaddrs(ifaddr)
        return address
    }
}
