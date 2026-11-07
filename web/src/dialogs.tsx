// Dialogs: the modal frame, the project editor, keyboard shortcuts, and Settings & integrations.
import React, { useEffect, useRef, useState } from "react";
import {
  Bell,
  Copy,
  KeyRound,
  Keyboard,
  LogOut,
  MonitorSmartphone,
  X,
  CircleAlert,
} from "lucide-react";
import { api, type Profile, type Session, type Token } from "./api";
import { PushSettings } from "./PushSettings";
import { autoReminder, setAutoReminder } from "./reminders";
import { reminderChoices } from "./ui";

export function Modal({
  children,
  close,
  label,
  className = "",
}: {
  children: React.ReactNode;
  close: () => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    if (!ref.current?.contains(document.activeElement))
      ref.current?.querySelector<HTMLElement>("input,button,textarea")?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const controls = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,textarea,select,a[href]",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === controls[0]) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === controls.at(-1)) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      // The hidden field that held the phone keyboard open is not worth returning to.
      if (previous?.id !== "focus-proxy")
        previous?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${className}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={ref}
      >
        {children}
      </div>
    </div>
  );
}

const SWATCHES = [
  "#db4035",
  "#ff9933",
  "#fad000",
  "#7ecc49",
  "#299438",
  "#6accbc",
  "#14aaf5",
  "#2563eb",
  "#884dff",
  "#e05194",
  "#808080",
];
export function ProjectEditor({
  project,
  close,
  save,
  remove,
}: {
  project: { name: string; color: string } | null;
  close: () => void;
  save: (name: string, color: string) => void;
  remove?: () => void;
}) {
  const [name, setName] = useState(project?.name || ""),
    [color, setColor] = useState(project?.color || "#2563eb"),
    [confirm, setConfirm] = useState(false);
  return (
    <Modal close={close} label="Project editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save(name.trim(), color);
        }}
      >
        <div className="modal-heading">
          <h2>{project ? "Edit project" : "New project"}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close project editor"
          >
            <X />
          </button>
        </div>
        <label className="field-label">
          Project name
          <input
            required
            maxLength={100}
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="field-label">
          Project color
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${c.toLowerCase() === color.toLowerCase() ? " is-selected" : ""}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
            <input
              type="color"
              aria-label="Project color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
        </div>
        {confirm && (
          <p className="muted">Tasks in this project will move to Inbox.</p>
        )}
        <div className="modal-actions">
          {remove && (
            <button
              type="button"
              className={`danger-button ${confirm ? "mod-cta" : ""}`}
              onClick={() => (confirm ? remove() : setConfirm(true))}
            >
              {confirm ? "Confirm delete" : "Delete project"}
            </button>
          )}
          <span />
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim()}>
            Save project
          </button>
        </div>
      </form>
    </Modal>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Q", "Add a task"],
  ["A", "Add a task at the end of this list"],
  ["/", "Search"],
  ["J  K  or  ↓  ↑", "Move between tasks"],
  ["Enter", "Open the task"],
  ["C", "Complete"],
  ["E", "Edit"],
  ["T", "Set a date"],
  ["⇧ T", "Remove the date"],
  ["1 – 4", "Priority"],
  ["V", "Move to a project"],
  ["D", "Duplicate"],
  ["⇧ G", "Go to the task's project"],
  ["G then T, I, U, C", "Go to Today, Inbox, Upcoming, Completed"],
  ["M", "Show or hide the sidebar"],
  ["⌘ Z", "Undo"],
  ["Esc", "Close"],
  ["?", "Keyboard shortcuts"],
];
export function ShortcutsDialog({ close }: { close: () => void }) {
  return (
    <Modal close={close} label="Keyboard shortcuts">
      <div className="modal-heading">
        <h2>Keyboard shortcuts</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close shortcuts"
        >
          <X />
        </button>
      </div>
      <p className="muted">
        In quick add: dates like <code>tomorrow 5pm</code>,{" "}
        <code>every monday</code>, <code>Nov 12</code>; <code>p1</code>–
        <code>p4</code>; <code>#Project</code>; <code>@label</code>;{" "}
        <code>!30m before</code>. Click a highlighted word to keep it as text.
      </p>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, label]) => (
          <React.Fragment key={label}>
            <dt>
              {keys.split("  ").map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{label}</dd>
          </React.Fragment>
        ))}
      </dl>
    </Modal>
  );
}

export function SettingsPanel({
  user,
  shell,
  close,
  logout,
  deleteAccount,
  openShortcuts,
}: {
  user: Profile;
  shell: boolean;
  close: () => void;
  logout: () => void;
  deleteAccount: () => void;
  openShortcuts: () => void;
}) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [name, setName] = useState(""),
    [created, setCreated] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(""),
    [auto, setAuto] = useState(autoReminder());
  const load = () => api<Token[]>("/tokens").then(setTokens);
  const loadSessions = () => api<Session[]>("/sessions").then(setSessions);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    if (!shell) loadSessions().catch((e) => setError(e.message));
  }, [shell]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal close={close} label="Settings and integrations">
      <div className="modal-heading">
        <h2>Your workspace</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close settings"
        >
          <X />
        </button>
      </div>
      <div className="profile-card">
        <span className="avatar">{user.name.slice(0, 1)}</span>
        <div>
          <strong>{user.name}</strong>
          <p>{user.email}</p>
        </div>
        {!shell && (
          <button className="secondary" onClick={logout}>
            <LogOut size={14} /> Sign out
          </button>
        )}
      </div>
      <section className="settings-block">
        <div className="settings-title">
          <Bell size={18} />
          <div>
            <h3>Automatic reminders</h3>
            <p>When a task gets a time, remind me:</p>
          </div>
        </div>
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
              {label}
            </option>
          ))}
        </select>
      </section>
      <PushSettings />
      {!shell && (
        <section className="token-group">
          <div className="settings-title">
            <MonitorSmartphone size={18} />
            <div>
              <h3>Signed-in devices</h3>
              <p>End a session on a device you no longer use.</p>
            </div>
          </div>
          {sessions.map((session) => (
            <div className="token-row" key={session.id}>
              <div>
                <strong>
                  {session.current
                    ? "This device"
                    : session.kind === "web"
                      ? "Browser"
                      : "Apple app"}
                </strong>
                <small>
                  Signed in {new Date(session.created_at).toLocaleDateString()}
                </small>
              </div>
              {!session.current && (
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api(`/sessions/${session.id}`, "DELETE");
                      await loadSessions();
                    })
                  }
                >
                  End session
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="token-group">
        <div className="settings-title">
          <KeyRound size={18} />
          <div>
            <h3>API & MCP access</h3>
            <p>Connect your tools with a personal access token.</p>
          </div>
        </div>
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            perform(async () => {
              const result = await api<{ token: string }>("/tokens", "POST", {
                name,
              });
              setCreated(result.token);
              setName("");
              await load();
            });
          }}
        >
          <input
            aria-label="Token name"
            placeholder="Token name, e.g. Desktop AI"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" disabled={busy}>
            Create token
          </button>
        </form>
        {created && (
          <div className="token-created">
            <strong>Copy this token now. It is shown only once.</strong>
            <code>{created}</code>
            <button
              className="secondary"
              onClick={() =>
                navigator.clipboard
                  .writeText(created)
                  .catch(() => setError("Select and copy the token above."))
              }
            >
              <Copy size={13} /> Copy token
            </button>
          </div>
        )}
        {tokens.map((t) => (
          <div className="token-row" key={t.id}>
            <div>
              <strong>{t.name}</strong>
              <small>
                Expires {new Date(t.expires_at).toLocaleDateString()}
              </small>
            </div>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api(`/tokens/${t.id}`, "DELETE");
                  await load();
                })
              }
            >
              Revoke
            </button>
          </div>
        ))}
      </section>
      <div className="integration-note">
        <strong>Connection details</strong>
        <p>
          REST API: <code>{new URL("api/v1", location.href).href}</code>
          <br />
          Use the included MCP adapter with your server URL and a token. Tokens
          expire after 90 days and can be revoked here.
        </p>
      </div>
      <button className="subtle-button shortcuts-link" onClick={openShortcuts}>
        <Keyboard size={15} /> Keyboard shortcuts
      </button>
      {error && (
        <div className="error" role="alert">
          <CircleAlert className="error-icon" size={16} />
          <span>{error}</span>
        </div>
      )}
      <details className="account-delete">
        <summary>Delete account</summary>
        <p>
          Permanently remove your tasks, projects, tokens, and Apple
          authorization. Type DELETE to confirm.
        </p>
        <input
          aria-label="Confirm account deletion"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          className="danger-button mod-cta"
          disabled={confirm !== "DELETE"}
          onClick={deleteAccount}
        >
          Permanently delete my account
        </button>
      </details>
    </Modal>
  );
}
