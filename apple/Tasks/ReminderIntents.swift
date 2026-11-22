import AppIntents
import Foundation
import UniformTypeIdentifiers

// Apple's reminder schema intents. Siri offers the app for requests that name no app, such as
// "Remind me to take out the trash", and changes or deletes tasks the way it does reminders.
// The app keeps no images, sections or location reminders, so those are refused rather than dropped.

@AppIntent(schema: .reminders.createReminder)
struct CreateReminderIntent {
    static let supportedModes: IntentModes = .background
    var title: String
    var list: ProjectEntity?
    var note: AttributedString?
    var isFlagged: Bool?
    @Parameter(title: "Images", default: [], supportedContentTypes: [.image]) var images: [IntentFile]
    @Parameter(title: "Tags", default: []) var tags: Set<String>
    @Parameter(title: "URLs", default: []) var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var locationTrigger: LocationTriggerEntity?
    var section: SectionEntity?

    func perform() async throws -> some ReturnsValue<TaskEntity> {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw $title.needsValueError("What's the reminder?") }
        try Unsupported.check(images: images, location: locationTrigger, section: section)
        let task = try await TaskActions.add(title: name, due: dueDate, reminder: nil, project: list, space: nil,
                                             note: note.map { String($0.characters) }, labels: tags, flagged: isFlagged,
                                             recurrence: try recurrence.map(Recurrence.value), urls: urls)
        return .result(value: await TaskEntity.load([task], api: try SavedSession.require())[0])
    }
}

@AppIntent(schema: .reminders.updateReminder)
struct UpdateReminderIntent {
    static let supportedModes: IntentModes = .background
    var target: TaskEntity
    var title: String?
    var note: AttributedString?
    var tags: Set<String>?
    var urls: [URL]?
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool?
    var isFlagged: Bool?
    var list: ProjectEntity?
    var locationTrigger: LocationTriggerEntity?

    func perform() async throws -> some ReturnsValue<TaskEntity> {
        try Unsupported.check(location: locationTrigger)
        let api = try SavedSession.require()
        let current: TodoTask = try await api.request("/api/v1/tasks/\(target.id)")
        var changes: [String: Any] = [:]
        if let title {
            let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { changes["title"] = name }
        }
        if let note { changes["description"] = String(note.characters) }
        if let tags { changes["labels"] = Array(tags).sorted().prefix(20).map { $0 } }
        if let dueDate {
            let schedule = try TaskActions.schedule(dueDate)
            changes["due_date"] = schedule.date
            changes["due_time"] = schedule.time ?? NSNull()
            changes["time_zone"] = schedule.zone
            // As in quick entry, a due time reminds at that time, unless the task already has a reminder.
            if schedule.time != nil && current.reminder_minutes == nil { changes["reminder_minutes"] = 0 }
        }
        if let recurrence { changes["recurrence"] = try Recurrence.value(recurrence) }
        if let isCompleted { changes["completed"] = isCompleted }
        if let isFlagged {
            if isFlagged { changes["priority"] = 1 } else if current.priority == 1 { changes["priority"] = 4 }
        }
        if let list {
            changes["project_id"] = list.projectID ?? NSNull()
            changes["space"] = list.space.rawValue
        }
        if !changes.isEmpty { _ = try await TaskActions.edit(current.id, changes) }
        if let urls, !urls.isEmpty { try await TaskActions.addLinks(urls, to: current.id, api: api) }
        let task: TodoTask = try await api.request("/api/v1/tasks/\(current.id)")
        return .result(value: await TaskEntity.load([task], api: api)[0])
    }
}

@AppIntent(schema: .reminders.deleteReminders)
struct DeleteRemindersIntent: DeleteIntent {
    static let supportedModes: IntentModes = .background
    var entities: [TaskEntity]

    func perform() async throws -> some IntentResult {
        let api = try SavedSession.require()
        for entity in entities {
            for attempt in 0..<2 {
                let task: TodoTask = try await api.request("/api/v1/tasks/\(entity.id)")
                do {
                    try await api.send("/api/v1/tasks/\(task.id)?version=\(task.version)", method: "DELETE")
                    break
                } catch let error as APIError where error.status == 409 && attempt == 0 { continue }
            }
        }
        await Spotlight.remove(entities.map(\.id))
        await TaskActions.refreshApp()
        return .result()
    }
}

/// "Create a list called groceries" makes a project in the space this device shows.
@AppIntent(schema: .reminders.createList)
struct CreateListIntent {
    static let supportedModes: IntentModes = .background
    var type: ListType
    var name: String

    func perform() async throws -> some ReturnsValue<ProjectEntity> {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw $name.needsValueError("What should the list be called?") }
        let body = try API.body(["id": UUID().uuidString.lowercased(), "name": trimmed, "space": Space.current.rawValue])
        let project: Project = try await SavedSession.require().request("/api/v1/projects", method: "POST", body: body)
        await TaskActions.refreshApp()
        return .result(value: ProjectEntity(project))
    }
}

/// The schema's list sections. The app has none, so the query finds nothing and a request with one is refused.
@AppEntity(schema: .reminders.section)
struct SectionEntity {
    static let defaultQuery = SectionQuery()
    let id: String
    var name: String
    var list: ProjectEntity
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct SectionQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [SectionEntity] { [] }
    func entities(matching string: String) async throws -> [SectionEntity] { [] }
}

enum Unsupported {
    static func check(images: [IntentFile] = [], location: LocationTriggerEntity? = nil, section: SectionEntity? = nil) throws {
        if !images.isEmpty { throw APIError(message: "Tasks can't hold images.") }
        if location != nil { throw APIError(message: "Tasks can't remind you at a place.") }
        if section != nil { throw APIError(message: "Projects don't have sections.") }
    }
}
