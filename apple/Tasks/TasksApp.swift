import SwiftUI

@main struct TasksApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    #else
    @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    #endif
    @StateObject private var store = Store()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).tint(Clean.inverse)
                .task { Notifications.shared.attach(store); await store.restore() }
                #if os(iOS)
                .onChange(of: phase) { _, next in
                    if next == .active, store.profile != nil { Task { await store.restore() } }
                }
                #else
                // On macOS, refresh each time the app comes to the front, which also checks the server is still there.
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    if store.profile != nil { Task { await store.restore() } }
                }
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1050, height: 720)
        #endif
    }
}
extension Color {
    init(hex: String) {
        let value = Int(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x2563eb
        self.init(red: Double((value >> 16) & 255)/255, green: Double((value >> 8) & 255)/255, blue: Double(value & 255)/255)
    }
}
