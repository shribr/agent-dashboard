import Foundation
import Combine
import UserNotifications
import UIKit

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

    // Notifications
    @Published var notificationSettings = NotificationSettings()
    private var previousAgentStates: [String: String] = [:]
    private var previousProviderStates: [String: String] = [:]
    private var notificationCooldowns: [String: Date] = [:]
    private let cooldownInterval: TimeInterval = 60

    // Provider settings
    @Published var providerSettings = ProviderSettings()

    // Offline cache
    @Published var isShowingCachedData: Bool = false
    @Published var cachedAt: Date?

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        self.session = URLSession(configuration: config)

        // Load saved settings
        loadSettings()
        loadNotificationSettings()
        loadProviderSettings()
        loadCachedState()
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

            checkAndNotify(
                agents: dashboardState.agents,
                providerHealth: dashboardState.dataSourceHealth
            )

            self.state = dashboardState
            self.isConnected = true
            self.connectionError = nil
            self.lastUpdated = Date()
            self.isShowingCachedData = false

            saveCachedState(dashboardState)
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

        // Log response for debugging
        let statusCode = httpResponse.statusCode
        if let rawString = String(data: data, encoding: .utf8) {
            let preview = rawString.prefix(500)
            print("[DashboardService] Conversation HTTP \(statusCode) (\(data.count) bytes): \(preview)")
        }

        guard statusCode == 200 else {
            // Try to extract error message from response body
            var serverError = "HTTP \(statusCode)"
            if let errorJson = try? JSONDecoder().decode([String: String].self, from: data),
               let msg = errorJson["error"] {
                serverError = msg
            }
            print("[DashboardService] Conversation error: \(serverError)")
            throw NSError(domain: "DashboardService", code: statusCode, userInfo: [
                NSLocalizedDescriptionKey: "Server returned \(serverError)"
            ])
        }

        let decoder = JSONDecoder()
        let result = try decoder.decode(ConversationResponse.self, from: data)
        print("[DashboardService] Decoded \(result.turns.count) turns for \(agentId)")
        // Check for server-side error message
        if let serverError = result.error, !serverError.isEmpty, result.turns.isEmpty {
            throw NSError(domain: "DashboardService", code: 0, userInfo: [
                NSLocalizedDescriptionKey: serverError
            ])
        }
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

    // MARK: - Notifications

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                print("[Notifications] Authorization error: \(error.localizedDescription)")
            }
            print("[Notifications] Authorization granted: \(granted)")
        }
    }

    private func checkAndNotify(agents: [AgentSession], providerHealth: [DataSourceStatus]) {
        guard notificationSettings.enabled else { return }

        for agent in agents {
            let prevStatus = previousAgentStates[agent.id]

            if let prev = prevStatus, prev != agent.status.rawValue {
                if agent.status == .done && prev != AgentStatus.done.rawValue {
                    if notificationSettings.isEventEnabled(.agentCompleted) {
                        fireLocalNotification(
                            event: .agentCompleted,
                            name: agent.name,
                            title: "Agent completed: \(agent.name)",
                            body: "\"\(agent.task)\" finished successfully. Elapsed: \(agent.elapsed)"
                        )
                    }
                }
                if agent.status == .error && prev != AgentStatus.error.rawValue {
                    if notificationSettings.isEventEnabled(.agentError) {
                        fireLocalNotification(
                            event: .agentError,
                            name: agent.name,
                            title: "Agent error: \(agent.name)",
                            body: "\"\(agent.task)\" encountered an error."
                        )
                    }
                }
            }

            if prevStatus == nil && (agent.status == .running || agent.status == .thinking) {
                if notificationSettings.isEventEnabled(.agentStarted) {
                    fireLocalNotification(
                        event: .agentStarted,
                        name: agent.name,
                        title: "Agent started: \(agent.name)",
                        body: "New session: \"\(agent.task)\" Model: \(agent.model)"
                    )
                }
            }

            previousAgentStates[agent.id] = agent.status.rawValue
        }

        for provider in providerHealth {
            let prevState = previousProviderStates[provider.id]
            if let prev = prevState, prev != HealthState.degraded.rawValue, provider.state == .degraded {
                if notificationSettings.isEventEnabled(.providerDegraded) {
                    fireLocalNotification(
                        event: .providerDegraded,
                        name: provider.name,
                        title: "Data source degraded: \(provider.name)",
                        body: provider.message
                    )
                }
            }
            previousProviderStates[provider.id] = provider.state.rawValue
        }
    }

    private func fireLocalNotification(event: NotificationEvent, name: String, title: String, body: String) {
        let cooldownKey = "\(event.rawValue):\(name)"
        if let lastFired = notificationCooldowns[cooldownKey],
           Date().timeIntervalSince(lastFired) < cooldownInterval {
            return
        }
        notificationCooldowns[cooldownKey] = Date()

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = event.rawValue

        let request = UNNotificationRequest(
            identifier: "\(cooldownKey)-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("[Notifications] Failed to deliver: \(error.localizedDescription)")
            }
        }
    }

    func saveNotificationSettings() {
        if let data = try? JSONEncoder().encode(notificationSettings) {
            UserDefaults.standard.set(data, forKey: "notificationSettings")
        }
    }

    private func loadNotificationSettings() {
        if let data = UserDefaults.standard.data(forKey: "notificationSettings"),
           let settings = try? JSONDecoder().decode(NotificationSettings.self, from: data) {
            notificationSettings = settings
        }
    }

    // MARK: - Provider Filtering

    var filteredAgents: [AgentSession] {
        guard let agents = state?.agents else { return [] }
        return agents.filter { agent in
            let source = providerSettings.primarySource
            let matchesSource: Bool
            switch source {
            case "copilot":
                matchesSource = agent.type == .copilot
            case "claude-code":
                matchesSource = agent.type == .claude
            default:
                matchesSource = true
            }
            let isEnabled = providerSettings.isProviderEnabled(agent.sourceProvider)
            return matchesSource && isEnabled
        }
    }

    func saveProviderSettings() {
        if let data = try? JSONEncoder().encode(providerSettings) {
            UserDefaults.standard.set(data, forKey: "providerSettings")
        }
    }

    private func loadProviderSettings() {
        if let data = UserDefaults.standard.data(forKey: "providerSettings"),
           let settings = try? JSONDecoder().decode(ProviderSettings.self, from: data) {
            providerSettings = settings
        }
    }

    // MARK: - Offline Cache

    private var cacheFileURL: URL {
        let documentsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return documentsDir.appendingPathComponent("dashboard_state_cache.json")
    }

    private func saveCachedState(_ state: DashboardState) {
        let cached = CachedDashboardState(
            state: state,
            cachedAt: Date().timeIntervalSince1970,
            serverVersion: serverVersion
        )
        do {
            let data = try JSONEncoder().encode(cached)
            try data.write(to: cacheFileURL, options: .atomic)
        } catch {
            print("[Cache] Failed to save: \(error.localizedDescription)")
        }
    }

    private func loadCachedState() {
        guard FileManager.default.fileExists(atPath: cacheFileURL.path) else { return }
        do {
            let data = try Data(contentsOf: cacheFileURL)
            let cached = try JSONDecoder().decode(CachedDashboardState.self, from: data)
            self.state = cached.state
            self.cachedAt = Date(timeIntervalSince1970: cached.cachedAt)
            self.isShowingCachedData = true
            self.serverVersion = cached.serverVersion
        } catch {
            print("[Cache] Failed to load: \(error.localizedDescription)")
        }
    }

    // MARK: - Diagnostics

    func generateDiagnosticReport() -> String {
        var lines: [String] = []
        lines.append("=== Agent Dashboard iOS Diagnostics ===")
        lines.append("Time: \(ISO8601DateFormatter().string(from: Date()))")
        lines.append("Platform: iOS \(UIDevice.current.systemVersion)")
        lines.append("App Version: 1.0.0")
        lines.append("")

        lines.append("-- Connection --")
        lines.append("  Mode: \(connectionMode.rawValue)")
        lines.append("  Base URL: \(baseURL)")
        lines.append("  Status: \(isConnected ? "Connected" : "Disconnected")")
        lines.append("  Poll Interval: \(pollInterval)s")
        if let version = serverVersion {
            lines.append("  Server Version: \(version)")
        }
        if let lastUpdated = lastUpdated {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .medium
            lines.append("  Last Updated: \(formatter.string(from: lastUpdated))")
        }
        if let error = connectionError {
            lines.append("  Error: \(error)")
        }
        lines.append("")

        lines.append("-- Data Source Health --")
        if let sources = state?.dataSourceHealth {
            for source in sources {
                lines.append("  \(source.id): \(source.state.rawValue) - \(source.message) (\(source.agentCount) agents)")
            }
        } else {
            lines.append("  (no data)")
        }
        lines.append("")

        lines.append("-- Agent Summary --")
        if let agents = state?.agents {
            lines.append("  Total: \(agents.count)")
            let byStatus = Dictionary(grouping: agents, by: { $0.status })
            for (status, group) in byStatus.sorted(by: { $0.value.count > $1.value.count }) {
                lines.append("  \(status.displayName): \(group.count)")
            }
            lines.append("")
            let byProvider = Dictionary(grouping: agents, by: { $0.sourceProvider })
            lines.append("  By Provider:")
            for (provider, group) in byProvider.sorted(by: { $0.value.count > $1.value.count }) {
                lines.append("    \(provider): \(group.count)")
            }
        } else {
            lines.append("  (no data)")
        }
        lines.append("")

        lines.append("-- Notification Settings --")
        lines.append("  Enabled: \(notificationSettings.enabled)")
        for event in NotificationEvent.allCases {
            lines.append("  \(event.displayName): \(notificationSettings.isEventEnabled(event))")
        }
        lines.append("")

        lines.append("-- Provider Settings --")
        lines.append("  Primary Source: \(providerSettings.primarySource)")
        if let sources = state?.dataSourceHealth {
            for source in sources {
                lines.append("  \(source.id): \(providerSettings.isProviderEnabled(source.id) ? "enabled" : "disabled")")
            }
        }
        lines.append("")

        lines.append("-- Offline Cache --")
        lines.append("  Showing Cached: \(isShowingCachedData)")
        if let cachedAt = cachedAt {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .medium
            lines.append("  Cached At: \(formatter.string(from: cachedAt))")
        }

        return lines.joined(separator: "\n")
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
