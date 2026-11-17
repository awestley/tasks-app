import { useEffect, useState } from "react";
import {
  CircleAlert,
  Copy,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  X,
} from "lucide-react";
import { api, type Profile, type Session, type Token } from "./api";
import { Modal } from "./Modal";
import { PushSettings } from "./PushSettings";

export function SettingsPanel({
  user,
  close,
  logout,
  deleteAccount,
}: {
  user: Profile;
  close: () => void;
  logout: () => void;
  deleteAccount: () => void;
}) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [name, setName] = useState(""),
    [created, setCreated] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState("");
  const load = () => api<Token[]>("/tokens").then(setTokens);
  const loadSessions = () => api<Session[]>("/sessions").then(setSessions);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    loadSessions().catch((e) => setError(e.message));
  }, []);
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
        <button className="secondary" onClick={logout}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
      <PushSettings />
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
          REST API: <code>{location.origin}/api/v1</code>
          <br />
          <a href="/docs" target="_blank" rel="noopener">
            API reference
          </a>
          <br />
          Use the included MCP adapter with your server URL and a token. Tokens
          expire after 90 days and can be revoked here.
        </p>
      </div>
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
