import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

struct PushConfiguration: Decodable { let apns_enabled: Bool }
struct PushDevice: Decodable, Identifiable { let id: String; let name: String; let kind: String }

/// Notification identifiers and actions shared with the server's payloads.
enum NotificationAction {
    static let reminderCategory = "TASK_REMINDER"
    static let summaryCategory = "TASK_SUMMARY"
    static let complete = "COMPLETE"
    static let snooze15 = "SNOOZE_15"
    static let snooze60 = "SNOOZE_60"
    static let tomorrow = "TOMORROW"
    /// The server's collapse ID, which APNs uses as the notification's identifier on the device.
    static func identifier(task id: String) -> String { "task-" + id }

    static func register() {
        let actions = [
            UNNotificationAction(identifier: complete, title: "Complete", options: [], icon: UNNotificationActionIcon(systemImageName: "checkmark.circle")),
            UNNotificationAction(identifier: snooze15, title: "Snooze 15 min", options: [], icon: UNNotificationActionIcon(systemImageName: "clock")),
            UNNotificationAction(identifier: snooze60, title: "Snooze 1 hour", options: [], icon: UNNotificationActionIcon(systemImageName: "clock.arrow.circlepath")),
            UNNotificationAction(identifier: tomorrow, title: "Tomorrow", options: [], icon: UNNotificationActionIcon(systemImageName: "sunrise")),
        ]
        let reminder = UNNotificationCategory(identifier: reminderCategory, actions: actions, intentIdentifiers: [], options: [])
        let summary = UNNotificationCategory(identifier: summaryCategory, actions: [], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([reminder, summary])
    }
}

@MainActor final class Notifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Notifications()
    weak var store: Store?
    @Published var status = ""
    @Published var selectedTaskID: String?
    /// Set when the system's notification settings ask to open this app's own settings.
    @Published var settingsRequested = false
    private var deviceToken: String?
    /// Refreshes happen constantly, and registering once for each signed-in user is enough.
    private var registeredUser: String?
    private var key: String { "pushDevice:" + (store?.server ?? "") }
    private var enabledKey: String { "pushEnabled:" + (store?.server ?? "") }
    /// This device's push registration on the server, used to report scheduled alarms.
    var deviceID: String? { UserDefaults.standard.string(forKey: key) }

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
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge, .providesAppNotificationSettings]) else {
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
        #if os(iOS)
        await Alarms.shared.sync(store.allTasks, force: true)
        #endif
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
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.setBadgeCount(0)
        status = "Notifications disabled on this device."
    }

    /// Keeps the badge and delivered notifications in step with the task list after each refresh.
    func didRefresh(_ tasks: [TodoTask]) async {
        #if os(iOS)
        await Alarms.shared.sync(tasks)
        #endif
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }
        let today = DateOnly.string(Date())
        let open = tasks.filter { !$0.completed }
        try? await center.setBadgeCount(open.filter { ($0.due_date ?? "9999") <= today }.count)
        let current = Set(open.map { NotificationAction.identifier(task: $0.id) })
        let stale = await center.deliveredNotifications().map(\.request.identifier).filter { $0.hasPrefix("task-") && !current.contains($0) }
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    /// A background push from the server: a task changed on another device after it was notified, or an alarm changed.
    func handleSync(_ ids: [String]) async {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids.map(NotificationAction.identifier))
        if let store, store.profile != nil || Keychain.read(server: store.server) != nil {
            await store.perform { try await store.refresh() }
        }
    }

    private func report(_ error: Error) async {
        let content = UNMutableNotificationContent()
        content.title = "Could not update task"
        content.body = error.localizedDescription
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "action-failed", content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list, .badge]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["task_id"] as? String
        // The summary has no task and opens the app on its task list.
        guard let id else { return }
        do {
            switch response.actionIdentifier {
            case NotificationAction.complete: try await TaskActions.complete(id)
            case NotificationAction.snooze15: try await TaskActions.snooze(id, minutes: 15)
            case NotificationAction.snooze60: try await TaskActions.snooze(id, minutes: 60)
            case NotificationAction.tomorrow: try await TaskActions.snooze(id, until: TaskActions.tomorrowMorning())
            case UNNotificationDismissActionIdentifier: return
            default: await open(id)
            }
        } catch {
            await report(error)
        }
    }
    /// Opens the task once the list is fresh, without holding up the system's tap handling.
    private func open(_ id: String) {
        Task {
            if let store { await store.perform { try await store.refresh() } }
            selectedTaskID = id
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        Task { @MainActor in self.settingsRequested = true }
    }
}

#if os(iOS)
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    // Apple delivers the tap that launched the app only to a delegate assigned before launch finishes.
    func application(_ application: UIApplication, willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = Notifications.shared
        NotificationAction.register()
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Notifications.shared.received(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Notifications.shared.status = "Push registration failed: \(error.localizedDescription)" }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let ids = userInfo["sync"] as? [String] else { return completionHandler(.noData) }
        Task {
            await Notifications.shared.handleSync(ids)
            completionHandler(.newData)
        }
    }
}
#else
final class PushAppDelegate: NSObject, NSApplicationDelegate {
    // Apple delivers the tap that launched the app only to a delegate assigned before launch finishes.
    func applicationWillFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = Notifications.shared
        NotificationAction.register()
    }
    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Notifications.shared.received(deviceToken) }
    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Notifications.shared.status = "Push registration failed: \(error.localizedDescription)" }
    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        guard let ids = userInfo["sync"] as? [String] else { return }
        Task { await Notifications.shared.handleSync(ids) }
    }
}
#endif
