import AppIntents
import Foundation

/// Task changes that work without the app's window: from notification actions, alarms, Siri and Shortcuts.
enum TaskActions {
    static func complete(_ id: String) async throws {
        let api = try SavedSession.require()
        // Notification actions do not carry the version, so read it. Retry once if another device changed it meanwhile.
        for attempt in 0..<2 {
            let task: TodoTask = try await api.request("/api/v1/tasks/\(id)")
            if task.completed { break }
            do {
                let _: TodoTask = try await api.request("/api/v1/tasks/\(id)/complete", method: "POST", body: API.body(["version": task.version]))
                break
            } catch let error as APIError where error.status == 409 && attempt == 0 { continue }
        }
        await refreshApp()
    }
    static func snooze(_ id: String, minutes: Int) async throws {
        let _: TodoTask = try await SavedSession.require().request("/api/v1/tasks/\(id)/snooze", method: "POST", body: API.body(["minutes": minutes]))
        await refreshApp()
    }
    static func snooze(_ id: String, until: Date) async throws {
        let value = until.formatted(.iso8601)
        let _: TodoTask = try await SavedSession.require().request("/api/v1/tasks/\(id)/snooze", method: "POST", body: API.body(["until": value]))
        await refreshApp()
    }
    /// 09:00 tomorrow on this device.
    static func tomorrowMorning(from now: Date = Date()) -> Date {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
    @MainActor static func refreshApp() async {
        if let store = Notifications.shared.store, store.profile != nil { await store.perform { try await store.refresh() } }
    }
}

struct CompleteTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete Task"
    static let description = IntentDescription("Marks a task as completed.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Task") var task: TaskEntity
    init() {}
    init(task: TaskEntity) { self.task = task }
    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await TaskActions.complete(task.id)
        return .result(dialog: "Completed \(task.title).")
    }
}

/// On iPhone it is also a Live Activity intent, so an alarm's Snooze button can run it (see Alarms.swift).
struct SnoozeTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Snooze Task"
    static let description = IntentDescription("Reminds you about a task again later, on every device with notifications on.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Task") var task: TaskEntity
    @Parameter(title: "Minutes", default: 15, inclusiveRange: (1, 10080)) var minutes: Int
    init() {}
    init(task: TaskEntity, minutes: Int) {
        self.task = task
        self.minutes = minutes
    }
    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await TaskActions.snooze(task.id, minutes: minutes)
        return .result(dialog: "Snoozed \(task.title) for \(minutes) minutes.")
    }
}

struct OpenTaskIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Task"
    @Parameter(title: "Task") var target: TaskEntity
    init() {}
    init(target: TaskEntity) { self.target = target }
    @MainActor func perform() async throws -> some IntentResult {
        Notifications.shared.selectedTaskID = target.id
        return .result()
    }
}

struct TaskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CompleteTaskIntent(), phrases: ["Complete \(\.$task) in \(.applicationName)", "Mark \(\.$task) done in \(.applicationName)"],
                    shortTitle: "Complete Task", systemImageName: "checkmark.circle")
        AppShortcut(intent: SnoozeTaskIntent(), phrases: ["Snooze \(\.$task) in \(.applicationName)"],
                    shortTitle: "Snooze Task", systemImageName: "zzz")
        AppShortcut(intent: OpenTaskIntent(), phrases: ["Open \(\.$target) in \(.applicationName)"],
                    shortTitle: "Open Task", systemImageName: "checklist")
    }
}
