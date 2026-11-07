import { useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Undo2,
  X,
} from "lucide-react";
import { findShortRefs } from "@awestley/pc-runtime";
import { PcEmbed, usePc } from "@awestley/pc-runtime/react";
import { api, type Task } from "./api";
import {
  enableNotifications,
  reminderAt,
  showReminder,
  usePermission,
  autoReminder,
  setAutoReminder,
} from "./reminders";
import { Popover, reminderChoices, daysFromNow, weekday } from "./ui";

export type Toast = {
  id: number;
  text: string;
  undo?: () => void;
  error?: boolean;
};
// Which app owns each short reference type ([[note:…]], ![[task:…]]) in task descriptions.
const TYPE_OWNERS = { task: "tasks", project: "tasks", note: "notes" };

export function ToastView({
  toast,
  close,
  compact,
  top,
}: {
  toast: Toast;
  close: () => void;
  compact?: boolean;
  /** At the top of the screen, clear of a sheet on the keyboard. */
  top?: boolean;
}) {
  return (
    <div
      className={`toast ${toast.error ? "is-error" : ""} ${compact ? "is-compact" : ""} ${top ? "is-top" : ""}`}
      role="status"
      key={toast.id}
    >
      {toast.error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
      <span>{toast.text}</span>
      {toast.undo && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.undo!();
            close();
          }}
        >
          <Undo2 size={14} /> Undo
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={close}>
        <X size={13} />
      </button>
    </div>
  );
}

export function WeekStrip({
  tasks,
  jump,
}: {
  tasks: Task[];
  jump: (date: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => daysFromNow(i));
  return (
    <div className="week-strip" role="navigation" aria-label="This week">
      {days.map((d, i) => {
        const n = tasks.filter((t) => t.due_date === d).length;
        return (
          <button
            key={d}
            className={i === 0 ? "is-today" : ""}
            onClick={() => jump(d)}
          >
            <small>{weekday(d)}</small>
            <strong>{Number(d.slice(8))}</strong>
            <span className="week-dots" aria-label={`${n} tasks`}>
              {Array.from({ length: Math.min(n, 3) }, (_, k) => (
                <i key={k} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function BellPanel({
  anchor,
  close,
  tasks,
  hosted,
}: {
  anchor: DOMRect;
  close: () => void;
  tasks: Task[];
  hosted: boolean;
}) {
  const permission = usePermission();
  const [auto, setAuto] = useState(autoReminder());
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ web_enabled: boolean }>("/push/config")
      .then((c) => setPush(c.web_enabled))
      .catch(() => setPush(false));
  }, []);
  const upcoming = tasks
    .map((t) => ({ t, at: reminderAt(t) }))
    .filter(
      (r): r is { t: Task; at: number } => r.at !== null && r.at > Date.now(),
    )
    .sort((a, b) => a.at - b.at)
    .slice(0, 4);
  return (
    <Popover anchor={anchor} close={close} label="Reminders" width={320}>
      <div className="bell-panel">
        <div className="bell-head">
          {permission === "granted" ? (
            <BellRing size={18} className="tone-green" />
          ) : (
            <BellOff size={18} />
          )}
          <div>
            <strong>Reminders</strong>
            <p>
              {permission === "granted"
                ? "On for this browser."
                : permission === "denied"
                  ? "Blocked. Allow notifications for this site in your browser settings."
                  : permission === "unsupported"
                    ? "This browser can't show notifications."
                    : "Get a notification when a task is due."}
            </p>
          </div>
        </div>
        {permission === "default" && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await enableNotifications().catch(() => "default");
              setBusy(false);
            }}
          >
            <Bell size={15} /> Turn on notifications
          </button>
        )}
        <label className="bell-field">
          <span>When a task has a time, remind me</span>
          <select
            aria-label="Automatic reminder"
            value={auto ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              setAuto(v);
              setAutoReminder(v);
            }}
          >
            <option value="">Never</option>
            {reminderChoices.map(([m, label]) => (
              <option key={m} value={m}>
                {label.replace("At due time", "At the time")}
              </option>
            ))}
          </select>
        </label>
        {upcoming.length > 0 && (
          <div className="bell-upcoming">
            <small>Coming up</small>
            {upcoming.map(({ t, at }) => (
              <div key={t.id}>
                <span>{t.title}</span>
                <time>
                  {new Date(at).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            ))}
          </div>
        )}
        <p className="bell-note">
          {push
            ? "Push is set up, so reminders also arrive when Tasks is closed."
            : hosted
              ? "Reminders fire while Personal Command is open (the companion counts). Set up push in Tasks settings to get them when it's closed."
              : "Reminders fire while Tasks is open. Set up push in Settings to get them when it's closed."}
        </p>
        {permission === "granted" && (
          <button
            className="secondary"
            onClick={() =>
              showReminder(
                {
                  ...(upcoming[0]?.t ||
                    ({ id: "test", title: "Test reminder" } as Task)),
                  title: upcoming[0]?.t.title || "Test reminder",
                },
                "test-" + Date.now(),
                "This is how reminders look.",
              )
            }
          >
            Send a test notification
          </button>
        )}
      </div>
    </Popover>
  );
}

// Notes, tasks and projects a description links to ([[note:id]]) or embeds (![[note:id]]).
export function Linked({ text }: { text: string }) {
  const pc = usePc();
  const refs = findShortRefs(text, TYPE_OWNERS);
  if (!refs.length) return null;
  return (
    <section className="linked-items" aria-label="Linked items">
      <h3>Linked</h3>
      {refs.map((r, i) =>
        r.embed ? (
          <PcEmbed key={i} target={r.ref} size="card">
            {r.label || r.ref}
          </PcEmbed>
        ) : (
          <button
            key={i}
            className="linked-link"
            onClick={() => pc.open(r.ref, { placement: "new-column" })}
          >
            {r.label || r.ref.replace(/^pc:\/\/[^/]+\//, "")}
          </button>
        ),
      )}
    </section>
  );
}
