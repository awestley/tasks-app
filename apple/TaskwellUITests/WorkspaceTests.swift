import XCTest

final class WorkspaceTests: XCTestCase {
    let base = "http://127.0.0.1:8002"
    let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration)
    }()
    var temporarySession: String?
    let taskTitle = "iOS UI test " + UUID().uuidString.prefix(8)

    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Any {
        var request = URLRequest(url: URL(string: base + path)!)
        request.httpMethod = method
        request.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            throw NSError(domain: "LocalTestBackend", code: 1)
        }
        if path == "/auth/dev" {
            let headers = response.allHeaderFields.reduce(into: [String:String]()) { $0[String(describing:$1.key)] = String(describing:$1.value) }
            temporarySession = HTTPCookie.cookies(withResponseHeaderFields: headers, for: URL(string:base)!).first(where: { $0.name == "taskwell_session" })?.value
        }
        return data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data)
    }
    override func tearDown() async throws {
        // Revoke the temporary login even when a UI assertion fails. Never create a persistent API token.
        if temporarySession != nil {
            do {
                let tasks = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
                for task in tasks where task["title"] as? String == taskTitle {
                    _ = try await request("/api/v1/tasks/\(task["id"] as! String)?version=\(task["version"] as! Int)", method:"DELETE")
                }
            } catch { XCTFail("Could not clean up the temporary test task") }
            _ = try await request("/auth/logout", method:"POST")
        }
        try await super.tearDown()
    }
    @MainActor func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        field.press(forDuration: 1.2)
        let selectAll = XCUIApplication().menuItems["Select All"]
        if selectAll.waitForExistence(timeout: 2) { selectAll.tap() }
        else {
            let old = field.value as? String ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text)
    }
    @MainActor func testQuickEntryAndPersistence() async throws {
        continueAfterFailure = false
        _ = try await request("/auth/dev", method: "POST")
        let token = try XCTUnwrap(temporarySession)
        let app = XCUIApplication()
        app.launch()
        if app.alerts.firstMatch.waitForExistence(timeout: 2) { app.alerts.buttons["OK"].tap() }
        let server = app.textFields["Your server URL"]
        XCTAssertTrue(server.waitForExistence(timeout: 8), app.debugDescription)
        replace(server, with: base)
        app.buttons["Local development"].tap()
        let tokenField = app.secureTextFields.firstMatch
        XCTAssertTrue(tokenField.waitForExistence(timeout: 3))
        tokenField.tap(); tokenField.typeText(token)
        app.buttons["Use development token"].tap()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Add task"].tap()
        let field = app.textFields["Task title, e.g. Order pizza Friday afternoon"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText(taskTitle + " Friday afternoon")
        XCTAssertTrue(app.buttons["Use details and edit"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Use details and edit"].tap()
        XCTAssertEqual(field.value as? String, taskTitle)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 10), app.debugDescription)
        let tasks = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        let task = try XCTUnwrap(tasks.first { $0["title"] as? String == taskTitle })
        XCTAssertEqual(task["due_time"] as? String, "15:00")
        XCTAssertEqual(task["reminder_minutes"] as? Int, 0)
        XCTAssertNotNil(task["due_date"] as? String)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), "Session should survive relaunch")
        let search = app.searchFields["Search tasks"]
        search.tap(); search.typeText(taskTitle)
        let row = app.buttons.containing(.staticText, identifier: taskTitle).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.tap()
        XCTAssertTrue(app.navigationBars["Edit task"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(field.value as? String, taskTitle)
        let description = app.textFields["Description"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap(); description.typeText("Edited on iPhone")
        // Dismiss the keyboard and scroll the form to the reminder controls.
        app.swipeUp()
        let reminder = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reminder")).firstMatch
        if !reminder.isHittable { app.swipeUp() }
        XCTAssertTrue(reminder.waitForExistence(timeout: 5), app.debugDescription)
        reminder.tap()
        app.buttons["15 minutes before"].tap()
        app.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Edit task"].waitForNonExistence(timeout: 10), app.debugDescription)
        let afterEdit = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        let edited = try XCTUnwrap(afterEdit.first { $0["id"] as? String == task["id"] as? String })
        XCTAssertEqual(edited["description"] as? String, "Edited on iPhone")
        XCTAssertEqual(edited["reminder_minutes"] as? Int, 15)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Taskwell iOS workspace"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Complete \(taskTitle)"].tap()
        XCTAssertTrue(app.buttons["Restore \(taskTitle)"].waitForExistence(timeout: 10))
        let afterCompletion = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        let completed = try XCTUnwrap(afterCompletion.first { $0["id"] as? String == task["id"] as? String })
        XCTAssertEqual(completed["completed"] as? Bool, true)
        if app.buttons["close"].exists { app.buttons["close"].tap() }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Settings"].tap()
        app.buttons["Enable notifications"].tap()
        XCTAssertTrue(app.alerts.staticTexts["Apple push needs to be configured on the server."].waitForExistence(timeout: 5))
        app.alerts.buttons["OK"].tap()
        app.buttons["Remove local session"].tap()
        XCTAssertTrue(app.textFields["Your server URL"].waitForExistence(timeout: 5))
    }
}
