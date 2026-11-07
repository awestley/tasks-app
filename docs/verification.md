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

Result: `apple/DerivedData-iOS/Logs/Test/Test-Taskwell-iOS-2026.10.31_22-54-48--0400.xcresult`. This verifies local native UI and API integration, not live Apple authentication, physical-device provisioning, or APNs delivery.

## Code review fixes, November 6, 2026

Fixed the findings from a full code review, on top of the rebuilt web app and Personal Command support. The review itself covered the code before that rebuild. Each web finding was then rechecked against the rebuilt app and fixed there, or dropped where the rebuild had already fixed it. `contract.py`, `events.py`, `search.py` and the rebuilt web code as a whole have not had a review of their own.

- 155 API tests passed on SQLite, with one PostgreSQL-only test skipped, and 156 passed on PostgreSQL 17, with none needing a running simulation. Apple sign-in and push delivery run against in-process fake providers over real HTTP. The Apple and push tests also passed against the Postman mock scripts run directly with Node, not through the Postman CLI.
- `alembic check` reported no differences on PostgreSQL 17 through revision 0005. A test now compares the OpenAPI snapshot with the running API.
- 18 browser tests passed against the built web app in six consecutive runs, on a heavily loaded machine. 27 parser unit tests passed, and both MCP transports passed the smoke script. A crafted task ID no longer reaches other routes.
- The production image ran behind real Caddy through Compose, on a loopback port. Migrations reached 0005, requests with spoofed `X-Forwarded-For` values shared one limit, a second client kept its own limit, a 5 MB chunked request received 413, caching headers were correct, the API schema was not served, MCP rejected missing and invalid tokens, `/%00` returned 404, and the background worker logged no failures on PostgreSQL. Production startup refused a standalone server with no `ALLOWED_APPLE_ACCOUNTS`, and accepted one inside the shell without it.
- macOS Debug and iOS Simulator builds passed, and six iOS UI tests passed on an iPhone 18 Pro simulator, covering a session ended on activation, sign-out and local removal with push enabled, a conflict that keeps the draft, a task in UTC, and ending another device's session.
- Three one-off simulator checks compared fixed and previous code. A notification delivered with `simctl push` and tapped while the app was not running opened the task only with the fix. A swipe to complete during a slowed refresh took effect only with the fix. Across seven refreshes, the app registered for push once with the fix and six times without it. These ran before moving onto the rebuild, whose Apple code is unchanged.

Not verified: `do-connecting-ip` on a real App Platform deployment, the updated GitHub Actions workflow on GitHub, sign-in through a real Personal Command shell, live Apple sign-in, live APNs or Web Push, physical devices, the macOS interface, and the hourly purge in a long-lived process (tests call it directly and it runs once at startup).
