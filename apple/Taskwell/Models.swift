import Foundation

struct Project: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var color: String
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
    var due_date: String?
    var due_time: String?
    var time_zone: String
    var reminder_minutes: Int?
    var priority: Int
    var labels: [String]
    var checklist: [ChecklistItem]
    var recurrence: String?
    var completed: Bool
    var version: Int
}
struct Profile: Codable {
    let id: String
    let name: String
    let email: String
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
    var version: Int?
    enum CodingKeys: String, CodingKey { case title, description, project_id, due_date, priority, labels, checklist, recurrence, version, due_time, time_zone, reminder_minutes }
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
        try container.encodeIfPresent(version, forKey: .version)
    }
}
enum DateOnly {
    static var formatter: DateFormatter {
        let result = DateFormatter()
        result.calendar = Calendar(identifier: .gregorian)
        result.locale = Locale(identifier: "en_US_POSIX")
        result.dateFormat = "yyyy-MM-dd"
        return result
    }
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
