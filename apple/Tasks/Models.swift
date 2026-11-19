import Foundation

/// Work and personal tasks are kept apart: the apps show one space at a time.
enum Space: String, CaseIterable, Identifiable, Sendable {
    case personal, work
    var id: String { rawValue }
    var name: String { self == .work ? "Work" : "Personal" }
    var symbol: String { self == .work ? "briefcase" : "house" }
    var other: Space { self == .work ? .personal : .work }
}
struct Project: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var color: String
    var space: String? = "personal"
    var inSpace: Space { Space(rawValue: space ?? "") ?? .personal }
}
struct ChecklistItem: Codable, Identifiable, Hashable {
    var id = UUID().uuidString
    var title = ""
    var completed = false
}
struct TodoTask: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var description: String
    var project_id: String?
    /// Always the project's space when the task is in a project.
    var space: String? = "personal"
    var due_date: String?
    var due_time: String?
    var time_zone: String
    var reminder_minutes: Int?
    var priority: Int
    var labels: [String]
    var checklist: [ChecklistItem]
    var recurrence: String?
    var alert_style: String? = "notification"
    var snoozed_until: String?
    var completed: Bool
    var version: Int
    var isAlarm: Bool { alert_style == "alarm" }
    var inSpace: Space { Space(rawValue: space ?? "") ?? .personal }
    /// The due time as an instant, read in the task's own time zone.
    var dueInstant: Date? {
        guard let due_date, let due_time, let zone = TimeZone(identifier: time_zone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let day = due_date.split(separator: "-").compactMap { Int($0) }
        let clock = due_time.split(separator: ":").compactMap { Int($0) }
        guard day.count == 3, clock.count == 2 else { return nil }
        return calendar.date(from: DateComponents(year: day[0], month: day[1], day: day[2], hour: clock[0], minute: clock[1]))
    }
    var reminderInstant: Date? {
        guard !completed, let reminder_minutes, let due = dueInstant else { return nil }
        return due.addingTimeInterval(-Double(reminder_minutes) * 60)
    }
    var snoozedInstant: Date? {
        guard !completed, let snoozed_until else { return nil }
        return ServerDate.parse(snoozed_until)
    }
}
/// The server sends UTC times without an offset, sometimes with fractional seconds.
enum ServerDate {
    static func parse(_ value: String) -> Date? {
        var text = value.split(separator: ".").first.map(String.init) ?? value
        if !text.hasSuffix("Z") && !text.contains("+") { text += "Z" }
        return try? Date(text, strategy: .iso8601)
    }
}
struct NotificationPreferences: Codable, Equatable {
    var summary_time: String?
    var summary_zone = TimeZone.current.identifier
    var overdue_minutes: Int?
    var time_sensitive_priority = 1
}
struct Profile: Codable {
    let id: String
    let name: String
    let email: String
}
/// The sign-in methods a server offers, from GET /auth/config.
struct AuthConfig: Codable {
    let apple_enabled: Bool
    /// Only development servers on this computer offer it.
    let dev_login: Bool
}
struct AppleChallenge: Codable {
    let challenge_id: String
    let nonce: String
}
struct AccessToken: Codable {
    let access_token: String
}
struct PersonalToken: Codable, Identifiable {
    let id: String
    let name: String
    let expires_at: String
}
struct CreatedToken: Codable { let token: String }
struct DeviceSession: Codable, Identifiable {
    let id: String
    let kind: String
    let current: Bool
}
struct TaskDraft: Encodable {
    var title = ""
    var description = ""
    var project_id: String?
    var due_date: String?
    var due_time: String?
    var time_zone = TimeZone.current.identifier
    var reminder_minutes: Int?
    var priority = 4
    var labels: [String] = []
    var checklist: [ChecklistItem] = []
    var recurrence: String?
    var alert_style = "notification"
    var version: Int?
    /// Set for a new task; a project decides it otherwise.
    var space: String?
    /// Set by a client that wants a retried create to return the same task.
    var id: String?
    enum CodingKeys: String, CodingKey { case id, title, description, project_id, due_date, priority, labels, checklist, recurrence, version, due_time, time_zone, reminder_minutes, alert_style, space }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(title, forKey: .title)
        try container.encode(description, forKey: .description)
        try container.encode(project_id, forKey: .project_id)
        try container.encode(due_date, forKey: .due_date)
        try container.encode(due_time, forKey: .due_time)
        try container.encode(time_zone, forKey: .time_zone)
        try container.encode(reminder_minutes, forKey: .reminder_minutes)
        try container.encode(priority, forKey: .priority)
        try container.encode(labels, forKey: .labels)
        try container.encode(checklist, forKey: .checklist)
        try container.encode(recurrence, forKey: .recurrence)
        try container.encode(alert_style, forKey: .alert_style)
        try container.encodeIfPresent(version, forKey: .version)
        try container.encodeIfPresent(space, forKey: .space)
        try container.encodeIfPresent(id, forKey: .id)
    }
}
enum DateOnly {
    // Formatters are slow to create, and these dates are read for every task on every render.
    static let formatter: DateFormatter = {
        let result = DateFormatter()
        result.calendar = Calendar(identifier: .gregorian)
        result.locale = Locale(identifier: "en_US_POSIX")
        result.timeZone = .autoupdatingCurrent
        result.dateFormat = "yyyy-MM-dd"
        return result
    }()
    static func string(_ date: Date) -> String { formatter.string(from: date) }
    static func date(_ string: String) -> Date { formatter.date(from: string) ?? Date() }
}

struct ParsedTask: Decodable {
    let title: String
    let due_date: String?
    let due_time: String?
    let time_zone: String
    let reminder_minutes: Int?
    let recurrence: String?
    let priority: Int?
    let labels: [String]
    let project_id: String?
    let recognized: [String]
}
struct AgentAvailability: Codable { var available: Bool; var servers: [String] }
struct AgentAction: Codable, Hashable { var server: String; var tool: String; var ok: Bool }
/// One request to the server's agent to work on a task.
struct AgentRun: Codable, Identifiable, Hashable {
    let id: String
    var status: String
    var summary: String
    var actions: [AgentAction]
    var error: String?
    var active: Bool { status == "queued" || status == "running" }
}
/// A task or project points at an item in another app (a pc:// reference) or a web page.
struct ItemLink: Codable, Identifiable, Hashable {
    let id: String
    var ref: String?
    var title: String
    var url: String?
}
