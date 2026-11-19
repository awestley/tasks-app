import AppIntents
import CoreSpotlight
import Foundation
import GeoToolbox

/// A task as Siri, Shortcuts, Spotlight and notifications see it. It follows Apple's reminder schema, so Siri can
/// offer the app for requests that name no app ("Remind me to take out the trash") and change or delete tasks the
/// way it does reminders. Indexed in Spotlight so Siri can find tasks by what they say, not just by title.
/// Also compiled into the notification service extension, which only needs the type to tag pushed reminders;
/// its query never runs there.
@AppEntity(schema: .reminders.reminder)
struct TaskEntity: IndexedEntity {
    static let defaultQuery = TaskQuery()
    let id: String
    var title: String
    var note: AttributedString?
    /// The task's labels.
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool
    /// Priority 1, the app's most urgent.
    var isFlagged: Bool?
    var creationDate: Date?
    var completionDate: Date?
    /// The task's project, or its space's Inbox.
    var list: ProjectEntity
    /// Always nil: the app has no location reminders.
    var locationTrigger: LocationTriggerEntity?
    /// The due date, and the time when there is one, as written on the task, such as 2026-11-20 15:00.
    @Property(title: "Due text") var dueText: String?
    @Property(title: "Space") var space: Space
    @Property(title: "Priority") var priority: Int
    var displayRepresentation: DisplayRepresentation {
        let detail = [dueText, list.isInbox ? nil : "# " + list.name].compactMap { $0 }.joined(separator: "  ")
        return DisplayRepresentation(title: "\(title)", subtitle: detail.isEmpty ? nil : "\(detail)")
    }
    /// Done tasks stay in the index for Siri ("what did I finish last week?") but not in Spotlight's results.
    var hideInSpotlight: Bool { isCompleted }

    init(_ task: TodoTask, project: Project? = nil) { self.init(task, list: project.map(ProjectEntity.init)) }
    init(_ task: TodoTask, list: ProjectEntity?) {
        id = task.id
        title = task.title
        note = task.description.isEmpty ? nil : AttributedString(task.description)
        tags = Set(task.labels)
        urls = []
        dueDate = task.dueComponents
        recurrence = task.recurrence.flatMap(Recurrence.rule)
        isCompleted = task.completed
        isFlagged = task.priority == 1
        creationDate = task.created_at.flatMap(ServerDate.parse)
        completionDate = task.completed_at.flatMap(ServerDate.parse)
        space = task.inSpace
        self.list = list ?? .inbox(task.inSpace)
        locationTrigger = nil
        priority = task.priority
        let text = [task.due_date, task.due_time].compactMap { $0 }.joined(separator: " ")
        dueText = text.isEmpty ? nil : text
    }
    /// Entities for tasks with their projects, which need the project list.
    static func load(_ tasks: [TodoTask], api: API) async -> [TaskEntity] {
        let projects: [Project] = (try? await api.request("/api/v1/projects")) ?? []
        let byID = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return tasks.map { TaskEntity($0, project: $0.project_id.flatMap { byID[$0] }) }
    }
}

extension TodoTask {
    /// The due date, with the time and time zone when there is a time.
    var dueComponents: DateComponents? {
        guard let due_date else { return nil }
        let day = due_date.split(separator: "-").compactMap { Int($0) }
        guard day.count == 3 else { return nil }
        var result = DateComponents(year: day[0], month: day[1], day: day[2])
        if let due_time {
            let clock = due_time.split(separator: ":").compactMap { Int($0) }
            result.hour = clock.first
            result.minute = clock.dropFirst().first ?? 0
            result.timeZone = TimeZone(identifier: time_zone)
        }
        return result
    }
}

/// The app repeats tasks daily, weekly or monthly, from the due date.
enum Recurrence {
    static func rule(_ value: String) -> Calendar.RecurrenceRule? {
        switch value {
        case "daily": Calendar.RecurrenceRule(calendar: .current, frequency: .daily)
        case "weekly": Calendar.RecurrenceRule(calendar: .current, frequency: .weekly)
        case "monthly": Calendar.RecurrenceRule(calendar: .current, frequency: .monthly)
        default: nil
        }
    }
    /// The app's value for a rule, or an error for one it can't keep, such as every other week.
    static func value(_ rule: Calendar.RecurrenceRule) throws -> String {
        let plain = rule.interval == 1 && rule.end == .never && rule.months.isEmpty && rule.daysOfTheMonth.isEmpty
            && rule.daysOfTheYear.isEmpty && rule.weeks.isEmpty && rule.weekdays.isEmpty && rule.hours.isEmpty
            && rule.minutes.isEmpty && rule.setPositions.isEmpty
        switch rule.frequency {
        case .daily where plain: return "daily"
        case .weekly where plain: return "weekly"
        case .monthly where plain: return "monthly"
        default: throw APIError(message: "Tasks can repeat every day, week or month.")
        }
    }
}

extension Space: AppEnum {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Space")
    static let caseDisplayRepresentations: [Space: DisplayRepresentation] = [
        .personal: DisplayRepresentation(title: "Personal", image: .init(systemName: "house")),
        .work: DisplayRepresentation(title: "Work", image: .init(systemName: "briefcase")),
    ]
    /// The space this device shows, which new tasks join unless told otherwise.
    static var current: Space { Space(rawValue: UserDefaults.standard.string(forKey: "space") ?? "") ?? .personal }
}

/// The signed-in server and session, read the same way the app's Store reads them.
enum SavedSession {
    static var api: API? {
        guard let server = UserDefaults.standard.string(forKey: "serverURL"), !server.isEmpty,
              let token = Keychain.read(server: server) else { return nil }
        return API(server: server, token: token)
    }
    static func require() throws -> API {
        guard let api else { throw APIError(message: "Sign in to the app first.") }
        return api
    }
}

struct TaskQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskEntity] {
        let api = try SavedSession.require()
        var result: [TodoTask] = []
        for id in identifiers where id.count == 36 {
            if let task: TodoTask = try? await api.request("/api/v1/tasks/\(id)") { result.append(task) }
        }
        return await TaskEntity.load(result, api: api)
    }
    func entities(matching string: String) async throws -> [TaskEntity] {
        let api = try SavedSession.require()
        let query = string.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let tasks: [TodoTask] = try await api.request("/api/v1/tasks?completed=false&limit=20&q=\(query)")
        return await TaskEntity.load(tasks, api: api)
    }
    func suggestedEntities() async throws -> [TaskEntity] {
        let api = try SavedSession.require()
        let tasks: [TodoTask] = try await api.request("/api/v1/tasks?completed=false&limit=200")
        // Dated tasks first, soonest first.
        let soonest = tasks.sorted { ($0.due_date ?? "9999", $0.due_time ?? "") < ($1.due_date ?? "9999", $1.due_time ?? "") }.prefix(20)
        return await TaskEntity.load(Array(soonest), api: api)
    }
}

/// A project, or a space's Inbox, as a reminder list. Siri and Shortcuts file new tasks into one.
@AppEntity(schema: .reminders.list)
struct ProjectEntity {
    static let defaultQuery = ProjectQuery()
    /// A project's ID, or inbox-personal and inbox-work for the Inboxes.
    let id: String
    var name: String
    var type: ListType
    @Property(title: "Space") var space: Space
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(space.name)") }
    var isInbox: Bool { id.hasPrefix("inbox-") }
    /// The project's ID, or nil for an Inbox.
    var projectID: String? { isInbox ? nil : id }
    init(id: String, name: String, space: Space) {
        self.id = id
        self.name = name
        self.type = .standard
        self.space = space
    }
    init(_ project: Project) { self.init(id: project.id, name: project.name, space: project.inSpace) }
    static func inbox(_ space: Space) -> ProjectEntity { ProjectEntity(id: "inbox-\(space.rawValue)", name: "Inbox", space: space) }
}

@AppEnum(schema: .reminders.listType)
enum ListType: String {
    case standard
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.standard: "Standard"]
}

struct ProjectQuery: EntityStringQuery {
    /// Both Inboxes, then every project.
    func all() async throws -> [ProjectEntity] {
        let projects: [Project] = try await SavedSession.require().request("/api/v1/projects")
        return Space.allCases.map(ProjectEntity.inbox) + projects.map(ProjectEntity.init)
    }
    func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
        let inboxes = Space.allCases.map(ProjectEntity.inbox).filter { identifiers.contains($0.id) }
        if inboxes.count == identifiers.count { return inboxes }
        return try await all().filter { identifiers.contains($0.id) }
    }
    func entities(matching string: String) async throws -> [ProjectEntity] {
        try await all().filter { $0.name.localizedStandardContains(string) }
    }
    /// The current space's Inbox and projects first.
    func suggestedEntities() async throws -> [ProjectEntity] {
        let current = Space.current
        return try await all().sorted {
            ($0.space != current ? 1 : 0, $0.isInbox ? 0 : 1, $0.name) < ($1.space != current ? 1 : 0, $1.isInbox ? 0 : 1, $1.name)
        }
    }
}

/// The schema's location reminders. The app keeps none, so the query finds nothing and a request with one is refused.
@AppEntity(schema: .reminders.locationTrigger)
struct LocationTriggerEntity {
    static let defaultQuery = LocationTriggerQuery()
    let id: String
    var place: GeoToolbox.PlaceDescriptor
    var event: LocationTriggerEvent
    var displayRepresentation: DisplayRepresentation { "Location" }
}

struct LocationTriggerQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [LocationTriggerEntity] { [] }
    func entities(matching string: String) async throws -> [LocationTriggerEntity] { [] }
}

@AppEnum(schema: .reminders.locationTriggerEvent)
enum LocationTriggerEvent: String {
    case arrive
    case depart
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.arrive: "Arrive", .depart: "Depart"]
}
