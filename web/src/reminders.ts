// Reminders on this device. While any view of the app is open (the companion often is, all day),
// reminders fire from here even when the server has no push configured. With push set up, the same
// reminder may also arrive from the server; both use the tag `reminder-<task>-<instant>`
// (api/taskwell/push.py reminder_tag), so the system shows it once.
import { useSyncExternalStore } from "react";
import type { Task } from "./api";
import { api } from "./api";

const AUTO = "tasks.autoReminder";
const FIRED = "tasks.fired";
const MISSED_GRACE = 15 * 60 * 1000;

/** Minutes before the due time for tasks that get a time; null for none. Default: at the due time. */
export function autoReminder(): number | null {
  try {
    const v = localStorage.getItem(AUTO);
    if (v === null) return 0;
    return v === "none" ? null : Number(v);
  } catch {
    return 0;
  }
}
export function setAutoReminder(minutes: number | null) {
  try {
    localStorage.setItem(AUTO, minutes === null ? "none" : String(minutes));
  } catch {
    /* private mode */
  }
}

/** The UTC instant (ms) of a wall time in an IANA zone. */
export function zonedInstant(date: string, time: string, zone: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          hourCycle: "h23",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
        })
          .formatToParts(t)
          .map((p) => [p.type, p.value]),
      );
      return (
        Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - t
      );
    } catch {
      return -new Date(t).getTimezoneOffset() * 60000;
    }
  };
  const first = wall - offset(wall);
  const second = wall - offset(first);
  return Math.min(first, second);
}
export function reminderAt(task: Task): number | null {
  if (task.completed || task.reminder_minutes === null || !task.due_date || !task.due_time)
    return null;
  return (
    zonedInstant(task.due_date, task.due_time, task.time_zone) -
    task.reminder_minutes * 60000
  );
}
export const reminderTag = (task: Task, at: number) => `reminder-${task.id}-${at}`;

/* ---------- permission ---------- */

export type Permission = "granted" | "denied" | "default" | "unsupported";
const permListeners = new Set<() => void>();
const currentPermission = (): Permission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;
let permission = currentPermission();
function updatePermission() {
  const next = currentPermission();
  if (next !== permission) {
    permission = next;
    permListeners.forEach((fn) => fn());
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", updatePermission);
  document.addEventListener("visibilitychange", updatePermission);
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((status) => (status.onchange = updatePermission))
    .catch(() => {});
}
export function usePermission() {
  return useSyncExternalStore(
    (fn) => {
      permListeners.add(fn);
      return () => permListeners.delete(fn);
    },
    () => permission,
  );
}

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (
      (await navigator.serviceWorker.getRegistration("./")) ||
      (await navigator.serviceWorker.register("./sw.js"))
    );
  } catch {
    return null;
  }
}

type PushConfig = { web_enabled: boolean; vapid_public_key: string | null };
/** Subscribe this browser to server push when the server has it configured. Quietly skips otherwise. */
export async function subscribePush() {
  if (!("PushManager" in window)) return false;
  const config = await api<PushConfig>("/push/config").catch(() => null);
  if (!config?.web_enabled || !config.vapid_public_key) return false;
  const reg = await registration();
  if (!reg) return false;
  await navigator.serviceWorker.ready;
  const key = config.vapid_public_key.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
  const subscription =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
  const data = subscription.toJSON();
  const device = await api<{ id: string }>("/push/subscriptions", "POST", {
    kind: "web",
    name: "This browser",
    endpoint: data.endpoint,
    ...data.keys,
  });
  try {
    localStorage.setItem("taskwell-push-id", device.id);
  } catch {
    /* private mode */
  }
  return true;
}

/** Ask for permission (from a button press) and set up push when the server supports it. */
export async function enableNotifications(): Promise<Permission> {
  if (typeof Notification === "undefined") return "unsupported";
  const result = await Notification.requestPermission();
  updatePermission();
  if (result === "granted") {
    await registration();
    await subscribePush().catch(() => false);
  }
  return result;
}

/* ---------- showing ---------- */

export async function showReminder(task: Task, tag: string, body?: string) {
  if (currentPermission() !== "granted") return false;
  const title = task.title.slice(0, 160);
  const options: NotificationOptions & { actions?: { action: string; title: string }[] } = {
    body: body || reminderBody(task),
    tag,
    icon: new URL("icon-192.png", location.href).href,
    data: { task_id: task.id },
    actions: [{ action: "complete", title: "Complete" }],
  };
  const reg = await registration();
  if (reg) {
    await reg.showNotification(title, options);
    return true;
  }
  const { actions: _actions, ...plain } = options;
  const n = new Notification(title, plain);
  n.onclick = () => {
    window.focus();
    n.close();
  };
  return true;
}
function reminderBody(task: Task) {
  if (!task.due_time) return "Task reminder";
  if (task.reminder_minutes === 0) return `Due now · ${task.due_time}`;
  const m = task.reminder_minutes || 0;
  const lead = m >= 1440 ? `${Math.round(m / 1440)} day` : m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`;
  return `Due in ${lead} · ${task.due_time}`;
}

/** Claim a reminder for this browser, so only one open view announces it. */
function claim(tag: string) {
  try {
    const fired: Record<string, number> = JSON.parse(localStorage.getItem(FIRED) || "{}");
    if (fired[tag]) return false;
    const cutoff = Date.now() - 3 * 86400000;
    for (const k of Object.keys(fired)) if (fired[k] < cutoff) delete fired[k];
    fired[tag] = Date.now();
    localStorage.setItem(FIRED, JSON.stringify(fired));
    return true;
  } catch {
    return true;
  }
}

/**
 * Keep timers for the reminders coming up. `announce` also shows it inside the app (the shell's
 * notice, or the app's toast). Returns a function that stops the schedule.
 */
export function scheduleReminders(
  tasks: Task[],
  announce: (task: Task) => void,
): () => void {
  const now = Date.now();
  const upcoming = tasks
    .map((task) => ({ task, at: reminderAt(task) }))
    .filter((r): r is { task: Task; at: number } => r.at !== null && r.at > now - MISSED_GRACE)
    .sort((a, b) => a.at - b.at);
  const fire = () => {
    const t = Date.now();
    for (const r of upcoming) {
      if (r.at > t) break;
      if (r.at < t - MISSED_GRACE) continue;
      const tag = reminderTag(r.task, r.at);
      if (!claim(tag)) continue;
      announce(r.task);
      showReminder(r.task, tag).catch(() => {});
    }
  };
  fire();
  const next = upcoming.find((r) => r.at > Date.now());
  // Timers drift while a laptop sleeps; check every minute as well.
  const timer = next
    ? setTimeout(fire, Math.min(next.at - Date.now() + 50, 2 ** 31 - 1))
    : undefined;
  const tick = setInterval(fire, 60000);
  return () => {
    clearTimeout(timer);
    clearInterval(tick);
  };
}
