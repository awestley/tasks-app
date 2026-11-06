# Quick entry, reminders and push

Press **Q** (or use the field at the top of the companion) and type `Order Pizza Friday Afternoon`. As you type, `Friday` and `Afternoon` light up, and the chips below show Friday at 3:00 PM with a reminder at that time. Enter adds the task and keeps the field open for the next one; ⌘Enter adds and closes. Click a highlighted word to keep it as plain text, or use the Date, Priority, Reminder, Labels and Project chips instead of typing. Parsing runs in the browser (so it works offline) with the same rules as the server's parser for the API and MCP; `api/tests/quick_add_cases.json` holds the cases both must agree on. No external language model sees task text.

Supported English phrases: today, tomorrow (tmr, tmrw), yesterday, day after tomorrow, tonight, weekday names, next weekday, next week, next month, this weekend, next weekend, in N days/weeks/months, in N hours/minutes, month and day (`Nov 20`, `20 November`, with an optional year), ISO dates, morning (09:00), afternoon (15:00), evening (19:00), noon, midnight, 12-hour times such as `10am`, and 24-hour times such as `15:30`. A bare weekday means the next matching day including today; `next Monday` means Monday of next calendar week. A time without a date uses today if still ahead, otherwise tomorrow. Explicit dates can be in the past and are shown for review.

Other details: `p1` through `p4`, `@label`, `#Project name` (typing `#` suggests projects, and offers to create a new one), `every day/week/month`, `every friday`, `daily`, `weekly`, `monthly`, and a reminder with a time: `!30m before`, `!1h before`, or `remind me 15 minutes before`. A task with a time gets the automatic reminder (at the time by default; change it under the bell). Unknown text stays in the title. This is a bounded English parser, not unrestricted natural-language understanding.

## Scheduling

The API stores `due_date`, `due_time` (`HH:MM`), an IANA `time_zone`, and `reminder_minutes` (null disables reminders, 0 means at due time, positive values mean before). The web and native editors use the device time zone initially and preserve the task's selected zone during edits. There is one reminder per occurrence, delivered to every enabled device.

The server checks every 15 seconds while push is configured. A durable delivery record and atomic lease prevent normal duplicate sends across workers. Failed transport requests and temporary provider errors retry with exponential backoff, up to eight attempts. After an outage, reminders can arrive up to 24 hours late. Expired device subscriptions are removed. Invalid credentials and permanent errors stop that delivery and are recorded in the database. Push is best effort; provider acceptance is not proof that a notification appeared on a device, and a crash after acceptance but before recording success can produce a duplicate. Matching notification tags/collapse IDs limit duplicates on devices.

Completion, deletion, removing a reminder, or rescheduling suppresses pending deliveries when the worker next checks them. A delivery already accepted by a provider cannot be recalled. Editing a title does not resend a delivered reminder. Reopening the same occurrence does not resend its already-delivered reminder; changing the reminder time creates a new delivery. Recurring successors retain the time zone, time, and reminder offset, with a fresh date. A recurring time in a spring-forward gap shifts forward by that gap. An explicitly entered nonexistent time is rejected; an ambiguous fall-back time uses its first occurrence.

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

The Sign in with Apple key is not assumed to have APNs permission. Enable Push Notifications for both app identifiers and regenerate provisioning profiles. The XcodeGen project includes the platform-specific push entitlements and uses development APNs for Debug and production APNs for Release. Make sure the build configuration matches its provisioning environment.

Native settings let you enable or disable notifications for that device. The app registers with APNs, refreshes its device token on launch, and uploads the token for the signed-in account. Notification taps refresh the workspace and open the matching task. Apple signing, provisioning and real-device delivery remain required release checks. See [Apple's APNs request contract](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## Local provider verification

```sh
postman simulation run postman/simulations/push/push.sim.yaml --port 4902 --output ndjson
# Another terminal, from the repository root:
PUSH_SIMULATION_URL=http://127.0.0.1:4902/push PYTHONPATH=api api/.venv/bin/pytest api/tests -q
```

The fixtures exercise real HTTP requests with ephemeral signing/encryption keys, including success, a transient 503, expired-token 410, and invalid-provider-token 403. This proves local integration and recovery behavior, not live APNs/Web Push delivery. `PUSH_SIMULATION_URL` is rejected in production. Never configure it on a deployed service.
