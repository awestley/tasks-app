# Tasks

A self-hosted task manager for the web, macOS, iPhone, and AI tools. Built for DigitalOcean with Sign in with Apple.

![Tasks web workspace](docs/screenshots/web-desktop.png)

## Included

- Responsive React web app with Inbox, Today, Upcoming, projects, labels, search, priorities, completed history, and keyboard shortcuts.
- Create, edit, complete, restore, and delete tasks, with checklists inside each task. Select several tasks (Cmd/Ctrl-click, Shift-click or Cmd/Ctrl-A on the web and Mac, Select tasks in the More menu on iPhone) to complete, date, prioritise, move or delete them together. Daily, weekly, and monthly recurrence. Project deletion keeps tasks in Inbox.
- Native SwiftUI macOS and iOS applications using the same backend. Apple sign-in, Keychain sessions, projects, task editing, search, API tokens, and account deletion.
- English quick task entry with a preview, due times and time zones, reminders, Web Push, and native Apple push integration. Notifications have Complete and Snooze actions, project grouping, Time Sensitive urgency, badges, an optional morning summary and overdue follow-up, and alarm-style reminders on iPhone. Siri and Shortcuts can add, complete, snooze, move and open tasks, find them through the Spotlight index, and act on the task on screen. Push delivery requires server configuration and device permission.
- Work and Personal spaces. Every task and project belongs to one, and each app shows one space at a time: the switch is at the top of the sidebar (Browse on a phone). Lists, counts, labels, search and quick add stay inside the current space, and each device remembers its own. A task in a project is in the project's space; Move to sends a task to the other space's Inbox, and moving a project in its editor takes its tasks along. Existing tasks start in Personal. The API and MCP tools take `space` (`personal` or `work`).
- Versioned REST API and generated OpenAPI contract.
- MCP over stdio and authenticated Streamable HTTP, with nine task and project tools.
- Sign in with Apple code exchange, signature/audience/issuer/expiry/nonce validation, one-time challenges, browser binding, and revocable sessions.
- PostgreSQL production storage, Alembic migrations, Docker image, DigitalOcean App Platform specification, and Droplet deployment with automatic HTTPS through Caddy.

This is an online-first first release. It does not yet include shared projects, subtasks, comments, attachments, calendar integrations, or offline editing. It is an independent app and does not use Todoist branding or services.

## Inside Personal Command

Tasks is one of the apps in Personal Command, the shell at westley.app (repo `awestley/westley-app`). It follows the shell's app contract (`docs/app-contract.md` there): the shell signs people in, opens Tasks views in columns, searches it with everything else, and lets other apps embed tasks and projects.

Set `SHELL_URL` to turn this on. Then:

- Sign in is the shell's. The API verifies the shell's ES256 access token (the `pc_session` cookie, or `Authorization: Bearer`) against `SHELL_URL/auth/.well-known/jwks.json` (or `SHELL_JWKS_URL`), and keys data by the token's `sub`. This app's own Apple and development sign in are turned off. Personal access tokens for MCP and scripts keep working.
- The app is served under `BASE_PATH` (`/apps/tasks`) as well as at the root (health checks), and can be framed by the same origin only.
- `GET /apps/tasks/manifest.json` describes it to the shell. Contract endpoints live in the API: `GET /api/v1/resolve`, `/search` (the shared search contract, ported in `api/tasks/search.py`), `/references`, `/events` (server-sent events), plus `GET /tasks/{id}` and `GET /projects/{id}`. Creates accept a client-chosen UUID `id`, and replaying one returns the existing item.
- Pane routes: `#/today`, `#/inbox`, `#/upcoming`, `#/all`, `#/completed`, `#/project/<id>`, `#/label/<name>`, `#/task/<id>`. It is the same app at every size: in a wide column the sidebar (views, projects, labels) is docked; in a narrow one it is a drawer (M toggles it). A task opens in a large view over the list, with its description, checklist, links and Flesh out on the left and its project, date, priority, labels and reminder on the right; J and K, or the arrows in its header, move to the next and previous task. On a phone-sized screen the task fills the screen. The theme follows the shell.
- On a phone (a touch screen under 700px wide, or a browser window under 560px) it switches to a native layout (`web/src/phone.tsx`, `phone.css`): tabs at the bottom (Inbox, Today, Upcoming, Search, Browse), a + button, large titles, quick add as a sheet that sits on the keyboard, swipe right to complete and left to schedule, and a task full screen. Inside the shell's phone layout it fills the screen below the shell's bar and pads itself with the `--pc-safe-*` insets the shell sets on the frame.
- The companion (`companion.html`) is the same app in its compact layout: a capture field first, a list picker, Space completes, ⌘Enter opens the task in a column, Escape twice hides it. The shell's quick add (`new-task`) focuses that field.
- `embed.js` defines `<tasks-task>` and `<tasks-project>`. Other apps show them through the shell runtime's `<pc-embed ref="pc://tasks/task/<id>">`. A task description can link `[[note:<id>]]` or embed `![[note:<id>]]` items from other apps.
- Styles use `@awestley/glassive`'s variable names, given Clean design values by `web/src/clean.css` and `clean-bridge.css`; the bridge comes from `@awestley/pc-runtime`. Both are private packages, vendored into `web/vendor/` until the build can install them from GitHub Packages; refresh them with `npm --prefix web run sync-vendor -- <obsidian-glassive> <westley-app>`.

Run it inside the shell locally:

```sh
# Tasks API on :8000, serving the built web app
npm --prefix web run build
cd api && SHELL_URL=http://127.0.0.1:8080 PUBLIC_URL=http://127.0.0.1:8080 BASE_PATH=/apps/tasks \
  .venv/bin/uvicorn tasks.main:app --port 8000
# The shell on :8080 (in westley-app), proxying /apps/tasks to it
PC_APPS=tasks=/apps/tasks/=http://127.0.0.1:8000 npm run dev
```

Offline: every view keeps a local replica and an outbox in `localStorage` (shared by the column, the companion and any tab, with one sender at a time through Web Locks). Changes show at once and sync in the background; new items get client-made UUIDs; a `409` re-applies the changed fields on top of the newer copy, and checklists merge item by item. A server error keeps the change and tries again; only a change the server refuses is dropped. The service worker keeps the app's files and answers `/search` and `/resolve` with `503 offline` when there is no connection, so the manifest declares `offline`.

## Run locally

Requirements: Python 3.12+, uv, Node 24+, npm. The Apple builds also need Xcode and XcodeGen (`brew install xcodegen`). Apple credentials are not needed for local development.

### Build everything and start the backend

```sh
./scripts/start.sh
```

This removes old builds, installs dependencies, builds the web app, builds the macOS and iOS Simulator apps, then starts the backend at http://localhost:8000. The backend serves the web app, so open http://localhost:8000 and choose **Open local workspace**. Press Control-C to stop. Running the script again stops an earlier backend on the same port first, if the same Mac account started it.

| Option | Effect |
| --- | --- |
| `--skip-apple` | Build only the web app. The Apple builds take a few minutes. |
| `--no-build` | Start the backend with the existing builds, without cleaning or building. |
| `--no-serve` | Clean and build, then exit without starting the backend. A backend that is already running keeps running. |
| `--port PORT` | Use another port. The default is 8000. |

Build output:

- Web: `web/dist`
- macOS: `apple/DerivedData/Build/Products/Debug/Tasks.app` (unsigned, because its entitlements need a development certificate)
- iOS Simulator: `apple/DerivedData-iOS/Build/Products/Debug-iphonesimulator/Tasks.app` (ad hoc signed so the Keychain works)

In the Mac app or iOS Simulator, connect to `http://localhost:8000`.

New workspaces start empty and are stored in `api/tasks.db`. The local workspace is a single shared local account, not a production authentication method. The API binds to loopback only, and local sign-in answers only requests from this computer. `DEV_LOGIN` defaults to false unless explicitly enabled, and production refuses to start with it enabled. [Authentication design](docs/authentication.md) explains every sign-in method and its safeguards.

### Web development with live reload

```sh
./scripts/dev.sh
```

This starts the backend on port 8000 and the Vite development server at http://localhost:5173, which reloads as you edit `web/src`. Open http://localhost:5173.

Open http://localhost:5173 and choose **Open local workspace**. New workspaces start empty and are stored in `api/tasks.db`. It is a single shared local account, not a production authentication method. The API binds to loopback only. `DEV_LOGIN` defaults to false unless explicitly enabled, and production refuses to start with it enabled.

### Start each component by hand

```sh
cp api/.env.example api/.env
uv sync --directory api --python 3.12
npm --prefix web ci
# Terminal 1:
cd api
.venv/bin/uvicorn tasks.main:app --host 127.0.0.1 --port 8000
# Terminal 2, from the repository root:
npm --prefix web run dev
```

Local sign-in only works from the address in `PUBLIC_URL`, which `api/.env` sets to http://localhost:5173. To use the backend's own copy of the web app at port 8000 instead, start it with `PUBLIC_URL=http://localhost:8000`, as `scripts/start.sh` does.

Development startup applies database migrations automatically. An original unversioned SQLite database is backed up into `api/.backups/` before its first migration. Keep that directory private, since backups contain workspace data. Production migrations run separately before deployment.

The web app saves every change locally first, sends it in the background, and follows server-sent events (polling every 30 seconds as a fallback). Native apps refresh on activation and support manual refresh. Dates are calendar dates; clients render them in the local calendar. Completion timestamps in the API are UTC. Recurrence advances one interval from the scheduled date, including overdue tasks; monthly recurrence clamps to the destination month's last day, then returns to the original day. Reopening a completed recurring occurrence keeps its successor, except through Undo (`undo: true` on the reopen), which removes the successor if it has not been touched.

Checklists support up to 100 items per task. Completing a task checks its remaining items; a recurring successor starts with every item unchecked. Reopening a task preserves its checkmarks. Checking the last item does not automatically complete the task.

[Quick entry and push setup](docs/reminders.md) explains supported phrases, reminder timing, VAPID configuration, and Apple push provisioning.

## Apple applications

```sh
xcodegen generate --spec apple/project.yml
open apple/Tasks.xcodeproj
```

Choose `Tasks-macOS` or `Tasks-iOS`. Set your Development Team and real bundle identifiers in `apple/project.yml`, regenerate, and build. Enter the backend's HTTPS origin on the app's connection screen. Simulator interaction tests use local ad hoc signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`) so Keychain works. Unsigned builds only verify compilation. Distribution requires your Apple signing identities and provisioning profiles.

Debug builds connected to a local development server, such as `http://localhost:8000` from the Mac app or iOS Simulator, offer **Open local workspace**, the same local account as the web app. Under **Local development** they also accept a personal access token, for pointing a Debug build at another server. Both are excluded from Release builds. API tokens intentionally cannot create more tokens or delete the account, so those settings require Apple sign-in. A physical phone requires an HTTPS backend reachable from that device.

[Apple setup](docs/apple-auth.md) covers identifiers, app grouping, return URLs, keys, and distribution.

Run the iOS UI test with `bash scripts/test-ios.sh SIMULATOR_UDID` (find a device with `xcrun simctl list devices`). It starts an isolated backend on port 8002, uses a temporary session, and removes its database when finished, including after a failed test. Test results are in `apple/DerivedData-iOS/Logs/Test`.

## API and MCP

API base: `https://YOUR_DOMAIN/api/v1`. Generate a personal access token in **Settings & integrations** and send `Authorization: Bearer TOKEN`. Tokens are shown once, hashed in storage, expire in 90 days, and can be revoked at any time. They can manage tasks and projects but cannot mint credentials or delete the account. Sessions expire in 30 days; sign in again afterward. Settings lists your signed-in devices and can end another device's session.

Browse the API reference at `https://YOUR_DOMAIN/docs`, also linked from **Settings & integrations**. Try it out uses your browser session, or a token entered under **Authorize**. The schema itself is at `/api/v1/openapi.json`. The authoritative schemas are in the server code. The generated snapshot is [docs/openapi.json](docs/openapi.json). [Contract semantics](docs/contract.md) explain pagination, conflicts, authorization, and recurrence.

Remote MCP URL: `https://YOUR_DOMAIN/mcp/`, with an Authorization bearer header. This release uses personal tokens, not MCP OAuth discovery. Use the stdio adapter for clients that cannot configure a bearer header.

```json
{
  "mcpServers": {
    "tasks": {
      "command": "/absolute/path/to/tasks/api/.venv/bin/python",
      "args": ["-m", "tasks.mcp_server"],
      "cwd": "/absolute/path/to/tasks/api",
      "env": {
        "TASKS_API_URL": "https://YOUR_DOMAIN",
        "TASKS_TOKEN": "YOUR_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

Keep actual tokens in your client's secret store or private configuration. Never commit them. Tools:

- Finding: `search` (ranked, the same results as the app's search, matching checklist items and labels too), `list_tasks` (filters), `get_task`, `list_projects`, `get_project` (with its links).
- Changing one task: `create_task`, `update_task` (with `undo` to reverse a completion you just made), `complete_task`, `snooze_task`, `delete_task`, `parse_task` (preview quick-entry text).
- Changing several tasks, like selecting them in the apps: `update_tasks` (complete or reopen, date, priority, move to a project or space, labels) and `delete_tasks`. Each task is changed on its own with its own version, and the result lists any that failed.
- Projects: `create_project`, `update_project`, `delete_project` (its tasks move to Inbox).
- Links: `link_item`, `unlink_item`, `find_linked` (stored links and `[[note:<id>]]` mentions in descriptions).

Prompts: `flesh_out_task`, `plan_project`, `capture_in_notebook`. Read a task's version before modifying it. A stale update returns 409 rather than silently overwriting another device's change. Errors carry the API's own message.

Over HTTP the tools call the API inside the same server, so `TASKS_API_URL` only matters for the stdio adapter.

### Working with other apps

Tasks and projects can link to items in other apps by reference (`pc://notes/note/<id>` for a Notebook note) or to web pages. Connect a client such as Claude Code to both the Tasks and the Notebook MCP servers and use the prompts above: the client reads the task, reads and writes notes, and keeps links in both directions (`[[task:<id>|Title]]` in a note, a link on the task). `GET /api/v1/references?target=<ref>` lists the tasks and projects that link to an item, and `GET /api/v1/resolve?ref=<ref>` summarizes one of this app's items. The web addresses `#task/<id>` and `#project/<id>` open an item. Set `NOTEBOOK_WEB_URL` so note links open in Notebook.

### Flesh out

With `ANTHROPIC_API_KEY` set, the task view offers Flesh out: the server runs Claude (`AGENT_MODEL`, default `claude-opus-5-5`) as an MCP client of its own `/mcp` endpoint, with a credential that lasts 15 minutes and is deleted when the run ends, and of each server in `AGENT_MCP_SERVERS`. Tools marked destructive and those in `AGENT_BLOCKED_TOOLS` are never offered, so by default the agent cannot delete, complete, create or rename tasks, projects or notebooks; it can edit the task, its links, and notes. To let it use Notebook, add `{"name": "notebook", "url": "https://<notebook host>/mcp", "token_env": "NOTEBOOK_TOKEN"}` to `AGENT_MCP_SERVERS` and set `NOTEBOOK_TOKEN` to a Notebook personal access token (New token in Notebook's Agents dialog). Every tool call is listed on the run. One run at a time per account; a restart marks running runs as failed. Model usage is billed to the configured API key.

## Import from Todoist

`scripts/import_todoist.py` copies open Todoist projects and tasks through the API. It runs on the system `python3` with no extra packages. Put your Todoist API token (Todoist **Settings > Integrations > Developer**) in `~/.todoist_token`, or set `TODOIST_TOKEN`. The script never prints it.

```bash
python3 scripts/import_todoist.py
```

The default is a dry run that lists what would be created and anything that needs checking. Add `--apply` to import. It signs in to the local workspace, so the server must run with local sign-in on; set `TASKS_API_URL` and `TASKS_TOKEN` to import into another server. Imported IDs are recorded in `~/.config/tasks/todoist-import.json`, so running it again adds only new tasks.

- Subtasks become checklist items. Comments, attachment links and Todoist deadlines are added to the description.
- Markdown links in titles keep their text; the URL moves to the description.
- Sections become labels; `--drop-sections` ignores them.
- Todoist priority 1 (urgent) becomes Urgent here.
- Repeats map to daily, weekly or monthly. Others, such as yearly or every 2 weeks, keep the original rule in the description and are listed in the output.
- One time-based reminder per task is kept (the earliest). An all-day task with a timed reminder on its due date becomes due at that time. Location reminders, completed tasks and archived projects are skipped.
- Dates without a time zone use this Mac's zone; `--time-zone` overrides it.

## Deploy

See [DigitalOcean deployment](docs/deployment.md). Both App Platform and a Droplet are supported. No cloud resources have been created by this project. The specification has placeholders for the repository, domain, database cluster, and Apple credentials.

## Verification

```sh
# API tests, using isolated SQLite databases and in-process fakes for Apple sign-in and push:
cd api
.venv/bin/pytest -q

# From the root, with the local app running:
api/.venv/bin/python scripts/check_mcp.py
npm --prefix web run build
cd web
npx playwright install chromium
npm test
```

The browser test uses the real backend and local development account, creates test resources, verifies persisted edits, completion/restoration, project management and token revocation, then removes its test resources. Set `CHROME_PATH` if using an already-installed Chromium binary.

PostgreSQL tests use `TEST_DATABASE_URL`. **Use a disposable database only:** the test fixtures recreate the tables. Never point it at a real workspace. Migration verification uses `alembic upgrade head` and `alembic check`. After changing the API, update the schema snapshot with `api/.venv/bin/python scripts/export_openapi.py`; a test fails if it is out of date.

To run the Apple tests against the included Postman simulation instead of the in-process fake, start it from the repository root and set `APPLE_SIMULATION_URL=http://localhost:4900/apple`:

```sh
postman simulation run postman/simulations/apple-auth/apple-auth.sim.yaml --port 4900 --output ndjson
```

[Verification notes](docs/verification.md) distinguish compiled, simulated, and live-provider evidence.
