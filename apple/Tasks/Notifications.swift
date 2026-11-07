import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

struct PushConfiguration: Decodable { let apns_enabled: Bool }
struct PushDevice: Decodable, Identifiable { let id: String; let name: String; let kind: String }

@MainActor final class Notifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Notifications()
    weak var store: Store?
    @Published var status = ""
    @Published var selectedTaskID: String?
    private var deviceToken: String?
    /// Refreshes happen constantly, and registering once for each signed-in user is enough.
    private var registeredUser: String?
    private var key: String { "pushDevice:" + (store?.server ?? "") }
    private var enabledKey: String { "pushEnabled:" + (store?.server ?? "") }

    func attach(_ store: Store) {
        self.store = store
        guard UserDefaults.standard.bool(forKey: enabledKey), let user = store.profile?.id, user != registeredUser else { return }
        registeredUser = user
        registerWithApple()
    }
    func enable() async throws {
        guard let store else { return }
        let configuration: PushConfiguration = try await store.api.request("/api/v1/push/config")
        guard configuration.apns_enabled else { throw APIError(message: "Apple push needs to be configured on the server.") }
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) else {
            throw APIError(message: "Allow notifications for this app in system settings.")
        }
        UserDefaults.standard.set(true, forKey: enabledKey)
        status = "Registering this device..."
        registeredUser = store.profile?.id
        registerWithApple()
    }
    private func registerWithApple() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }
    func received(_ token: Data) {
        deviceToken = token.map { String(format: "%02x", $0) }.joined()
        Task { do { try await upload() } catch { status = error.localizedDescription } }
    }
    private func upload() async throws {
        guard let store, store.profile != nil, let deviceToken, UserDefaults.standard.bool(forKey: enabledKey) else { return }
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        #if os(iOS)
        let name = "iPhone / iPad"
        #else
        let name = "Mac"
        #endif
        let device: PushDevice = try await store.api.request("/api/v1/push/subscriptions", method: "POST", body: API.body([
            "kind": "apns", "token": deviceToken, "topic": Bundle.main.bundleIdentifier ?? "", "sandbox": sandbox, "name": name
        ]))
        let previous = UserDefaults.standard.string(forKey: key)
        UserDefaults.standard.set(device.id, forKey: key)
        if let previous, previous != device.id { _ = try? await store.api.send("/api/v1/push/subscriptions/\(previous)", method: "DELETE") }
        status = "Notifications enabled on this device."
    }
    func disable() async throws {
        if let store, let id = UserDefaults.standard.string(forKey: key) {
            let devices: [PushDevice] = try await store.api.request("/api/v1/push/subscriptions")
            if devices.contains(where: { $0.id == id }) { try await store.api.send("/api/v1/push/subscriptions/\(id)", method: "DELETE") }
        }
        clearLocal()
    }
    func clearLocal() {
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: enabledKey)
        deviceToken = nil
        registeredUser = nil
        #if os(iOS)
        UIApplication.shared.unregisterForRemoteNotifications()
        #else
        NSApplication.shared.unregisterForRemoteNotifications()
        #endif
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        status = "Notifications disabled on this device."
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["task_id"] as? String
        Task { @MainActor in
            if let store = self.store { try? await store.refresh() }
            self.selectedTaskID = id
        }
        completionHandler()
    }
}

#if os(iOS)
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    // Apple delivers the tap that launched the app only to a delegate assigned before launch finishes.
    func application(_ application: UIApplication, willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = Notifications.shared
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Notifications.shared.received(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Notifications.shared.status = "Push registration failed: \(error.localizedDescription)" }
}
#else
final class PushAppDelegate: NSObject, NSApplicationDelegate {
    // Apple delivers the tap that launched the app only to a delegate assigned before launch finishes.
    func applicationWillFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = Notifications.shared
    }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Notifications.shared.received(deviceToken) }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Notifications.shared.status = "Push registration failed: \(error.localizedDescription)" }
}
#endif
