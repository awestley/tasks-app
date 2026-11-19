import AppIntents
import CoreSpotlight
import Foundation

/// Keeps every task in the on-device Spotlight index, where Siri finds them by meaning ("what do I need for the
/// dentist?") and Spotlight search lists open ones. Only tasks that changed since the last sync are written.
enum Spotlight {
    /// Task ID to a signature of what was indexed: its version and project name.
    private static let storageKey = "spotlightTasks"
    private static var index: CSSearchableIndex { .default() }

    static func signature(_ task: TodoTask, project: String?) -> String { "\(task.version)|\(project ?? "")" }

    /// Indexes new and changed tasks and removes deleted ones.
    static func sync(_ tasks: [TodoTask], projects: [Project]) async {
        let names = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let stored = UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String] ?? [:]
        var next: [String: String] = [:]
        var changed: [TaskEntity] = []
        for task in tasks {
            let project = task.project_id.flatMap { names[$0] }
            let value = signature(task, project: project)
            next[task.id] = value
            if stored[task.id] != value { changed.append(TaskEntity(task, project: project)) }
        }
        let removed = Array(Set(stored.keys).subtracting(next.keys))
        do {
            if !changed.isEmpty { try await index.indexAppEntities(changed) }
            if !removed.isEmpty { try await index.deleteAppEntities(identifiedBy: removed, ofType: TaskEntity.self) }
            UserDefaults.standard.set(next, forKey: storageKey)
        } catch {
            // Indexing is best effort. The next refresh tries again, since nothing was recorded.
        }
    }

    /// Indexes tasks changed outside the app's window, such as by Siri, without waiting for the next refresh.
    static func index(_ tasks: [TodoTask], api: API) async {
        let entities = await TaskEntity.load(tasks, api: api)
        guard (try? await index.indexAppEntities(entities)) != nil else { return }
        var stored = UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String] ?? [:]
        for (task, entity) in zip(tasks, entities) { stored[task.id] = signature(task, project: entity.project) }
        UserDefaults.standard.set(stored, forKey: storageKey)
    }

    /// Removes every task, when signing out or the session ends.
    static func clear() async {
        try? await index.deleteAppEntities(ofType: TaskEntity.self)
        UserDefaults.standard.removeObject(forKey: storageKey)
    }
}
