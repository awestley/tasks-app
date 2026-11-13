import { useEffect, useState } from "react";
import { api, localDate, type Task } from "./api";

type Device = { id: string; kind: string; name: string };
type Config = { web_enabled: boolean; vapid_public_key: string | null };
type Preferences = {
  summary_time: string | null;
  summary_zone: string;
  overdue_minutes: number | null;
  time_sensitive_priority: number;
};

/** Removes this browser's notifications for tasks that are no longer open, and updates the app badge. */
export function clearStaleNotifications(tasks: Task[]) {
  if (!("serviceWorker" in navigator)) return;
  const open = tasks.filter((t) => !t.completed);
  const today = localDate();
  navigator.serviceWorker.controller?.postMessage({
    type: "open-tasks",
    ids: open.map((t) => t.id),
    badge: open.filter((t) => t.due_date && t.due_date <= today).length,
  });
}

export function NotificationPreferences() {
  const [value, setValue] = useState<Preferences>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<Preferences>("/notifications/settings")
      .then(setValue)
      .catch((e) => setError(e.message));
  }, []);
  const save = (change: Partial<Preferences>) => {
    if (!value) return;
    const next = {
      ...value,
      ...change,
      summary_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    setValue(next);
    setError("");
    api<Preferences>("/notifications/settings", "PUT", next)
      .then(setValue)
      .catch((e) => setError(e.message));
  };
  if (!value) return error ? <p className="error-text">{error}</p> : null;
  return (
    <div className="notification-preferences">
      <label className="check">
        <input
          type="checkbox"
          checked={value.summary_time !== null}
          onChange={(e) =>
            save({ summary_time: e.target.checked ? "08:00" : null })
          }
        />
        Morning summary
      </label>
      {value.summary_time !== null && (
        <label>
          Summary time
          <input
            type="time"
            aria-label="Summary time"
            value={value.summary_time}
            onChange={(e) =>
              e.target.value && save({ summary_time: e.target.value })
            }
          />
        </label>
      )}
      <label>
        Overdue follow-up
        <select
          aria-label="Overdue follow-up"
          value={value.overdue_minutes ?? ""}
          onChange={(e) =>
            save({
              overdue_minutes: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          <option value="">Off</option>
          <option value="30">30 minutes after</option>
          <option value="60">1 hour after</option>
          <option value="120">2 hours after</option>
          <option value="240">4 hours after</option>
        </select>
      </label>
      <label>
        Time Sensitive on Apple devices
        <select
          aria-label="Time Sensitive"
          value={value.time_sensitive_priority}
          onChange={(e) =>
            save({ time_sensitive_priority: Number(e.target.value) })
          }
        >
          <option value="1">Urgent</option>
          <option value="2">Urgent and high</option>
          <option value="0">Off</option>
        </select>
      </label>
      <p className="muted">
        The summary lists tasks due today and overdue, and is not sent when
        there are none. Follow-ups apply to tasks with a reminder. Settings
        apply to every device.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}

export async function disableBrowserPush() {
  const id = localStorage.getItem("tasks-push-id");
  if (id) {
    try {
      await api("/push/subscriptions/" + id, "DELETE");
    } catch (error) {
      // 404: already removed. 401: the session ended, and unsubscribing below still retires this endpoint.
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 401) throw error;
    }
  }
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  }
  localStorage.removeItem("tasks-push-id");
}

export function PushSettings() {
  const [config, setConfig] = useState<Config>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const load = async () => {
    const [nextConfig, nextDevices] = await Promise.all([
      api<Config>("/push/config"),
      api<Device[]>("/push/subscriptions"),
    ]);
    setConfig(nextConfig);
    setDevices(nextDevices);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    // Permission is requested only from the user's button press.
    if ((await Notification.requestPermission()) !== "granted")
      throw new Error(
        "Notifications are blocked. Allow them in browser settings to receive reminders.",
      );
    await navigator.serviceWorker.register("/sw.js");
    const registration = await navigator.serviceWorker.ready;
    const key = config!.vapid_public_key!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")),
      (c) => c.charCodeAt(0),
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      }));
    const data = subscription.toJSON();
    const result = await api<Device>("/push/subscriptions", "POST", {
      kind: "web",
      name: "This browser",
      endpoint: data.endpoint,
      ...data.keys,
    });
    localStorage.setItem("tasks-push-id", result.id);
  };
  return (
    <section className="push-settings">
      <h3>Reminders & notifications</h3>
      <p className="muted">
        Choose a due time and reminder when editing a task. Enable notifications
        on each device that should receive them.
      </p>
      {!supported ? (
        <p className="muted">
          This browser does not expose push notifications. On iPhone, add this
          app to your Home Screen and open it there.
        </p>
      ) : !config?.web_enabled ? (
        <p className="muted">
          Browser push needs to be configured on the server.
        </p>
      ) : (
        <button
          className="secondary"
          disabled={busy || Notification.permission === "denied"}
          onClick={() => perform(enable)}
        >
          Enable on this browser
        </button>
      )}
      {supported && Notification.permission === "denied" && (
        <p className="muted">Notifications are blocked in browser settings.</p>
      )}
      <NotificationPreferences />
      {devices.map((device) => (
        <div className="push-device" key={device.id}>
          <span>
            {device.name} ({device.kind === "web" ? "browser" : "Apple"})
          </span>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                if (device.id === localStorage.getItem("tasks-push-id"))
                  await disableBrowserPush();
                else await api("/push/subscriptions/" + device.id, "DELETE");
              })
            }
          >
            Disable
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
