---
name: local-deploy
description: Deploy Tasks on the owner's Mac, which is the only deployment today. Use when asked to "deploy", "deploy locally", "run the latest", "build so I can test", or to put a merged change into the running backend, Mac app and iPhone simulator.
---

# Deploy locally

There is no cloud deployment yet. Deploying means updating three things on this Mac from the main checkout.

1. **Get the code.** `git fetch`. Deploy what is on `origin/dev` (or the branch the owner names). The main checkout is shared with other sessions and Cursor: if it has uncommitted changes you did not make, stop and ask rather than switching branches over them. Compare with `git cherry` and other worktrees so nothing unmerged is lost.
2. **Back up the data.** Copy `api/tasks.db` to `api/.backups/tasks-<timestamp>.db`. Startup runs migrations on it.
3. **Build and start the backend.** `./scripts/start.sh` cleans old builds, builds web, macOS and the iOS Simulator app, stops an earlier Tasks backend on port 8000, and starts a new one. Run it in a Terminal tab so it keeps running. Options: `--skip-apple`, `--no-build`, `--no-serve` (a running backend keeps running), `--port PORT`. If port 8000 is held by another program or another macOS account, the script says so; ask before stopping anything.
4. **Mac app.** Quit the running Tasks app, then copy `apple/DerivedData/Build/Products/Debug/Tasks.app` to `~/Applications/Tasks.app`, replacing the old copy. Do not leave stray copies elsewhere with the same bundle ID.
5. **iPhone simulator.** `xcrun simctl install booted apple/DerivedData-iOS/Build/Products/Debug-iphonesimulator/Tasks.app` on the owner's personal iPhone 18 Pro simulator, then launch it. It should point at `http://localhost:8000`.
6. **Check.** `curl -s localhost:8000/health`, open http://localhost:8000, and confirm the apps show the owner's tasks. Report what runs where and anything not checked.

Never run UI tests on the personal simulator or against `api/tasks.db`; use `scripts/test-ios.sh` with another simulator.
