# Project instructions

This is a personal task tool, not a product marketing site. Keep interfaces focused on tasks, navigation, settings, and useful status. Do not add promotional landing pages, slogans, motivational messages, decorative overview cards, upsells, or sample tasks by default. Use short, factual interface copy. Keep the web, macOS, and iOS interfaces consistent with this preference.

Deployment and Apple Developer credentials will be provided later. Continue local implementation and verification without requesting those details again unless work requires them.

Never use an em dash in responses to the user.

Do not show a product name in the interface. Keep the existing blue checkmark as the app icon and favicon only; do not show it inside the app. Use generic labels such as Tasks only where a browser tab or installed app requires a name.

## Use sub-agents whenever possible

Delegate to sub-agents by default instead of doing the work inline:

- **Searching and exploring.** Any search across more than a couple of files, or any question whose answer means reading widely (for example tracing a feature across the web, macOS, and iOS code), goes to an Explore or general-purpose agent. Keep the conclusion in the main context, not the file dumps.
- **Independent work in parallel.** When a task splits into pieces that don't depend on each other (separate platforms, separate files, separate checks), launch one agent per piece in a single message so they run concurrently.
- **Planning.** Use a Plan agent to design the approach for non-trivial changes before implementing.
- **Review and verification.** After a change, have a fresh agent review the diff or run and check the tests, so the read isn't anchored on the main session's assumptions. Give it the code, not the conclusion.
- **Web lookups.** Use a web-fetch agent to read pages and docs.

Brief every agent like a peer: the goal, what's already ruled out, the files or docs to read, and what done looks like. Wait for its result rather than redoing the same work inline, and check what it reports before relying on it.

Work inline only when it's genuinely trivial: a single known file read, a one-line edit, or a lookup whose target is already known.
