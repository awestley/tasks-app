import AppIntents
import Foundation

/// A task as Siri, Shortcuts and notifications see it. Also compiled into the notification service extension,
/// which only needs the type to tag pushed reminders; its query never runs there.
struct TaskEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task")
    static let defaultQuery = TaskQuery()
    let id: String
    var title: String
    var due: String?
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: due.map { "\($0)" })
    }
    init(id: String, title: String, due: String? = nil) {
        self.id = id
        self.title = title
        self.due = due
    }
    init(_ task: TodoTask) {
        let due = [task.due_date, task.due_time].compactMap { $0 }.joined(separator: " ")
        self.init(id: task.id, title: task.title, due: due.isEmpty ? nil : due)
    }
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
        var result: [TaskEntity] = []
        for id in identifiers where id.count == 36 {
            if let task: TodoTask = try? await api.request("/api/v1/tasks/\(id)") { result.append(TaskEntity(task)) }
        }
        return result
    }
    func entities(matching string: String) async throws -> [TaskEntity] {
        let query = string.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let tasks: [TodoTask] = try await SavedSession.require().request("/api/v1/tasks?completed=false&limit=20&q=\(query)")
        return tasks.map(TaskEntity.init)
    }
    func suggestedEntities() async throws -> [TaskEntity] {
        let tasks: [TodoTask] = try await SavedSession.require().request("/api/v1/tasks?completed=false&limit=200")
        // Dated tasks first, soonest first.
        return tasks.sorted { ($0.due_date ?? "9999", $0.due_time ?? "") < ($1.due_date ?? "9999", $1.due_time ?? "") }
            .prefix(20).map(TaskEntity.init)
    }
}
