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
            temporarySession = HTTPCookie.cookies(withResponseHeaderFields: headers, for: URL(string:base)!).first(where: { $0.name == "tasks_session" })?.value
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
    /// Signs the app in with a temporary local session, which `endSession` can revoke from outside the app.
    @MainActor func signedInApp(arguments: [String] = []) async throws -> XCUIApplication {
        continueAfterFailure = false
        _ = try await request("/auth/dev", method: "POST")
        let token = try XCTUnwrap(temporarySession)
        let app = XCUIApplication()
        app.launchArguments += arguments
        app.launch()
        if app.buttons["Add task"].waitForExistence(timeout: 4) {
            // A previous run left a session behind. Start from sign-in so this run uses its own.
            openSettings(app)
            app.buttons["Remove local session"].tap()
        } else if app.alerts.firstMatch.exists { app.alerts.buttons["OK"].tap() }
        let server = app.textFields["Your server URL"]
        XCTAssertTrue(server.waitForExistence(timeout: 8), app.debugDescription)
        replace(server, with: base)
        app.buttons["Local development"].tap()
        let tokenField = app.secureTextFields.firstMatch
        XCTAssertTrue(tokenField.waitForExistence(timeout: 3))
        tokenField.tap(); tokenField.typeText(token)
        app.buttons["Use development token"].tap()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        return app
    }
    @MainActor func openSettings(_ app: XCUIApplication) {
        if !app.buttons["Settings"].exists { app.navigationBars.buttons.element(boundBy: 0).tap() }
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Remove local session"].waitForExistence(timeout: 5), app.debugDescription)
    }
    func endSession() async throws {
        _ = try await request("/auth/logout", method: "POST")
        temporarySession = nil
    }
    @MainActor func testEndedSessionReturnsToSignInOnActivation() async throws {
        let app = try await signedInApp()
        try await endSession()
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.alerts.staticTexts["Your session has ended. Sign in again."].waitForExistence(timeout: 10), app.debugDescription)
        app.alerts.buttons["OK"].tap()
        XCTAssertTrue(app.textFields["Your server URL"].waitForExistence(timeout: 5))
    }
    @MainActor func testSignOutAndRemoveSessionWorkAfterSessionEndsWithPushOn() async throws {
        // Registers this device as push-enabled, so sign-out has server cleanup to attempt.
        let push = ["-pushDevice:" + base, "device-from-an-earlier-run"]
        for button in ["Sign out", "Remove local session"] {
            let app = try await signedInApp(arguments: push)
            openSettings(app)
            try await endSession()
            app.buttons[button].tap()
            XCTAssertTrue(app.textFields["Your server URL"].waitForExistence(timeout: 10), "\(button): " + app.debugDescription)
            XCTAssertFalse(app.alerts.firstMatch.exists, "\(button) should not report an error")
            app.terminate()
        }
    }
    @MainActor func testConflictKeepsDraftAndSecondSaveSucceeds() async throws {
        let app = try await signedInApp()
        let created = try await request("/api/v1/tasks", method: "POST", body: ["title": taskTitle]) as! [String:Any]
        let id = created["id"] as! String
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        let search = app.searchFields["Search tasks"]
        search.tap(); search.typeText(taskTitle)
        // A row with only a title exposes it as the button's own label.
        let row = app.buttons[taskTitle]
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.tap()
        let description = app.textFields["Description"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap(); description.typeText("Written on this device")
        _ = try await request("/api/v1/tasks/\(id)", method: "PATCH", body: ["version": 1, "priority": 2])
        app.buttons["Save"].tap()
        let notice = app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "changed on another device")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 10), app.debugDescription)
        app.alerts.buttons["OK"].tap()
        // Typing replaces the placeholder that identified the field, so find it by what it now holds.
        let draft = app.textFields.matching(NSPredicate(format: "value == %@", "Written on this device")).firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 5), "The draft should survive the conflict: " + app.debugDescription)
        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
        let save = app.buttons["Save"]
        let enabled = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: save)
        await fulfillment(of: [enabled], timeout: 5)
        save.tap()
        XCTAssertTrue(app.navigationBars["Edit task"].waitForNonExistence(timeout: 10), app.debugDescription)
        let saved = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        XCTAssertEqual(saved.first { $0["id"] as? String == id }?["description"] as? String, "Written on this device")
    }
    @MainActor func testTaskInUTCShowsItsTimeZone() async throws {
        let app = try await signedInApp()
        _ = try await request("/api/v1/tasks", method: "POST", body: ["title": taskTitle, "due_date": "2099-01-01", "due_time": "09:00", "time_zone": "UTC"])
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        let search = app.searchFields["Search tasks"]
        search.tap(); search.typeText(taskTitle)
        let row = app.buttons.containing(.staticText, identifier: taskTitle).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.tap()
        XCTAssertTrue(app.navigationBars["Edit task"].waitForExistence(timeout: 5), app.debugDescription)
        let picker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Time zone")).firstMatch
        if !picker.exists { app.swipeUp() }
        XCTAssertTrue(picker.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(picker.label.contains("UTC"), picker.label)
    }
    @MainActor func testAnotherDevicesSessionCanBeEnded() async throws {
        let app = try await signedInApp()
        // A second session, as if signed in on another device. It has its own cookie storage.
        let other = URLSession(configuration: .ephemeral)
        var login = URLRequest(url: URL(string: base + "/auth/dev")!)
        login.httpMethod = "POST"
        login.setValue("http://127.0.0.1:5173", forHTTPHeaderField: "Origin")
        _ = try await other.data(for: login)
        let profile = URL(string: base + "/api/v1/me")!
        let (_, before) = try await other.data(from: profile)
        XCTAssertEqual((before as? HTTPURLResponse)?.statusCode, 200)
        openSettings(app)
        let end = app.buttons["End session"].firstMatch
        if !end.waitForExistence(timeout: 3) { app.swipeUp() }
        XCTAssertTrue(end.waitForExistence(timeout: 5), app.debugDescription)
        end.tap()
        let after = expectation(description: "The other session ends")
        for _ in 0..<10 {
            try await Task.sleep(for: .milliseconds(500))
            let (_, response) = try await other.data(from: profile)
            if (response as? HTTPURLResponse)?.statusCode == 401 { after.fulfill(); break }
        }
        await fulfillment(of: [after], timeout: 1)
        XCTAssertTrue(app.buttons["Remove local session"].exists, "This device stays signed in")
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
        screenshot.name = "Tasks iOS workspace"; screenshot.lifetime = .keepAlways; add(screenshot)
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
