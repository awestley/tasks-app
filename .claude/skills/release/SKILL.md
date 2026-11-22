---
name: release
description: Cut a Tasks release (version bump, dev to main PR, tag, GitHub release) and clean up. Use when asked to "release", "build and deploy latest top to bottom", or "ship a version".
---

# Release

Confirm with the owner before pushing, merging, tagging or deleting anything.

1. **Collect everything.** `git fetch --prune`. Check the main checkout, every worktree (`git worktree list`) and local branches for commits or changes missing from `origin/dev` (`git cherry origin/dev <branch>`). Ask whether to bring any in first.
2. **Bump the version** on a `claude/release-X.Y.Z` branch off `origin/dev`. The version appears in `api/pyproject.toml`, `api/tasks/main.py`, `apple/project.yml`, `web/package.json` and `docs/openapi.json` (regenerate it with `api/.venv/bin/python scripts/export_openapi.py`). Run the checks in `CLAUDE.md`. PR into `dev`.
3. **Release PR** from `dev` into `main` once `dev` is green.
4. **Tag and publish** after it merges: an annotated `vX.Y.Z` tag on `main`, pushed, and a GitHub release "Tasks vX.Y.Z" with short factual notes grouped by area.
5. **Deploy locally** with the `local-deploy` skill.
6. **Clean up** only with the owner's yes: merged remote branches, merged local branches and their worktrees, old build folders. GitHub keeps `dev` and `main`.

Past releases: v0.1.0 (2026-11-07), v0.2.0 (2026-11-18).
