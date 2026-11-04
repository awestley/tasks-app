import Foundation
import Combine

@MainActor final class Store: ObservableObject {
    @Published var tasks: [TodoTask] = []
    @Published var projects: [Project] = []
    @Published var profile: Profile?
    @Published var error: String?
    @Published var busy = false
    @Published var server = UserDefaults.standard.string(forKey: "serverURL") ?? "https://tasks.example.com"
    var api: API { API(server: server, token: Keychain.read(server: server)) }
    func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await action() } catch { self.error = error.localizedDescription }
    }
    func connect(server: String) throws {
        let value = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: value), let host = url.host, url.query == nil, url.fragment == nil,
              url.path.isEmpty, url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
        else { throw APIError(message: "Enter an HTTPS origin without a path, such as https://tasks.example.com.") }
        if self.server != value { profile = nil; tasks = []; projects = [] }
        self.server = value
        UserDefaults.standard.set(value, forKey: "serverURL")
    }
    func restore() async {
        guard Keychain.read(server: server) != nil else { return }
        await perform { try await self.refresh() }
    }
    func refresh() async throws {
        let client = api
        async let person: Profile = client.request("/api/v1/me")
        async let groups: [Project] = client.request("/api/v1/projects")
        var all: [TodoTask] = []
        var offset = 0
        while true {
            let page: [TodoTask] = try await client.request("/api/v1/tasks?limit=200&offset=\(offset)")
            all.append(contentsOf: page)
            if page.count < 200 { break }
            offset += 200
        }
        let (nextProfile, nextProjects) = try await (person, groups)
        profile = nextProfile
        projects = nextProjects
        tasks = all
        Notifications.shared.attach(self)
    }
    func signIn(code: String, challenge: String) async throws {
        let result: AccessToken = try await api.request("/auth/apple/native", method: "POST", body: API.body(["code": code, "challenge_id": challenge]))
        try Keychain.save(result.access_token, server: server)
        try await refresh()
    }
    func save(_ draft: TaskDraft, id: String?) async throws {
        let _: TodoTask = try await api.request(id.map { "/api/v1/tasks/\($0)" } ?? "/api/v1/tasks", method: id == nil ? "POST" : "PATCH", body: JSONEncoder().encode(draft))
        try await refresh()
    }
    func toggle(_ task: TodoTask) async {
        await perform {
            let _: TodoTask = try await self.api.request("/api/v1/tasks/\(task.id)", method: "PATCH", body: API.body(["version": task.version, "completed": !task.completed]))
            try await self.refresh()
        }
    }
    /// Changes a few fields of a task. Pass NSNull() to clear a field.
    func update(_ task: TodoTask, _ fields: [String: Any]) async {
        await perform {
            let _: TodoTask = try await self.api.request("/api/v1/tasks/\(task.id)", method: "PATCH", body: API.body(fields.merging(["version": task.version]) { $1 }))
            try await self.refresh()
        }
    }
    func duplicate(_ task: TodoTask) async {
        await perform {
            let copy = TaskDraft(title: task.title, description: task.description, project_id: task.project_id, due_date: task.due_date, due_time: task.due_time, time_zone: task.time_zone, reminder_minutes: task.reminder_minutes, priority: task.priority, labels: task.labels, checklist: task.checklist.map { ChecklistItem(title: $0.title, completed: $0.completed) }, recurrence: task.recurrence)
            try await self.save(copy, id: nil)
        }
    }
    func delete(_ task: TodoTask) async throws {
        try await api.send("/api/v1/tasks/\(task.id)?version=\(task.version)", method: "DELETE")
        try await refresh()
    }
    func signOut() async throws {
        try await Notifications.shared.disable()
        try await api.send("/auth/logout", method: "POST")
        try forgetSession()
    }
    func forgetSession() throws {
        Notifications.shared.clearLocal()
        try Keychain.save(nil, server: server)
        profile = nil
        tasks = []
        projects = []
    }
    func deleteAccount() async throws {
        try await api.send("/api/v1/me", method: "DELETE")
        try forgetSession()
    }
}
