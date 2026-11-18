# Authentication design

How people sign in to the web, Mac and iPhone apps, and why. [Apple setup](apple-auth.md) covers configuring Apple's side.

## Requirements

- One owner, or a short list of named Apple accounts, per self-hosted server. No public sign-up.
- The same account on web, macOS, iOS and AI tools, with every credential revocable on its own.
- No passwords stored on the server.
- Local development and UI tests work without Apple Developer credentials, and nothing that skips identity checks can reach production.

## Methods

| Method | Clients | Available | Credential issued |
| --- | --- | --- | --- |
| Sign in with Apple, web flow | Browser | When Apple is configured | `web` session in an HttpOnly cookie |
| Sign in with Apple, native flow | Mac, iPhone | When Apple is configured and the app's bundle ID is listed | `native` session, bearer token in Keychain |
| Local workspace | Browser, Debug builds of the apps | `DEV_LOGIN=true`, outside production, from this computer only | `web` or `native` session for one shared local account |
| Personal access token | MCP, scripts, Debug builds | Created in Settings by a signed-in session | `api` token: tasks and projects only |

Sessions last 30 days and tokens 90 days. The server stores only a SHA-256 hash of each. Each is a random 320-bit value, so a fast hash is enough. Signing out deletes the credential row. Settings lists sessions and tokens and can revoke any of them.

## Sign-in screen

Every client shows the same card: the mark, **Sign in**, then only the methods the server offers, from `GET /auth/config`.

```
Web                              Mac and iPhone
──────────────────────────       ──────────────────────────────────────
GET /auth/config                 Server [https://tasks.example.com]
                                 Continue ─► GET {server}/auth/config
[Sign in with Apple]             [Sign in with Apple]      apple_enabled
[Open local workspace]           [Open local workspace]    dev_login, Debug builds
"Apple sign-in is not            "Apple sign-in is not     otherwise
 configured."                     configured."
inline error                     inline error
```

The apps remember the server and check it again when the card appears, so a returning person sees their sign-in options without pressing Continue. Editing the server hides the previous server's options. Errors, including "Your session has ended", appear on the card instead of in an alert.

## Flows

Native Sign in with Apple:

```
App                         Server                             Apple
 │ POST /auth/apple/challenge {client_id}                        │
 │──────────────────────────►│ store challenge id + nonce (10 min) │
 │◄──────────────────────────│                                     │
 │ Apple sheet, nonce ─────────────────────────────────────────────►│
 │◄──────────────────────────────────────────── authorization code │
 │ POST /auth/apple/native {challenge_id, code}                    │
 │──────────────────────────►│ delete challenge (one use)          │
 │                           │ exchange code, verify ID token ────►│
 │                           │ signature, iss, aud, exp, nonce     │
 │                           │ allowlist, create native session    │
 │◄──────── bearer token ────│                                     │
 │ Keychain, scoped to the server origin                           │
```

The web flow is the same, except that the server redirects to Apple, the challenge is also bound to a `__Host-apple_binding` cookie so that nobody can complete a sign-in started in another browser, and the session arrives as a cookie.

Local workspace:

```
Browser: POST /auth/dev          Origin must be the app's own  ─► cookie
App:     POST /auth/dev/native   no Origin header allowed      ─► bearer token
Both:    404 unless DEV_LOGIN=true outside production; 403 unless from this computer
```

## Decisions and trade-offs

**Sign in with Apple stays the only production method.** It relies on the Apple Account's own two-factor protection, works natively on every Apple device, and leaves the server with no password to store, and `ALLOWED_APPLE_ACCOUNTS` limits it to the owner. The cost is a dependency on Apple: production sign-in cannot work until the Apple Developer configuration exists, and if Apple's sign-in service is unavailable, nobody can sign in again, although existing sessions keep working. Passwords were rejected because they add hashing, reset, breach checking and brute-force protection for no gain over Apple for a single owner.

**The server is the authority on what is offered.** Clients render what `/auth/config` reports instead of guessing, so a server without Apple credentials shows a clear note rather than failing on Continue.

**Local sign-in is fenced three ways.** Production refuses to start with `DEV_LOGIN=true`. Outside production, the endpoints answer only requests from a loopback address, and through a proxy only when the proxy reports a loopback client, so a development server bound to a network address cannot hand out sessions to the network. The cookie route requires the app's own Origin, and the native route refuses any request with an Origin header, so no web page can obtain a session, nor read a bearer token. Debug-only buttons in the apps are hygiene, not the control.

**Native local sign-in issues a real session, not a pasted token.** Personal access tokens cannot manage credentials or delete the account, so testing those screens previously required Apple. The token field remains under Local development for pointing a Debug build at another server.

**Cookie hardening.** In production the session cookie is `__Host-tasks_session`, and the binding cookie is always `__Host-apple_binding`. Browsers accept those names only when the cookie is Secure, host-only and path-wide, so a sibling subdomain cannot plant or overwrite them. The session cookie is HttpOnly and SameSite=Lax. Cookie writes also require the configured Origin. Development keeps the plain session name because it runs over HTTP.

## Threats considered

| Threat | Control |
| --- | --- |
| Stolen session from the database | Only hashes stored. Revocation per device. |
| CSRF with the session cookie | SameSite=Lax plus Origin check on every cookie write. |
| Login CSRF, swapping in an attacker's Apple account | State bound to a `__Host-` browser cookie; one-time challenge. |
| Replay of an Apple code or ID token | Challenge deleted atomically before exchange; nonce must match. |
| Someone else's Apple account | `ALLOWED_APPLE_ACCOUNTS`, required in production. |
| Development login exposed | Production refuses it; loopback only; Origin rules above. |
| Cookie injection from a subdomain | `__Host-` prefix in production. |
| Brute force against sign-in routes | 30 requests per minute per client address on `/auth/`. |
| Token theft from the device | Keychain, this device only, after first unlock. |

## What to revisit

- **Passkeys** on the web (and in the apps once associated domains can be configured) as a second phishing-resistant method that does not depend on Apple's service.
- **Idle expiry.** Sessions end after 30 days regardless of use. Recording last use would allow ending idle sessions sooner and showing it in Settings.
- **Apple revocation notifications.** A session survives revocation at Apple until it expires. See [Apple setup](apple-auth.md).
- **Distributed rate limiting.** The limiter is in memory per process, which suits one instance.
- **MCP OAuth.** HTTP MCP uses personal tokens; OAuth discovery would let clients sign in without copying a token.
