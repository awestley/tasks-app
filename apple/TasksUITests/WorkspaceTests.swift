import XCTest

final class WorkspaceTests: XCTestCase {
    let base = ProcessInfo.processInfo.environment["TASKS_TEST_BASE"] ?? "http://127.0.0.1:8002"
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
                for task in tasks where (task["title"] as? String)?.hasPrefix(taskTitle) == true {
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
        dismissSavePassword(app)
        return app
    }
    /// The simulator can offer to save the typed token as a password, covering the app. It is not part of the app.
    @MainActor func dismissSavePassword(_ app: XCUIApplication) {
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 3) { notNow.tap() }
    }
    /// On iPhone, search lives in its own tab.
    @MainActor func search(_ app: XCUIApplication, for text: String) {
        let tab = app.tabBars.buttons["Search"]
        if tab.exists { tab.tap() }
        let field = app.searchFields["Search tasks"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), app.debugDescription)
        field.tap(); field.typeText(text)
    }
    @MainActor func openSettings(_ app: XCUIApplication) {
        if !app.buttons["Settings"].exists { app.tabBars.buttons["Browse"].tap() }
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
        // Sign-in errors appear on the sign-in card, beside the server they concern.
        XCTAssertTrue(app.staticTexts["Your session has ended. Sign in again."].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.textFields["Your server URL"].exists)
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
            XCTAssertFalse(app.alerts.firstMatch.exists || app.staticTexts["signInError"].exists, "\(button) should not report an error")
            app.terminate()
        }
    }
    @MainActor func testLocalWorkspaceSignInAndSignOut() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        if app.buttons["Add task"].waitForExistence(timeout: 4) {
            openSettings(app)
            app.buttons["Remove local session"].tap()
        }
        let server = app.textFields["Your server URL"]
        XCTAssertTrue(server.waitForExistence(timeout: 8), app.debugDescription)
        replace(server, with: base)
        // A server the card already checked keeps its options. Any other server waits for Continue.
        if app.buttons["Continue"].waitForExistence(timeout: 1) { app.buttons["Continue"].tap() }
        // The test backend has no Apple credentials, so it offers only the local workspace, as the web does.
        let local = app.buttons["Open local workspace"]
        XCTAssertTrue(local.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Apple sign-in is not configured."].exists)
        local.tap()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        // A local sign-in is a full session, so settings can manage sessions, and signing out revokes it.
        openSettings(app)
        app.buttons["Sign out"].tap()
        XCTAssertTrue(server.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.staticTexts["signInError"].exists, app.debugDescription)
        XCTAssertTrue(local.waitForExistence(timeout: 10), "A saved server shows its sign-in methods right away: " + app.debugDescription)
    }
    /// Opens a task from search into the task view.
    @MainActor func openTask(_ app: XCUIApplication, _ title: String) {
        search(app, for: title)
        let row = app.buttons.containing(.staticText, identifier: title).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.tap()
        XCTAssertTrue(app.textFields["Task title"].waitForExistence(timeout: 5), app.debugDescription)
    }
    func saved(_ id: String) async throws -> [String:Any]? {
        let tasks = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        return tasks.first { $0["id"] as? String == id }
    }
    /// Waits for the server to hold a value the app saved on its own.
    func waitForSaved(_ id: String, _ check: @escaping ([String:Any]) -> Bool) async throws {
        for _ in 0..<20 {
            let task = try await saved(id)
            if let task, check(task) { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("The change was not saved")
    }
    @MainActor func testEditsSaveAsYouTypeAndKeepAnotherDevicesChange() async throws {
        let app = try await signedInApp()
        let created = try await request("/api/v1/tasks", method: "POST", body: ["title": taskTitle, "checklist": [["title": "First step", "completed": false]]]) as! [String:Any]
        let id = created["id"] as! String
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        openTask(app, taskTitle)
        // Another device changes the task after this one loaded it.
        _ = try await request("/api/v1/tasks/\(id)", method: "PATCH", body: ["version": 1, "priority": 2])
        let description = app.textFields["Description"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap(); description.typeText("Written on this device")
        try await waitForSaved(id) { $0["description"] as? String == "Written on this device" }
        let current = try await saved(id)
        let task = try XCTUnwrap(current)
        XCTAssertEqual(task["priority"] as? Int, 2, "The other device's change should stay")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Task view"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Close task"].tap()
        XCTAssertTrue(app.textFields["Task title"].waitForNonExistence(timeout: 5), app.debugDescription)
    }
    @MainActor func testTaskInUTCShowsItsTimeZone() async throws {
        let app = try await signedInApp()
        _ = try await request("/api/v1/tasks", method: "POST", body: ["title": taskTitle, "due_date": "2099-01-01", "due_time": "09:00", "time_zone": "UTC"])
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        openTask(app, taskTitle)
        let zone = app.staticTexts["taskTimeZone"]
        if !zone.exists { app.swipeUp() }
        XCTAssertTrue(zone.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(zone.label, "UTC")
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
        // Settings scrolled down to the device list; the account section is at the top.
        if !app.buttons["Remove local session"].exists { app.swipeDown() }
        XCTAssertTrue(app.buttons["Remove local session"].waitForExistence(timeout: 5), "This device stays signed in")
    }
    @MainActor func testSelectSeveralTasksAndChangeThemTogether() async throws {
        let app = try await signedInApp()
        var ids: [String: String] = [:]
        // Due today, so they show in Today without searching. Searching hides the navigation bar.
        let today = Date().formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
        for letter in ["A", "B", "C"] {
            let created = try await request("/api/v1/tasks", method: "POST", body: ["title": "\(taskTitle) \(letter)", "priority": 4, "due_date": today]) as! [String:Any]
            ids[letter] = created["id"] as? String
        }
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Add task"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(taskTitle) C")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        // Phones have no modifier keys, so selecting starts from the More menu.
        XCTAssertTrue(app.buttons["More"].firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["More"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Select tasks"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Select tasks"].tap()
        app.buttons["Select \(taskTitle) A"].tap()
        app.buttons["Select \(taskTitle) B"].tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["Select \(taskTitle) A"].isSelected)
        app.buttons["Priority"].tap()
        XCTAssertTrue(app.buttons["Urgent"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Urgent"].tap()
        var priorities: [String: Int] = [:]
        for _ in 0..<10 {
            let tasks = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
            for task in tasks { if let id = task["id"] as? String { priorities[id] = task["priority"] as? Int } }
            if priorities[ids["B"]!] == 1 { break }
            try await Task.sleep(for: .milliseconds(300))
        }
        XCTAssertEqual(priorities[ids["A"]!], 1)
        XCTAssertEqual(priorities[ids["B"]!], 1)
        XCTAssertEqual(priorities[ids["C"]!], 4, "Unselected tasks keep their priority")
        // The selection survives the change, so it can be deleted next.
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Delete"].tap()
        let confirm = app.buttons["Delete 2 tasks"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), app.debugDescription)
        confirm.tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForNonExistence(timeout: 10), "Selection ends when its tasks are gone: " + app.debugDescription)
        let remaining = (try await request("/api/v1/tasks?limit=200") as! [[String:Any]]).compactMap { $0["id"] as? String }
        XCTAssertFalse(remaining.contains(ids["A"]!))
        XCTAssertFalse(remaining.contains(ids["B"]!))
        XCTAssertTrue(remaining.contains(ids["C"]!))
        // A task's own menu can start a selection too.
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(taskTitle) C")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Select"].firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Select"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["1 selected"].waitForExistence(timeout: 5), app.debugDescription)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iOS selection"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["1 selected"].waitForNonExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["Complete \(taskTitle) C"].exists, app.debugDescription)
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
        dismissSavePassword(app)
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
        search(app, for: taskTitle)
        let row = app.buttons.containing(.staticText, identifier: taskTitle).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        row.tap()
        XCTAssertTrue(app.textFields["Task title"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(app.textFields["Task title"].value as? String, taskTitle)
        let description = app.textFields["Description"]
        XCTAssertTrue(description.waitForExistence(timeout: 5))
        description.tap(); description.typeText("Edited on iPhone")
        // The details follow the content on a phone.
        let reminder = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reminder")).firstMatch
        if !reminder.isHittable { app.swipeUp() }
        XCTAssertTrue(reminder.waitForExistence(timeout: 5), app.debugDescription)
        reminder.tap()
        app.buttons["15 minutes before"].tap()
        let details = XCTAttachment(screenshot: app.screenshot())
        details.name = "Task view details"; details.lifetime = .keepAlways; add(details)
        app.buttons["Close task"].tap()
        XCTAssertTrue(app.textFields["Task title"].waitForNonExistence(timeout: 10), app.debugDescription)
        try await waitForSaved(task["id"] as! String) { $0["description"] as? String == "Edited on iPhone" && $0["reminder_minutes"] as? Int == 15 }
        let afterEdit = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        let edited = try XCTUnwrap(afterEdit.first { $0["id"] as? String == task["id"] as? String })
        XCTAssertEqual(edited["description"] as? String, "Edited on iPhone")
        XCTAssertEqual(edited["reminder_minutes"] as? Int, 15)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iOS workspace"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["Complete \(taskTitle)"].tap()
        XCTAssertTrue(app.buttons["Restore \(taskTitle)"].waitForExistence(timeout: 10))
        let afterCompletion = try await request("/api/v1/tasks?limit=200") as! [[String:Any]]
        let completed = try XCTUnwrap(afterCompletion.first { $0["id"] as? String == task["id"] as? String })
        XCTAssertEqual(completed["completed"] as? Bool, true)
        if app.buttons["close"].exists { app.buttons["close"].tap() }
        app.tabBars.buttons["Browse"].tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["Settings"].tap()
        app.buttons["Enable notifications"].tap()
        XCTAssertTrue(app.alerts.staticTexts["Apple push needs to be configured on the server."].waitForExistence(timeout: 5))
        app.alerts.buttons["OK"].tap()
        // Notification preferences are saved on the server for every device.
        let summary = app.switches["Morning summary"]
        if !summary.isHittable { app.swipeUp() }
        XCTAssertTrue(summary.waitForExistence(timeout: 5), app.debugDescription)
        summary.switches.firstMatch.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Overdue follow-up")).firstMatch.exists, app.debugDescription)
        var saved: [String: Any] = [:]
        for _ in 0..<10 {
            saved = try await request("/api/v1/notifications/settings") as! [String: Any]
            if saved["summary_time"] as? String != nil { break }
            try await Task.sleep(for: .milliseconds(300))
        }
        XCTAssertEqual(saved["summary_time"] as? String, "08:00")
        let remove = app.buttons["Remove local session"]
        if !remove.exists || !remove.isHittable { app.swipeDown() }
        remove.tap()
        XCTAssertTrue(app.textFields["Your server URL"].waitForExistence(timeout: 5))
    }
}
