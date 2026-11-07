import { useState } from "react";
import { Apple, Check, CircleAlert, RefreshCw } from "lucide-react";
import { api } from "./api";
import * as S from "./store";

export function Logo() {
  return (
    <div className="brand" aria-hidden="true">
      <span className="brand-mark">
        <Check size={21} strokeWidth={3} />
      </span>
    </div>
  );
}

export function SignIn({ hosted }: { hosted: boolean }) {
  const config = S.useStore((s) => s.config);
  const bootError = S.useStore((s) => s.bootError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shell = config.shell || hosted;
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-label="Sign in">
        <Logo />
        <h1>Sign in</h1>
        <div className="auth-actions">
          {shell && (
            <a
              className="primary"
              target="_top"
              href={
                "/login?next=" +
                encodeURIComponent(location.pathname + location.hash)
              }
            >
              Sign in
            </a>
          )}
          {config.apple_enabled && (
            <a className="apple-button" href="auth/apple/start">
              <Apple size={20} /> Sign in with Apple
            </a>
          )}
          {config.dev_login && (
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/auth/dev", "POST");
                  await S.signedIn();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Opening..." : "Open local workspace"}
            </button>
          )}
          {!config.apple_enabled && !shell && !config.dev_login && (
            <p className="auth-note">Apple sign-in is not configured.</p>
          )}
          {(error || bootError) && (
            <div className="error" role="alert">
              <CircleAlert className="error-icon" size={16} />
              <span>{error || bootError}</span>
            </div>
          )}
          {bootError && !error && (
            <button className="secondary" onClick={() => location.reload()}>
              <RefreshCw size={14} /> Try again
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
