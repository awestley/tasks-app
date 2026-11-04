import SwiftUI

@main struct TaskwellApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    #else
    @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    #endif
    @StateObject private var store = Store()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).tint(Color(hex: "2563eb"))
                .task { Notifications.shared.attach(store); await store.restore() }
                .onChange(of: phase) { _, next in
                    if next == .active, store.profile != nil { Task { await store.restore() } }
                }
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
