import SwiftUI

@main
struct AgentDashboardApp: App {
    @StateObject private var service = DashboardService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(service)
        }
    }
}
