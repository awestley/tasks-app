# Taskwell API contract

All application resources live under `/api/v1` and belong to the authenticated user. Bearer credentials or an HttpOnly session cookie are required. Cookie writes require the configured Origin. Invalid credentials return 401, missing or other-user resources 404, invalid input 422, stale task versions 409, request bodies over 100 KB 413. No cross-user IDs are accepted. Due dates must fall between the years 1900 and 2999. Responses describe what is stored: a task whose schedule no longer validates, for example after a time zone rule change, stays readable, and PATCH returns 422 until the schedule is corrected.

- GET /me: profile.
- GET/POST /projects; PATCH/DELETE /projects/{id}: project management. PATCH changes only the fields it receives. Deleting a project moves its tasks into Inbox.
- GET /tasks: paginated tasks, with `offset`, `limit` (max 200), optional `q`, `project_id`, `completed`, `label`, `due_before`. Dates use ISO calendar dates, interpreted in the user's local calendar.
- GET /tasks/revision: a value that changes whenever a task is added, edited or deleted, so a client can skip downloading an unchanged list.
- POST /tasks: title, description, project_id, due_date, priority (1 urgent through 4 normal), labels, checklist, recurrence (daily, weekly, monthly or null).
- PATCH /tasks/{id}: edits require `version` from the last read. Atomic compare-and-swap prevents lost updates.
- POST /tasks/{id}/complete: requires version, completes once and creates the next occurrence when recurring. Restoring an occurrence does not recreate its already generated successor.
- DELETE /tasks/{id}?version=N: version-checked permanent deletion.
- GET/POST /tokens; DELETE /tokens/{id}: create/revoke 90-day personal access tokens, disclosed only once. Tokens cannot mint additional tokens or delete the account.
- GET /sessions; DELETE /sessions/{id}: list signed-in devices and end another device's session. Requires session credentials. The current session ends through POST /auth/logout.
- DELETE /me: revoke Apple authorization and delete account data. Requires session credentials.
- GET /auth/config: public provider and local-development availability.
- GET /auth/apple/start: start browser flow with stored state, nonce and browser-binding cookie.
- POST /auth/apple/callback: consume one-time state, exchange code, validate issuer/audience/expiry/signature/nonce, set session.
- POST /auth/apple/challenge; POST /auth/apple/native: native one-time nonce + authorization code exchange. Token returned only to native client. An account outside `ALLOWED_APPLE_ACCOUNTS` receives 403, or `auth_error=denied` in the browser flow.
- POST /auth/logout: revoke current credential and clear cookie.

OpenAPI is generated from the same validated schemas used by the server and saved to `docs/openapi.json`. API tokens work with the MCP stdio adapter. The web UI refreshes after mutations, and on focus and periodically when the task revision has changed. Native clients refresh on activation. First release is online-first, without collaboration, attachments, or offline conflict merging. The API description is served in development only; `docs/openapi.json` holds the same schema.

## MCP transport

`/mcp/` accepts Streamable HTTP using a bearer credential. Cookie-only requests are rejected. The endpoint implements the official MCP SDK protocol and exposes tools rather than a hand-written JSON-RPC approximation. Stdio runs the same tools with `TASKWELL_API_URL` and `TASKWELL_TOKEN`. HTTP MCP currently requires client-configured tokens; OAuth authorization discovery is not implemented.

## Task checklists

Tasks include `checklist`, an ordered array of up to 100 items. Each item has a stable `id` (1-64 letters, digits, underscores or hyphens), `title` (1-500 characters), and `completed` boolean. New items may omit `id`; the server generates one. Duplicate IDs and blank titles are rejected. Omitted checklist fields preserve existing items on PATCH; supplying an array replaces the checklist and supplying `[]` clears it. Null is invalid. All changes use the task's existing version check.

Completing a task checks every checklist item atomically. Reopening the task preserves those checkmarks. Unchecking an item on a completed task is rejected unless the same request also reopens the task. Recurring successors copy item titles and IDs with all items unchecked. Checklist IDs are scoped to their task. Checking the last item does not automatically complete the task. A checklist item is not a standalone task and has no separate due date, project, priority or recurrence.

## Quick entry and reminders

`POST /api/v1/tasks/parse` accepts `text` and an IANA `time_zone`, returning a parsed title, optional scheduling/project/priority fields, labels and recognized phrases without saving. Project lookup is scoped to the caller. The `parse_task` MCP tool uses the same endpoint. Clients show the preview before applying it. Standard task creation accepts explicit fields and does not silently parse titles.

Tasks now include optional `due_time` (HH:MM), `time_zone` (IANA, UTC default for API clients), and `reminder_minutes` (null or an integer 0 through 10080). A time requires a date; a reminder requires both. PATCH omission preserves fields; null clears the time or reminder, but not the time zone. Clear dependent fields together when removing a date. Existing task version checks apply to schedule edits. See [reminder semantics](reminders.md) for DST, recurrence and delivery guarantees.

`GET /api/v1/push/config` returns configured provider flags and the public VAPID key. `GET/POST /api/v1/push/subscriptions` lists or registers caller-owned devices; `DELETE /api/v1/push/subscriptions/{id}` removes one. Web registration accepts kind=web, endpoint, p256dh, auth, and optional name. Native registration accepts kind=apns, token, allowed topic, sandbox boolean, and optional name. Provider identity is unique; repeated registration updates the current user's device, and another user's registration returns 409. Up to 20 devices are permitted. Response bodies never expose device tokens or encryption secrets. Unconfigured providers return 503 on registration; invalid destinations or keys return 422. Arbitrary Web Push hosts, local network destinations and unrecognized native app identifiers are rejected.
