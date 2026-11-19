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
