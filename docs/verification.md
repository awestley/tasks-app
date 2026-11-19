# Verification record

Local verification on October 26, 2026:

- React/TypeScript production build.
- macOS Debug build with Xcode, signing disabled.
- iOS Simulator Debug build with Xcode, signing disabled.
- API test suite on SQLite, including resource ownership, input validation, cookie Origin checks, optimistic concurrency, recurrence, pagination, project deletion, credential scopes/revocation, and account deletion.
- Apple integration tests against the included Postman HTTP simulation, using ephemeral signed RSA ID tokens and an ephemeral ES256 client key. Covers valid native and web sign-in, nonce mismatch, wrong audience/issuer, expiry, bad signatures, replay, provider failure, browser binding, unknown bundle ID, and grant revocation.
- Both MCP transports exercised against the running local API with the official MCP client SDK: tool discovery, create, update, stale-version conflict, complete and delete. Temporary API credentials revoked afterward.
- DigitalOcean specification schema validation. This checks the template's structure, not whether placeholder resources exist in an account.
- Docker production image build and production-mode container smoke test: compiled web assets served, PostgreSQL health verified, HTTPS security headers present, demo login disabled, and unauthenticated REST/MCP requests rejected.
- Initial migration applied to local PostgreSQL 17; `alembic check` reports no schema differences.

Final outcomes:

- 32 API and Apple simulation tests passed on SQLite.
- The same 32 tests passed on PostgreSQL 17.
- The browser workflow passed task creation, editing, persistence after reload, completion, restoration, deletion, project creation/deletion, API-token use and revocation, search, mobile navigation, and a 390-pixel overflow check. No browser page errors were reported.
- Desktop and mobile screenshots were reviewed locally.
- Both MCP transports passed the end-to-end smoke script.

The test runner reports an upstream Starlette deprecation warning about its HTTPX test adapter; it does not affect the passing test results.

Not yet verified: real Apple sign-in, provisioning or distribution to a physical Apple device, App Store/TestFlight submission, DigitalOcean deployment, production DNS/TLS, or restoration of a production database backup. These require the target accounts, credentials and domain.

The Apple simulation was authored from Apple's public token contract and the Orbit integration brief. No owner-published Apple mock was available in a connected workspace, so the fixture is local project-owned test code. Passing it verifies our application against those contract fixtures, not Apple's live service.

## Personal-tool interface update, October 27, 2026

Removed the web promotional landing page, motivational copy, banners, decorative overview panel, and corresponding native copy. New local workspaces start empty. The project instructions now record the personal-tool scope.

Verified the web production build, the browser task/project/token workflow and mobile layout, 22 core API tests, and both macOS and iOS Simulator builds. The ten Apple-provider simulation cases were skipped on this run because the provider simulation was not running; the previous simulated-provider results above remain the most recent authentication integration evidence.

## Task checklists, October 27, 2026

Added task checklists across web, macOS, iOS, REST, and both MCP transports. Completing the parent checks remaining items; recurring successors receive unchecked copies. Checklist writes use the parent version to reject stale changes.

- 34 core tests passed on SQLite and PostgreSQL 17. Ten Apple simulation tests were skipped because the provider simulation was not running; authentication behavior was unchanged.
- Migration tests cover new databases, repeat startup, and backup/adoption of the original unversioned SQLite database with task content and versions preserved. PostgreSQL migration from 0001 to 0002 preserved an existing task, backfilled an empty checklist, and passed `alembic check`.
- Browser workflow passed checklist creation, editing, persistence, completion, restoration, removal, and progress counts, alongside existing task/project/token and mobile checks. No page errors were reported.
- Both MCP transports passed checklist creation, editing, stale-version rejection, completion, and deletion against the local API.
- Web production build and unsigned macOS and iOS Simulator builds passed.
- Checklist editor screenshot was reviewed locally.
- Updated Docker image built successfully. Container checks confirmed compiled web assets, checklist OpenAPI schema, and fresh migrations; local databases and migration backups are excluded from the image.

## Blue theme, quick entry, reminders and push, October 31, 2026

Changed the web and native accent colors and app icons to blue. Added a shared English quick-entry parser, preview controls, task wall times and IANA time zones, reminder offsets, per-device push subscriptions, and a durable reminder delivery loop. The API and MCP expose the same scheduling behavior.

- 58 API and push simulation tests passed on SQLite on October 30; the final PostgreSQL run passed 59 tests including an added parsing case on October 31. The ten Apple sign-in simulation tests were skipped because that separate simulation was not running.
- PostgreSQL migration 0002 to 0003 preserved an existing task and its version, defaulted its time zone to UTC without enabling a reminder, and passed `alembic check`.
- APNs and encrypted Web Push requests ran over real HTTP to the local Postman fixtures. Request logs recorded acceptance, temporary 503 failures, expired-token 410 responses, and permanent 403 failures. Tests verified retries, deduplication, ownership, rescheduling/completion cancellation, active leases and endpoint cleanup.
- The web quick-entry/reminder workflow and existing task/project/token workflow passed, including persistence, manual correction, mobile overflow and notification settings. A separate service-worker contract test verified notification content and task-link construction with simulated browser APIs. Browser-injected notification display could not be established in headless Chromium, so OS notification display is not claimed.
- Both MCP transports passed discovery, parsing, timed task creation, reminder edits, checklist changes, conflict handling, completion and deletion.
- Final macOS Debug and iOS Simulator builds passed with signing disabled. Native UI interaction and live APNs registration remain unverified.
- Web production build and Docker image build passed. An isolated container verified fresh migrations, time-zone data, push dependencies, the service worker, manifest and icons, and absence of local databases/backups.
- Blue desktop, mobile, quick-entry and reminder editor screenshots were reviewed. Temporary browser-test tasks were removed.

Live Web Push, Apple push, Apple sign-in and DigitalOcean deployment remain pending credentials and deployment. Provider simulation acceptance does not prove notification display on a device. See [reminder setup](reminders.md) for activation and delivery limitations.

## Native iOS interaction, October 31, 2026

Ran `bash scripts/test-ios.sh 6DEF783D-47A6-4469-BAF1-A793A86AC64E` on the iPhone 18 Pro simulator with iOS 27.2. The full XCTest UI workflow passed in 57 seconds against an isolated SQLite backend:

- Temporary development session entered through the native login form, stored in Keychain, and restored after app relaunch.
- Quick entry extracted Friday at 15:00 and an at-due-time reminder, then persisted those values through the API.
- Search found the created task; editing preserved its title and changed its description and reminder to 15 minutes before.
- Completion changed the native control to Restore and persisted `completed=true`.
- Enabling notifications without APNs configuration displayed the expected message while keeping Settings open.
- Removing the local session returned to login; teardown deleted the test task and revoked the session. The script stopped the backend and removed its isolated database.

Testing exposed and fixed stale task/project editor selection and error alerts dismissing the active sheet. The server URL field now disables correction/capitalization, and Settings has an explicit accessibility label. Simulator UI runs use ad hoc signing so Keychain entitlements are present; earlier unsigned build checks did not establish runtime sign-in behavior. The shared changes also passed a macOS Debug compile.

Result: `apple/DerivedData-iOS/Logs/Test/Test-Tasks-iOS-2026.10.31_22-54-48--0400.xcresult`. This verifies local native UI and API integration, not live Apple authentication, physical-device provisioning, or APNs delivery.

## Code review fixes, November 6, 2026

Fixed the High and Medium findings from a full code review: open sign-up, the shared rate limit behind a proxy, the chunked body limit bypass, one task stopping all reminders, ended sessions trapping native users, unresolvable version conflicts, MCP path traversal, the Q shortcut replacing an open editor, past reminders firing, unreadable stored tasks, recurrence drift, cold-launch notification taps, stale assets after a deploy, skipped provider tests, tests touching the development database, and native actions dropped while busy.

- 96 API tests passed on SQLite and on PostgreSQL 17, with none skipped. Apple sign-in and push delivery now run against in-process fake providers over real HTTP. The Apple and push tests also passed against the Postman mock scripts run directly with Node, not through the Postman CLI.
- `alembic check` reported no differences on SQLite and PostgreSQL 17, through revision 0004. The OpenAPI snapshot is now compared by a test.
- Nine browser tests passed against the built web app, including new regressions for shortcuts, conflicts, ended sessions and refused accounts. Both MCP transports passed the smoke script, and a crafted task ID no longer reaches other routes.
- The production image ran behind real Caddy through Compose, on a loopback port: migrations reached 0004, requests with spoofed `X-Forwarded-For` values shared one limit, a second client kept its own limit, a 5 MB chunked request received 413, and caching headers were correct. Production startup refused an empty or placeholder `ALLOWED_APPLE_ACCOUNTS`. A chunked 30 MB request to the API process directly received 413 with memory unchanged.
- macOS Debug and iOS Simulator builds passed. Four iOS UI tests passed on an iPhone 18 Pro simulator, covering a session ended on activation, sign-out and local removal with push enabled, and a conflict that keeps the draft.
- Two one-off simulator checks compared fixed and previous code. A notification delivered with `simctl push` and tapped while the app was not running opened the task only with the fix. A swipe to complete during a slowed refresh took effect only with the fix.

Not verified: `do-connecting-ip` on a real App Platform deployment, the updated GitHub Actions workflow on GitHub, live Apple sign-in, live APNs or Web Push, and physical devices.

## Remaining review fixes, November 6, 2026

Fixed the Low findings from the same review: unhandled server errors on bad input, repeated native date formatters and push registrations, full task downloads on every poll, unbounded expired data, label filter case, project PATCH resetting color, inconsistent configuration parsing, the service worker's notification click, Upcoming grouping across years, a garbled heading after a project is deleted elsewhere, the UTC time zone picker, API docs in production, session listing and revocation, Host-based origin trust in development, dead code, stale documentation, and the size of `web/src/main.tsx`.

- 108 API tests passed on SQLite, with one PostgreSQL-only test skipped, and 109 passed on PostgreSQL 17. The Apple and push tests also passed against the Postman mock scripts run directly with Node.
- 16 browser tests passed against the built web app, and both MCP transports passed the smoke script.
- The production image ran behind real Caddy through Compose: the API schema was not served, MCP rejected missing and invalid tokens, `/%00` returned 404, and the background worker logged no failures on PostgreSQL.
- macOS Debug and iOS Simulator builds passed, and six iOS UI tests passed on an iPhone 18 Pro simulator.
- A one-off simulator check counted push registrations across seven refreshes: one with the fix, six with the previous code.

Not verified: the purge running on its hourly schedule in a long-lived process (tests call it directly and it ran once at startup), the macOS app's interface, and everything listed as not verified in the previous section.

## Sign-in screen and authentication, November 7, 2026

The Mac and iPhone sign-in screen now asks the server which methods it offers, as the web does, instead of always requesting an Apple challenge. Development servers offer **Open local workspace** to the apps through a new native route. Development sign-in answers only this computer, and production cookies use the `__Host-` prefix. [Authentication design](authentication.md) records the reasoning.

- 130 API tests passed on SQLite with one PostgreSQL-only test skipped. New tests cover development sign-in being off by default, refused from other addresses and from any request with an Origin header on the native route, honoring the proxy-reported address, issuing a full native session, and the production cookie name and attributes.
- macOS Debug and iOS Simulator builds passed. Seven iOS UI tests, including a new local workspace sign-in and sign-out test, passed twice in a row on an iPhone 17 simulator with iOS 27.2 against an isolated backend.
- Manual simulator checks against a backend with this code: a new server, local workspace sign-in creating one `native` session, a session revoked on the server returning to the card with an inline message and the saved server's options, an unreachable server, and dark mode.
- The built web app signed in to the local workspace against the same backend.

Testing found and fixed three problems in the first version of the new screen: the server field had no VoiceOver label, a scroll view swallowed taps made just after typing, and re-centering the card while the keyboard was up sometimes stalled the interface.

Not verified: real Sign in with Apple on either platform, which needs the Apple Developer configuration; the macOS sign-in screen interactively, which shares the iOS view code but was only compiled; and PostgreSQL for the new tests.

## Smarter notifications, November 12, 2026

Added notification actions (Complete, Snooze, Tomorrow), server-side snooze delivered to every device, project grouping, Time Sensitive urgency by priority, relevance scores, badges, replacement of earlier notifications for the same task, background pushes that remove notifications for tasks finished elsewhere, an optional morning summary and overdue follow-up, App Intents for Siri and Shortcuts, a notification service extension that tags pushed reminders with the task's entity (iOS 27 `appEntityIdentifiers`), and AlarmKit alarm-style reminders on iPhone. The Apple apps now require iOS 27 and macOS 27. See [reminders](reminders.md).

- 147 API tests passed on SQLite with one PostgreSQL-only test skipped. 16 new tests cover snooze validation and delivery, snooze clearing, overdue follow-ups once per occurrence, summaries at local time across DST and skipped when empty, APNs payload keys and headers, the Time Sensitive setting, armed-alarm suppression per device, and background sync pushes, including after deletion. The in-process fake APNs provider and the Postman mock script now reject invalid interruption levels, relevance scores and background push formats.
- Migration 0005 upgraded, backfilled delivery keys in the format the delivery loop uses, downgraded and upgraded again on SQLite. Ruff and the OpenAPI snapshot are current.
- 18 browser tests passed against an isolated backend, including new tests for the snooze menu, notification settings persistence, and the service worker's actions, badge and stale-notification removal with simulated browser APIs.
- iOS Simulator and macOS Debug builds passed with no warnings, including both notification service extensions. All 7 iOS UI tests passed on an iPhone 17 simulator with iOS 27.2, including new checks for the Alert picker and saving the morning summary setting. The tests now dismiss the simulator's own "Save Password?" sheet, which covered the app after the token was typed. A refresh that waited on notification and alarm calls kept the task list busy; that work now runs separately.
- The simulator's system log showed the notification service extension registered with the system.

Not verified: notification display, actions, extension entity tagging and badge on a device or simulator (the permission prompt did not appear in the simulator and automated input stopped registering), AlarmKit alarms ringing, Siri acting on notifications or alarms, the Time Sensitive capability with real provisioning, live APNs and Web Push, PostgreSQL for migration 0005, and the MCP smoke script for the new `snooze_task` tool.

## Code review fixes on the rebuilt web app

Fixed the findings from a full code review, on top of the rebuilt web app and Personal Command support. The review itself covered the code before that rebuild. Each web finding was then rechecked against the rebuilt app and fixed there, or dropped where the rebuild had already fixed it. `contract.py`, `events.py`, `search.py` and the rebuilt web code as a whole have not had a review of their own.

- 155 API tests passed on SQLite, with one PostgreSQL-only test skipped, and 156 passed on PostgreSQL 17, with none needing a running simulation. Apple sign-in and push delivery run against in-process fake providers over real HTTP. The Apple and push tests also passed against the Postman mock scripts run directly with Node, not through the Postman CLI.
- `alembic check` reported no differences on PostgreSQL 17 through revision 0005. A test now compares the OpenAPI snapshot with the running API.
- 18 browser tests passed against the built web app in six consecutive runs, on a heavily loaded machine. 27 parser unit tests passed, and both MCP transports passed the smoke script. A crafted task ID no longer reaches other routes.
- The production image ran behind real Caddy through Compose, on a loopback port. Migrations reached 0005, requests with spoofed `X-Forwarded-For` values shared one limit, a second client kept its own limit, a 5 MB chunked request received 413, caching headers were correct, the API schema was not served, MCP rejected missing and invalid tokens, `/%00` returned 404, and the background worker logged no failures on PostgreSQL. Production startup refused a standalone server with no `ALLOWED_APPLE_ACCOUNTS`, and accepted one inside the shell without it.
- macOS Debug and iOS Simulator builds passed, and six iOS UI tests passed on an iPhone 18 Pro simulator, covering a session ended on activation, sign-out and local removal with push enabled, a conflict that keeps the draft, a task in UTC, and ending another device's session.
- Three one-off simulator checks compared fixed and previous code. A notification delivered with `simctl push` and tapped while the app was not running opened the task only with the fix. A swipe to complete during a slowed refresh took effect only with the fix. Across seven refreshes, the app registered for push once with the fix and six times without it. These ran before moving onto the rebuild, whose Apple code is unchanged.

Not verified: `do-connecting-ip` on a real App Platform deployment, the updated GitHub Actions workflow on GitHub, sign-in through a real Personal Command shell, live Apple sign-in, live APNs or Web Push, physical devices, the macOS interface, and the hourly purge in a long-lived process (tests call it directly and it runs once at startup).

## Merging the rebuilt web app with notifications, links and the agent, November 17, 2026

`dev` had rebuilt the web app (offline replica, live updates, Personal Command shell support) while this branch added smarter notifications, links, the Flesh out agent, the API reference page and the Clean design. Where both rebuilt the same files, dev's version was kept. This branch's web features were moved into the rebuilt app: links and Flesh out in the task detail, links in the project editor, the alert style and a snooze note in the task detail, Snooze in the task menu, notification preferences and an API reference link in Settings, and Complete and Snooze actions, badge and stale-notification removal in the service worker. The Apple apps keep this branch's features and return to the Glassive tokens, matching the web app. The in-app checkmark was removed from the web sign-in and sidebar, as AGENTS.md asks.

Both branches numbered migrations 0004 and 0005 differently. The chain is now 0004 recurrence anchors, 0005 notifications, 0006 links, 0007 agent runs and 0008 the shell user id. A database created on the shell's branch is recognized and restarted after 0003; 0004 and 0008 skip columns it already has. `/resolve` and `/references` follow the app contract's shape, and `/references` also returns stored links. The schema moved to `/api/v1/openapi.json` for the shell manifest too, and `/docs` redirects to `/docs/` so the page's relative asset URLs work under `/apps/tasks/`.

- 238 API tests passed on SQLite with one PostgreSQL-only test skipped, and 239 passed on PostgreSQL 17. `alembic check` reported no differences on SQLite and PostgreSQL 17. Databases created at the shell branch's 0004 and 0005 upgraded to 0008 and matched the models.
- 30 browser tests passed against the built web app, including a new test for links, alert style, snooze, notification settings and the API reference. 49 web unit tests passed. Both MCP transports passed the smoke script.
- macOS Debug and iOS Simulator builds passed.
- Testing found that posting open tasks to the service worker on every change crashed headless Chromium once the rebuilt app installs its worker at startup. The message is now sent only with notification permission, and only when the list or badge changes.

Not verified: iOS UI tests on a simulator, live push and alarms, sign-in through a real Personal Command shell, and the GitHub Actions run.

## Task view and the Clean design on dev, November 19, 2026

The local `claude/code-review-fixes` branch had the Clean design, and dev had links, Flesh out, the rebuilt web app (with the Glassive look) and, since version 0.2.0, multi-select. This branch starts from dev and brings Clean back:

- Web: `clean.css` and `clean-bridge.css` give the Glassive variable names Clean values, so the rebuilt app draws in Clean. Medium priority, the open row and multi-selected rows use Clean's blue.
- Apple: `Clean.swift` replaces `Glassive.swift`, and the views use the Clean colors again, including dev's unreachable-server banner.
- The task view is now a large view with the task's content on the left (title, description, checklist, links, Flesh out) and its details on the right (project, date, priority, labels, reminder). It saves as you edit. On the web it opens over the list on screens 700px and wider and moves between tasks with J/K or its arrows. On macOS and iPad it is a large sheet with two columns, and on iPhone the details follow the content. Adding a task still uses the add form.
- Multi-select is dev's own. An earlier port of it on this branch was replaced by dev's when merging.

Results after merging dev at ca79875:
- Web: typecheck clean, 49 unit tests passed, and 31 browser tests passed. The integrations and scheduling specs were updated because the task view is now a dialog.
- iOS UI tests on iPhone 17 (iOS 27.2): 8 of 8 passed. Two were rewritten for the new view: edits save as you type and keep another device's change, and the time zone shows in the details.
- iPad Pro 13-inch, before the merge: the task view test passed in two columns. `testQuickEntryAndPersistence` failed at "Use details and edit" in the add form, which this change does not touch; it passes on iPhone.
- macOS Debug build passed. The Mac app was not run, because a test build shares the installed app's settings and sign-in.
- `scripts/test-ios.sh` takes `TASKS_TEST_PORT` when another worktree's run holds port 8002.

## Siri, Spotlight and on-screen tasks, November 19, 2026

Added the Add Task and Move Task to Space intents, Snooze Task until a time, a project entity, Spotlight indexing of tasks as App Intents entities, on-screen task annotations, and Siri donations for completing and snoozing in the app. See [reminders](reminders.md).

- iOS Simulator and macOS Debug builds passed with the iOS 27.2 SDK (Xcode 27.2).
- `testSiriAddsFindsAndMovesATask` (AppIntentsTesting) passed on its own in 30 seconds. It ran Add Task with "tomorrow at 3pm" in the title and got the right date, time and space. A Spotlight query for "dentist forms" found the task, the Upcoming row was reported as an on-screen entity, Move Task sent it to Work, and a second Add Task joined the Work space.
- In the full UI suite, five tests passed. Three tests, including the Siri test on a second run, finished their steps without an assertion failure and then went over the 3-minute limit in `tearDown`, which cleans up through the test backend. The Mac's load average was between 14 and 79 at the time, with XProtect and the Spotlight indexer using most of the CPU.
- Rerun an hour later, those three passed: quick entry in 66 seconds, select several in 55, and the Siri test in 30, each with `tearDown` under a second. All eight UI tests have now passed.

Not verified: all eight UI tests in a single run, Siri AI's natural language requests (they need the iOS 27.3 Developer Preview and an Apple Intelligence device), Spotlight search results on a device, and donations showing up as Siri suggestions.

## Reminders schema for Siri, November 19, 2026

Tasks now follow Apple's reminders schema domain, so Siri can offer the app for requests that name no app, such as "Remind me to take out the trash". Tasks are reminder entities, projects and both Inboxes are list entities, and the app has Create Reminder, Update Reminder, Delete Reminders and Create List intents. Add Task also gained "Remind me in Tasks" phrases. See [reminders](reminders.md).

- iOS Simulator and macOS Debug builds passed with the iOS 27.2 SDK, with no warnings. The built metadata lists every schema intent and entity under the `reminders` domain.
- `testReminderSchemaCreatesChangesAndDeletesTasks` (AppIntentsTesting) passed in 24 seconds. Create Reminder saved the title, Work Inbox, note, tag, flag (priority 1), link, due time with a reminder at that time, and a weekly repeat. Create List made a project, and a reminder created in it landed there. Update Reminder renamed the task, cleared the flag, moved it to the Personal Inbox and completed it. Delete Reminders deleted a task.
- `testSiriAddsFindsAndMovesATask` also passed, now including a task added with a separate due time that reminds at that time.
- The full iOS UI suite passed in a single run: all ten tests.

Not verified: Siri offering the app in its list for "Remind me to..." (it needs a device with Siri AI), Siri filling the schema parameters from speech, and the Shortcuts app showing the schema intents.
