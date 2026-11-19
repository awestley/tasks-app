import AppIntents
import AppIntentsTesting
import XCTest

/// Runs the app's intents, Spotlight entities and on-screen annotations the way Siri reaches them,
/// against the isolated test backend.
extension WorkspaceTests {
    var intents: IntentDefinitions { IntentDefinitions(bundleIdentifier: "com.example.tasks.ios") }

    func task(titled prefix: String) async throws -> [String: Any]? {
        let tasks = try await request("/api/v1/tasks?limit=200") as! [[String: Any]]
        return tasks.first { ($0["title"] as? String)?.hasPrefix(prefix) == true }
    }

    @MainActor func testSiriAddsFindsAndMovesATask() async throws {
        let app = try await signedInApp()
        let title = "\(taskTitle) bring the dentist forms"

        // Everything in the title, as when Siri asks "What's the task?": the date and time are read out of it.
        try await intents.intents["AddTaskIntent"].makeIntent(title: "\(title) tomorrow at 3pm").run()
        let first = try await task(titled: taskTitle)
        let added = try XCTUnwrap(first, "Add Task did not create the task")
        let id = try XCTUnwrap(added["id"] as? String)
        XCTAssertEqual(added["title"] as? String, title)
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
        XCTAssertEqual(added["due_date"] as? String, tomorrow.formatted(.iso8601.year().month().day().dateSeparator(.dash)))
        XCTAssertEqual(added["due_time"] as? String, "15:00")
        XCTAssertEqual(added["space"] as? String, "personal")

        // Siri finds it by meaning through the Spotlight index.
        let taskType = intents.entities["TaskEntity"]
        var found: [AnyAppEntity] = []
        for _ in 0..<10 where !found.contains(where: { "\($0.identifier)".contains(id) }) {
            found = try await taskType.spotlightQuery("dentist forms")
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTAssertTrue(found.contains { "\($0.identifier)".contains(id) }, "Spotlight did not return the task: \(found)")

        // The task is on screen in Upcoming, annotated so Siri can act on "this".
        app.tabBars.buttons["Upcoming"].tap()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), app.debugDescription)
        let annotated = try await taskType.viewAnnotations()
        XCTAssertTrue(annotated.contains { "\($0.entity.identifier)".contains(id) }, "The row is not annotated: \(annotated)")

        // "Move this to Work."
        try await intents.intents["MoveTaskIntent"].makeIntent(task: taskType.makeReference(identifier: id),
                                                                space: AnyAppEnum(typeIdentifier: "Space", rawValue: "work")).run()
        try await waitForSaved(id) { $0["space"] as? String == "work" }
        XCTAssertFalse(app.staticTexts[title].waitForExistence(timeout: 1), "The moved task is still listed in Personal")

        // A new task joins the space asked for, and a due time given on its own reminds at that time.
        let plain = "\(taskTitle) renew the passport"
        var due = Calendar.current.dateComponents([.year, .month, .day], from: tomorrow)
        due.hour = 9
        due.minute = 30
        try await intents.intents["AddTaskIntent"].makeIntent(title: plain, due: due,
                                                              space: AnyAppEnum(typeIdentifier: "Space", rawValue: "work")).run()
        let created = try await task(titled: plain)
        let second = try XCTUnwrap(created)
        XCTAssertEqual(second["title"] as? String, plain)
        XCTAssertEqual(second["space"] as? String, "work")
        XCTAssertEqual(second["due_time"] as? String, "09:30")
        XCTAssertEqual(second["reminder_minutes"] as? Int, 0)
    }
}

/// Apple's reminder schema, which Siri uses for requests that name no app ("Remind me to take out the trash").
extension WorkspaceTests {
    @MainActor func testReminderSchemaCreatesChangesAndDeletesTasks() async throws {
        _ = try await signedInApp()
        let tasks = intents.entities["TaskEntity"]
        let lists = intents.entities["ProjectEntity"]

        // "Remind me to take out the trash tomorrow at 7pm, every week."
        let title = "\(taskTitle) take out the trash"
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
        var due = Calendar.current.dateComponents([.year, .month, .day], from: tomorrow)
        due.hour = 19
        due.minute = 0
        try await intents.intents["CreateReminderIntent"].makeIntent(
            title: title, list: lists.makeReference(identifier: "inbox-work"), note: AttributedString("Bins by the gate"),
            isFlagged: true, tags: Set(["home"]), urls: [URL(string: "https://example.com/collection")!], dueDate: due,
            recurrence: Calendar.RecurrenceRule(calendar: .current, frequency: .weekly)).run()
        let created = try await task(titled: title)
        let added = try XCTUnwrap(created, "Create Reminder did not create the task")
        let id = try XCTUnwrap(added["id"] as? String)
        XCTAssertEqual(added["title"] as? String, title)
        XCTAssertEqual(added["space"] as? String, "work")
        XCTAssertTrue(added["project_id"] is NSNull || added["project_id"] == nil)
        XCTAssertEqual(added["description"] as? String, "Bins by the gate")
        XCTAssertEqual(added["priority"] as? Int, 1)
        XCTAssertEqual(added["labels"] as? [String], ["home"])
        XCTAssertEqual(added["due_date"] as? String, tomorrow.formatted(.iso8601.year().month().day().dateSeparator(.dash)))
        XCTAssertEqual(added["due_time"] as? String, "19:00")
        XCTAssertEqual(added["reminder_minutes"] as? Int, 0)
        XCTAssertEqual(added["recurrence"] as? String, "weekly")
        let links = try await request("/api/v1/tasks/\(id)/links") as! [[String: Any]]
        XCTAssertEqual(links.first?["url"] as? String, "https://example.com/collection")

        // "Create a list called groceries", then a reminder in it.
        let listName = "\(taskTitle) groceries"
        try await intents.intents["CreateListIntent"].makeIntent(type: AnyAppEnum(typeIdentifier: "ListType", rawValue: "standard"),
                                                                 name: listName).run()
        let projects = try await request("/api/v1/projects") as! [[String: Any]]
        let project = try XCTUnwrap(projects.first { $0["name"] as? String == listName }, "Create List did not create the project")
        let projectID = try XCTUnwrap(project["id"] as? String)
        let milk = "\(taskTitle) buy milk"
        try await intents.intents["CreateReminderIntent"].makeIntent(title: milk, list: lists.makeReference(identifier: projectID)).run()
        let inList = try await task(titled: milk)
        XCTAssertEqual(try XCTUnwrap(inList)["project_id"] as? String, projectID)

        // "Rename it to take the bins out, move it to Personal and mark it done."
        let renamed = "\(taskTitle) take the bins out"
        try await intents.intents["UpdateReminderIntent"].makeIntent(
            target: tasks.makeReference(identifier: id), title: renamed, isFlagged: false,
            list: lists.makeReference(identifier: "inbox-personal")).run()
        try await waitForSaved(id) { $0["title"] as? String == renamed && $0["space"] as? String == "personal" && $0["priority"] as? Int == 4 }
        try await intents.intents["UpdateReminderIntent"].makeIntent(target: tasks.makeReference(identifier: id), isCompleted: true).run()
        let done = try await request("/api/v1/tasks/\(id)") as! [String: Any]
        XCTAssertEqual(done["completed"] as? Bool, true)

        // "Delete this reminder."
        let milkID = try XCTUnwrap(try XCTUnwrap(inList)["id"] as? String)
        try await intents.intents["DeleteRemindersIntent"].makeIntent(entities: [tasks.makeReference(identifier: milkID)]).run()
        do {
            _ = try await request("/api/v1/tasks/\(milkID)")
            XCTFail("Delete Reminders did not delete the task")
        } catch {}
        _ = try await request("/api/v1/projects/\(projectID)", method: "DELETE")
    }
}
