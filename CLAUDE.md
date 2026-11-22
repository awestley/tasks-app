# Claude instructions

@AGENTS.md

New to this repo? Read [docs/handoff.md](docs/handoff.md) first: what the project is, why it is built this way, work in flight, and known problems. Then `README.md` and `docs/architecture.md`.

## Working rules

- The repository is public. Never commit secrets, tokens, personal task data or personal details. Never read or print `.env` files or `~/.todoist_token`.
- Run `git fetch` before starting work and branch from current `origin/dev`, not local `dev`, which is often stale.
- Commit and push only when asked. New work goes on a new `claude/<topic>` branch with a PR into `dev`. No attribution or co-author lines in commits or PRs. Commit subjects are plain imperative sentences about the effect.
- Other Claude sessions and Cursor share the main checkout and may leave uncommitted changes. Do not stash, reset, restore or commit changes you did not make. Use a worktree under `.claude/worktrees/` for separate work, and never run a bare `git stash` in a worktree.
- `api/tasks.db` is the owner's real workspace. Back it up to `api/.backups/` before anything that migrates it. Test against a temporary `DATABASE_URL`.
- Port 8000 is the owner's running backend. Use another port for test servers (`--port`, `TASKS_API_PORT`, `TASKS_TEST_PORT`).
- A feature belongs on web, macOS and iOS, and then in the REST docs, the MCP tools and, where it fits, the Siri intents. Todoist is the UX reference.
- After API changes run `api/.venv/bin/python scripts/export_openapi.py`. Record new features in `docs/verification.md` with a dated section that says what was not verified.
- Run iOS UI tests with `bash scripts/test-ios.sh <UDID>` on a dedicated simulator, not the owner's personal one. Build macOS with `CODE_SIGNING_ALLOWED=NO`; iOS Simulator builds use ad hoc signing (`CODE_SIGN_IDENTITY=-`).
- "Deploy" means the local Mac setup: use the `local-deploy` skill. Releases: the `release` skill.

## Checks

```sh
cd api && .venv/bin/ruff check . ../scripts && .venv/bin/ruff format --check . ../scripts && .venv/bin/pytest -q
npm --prefix web run build && npm --prefix web run test:unit
api/.venv/bin/python scripts/check_mcp.py   # with a backend running
```

Browser tests (`cd web && npm test`) need a backend with local sign-in; see `.github/workflows/ci.yml` for the exact setup.
