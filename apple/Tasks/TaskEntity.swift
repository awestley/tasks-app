import AppIntents
import CoreSpotlight
import Foundation

/// A task as Siri, Shortcuts, Spotlight and notifications see it. Indexed in Spotlight so Siri can find tasks
/// by what they say, not just by title. Also compiled into the notification service extension,
/// which only needs the type to tag pushed reminders; its query never runs there.
struct TaskEntity: IndexedEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task")
    static let defaultQuery = TaskQuery()
    let id: String
    @Property(title: "Title", indexingKey: \.title) var title: String
    @Property(title: "Notes", indexingKey: \.contentDescription) var notes: String
    @Property(title: "Due", indexingKey: \.dueDate) var due: Date?
    /// The due date, and the time when there is one, as written on the task, such as 2026-11-20 15:00.
    @Property(title: "Due text") var dueText: String?
    @Property(title: "Project") var project: String?
    @Property(title: "Space") var space: Space
    @Property(title: "Labels", indexingKey: \.keywords) var labels: [String]
    @Property(title: "Priority") var priority: Int
    @Property(title: "Completed") var completed: Bool
    var displayRepresentation: DisplayRepresentation {
        let detail = [dueText, project.map { "# " + $0 }].compactMap { $0 }.joined(separator: "  ")
        return DisplayRepresentation(title: "\(title)", subtitle: detail.isEmpty ? nil : "\(detail)")
    }
    /// Done tasks stay in the index for Siri ("what did I finish last week?") but not in Spotlight's results.
    var hideInSpotlight: Bool { completed }

    init(id: String, title: String, notes: String = "", due: Date? = nil, dueText: String? = nil, project: String? = nil,
         space: Space = .personal, labels: [String] = [], priority: Int = 4, completed: Bool = false) {
        self.id = id
        self.title = title
        self.notes = notes
        self.due = due
        self.dueText = dueText
        self.project = project
        self.space = space
        self.labels = labels
        self.priority = priority
        self.completed = completed
    }
    init(_ task: TodoTask, project: String? = nil) {
        let text = [task.due_date, task.due_time].compactMap { $0 }.joined(separator: " ")
        let due = task.dueInstant ?? task.due_date.map { DateOnly.date($0) }
        self.init(id: task.id, title: task.title, notes: task.description, due: due, dueText: text.isEmpty ? nil : text,
                  project: project, space: task.inSpace, labels: task.labels, priority: task.priority, completed: task.completed)
    }
    /// Entities for tasks with their project names, which need the project list.
    static func load(_ tasks: [TodoTask], api: API) async -> [TaskEntity] {
        let projects: [Project] = (try? await api.request("/api/v1/projects")) ?? []
        let names = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        return tasks.map { TaskEntity($0, project: $0.project_id.flatMap { names[$0] }) }
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

/// A project, so Siri and Shortcuts can file a new task into one.
struct ProjectEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Project")
    static let defaultQuery = ProjectQuery()
    let id: String
    @Property(title: "Name") var name: String
    @Property(title: "Space") var space: Space
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(space.name)") }
    init(id: String, name: String, space: Space) {
        self.id = id
        self.name = name
        self.space = space
    }
    init(_ project: Project) { self.init(id: project.id, name: project.name, space: project.inSpace) }
}

struct ProjectQuery: EntityStringQuery {
    func all() async throws -> [ProjectEntity] {
        let projects: [Project] = try await SavedSession.require().request("/api/v1/projects")
        return projects.map(ProjectEntity.init)
    }
    func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
        try await all().filter { identifiers.contains($0.id) }
    }
    func entities(matching string: String) async throws -> [ProjectEntity] {
        try await all().filter { $0.name.localizedStandardContains(string) }
    }
    /// The current space's projects first.
    func suggestedEntities() async throws -> [ProjectEntity] {
        let current = Space.current
        return try await all().sorted { ($0.space != current ? 1 : 0, $0.name) < ($1.space != current ? 1 : 0, $1.name) }
    }
}
