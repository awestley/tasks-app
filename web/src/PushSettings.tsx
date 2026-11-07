import { useEffect, useState } from "react";
import { api } from "./api";

type Device = { id: string; kind: string; name: string };
type Config = { web_enabled: boolean; vapid_public_key: string | null };

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
    const registration = await navigator.serviceWorker.getRegistration("./");
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
    await navigator.serviceWorker.register("./sw.js");
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
