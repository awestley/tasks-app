import { Apple, CircleAlert } from "lucide-react";

export function SignIn({
  config,
  busy,
  error,
  openLocalWorkspace,
}: {
  config: { apple_enabled: boolean; dev_login: boolean };
  busy: boolean;
  error: string;
  openLocalWorkspace: () => void;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-label="Sign in">
        <h1>Sign in</h1>
        <div className="auth-actions">
          {config.apple_enabled && (
            <a className="apple-button" href="/auth/apple/start">
              <Apple size={20} /> Sign in with Apple
            </a>
          )}
          {config.dev_login && (
            <button
              className="primary"
              disabled={busy}
              onClick={openLocalWorkspace}
            >
              {busy ? "Opening..." : "Open local workspace"}
            </button>
          )}
          {!config.apple_enabled && (
            <p className="auth-note">Apple sign-in is not configured.</p>
          )}
          {error && (
            <div className="error" role="alert">
              <CircleAlert className="error-icon" size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
