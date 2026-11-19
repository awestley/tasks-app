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
    /// Creates a task. With only a title, reads dates, priority, labels and projects out of it, as quick add does;
    /// with a date or project given separately, takes the title as it is.
    static func add(title: String, due: DateComponents?, reminder: Int?, project: ProjectEntity?, space: Space?) async throws -> TodoTask {
        let api = try SavedSession.require()
        let zone = TimeZone.current.identifier
        var draft = TaskDraft(title: title.trimmingCharacters(in: .whitespacesAndNewlines), time_zone: zone)
        if due == nil && project == nil,
           let parsed: ParsedTask = try? await api.request("/api/v1/tasks/parse", method: "POST", body: API.body(["text": draft.title, "time_zone": zone])),
           !parsed.recognized.isEmpty, !parsed.title.isEmpty {
            draft.title = parsed.title
            draft.due_date = parsed.due_date
            draft.due_time = parsed.due_time
            draft.time_zone = parsed.time_zone
            draft.reminder_minutes = parsed.reminder_minutes
            draft.recurrence = parsed.recurrence
            draft.priority = parsed.priority ?? 4
            draft.labels = parsed.labels
            draft.project_id = parsed.project_id
        }
        if let due, let day = Calendar.current.date(from: DateComponents(year: due.year, month: due.month, day: due.day)) {
            draft.due_date = DateOnly.string(day)
            draft.due_time = due.hour.map { String(format: "%02d:%02d", $0, due.minute ?? 0) }
        }
        if let reminder, draft.due_time != nil { draft.reminder_minutes = reminder }
        if let project { draft.project_id = project.id }
        // A project decides the space; the server enforces it.
        if draft.project_id == nil { draft.space = (space ?? Space.current).rawValue }
        // A fixed ID makes a repeated request (Siri retrying, say) return the same task instead of a second one.
        draft.id = UUID().uuidString.lowercased()
        let task: TodoTask = try await api.request("/api/v1/tasks", method: "POST", body: JSONEncoder().encode(draft))
        await Spotlight.index([task], api: api)
        await refreshApp()
        return task
    }
    /// Moves a task to the other space. Without a project there, it leaves its project for that space's Inbox.
    static func move(_ id: String, to space: Space) async throws -> TodoTask {
        let api = try SavedSession.require()
        for attempt in 0..<2 {
            let task: TodoTask = try await api.request("/api/v1/tasks/\(id)")
            if task.inSpace == space { return task }
            do {
                let moved: TodoTask = try await api.request("/api/v1/tasks/\(id)", method: "PATCH", body: API.body(["version": task.version, "space": space.rawValue]))
                await Spotlight.index([moved], api: api)
                await refreshApp()
                return moved
            } catch let error as APIError where error.status == 409 && attempt == 0 { continue }
        }
        throw APIError(message: "The task changed on another device. Try again.")
    }
    @MainActor static func refreshApp() async {
        if let store = Notifications.shared.store, store.profile != nil { await store.perform { try await store.refresh() } }
    }
}

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription("Adds a task. Dates, priorities, labels and projects in the title are recognised, as in quick add.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Title", requestValueDialog: "What's the task?") var title: String
    @Parameter(title: "Due", kind: .dateTime) var due: DateComponents?
    @Parameter(title: "Reminder", description: "Minutes before the due time.", inclusiveRange: (0, 10080)) var reminder: Int?
    @Parameter(title: "Project") var project: ProjectEntity?
    @Parameter(title: "Space", description: "Personal or Work. Defaults to the space this device shows; a project decides it.") var space: Space?
    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$title)") {
            \.$due
            \.$reminder
            \.$project
            \.$space
        }
    }
    init() {}
    func perform() async throws -> some IntentResult & ReturnsValue<TaskEntity> & ProvidesDialog {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw $title.needsValueError("What's the task?") }
        let task = try await TaskActions.add(title: name, due: due, reminder: reminder, project: project, space: space)
        let entity = TaskEntity(task, project: project?.name)
        let when = entity.dueText.map { ", due \($0)" } ?? ""
        return .result(value: entity, dialog: "Added \(task.title) to \(task.inSpace.name)\(when).")
    }
}

struct MoveTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Move Task to Space"
    static let description = IntentDescription("Moves a task to Personal or Work. A task in a project goes to the other space's Inbox.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Task") var task: TaskEntity
    @Parameter(title: "Space") var space: Space
    static var parameterSummary: some ParameterSummary { Summary("Move \(\.$task) to \(\.$space)") }
    init() {}
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let before = task.space
        let moved = try await TaskActions.move(task.id, to: space)
        if before == space { return .result(dialog: "\(moved.title) is already in \(space.name).") }
        return .result(dialog: "Moved \(moved.title) to \(space.name).")
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
    /// A time, such as tonight at 8, in place of minutes.
    @Parameter(title: "Until") var until: Date?
    init() {}
    init(task: TaskEntity, minutes: Int) {
        self.task = task
        self.minutes = minutes
    }
    init(task: TaskEntity, until: Date) {
        self.task = task
        self.until = until
    }
    func perform() async throws -> some IntentResult & ProvidesDialog {
        if let until, until > Date() {
            try await TaskActions.snooze(task.id, until: until)
            return .result(dialog: "Snoozed \(task.title) until \(until.formatted(date: .abbreviated, time: .shortened)).")
        }
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
        AppShortcut(intent: AddTaskIntent(), phrases: ["Add a task in \(.applicationName)", "New task in \(.applicationName)",
                                                       "Add a \(\.$space) task in \(.applicationName)", "Add a task to \(\.$project) in \(.applicationName)"],
                    shortTitle: "Add Task", systemImageName: "plus.circle")
        AppShortcut(intent: CompleteTaskIntent(), phrases: ["Complete \(\.$task) in \(.applicationName)", "Mark \(\.$task) done in \(.applicationName)"],
                    shortTitle: "Complete Task", systemImageName: "checkmark.circle")
        AppShortcut(intent: SnoozeTaskIntent(), phrases: ["Snooze \(\.$task) in \(.applicationName)"],
                    shortTitle: "Snooze Task", systemImageName: "zzz")
        AppShortcut(intent: MoveTaskIntent(), phrases: ["Move a task to \(\.$space) in \(.applicationName)", "Move this to \(\.$space) in \(.applicationName)"],
                    shortTitle: "Move Task", systemImageName: "arrow.left.arrow.right")
        AppShortcut(intent: OpenTaskIntent(), phrases: ["Open \(\.$target) in \(.applicationName)"],
                    shortTitle: "Open Task", systemImageName: "checklist")
    }
}
