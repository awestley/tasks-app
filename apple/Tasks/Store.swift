import Foundation
import Combine

@MainActor final class Store: ObservableObject {
    @Published var tasks: [TodoTask] = []
    @Published var projects: [Project] = []
    @Published var profile: Profile?
    @Published var error: String?
    /// Set while the server cannot be reached, such as "Can't reach localhost:8004." Cleared by the next successful refresh.
    @Published var unreachable: String?
    @Published var busy = false
    @Published var server = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    var api: API { API(server: server, token: Keychain.read(server: server)) }
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// Runs work one at a time, in order. Work started during a refresh waits its turn instead of being lost.
    func perform(_ action: () async throws -> Void) async {
        if busy { await withCheckedContinuation { waiting.append($0) } }
        busy = true
        defer { if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() } }
        do { try await action() } catch { report(error) }
    }
    func report(_ error: Error) {
        if let error = error as? APIError, error.sessionEnded { endSession(); return }
        let text = message(for: error)
        if Store.isConnectionFailure(error) { unreachable = text }
        self.error = text
    }
    /// Connection failures mean the server is down, the address is wrong, or this device is offline.
    static func isConnectionFailure(_ error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.cannotConnectToHost, .cannotFindHost, .timedOut, .notConnectedToInternet, .networkConnectionLost,
                .dnsLookupFailed, .cannotLoadFromNetwork, .internationalRoamingOff, .dataNotAllowed].contains(error.code)
    }
    /// Names the server in connection failures, so a wrong or stopped server is obvious.
    func message(for error: Error) -> String {
        Store.isConnectionFailure(error) ? "Can't reach \(Store.displayName(server))." : error.localizedDescription
    }
    /// The host and port, such as localhost:8004 or tasks.example.com.
    static func displayName(_ server: String) -> String {
        guard let url = URL(string: server), let host = url.host else { return server }
        return url.port.map { "\(host):\($0)" } ?? host
    }
    /// Returns to the sign-in card so the server address can be changed. Keeps the saved session for this server,
    /// so choosing it again signs straight back in.
    func changeServer() {
        profile = nil
        tasks = []
        projects = []
        unreachable = nil
        error = nil
    }
    /// Keeps notification settings on purpose, so they resume after signing in again.
    private func endSession() {
        try? Keychain.save(nil, server: server)
        profile = nil
        tasks = []
        projects = []
        unreachable = nil
        error = "Your session has ended. Sign in again."
    }
    /// True once the person has chosen a server.
    var serverSaved: Bool { !server.isEmpty }
    static func origin(_ server: String) -> String {
        server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    func connect(server: String) throws {
        let value = Store.origin(server)
        guard let url = URL(string: value), let host = url.host, url.query == nil, url.fragment == nil,
              url.path.isEmpty, url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
        else { throw APIError(message: "Enter an HTTPS origin without a path, such as https://tasks.example.com.") }
        if self.server != value { profile = nil; tasks = []; projects = []; unreachable = nil }
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
        unreachable = nil
        Notifications.shared.attach(self)
        // Not awaited: system notification and alarm calls must never hold up the task list.
        Task { await Notifications.shared.didRefresh(all) }
    }
    func signIn(code: String, challenge: String) async throws {
        let result: AccessToken = try await api.request("/auth/apple/native", method: "POST", body: API.body(["code": code, "challenge_id": challenge]))
        try Keychain.save(result.access_token, server: server)
        try await refresh()
    }
    /// Signs in to the local development workspace. Development servers offer this to this computer only.
    func signInLocally() async throws {
        let result: AccessToken = try await api.request("/auth/dev/native", method: "POST")
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
    /// Notifies every enabled device about the task again later.
    func snooze(_ task: TodoTask, minutes: Int? = nil, until: Date? = nil) async {
        await perform {
            let body: [String: Any] = until.map { ["until": $0.formatted(.iso8601)] } ?? ["minutes": minutes ?? 15]
            let _: TodoTask = try await self.api.request("/api/v1/tasks/\(task.id)/snooze", method: "POST", body: API.body(body))
            try await self.refresh()
        }
    }
    func duplicate(_ task: TodoTask) async {
        await perform {
            let copy = TaskDraft(title: task.title, description: task.description, project_id: task.project_id, due_date: task.due_date, due_time: task.due_time, time_zone: task.time_zone, reminder_minutes: task.reminder_minutes, priority: task.priority, labels: task.labels, checklist: task.checklist.map { ChecklistItem(title: $0.title, completed: $0.completed) }, recurrence: task.recurrence, alert_style: task.alert_style ?? "notification")
            try await self.save(copy, id: nil)
        }
    }
    func delete(_ task: TodoTask) async throws {
        try await api.send("/api/v1/tasks/\(task.id)?version=\(task.version)", method: "DELETE")
        try await refresh()
    }
    func signOut() async throws {
        do {
            try await Notifications.shared.disable()
            try await api.send("/auth/logout", method: "POST")
        } catch let error as APIError where error.sessionEnded {
            // The server already ended this session, so there is nothing left to revoke there.
        }
        try forgetSession()
    }
    func forgetSession() throws {
        Notifications.shared.clearLocal()
        try Keychain.save(nil, server: server)
        profile = nil
        tasks = []
        projects = []
        unreachable = nil
    }
    func deleteAccount() async throws {
        try await api.send("/api/v1/me", method: "DELETE")
        try forgetSession()
    }
}
