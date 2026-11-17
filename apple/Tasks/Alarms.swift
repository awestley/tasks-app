import AlarmKit
import AppIntents
import SwiftUI

extension SnoozeTaskIntent: LiveActivityIntent {}

struct TaskAlarm: AlarmMetadata {
    var taskID: String
}

/// Rings alarm-style reminders with AlarmKit on iPhone and iPad, and tells the server which ones are armed
/// so it does not also send this device a notification for them. Other devices get the normal push.
@MainActor final class Alarms {
    static let shared = Alarms()
    /// Alarm ID to "task ID|reminder seconds|title". The title is included so a rename schedules a fresh alarm.
    private let storageKey = "alarmTasks"
    private var reported: Set<String>?

    var state: AlarmManager.AuthorizationState { AlarmManager.shared.authorizationState }

    /// Asks once, the first time a task is set to ring as an alarm.
    func requestPermission() async -> Bool {
        if state == .notDetermined { _ = try? await AlarmManager.shared.requestAuthorization() }
        return state == .authorized
    }

    func sync(_ tasks: [TodoTask], force: Bool = false) async {
        var stored = UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String] ?? [:]
        let now = Date()
        var wanted: [String: (TodoTask, Date)] = [:]
        if state == .authorized {
            for task in tasks where task.isAlarm && !task.completed {
                for instant in [task.reminderInstant, task.snoozedInstant].compactMap({ $0 })
                where instant > now && instant <= now.addingTimeInterval(7 * 86400) {
                    wanted["\(task.id)|\(Int(instant.timeIntervalSince1970))|\(task.title)"] = (task, instant)
                }
            }
        }
        // Nothing armed and nothing to arm: leave AlarmKit alone, so it is never touched without permission.
        if stored.isEmpty && wanted.isEmpty { return await report([], force: force) }
        // Alarms that already rang or were stopped are gone from AlarmKit.
        let existing = Set(((try? AlarmManager.shared.alarms) ?? []).map(\.id.uuidString))
        stored = stored.filter { existing.contains($0.key) }
        for (id, key) in stored where wanted[key] == nil {
            if let uuid = UUID(uuidString: id) { try? AlarmManager.shared.cancel(id: uuid) }
            stored.removeValue(forKey: id)
        }
        let armed = Set(stored.values)
        for (key, (task, instant)) in wanted where !armed.contains(key) {
            let id = UUID()
            do {
                _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration(task, at: instant))
                stored[id.uuidString] = key
            } catch {
                // The reminder still arrives as a notification, because it is not reported as armed.
            }
        }
        UserDefaults.standard.set(stored, forKey: storageKey)
        await report(Set(stored.values), force: force)
    }

    private func configuration(_ task: TodoTask, at instant: Date) -> AlarmManager.AlarmConfiguration<TaskAlarm> {
        let snooze = AlarmButton(text: "Snooze", textColor: .white, systemImageName: "zzz")
        let alert = AlarmPresentation.Alert(title: "\(task.title)", secondaryButton: snooze, secondaryButtonBehavior: .custom)
        let attributes = AlarmAttributes(presentation: AlarmPresentation(alert: alert), metadata: TaskAlarm(taskID: task.id), tintColor: Clean.accent)
        return .alarm(
            schedule: .fixed(instant),
            attributes: attributes,
            // Lets Siri act on the ringing alarm's task, for example to snooze it.
            appEntityIdentifier: EntityIdentifier(for: TaskEntity.self, identifier: task.id),
            secondaryIntent: SnoozeTaskIntent(task: TaskEntity(task), minutes: 10)
        )
    }

    private func report(_ keys: Set<String>, force: Bool) async {
        guard force || keys != reported, let device = Notifications.shared.deviceID, let api = SavedSession.api else { return }
        let alarms: [[String: Any]] = keys.compactMap { key in
            let parts = key.split(separator: "|", maxSplits: 2).map(String.init)
            guard parts.count >= 2, let seconds = Double(parts[1]) else { return nil }
            return ["task_id": parts[0], "at": Date(timeIntervalSince1970: seconds).formatted(.iso8601)]
        }
        do {
            try await api.send("/api/v1/push/subscriptions/\(device)/alarms", method: "PUT", body: API.body(["alarms": alarms]))
            reported = keys
        } catch {
            reported = nil
        }
    }
}
