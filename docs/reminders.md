# Quick entry, reminders and push

Press **Q** (or use the field at the top of the companion) and type `Order Pizza Friday Afternoon`. As you type, `Friday` and `Afternoon` light up, and the chips below show Friday at 3:00 PM with a reminder at that time. Enter adds the task and keeps the field open for the next one; ⌘Enter adds and closes. Click a highlighted word to keep it as plain text, or use the Date, Priority, Reminder, Labels and Project chips instead of typing. Parsing runs in the browser (so it works offline) with the same rules as the server's parser for the API and MCP; `api/tests/quick_add_cases.json` holds the cases both must agree on. No external language model sees task text.

Supported English phrases: today, tomorrow (tmr, tmrw), yesterday, day after tomorrow, tonight, weekday names, next weekday, next week, next month, this weekend, next weekend, in N days/weeks/months, in N hours/minutes, month and day (`Nov 20`, `20 November`, with an optional year), ISO dates, morning (09:00), afternoon (15:00), evening (19:00), noon, midnight, 12-hour times such as `10am`, and 24-hour times such as `15:30`. A bare weekday means the next matching day including today; `next Monday` means Monday of next calendar week. A time without a date uses today if still ahead, otherwise tomorrow. Explicit dates can be in the past and are shown for review.

Other details: `p1` through `p4`, `@label`, `#Project name` (typing `#` suggests projects, and offers to create a new one), `every day/week/month`, `every friday`, `daily`, `weekly`, `monthly`, and a reminder with a time: `!30m before`, `!1h before`, or `remind me 15 minutes before`. A task with a time gets the automatic reminder (at the time by default; change it under the bell). Unknown text stays in the title. This is a bounded English parser, not unrestricted natural-language understanding.

## Scheduling

The API stores `due_date`, `due_time` (`HH:MM`), an IANA `time_zone`, and `reminder_minutes` (null disables reminders, 0 means at due time, positive values mean before). The web and native editors use the device time zone initially and preserve the task's selected zone during edits. There is one reminder per occurrence, delivered to every enabled device.

The server checks every 15 seconds while push is configured. A durable delivery record and atomic lease prevent normal duplicate sends across workers. Failed transport requests and temporary provider errors retry with exponential backoff, up to eight attempts. After an outage, reminders can arrive up to 24 hours late. A reminder whose time had already passed when the task was last saved does not fire, and a device enabled after a reminder came due does not receive it. Expired device subscriptions are removed. Invalid credentials and permanent errors stop that delivery and are recorded in the database. Push is best effort; provider acceptance is not proof that a notification appeared on a device, and a crash after acceptance but before recording success can produce a duplicate. Matching notification tags/collapse IDs limit duplicates on devices.

Completion, deletion, removing a reminder, or rescheduling suppresses pending deliveries when the worker next checks them. A delivery already accepted by a provider cannot be recalled. Editing a title does not resend a delivered reminder. Reopening the same occurrence does not resend its already-delivered reminder; changing the reminder time creates a new delivery. Recurring successors retain the time zone, time, and reminder offset, with a fresh date. A recurring time in a spring-forward gap shifts forward by that gap for that date only, and later occurrences return to the original time. Monthly tasks clamp to the end of a short month and then return to their original day. Choosing a new date, time or recurrence starts a new series from those values. An explicitly entered nonexistent time is rejected; an ambiguous fall-back time uses its first occurrence.

## Notification content and behavior

Every notification is short and factual. A task notification shows the task title, its project as a subtitle, and timing such as `Due 15:00`, `Due tomorrow 09:00`, `Due now` or `Overdue since 15:00`. Notes and checklist contents are never sent.

- **Actions.** Task notifications offer Complete, Snooze 15 min, Snooze 1 hour and Tomorrow on Apple devices, and Complete and Snooze 15 min in browsers that support actions. Actions call the API directly and work without opening the app. If an action fails, the Apple apps post a "Could not update task" notification and browsers open the task instead.
- **Snooze.** `POST /api/v1/tasks/{id}/snooze` stores `snoozed_until` on the task, so every enabled device is notified again, including the web. Snoozing does not need the task's version and works for tasks without a due date. Completing the task or changing its date, time, time zone or reminder clears a snooze. Recurring successors do not inherit it. The task menus offer 15 minutes, 1 hour, 3 hours and tomorrow at 09:00.
- **Replacement.** Notifications for one task share an identifier (`task-<id>`), so a snooze or follow-up replaces the earlier notification instead of adding another.
- **Grouping.** Apple devices group notifications by project (`thread-id`), with Inbox tasks together and the summary on its own.
- **Urgency.** Tasks at or above a chosen priority are Time Sensitive and can break through Focus (default: Urgent only; can be Urgent and high, or off). Other reminders are Active and the summary is Passive. Each notification has a relevance score from its priority, raised for overdue follow-ups, which the system uses to order summaries.
- **Badge.** Each push carries the count of open tasks due today or overdue. The apps and the web app update the badge after each refresh.
- **Stale notifications.** When a task that was notified in the last day is completed, deleted, rescheduled or snoozed, the server sends a background push to Apple devices, which remove that notification and refresh. The web app closes notifications for tasks that are no longer open whenever it loads tasks.
- **Overdue follow-up.** Optional, 30 minutes to 4 hours after the due time, for open tasks that have a reminder. One follow-up per occurrence. A snooze past the follow-up time replaces it.
- **Morning summary.** Optional, at a chosen local time: for example `2 due today, 1 overdue`. Nothing is sent when both counts are zero, and a summary more than two hours late is dropped. A summary time in a spring-forward gap moves forward by the gap.

Settings for the summary, follow-ups and Time Sensitive apply to every device and are under **Settings > Reminders & notifications** (`GET`/`PUT /api/v1/notifications/settings`). The summary uses the time zone of the device that last saved the settings.

## Siri, Shortcuts and alarms (iOS 27 and macOS 27)

The Apple apps require iOS 27 and macOS 27.

- A notification service extension tags each pushed task notification with the task's App Intents entity (`appEntityIdentifiers`, new in iOS 27). Siri can then act on the task the notification is about, for example when it announces the notification.
- **Add Task**, **Complete Task**, **Snooze Task**, **Move Task to Space** and **Open Task** are App Intents, available in Siri and Shortcuts.
  - Add Task takes a title, and optionally a due date and time, a reminder, a project and a space. With only a title it reads dates, priority, labels and projects out of it, like quick add, so "Add a task" followed by "bring the dentist forms tomorrow at 3pm" sets the due time. A task without a project joins the space asked for, or the space the device shows. Each create sends a client-chosen ID, so a retried request returns the same task.
  - Snooze Task takes minutes or a time ("until tonight at 8").
  - Move Task to Space sends a task to Personal or Work; a task in a project goes to the other space's Inbox.
  - Phrases include "Add a task in Tasks", "Remind me in Tasks", "Create a reminder in Tasks", "Add a work task in Tasks", "Add a task to <project> in Tasks" and "Move this to Work in Tasks".
  - A due time given to Add Task reminds at that time unless another reminder is set, as in quick entry.
- Tasks and projects follow Apple's reminders schema domain, so Siri offers the app for requests that name no app, such as "Remind me to take out the trash", next to Reminders and other reminder apps.
  - Tasks are reminder entities (`.reminders.reminder`): labels are tags, priority 1 is flagged, and the project or the space's Inbox is the list. Projects and both Inboxes are list entities (`.reminders.list`, IDs `inbox-personal` and `inbox-work` for the Inboxes).
  - **Create Reminder** takes a title, list, note, tags, web addresses (saved as links), due date, repeat and flag. A due time reminds at that time. With only a title it reads dates and the rest out of it, as Add Task does.
  - **Update Reminder** changes the title, note, tags, due date, repeat, flag, list or done state, and adds links. Moving to a list in the other space moves the task there.
  - **Delete Reminders** deletes tasks. **Create List** ("Create a list called groceries") makes a project in the space the device shows.
  - Repeats are daily, weekly or monthly; any other rule is refused. The app keeps no images, sections or location reminders, so a request with one is refused rather than saved without it.
  - Schema entities keep Apple's type names, so Shortcuts shows tasks as reminders and projects as lists.
- Tasks are indexed in Spotlight as App Intents entities (`IndexedEntity`) with their notes, due date, project, space, labels, priority and done state, so Siri can find a task by what it says. Open tasks appear in Spotlight search; done ones stay in the index for Siri only. The app writes only tasks that changed since the last refresh, and clears the index when signing out or when the session ends.
- Task rows and the open task are annotated with their entity (`appEntityIdentifier`), so Siri can act on the task on screen ("snooze this until tonight").
- Completing or snoozing a task in the app is donated to Siri (`IntentDonationManager`), so it can suggest the same action later.
- Siri AI's natural language requests for third-party apps need the iOS 27.3 Developer Preview and an Apple Intelligence device. The intents also work with Siri phrases and Shortcuts on any iOS 27 device.
- `TasksUITests/SiriTests.swift` runs Add Task and Move Task with `AppIntentsTesting`, finds the task through a Spotlight query, and checks the on-screen annotation. It also runs Create Reminder, Create List, Update Reminder and Delete Reminders. Both tests use the isolated test backend (`scripts/test-ios.sh`).
- A task with a reminder can use **Alert: Alarm on iPhone**. On iPhone and iPad the reminder then rings with AlarmKit, through silent mode and Focus, with a Snooze button (10 minutes) and the task's entity attached so Siri can act on the ringing alarm. The app schedules alarms for the next 7 days after each refresh and reports them to the server (`PUT /api/v1/push/subscriptions/{id}/alarms`), which then skips that device's notification for the same reminder. Other devices, including Macs and browsers, get a normal notification. The app asks for alarm permission the first time a task is set to Alarm; without it, the device gets a notification. Alarms are scheduled on the device, so a change made elsewhere reaches it on the next refresh or background push.

## Browser push

Generate a stable VAPID key pair using your contact address:

```sh
api/.venv/bin/python scripts/generate-vapid.py --subject mailto:YOUR_EMAIL --output api/.env.push
```

The new file is private and ignored by Git and Docker. Copy its three settings into the backend's environment or secret store: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`. The private key is base64url-encoded PKCS8 DER, not raw PEM. Restart the service after configuration. Do not rotate the key pair routinely; subscriptions are tied to it.

On DigitalOcean App Platform, use encrypted environment variables for the private key. On a Droplet, add settings to the root `.env`. For local development, append the generated settings to `api/.env`. The background delivery loop runs inside the API process; no extra worker service is required. Keep at least one API instance running for reminders.

In the app, the bell in the top bar turns notifications on for this browser (permission is requested only after that button press); **Settings & integrations > Reminders & notifications > Enable on this browser** adds server push, so reminders arrive while the app is closed. While any Tasks view is open (a tab, a column, or the companion), the app also schedules reminders itself, so they work without push and offline; both use the same notification tag, so a reminder shows once. Each reminder has a **Complete** button that completes the task without opening anything; clicking the notification opens the task (in a column when running inside Personal Command). Notes and checklist contents are not included in payloads. Disabling a device removes its server subscription. Normal sign-out also disables this browser's subscription.

Production uses HTTPS. iPhone browser push is supported through a Home Screen web app; the included manifest supplies that installation mode. See [Apple's Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) and [WebKit's Home Screen guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Native Apple push

Configure these backend values when your Apple Developer setup is available:

- `APNS_TEAM_ID`: Apple team ID.
- `APNS_KEY_ID`: key identifier for an APNs-enabled signing key.
- `APNS_PRIVATE_KEY`: the `.p8` key, using literal `\n` between lines in an environment value.
- `APPLE_NATIVE_CLIENT_IDS`: comma-separated allowed iOS and macOS bundle identifiers.

The Sign in with Apple key is not assumed to have APNs permission. Enable Push Notifications and Time Sensitive Notifications for both app identifiers, register the notification service extensions (`com.example.tasks.ios.notifications`, `com.example.tasks.macos.notifications`), and regenerate provisioning profiles. The iOS app also uses the remote-notification background mode for stale-notification removal, and AlarmKit. The XcodeGen project includes the platform-specific push entitlements and uses development APNs for Debug and production APNs for Release. Make sure the build configuration matches its provisioning environment.

Native settings let you enable or disable notifications for that device. The app registers with APNs, refreshes its device token on launch, and uploads the token for the signed-in account. Notification taps refresh the workspace and open the matching task, including a tap that launches the app. Apple signing, provisioning and real-device delivery remain required release checks. See [Apple's APNs request contract](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## Local provider verification

The API tests include an in-process fake provider (`api/tests/fake_providers.py`), so they need no setup. To run them against the Postman simulation instead:

```sh
postman simulation run postman/simulations/push/push.sim.yaml --port 4902 --output ndjson
# Another terminal, from the repository root:
PUSH_SIMULATION_URL=http://127.0.0.1:4902/push PYTHONPATH=api api/.venv/bin/pytest api/tests -q
```

Both exercise real HTTP requests with ephemeral signing/encryption keys, including success, a transient 503, expired-token 410, and invalid-provider-token 403. This proves local integration and recovery behavior, not live APNs/Web Push delivery. `PUSH_SIMULATION_URL` is rejected in production. Never configure it on a deployed service.
