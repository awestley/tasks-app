# Handoff

Written on 2026-11-22 for a Claude that has never seen this project. Sources: 21 earlier Claude Code sessions on this repo (November 4 to 19, 2026, including two from when it was called Taskwell), git and GitHub history (PRs #1 to #18, no issues), the docs in this repo, the user-level Claude configuration, and one auto-memory file. Anything marked *(inferred)* is my reading, not something stated in a source.

**This repository is public.** Keep secrets, tokens, personal task data and personal details out of commits, PRs and docs.

## 1. What it is

- A self-hosted, Todoist-like task manager for one owner. A FastAPI backend (`api/`) serves a React web app (`web/`), a REST API, and an MCP server. SwiftUI macOS and iOS apps (`apple/`) use the same API.
- It is also one of the apps inside Personal Command, the owner's shell at westley.app (repo `awestley/westley-app`), which signs people in, opens Tasks views in columns and embeds tasks in other apps. See README "Inside Personal Command".
- It is meant to be "task central": other apps and AI clients reach tasks over MCP, and tasks link to items in other apps (Notebook first) by `pc://` reference.
- **State:** version 0.2.0 was released on 2026-11-18 (tag `v0.2.0` on `main`). Since then eight PRs (#11 to #18) merged into `dev`: the two-column task view, the iPhone tab bar, Work and Personal spaces, an MCP refresh, Siri intents, MCP `add_task`, and bulk REST endpoints. CI on `dev` is green. There is no cloud deployment; it runs on the owner's Mac. The last work was on 2026-11-19.

## 2. Where things are in the repo

| Path | What |
| --- | --- |
| `api/tasks/` | FastAPI app. `main.py` routes, `auth.py`, `mcp_server.py`, `agent.py` (Flesh out), `contract.py`/`events.py`/`search.py` (shell contract), `links.py`/`refs.py`, `push.py`, `reminders.py`, `quick_add.py` |
| `api/migrations/` | Alembic. Treat existing migrations as immutable |
| `web/src/` | React app. `store.ts` is the local replica and outbox. `phone.tsx` is the phone layout. `clean.css` + `clean-bridge.css` are the design tokens |
| `web/vendor/` | Vendored private packages (`@awestley/glassive`, `@awestley/pc-runtime`) |
| `apple/` | XcodeGen project (`project.yml`). `Tasks/` app code, `TasksUITests/`, `NotificationService/` |
| `scripts/` | `start.sh` (build and run everything), `dev.sh` (live reload), `test-ios.sh`, `check_mcp.py`, `export_openapi.py`, `import_todoist.py`, `generate-vapid.py` |
| `docs/` | `architecture.md`, `authentication.md`, `contract.md`, `reminders.md` (quick entry, push, Siri), `deployment.md`, `apple-auth.md`, `verification.md` (dated test record), `openapi.json` (snapshot, a test checks it) |
| `postman/` | Postman mocks and simulations for Apple sign-in and push |
| `.do/app.yaml`, `compose.yaml`, `Caddyfile`, `Dockerfile` | DigitalOcean App Platform and Droplet deployment, all with placeholders |

## 3. Architecture and the reasons behind it

Read `docs/architecture.md` and `docs/authentication.md` first; they are accurate. The decisions below are the ones whose reasons live mostly in session history.

- **The server is the authority.** Every client and MCP tool goes through the same API. Tasks carry a `version`; an update with a stale version returns 409 instead of overwriting. Recurring successors are created in the same transaction as completion.
- **The web app is local-first.** It keeps a replica and an outbox in `localStorage`, sends in the background, follows server-sent events, and on 409 re-applies only the changed fields on top of the newer copy. A code review on 2026-11-07 found that a 500 dropped the write; now a server error keeps the change and retries, and only a refused change is dropped.
- **Clients choose UUIDs, and replaying a create returns the existing item.** This serves the offline outbox, the shell contract, Siri retries and MCP retries.
- **Sign in with Apple is the only production sign-in**, limited by `ALLOWED_APPLE_ACCOUNTS`. Passwords were rejected: hashing, resets, breach checks and brute-force protection buy nothing over Apple for a single owner. Development has a "local workspace" sign-in that production refuses and that answers only loopback requests. Native local sign-in issues a real session rather than asking for a pasted token, because personal tokens cannot reach the credential and account screens. In shell mode (`SHELL_URL`) the shell's ES256 token is verified and the app's own sign-in is off.
- **MCP** uses the official SDK over stdio and over Streamable HTTP mounted at `/mcp`. HTTP tool calls reach the API in-process through `httpx.ASGITransport`, so HTTP MCP does not depend on `TASKS_API_URL`. Auth is personal access tokens; MCP OAuth was deferred. `list_project_links` was removed in favor of `get_project` returning links.
- **Flesh out** (task view) runs Claude on the server as an MCP client of this app's own `/mcp` with a 15-minute credential, plus any servers in `AGENT_MCP_SERVERS` (Notebook). Destructive tools and `AGENT_BLOCKED_TOOLS` are never offered, and tools that act on other items are blocked so the agent stays on its task. The editor once lost the user's draft after a 409 because it was keyed on the task version; it now uses an agent-edit counter.
- **Design system.** Glassive came first (2026-11-04). The owner switched the web app to Clean in Cursor on 2026-11-17, and Claude ported Clean to Apple (`Clean.swift`) and onto the rebuilt web app. CSS keeps Glassive's variable names because the shell and embeds share them; `clean-bridge.css` gives those names Clean values. Private packages are vendored until the build can install from GitHub Packages.
- **Taskwell was renamed to Tasks** (2026-11-07). The Keychain service name changed with it. The decision was not to migrate the old Keychain item, since bundle IDs are still `com.example.*` placeholders and only development installs were affected.
- **Spaces** (Work and Personal) keep work and home tasks apart. Each device shows one space and remembers it. A task in a project is in the project's space; moving a task to the other space puts it in that space's Inbox. Existing data started in Personal, and the owner then moved all of their projects and tasks to Work (2026-11-19). The shared search contract has no space filter, so MCP `search` spans both spaces.
- **The task view** became a large two-column view (content left, details right, saving as you edit) after the owner called the earlier one "ugly and clunky compared to todoist". The iPhone layout got a bottom tab bar with Select moved into a More menu, also modelled on Todoist.
- **Siri.** App Intents for add, complete, snooze, move and open, Spotlight indexing, on-screen annotations and donations. "Remind me in Tasks" phrases alone could not make "Remind me to take out the trash" use this app, because every App Shortcut phrase must contain the app name, so the app adopted Apple's reminders schema domain. See section 5.
- **Platform floor.** The Apple apps require iOS 27 and macOS 27. CI's `apple` job runs on an `xcode-27` runner because `macos-latest` only has Xcode 26.
- **Deployment.** DigitalOcean App Platform and Droplet (Docker Compose behind Caddy) configs exist with placeholders, but no cloud resources were ever created. "Deploy" currently means the local Mac setup (section 7 and the `local-deploy` skill).
- **No in-app logo.** The checkmark appears only as the app icon and favicon. The app icon is the Icon Composer bundle `AppIcon.icon` in both Apple targets; the old image set and icon scripts were removed.

### Tried and rejected

- Passwords for sign-in (above).
- Switching the git remote to SSH to get around a missing GitHub `workflow` token scope. Claude declined; the owner ran `gh auth refresh -h github.com -s workflow` instead.
- Fixing review findings on a stale local `dev`. A whole review-and-fix pass (commit `334848d`) was done 10 commits behind `origin/dev`, then had to be ported by hand (PRs #4 to #6). Always fetch first.
- A port of multi-select on the task-view branch, replaced by `dev`'s own when merging.
- "Remind me in Tasks" phrases as the way to win generic "Remind me" requests (above).

## 4. Conventions the owner stated or enforced

These are also in `CLAUDE.md` and `AGENTS.md`, which are the standing rules.

- Product rules in `AGENTS.md`: personal tool, no marketing copy or sample tasks, short factual copy, no product name or logo inside the app, keep web, macOS and iOS consistent, do not ask for deployment or Apple credentials. Never use an em dash in replies.
- **Feature parity.** A feature is expected on web, macOS and iOS ("Yes, do Apple"), and the owner then asks for the REST docs, MCP tools and Siri intents to catch up ("lots of changes, update this to support"). Plan for all of them.
- **Todoist is the UX reference.** Compare layouts with how Todoist does it.
- **Git:** commit and push only when asked. New work goes on a new `claude/<topic>` branch off current `origin/dev`, with a PR into `dev`. Releases are a `dev` to `main` PR, an annotated `vX.Y.Z` tag on `main` and a GitHub release (`release` skill). No attribution or co-author lines in commits or PRs. Commit subjects are plain imperative sentences about the effect ("Keep work and personal tasks apart with spaces").
- **Shared checkout.** Other Claude sessions and Cursor work in the main checkout, often with uncommitted changes. Never stash, reset, restore or commit someone else's changes there; use a git worktree under `.claude/worktrees/` for separate work. Never run a bare `git stash` in a worktree.
- **Data safety.** `api/tasks.db` is the owner's real workspace. Back it up to `api/.backups/` before anything that migrates it, and test against a temporary `DATABASE_URL`, never the real file.
- **Testing:** run what the change touches and record new features in `docs/verification.md` with a dated section that ends with what was not verified. After API changes run `scripts/export_openapi.py`. UI tests go through `scripts/test-ios.sh` on a dedicated simulator, not the owner's personal one.
- **Reporting:** say what was verified and what was not; the owner acts on short yes/no follow-ups ("Yes, fix it", "Not now", "Commit on new branch").
- Auto-fix for PR CI was turned on once (PR #6) and declined on later PRs. Ask; do not assume.

## 5. In-flight work

1. **The reminders schema never reached `dev`.** Branch `claude/siri-intents` has two commits that are pushed but not merged: `1379f44` (Remind me phrases, a due time from Siri sets the reminder) and `0959fda` (Apple's reminders schema: Create Reminder, Update Reminder, Delete Reminders, Create List). PR #16 merged at 20:50 UTC on 2026-11-19, before those were pushed, yet its description already describes them, and the session that wrote them believed they were in it. CI passed on the branch and it merges cleanly into current `dev`. PR #20 was opened for them on 2026-11-22. **Next step:** merge #20 when the owner agrees, then rerun the iOS UI tests on `dev`, since they were last run before #17 and #18 merged.
2. **On-device Siri checks.** Siri offering the app for "Remind me to...", Siri AI natural language requests, Spotlight results and donation suggestions need the iOS 27.3 beta on an Apple Intelligence device. None were tried.
3. **Local deploy is probably behind `dev`** *(inferred)*. The last recorded local deploy was spaces (2026-11-19, 16:00 UTC). PRs #15 to #18 merged later, and nothing records a redeploy.
4. **Todoist import leftovers.** All 35 open tasks were imported. About 100 open tasks in 3 archived Todoist projects, and completed history, were skipped. The owner was asked which to add and did not answer.
5. **Cleanup.** Local worktrees still exist for merged branches: `.claude/worktrees/intelligent-shaw-cf3367`, `.claude/worktrees/mcp-review` (on `claude/mcp-siri-parity`), `.claude/worktrees/task-detail`, `../tasks-ios-tab-bar`, and a pruned scratch worktree for `claude/api-reference-update`. Remote branches for merged PRs #11 to #18 remain. `../tasks-shell` is an old broken worktree copy from November 4. Ask before deleting any of them.
6. **Production deployment** waits on the owner's DigitalOcean choice, domain and Apple Developer setup (`docs/deployment.md`, "Inputs still needed"). Do not ask for them.

## 6. Open questions and known problems

- iPad: `testQuickEntryAndPersistence` failed at "Use details and edit" in the add form on iPad Pro 13-inch (2026-11-19). It passes on iPhone. Not investigated.
- iOS UI tests time out in `tearDown` when the Mac is heavily loaded; they pass on rerun.
- One Playwright test failed locally on unmodified `dev` on 2026-11-19; the session did not record which. CI on `dev` passes *(likely flaky, inferred)*.
- The README has drifted *(from reading it)*: it says MCP has "nine task and project tools" and lists the removed `list_project_links`, and its "Included" section says offline editing is not included while a later section describes the offline replica.
- Never verified live: Sign in with Apple, Web Push and APNs delivery, AlarmKit alarms, App Platform's client IP header, sign-in through a real shell, and Flesh out against the real model (no API key was set when it was built).
- Not yet done (`docs/authentication.md`, "What to revisit"): passkeys, idle session expiry, Apple revocation notifications, a shared rate limiter, MCP OAuth. `docs/architecture.md` notes label filtering runs after the user-scoped query.
- The Mac app was not exercised by UI tests; a test build shares the installed app's settings and sign-in.
- Notebook's CI for its links PR (notebook-app #365) did not run because of a GitHub billing problem on 2026-11-17. Its current state was not checked.
- There is a `tasks.db` at the repo root dated 2026-10-27, separate from `api/tasks.db` *(probably stale, inferred; leave it alone)*.

## 7. Outside the repo

Names only. Values live in gitignored files or the owner's own stores.

- **GitHub:** `awestley/tasks-app` (public). Default branch `dev`, releases on `main`. Actions workflow "Verify" with `api`, `web` and `apple` jobs.
- **Related repos:** `awestley/westley-app` (Personal Command shell, checked out at `../smithy-app`; app contract in its `docs/app-contract.md`), `awestley/notebook-app` (Notebook, with its own MCP server and `[[task:]]` links).
- **Local Mac, as "deployed":** backend on port 8000 from the main checkout via `./scripts/start.sh` in a Terminal tab; data in `api/tasks.db`, backups in `api/.backups/`; Mac app copied to `~/Applications/Tasks.app`; iOS build on the owner's iPhone 18 Pro simulator. UI tests used an iPhone 18 Pro Max simulator. Xcode 27.2.
- **Ports:** other apps and projects on the Mac sometimes hold 8000 and 8001. Use `--port` or `TASKS_API_PORT`.
- **Mac accounts:** the repo belongs to one macOS account, and a second administrator account was given ACL access on 2026-11-17 so it could run `start.sh`. A backend started by one account cannot be stopped by the other.
- **Local secrets files (gitignored, never read or commit):** `api/.env` (may hold `ANTHROPIC_API_KEY`, VAPID and APNs keys), `~/.todoist_token`. Import state: `~/.config/tasks/todoist-import.json`.
- **DigitalOcean:** `doctl` has saved contexts, but they belong to other projects. Nothing exists for Tasks.
- **Apple Developer:** not set up. Bundle IDs are `com.example.*` placeholders.

## 8. Claude setup carried by the repo

- `CLAUDE.md` loads `AGENTS.md` (shared with Cursor) and adds the working rules. Keep shared product rules in `AGENTS.md`.
- `.claude/settings.json`: attribution off, routine read-only and test commands allowed, `.env` reads and destructive git denied.
- `.claude/skills/local-deploy` and `.claude/skills/release`: the "deploy locally" and "build, deploy, release" routines the owner asks for, taken from the previous account's memory and sessions.
- No `.mcp.json`. No MCP server was configured for this repo. The only user-level server (`lightsmith`) belongs to another project. To let Claude use this app's own MCP server, see README "API and MCP"; it needs a personal access token, which must stay out of the repo.
- Nothing else at user level was relied on. There was no user-level `CLAUDE.md`, agents or commands. User skills (`hyperframes*`, `marvin`, `media-use`) are for other projects. Sessions here invoked `/engineering:code-review` and `/engineering:system-design` from Anthropic's knowledge-work "engineering" plugin, synced to the old account. They are generic: install that plugin, or use the built-in `/code-review` and `/security-review`.
- `.claude/launch.json` (desktop app preview servers) stays gitignored because it holds machine paths. The portable entry is `{"name": "dev", "runtimeExecutable": "bash", "runtimeArgs": ["-c", "TASKS_API_PORT=8001 exec bash scripts/dev.sh"], "port": 5173}`.
