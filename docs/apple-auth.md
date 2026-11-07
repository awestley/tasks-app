# Sign in with Apple

## Configure your account

1. In Apple Developer, register the iOS and macOS App IDs and enable Sign in with Apple. Replace the placeholder bundle IDs in `apple/project.yml` and regenerate the Xcode project.
2. Group the native App IDs under the same primary App ID. Associate the web Services ID with that primary App ID. This is required for the same Apple account to resolve to a consistent identity across all three clients.
3. Register a Services ID for the website and enable Sign in with Apple. Configure the domain and this exact return URL: `https://YOUR_DOMAIN/auth/apple/callback`.
4. Create a Sign in with Apple private key associated with the primary App ID. Store its `.p8` value in the deployment secret named `APPLE_PRIVATE_KEY`. Never add the key to the repository.
5. Set `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_WEB_CLIENT_ID`, and comma-separated `APPLE_NATIVE_CLIENT_IDS` on the backend. The web ID is the Services ID; native IDs are the bundle identifiers. Set `PUBLIC_URL` to the HTTPS origin with no trailing slash.
6. Set `ALLOWED_APPLE_ACCOUNTS` to the comma-separated Apple accounts that may use this server. Each entry is an Apple subject or a verified email address. Production refuses to start without it, unless the app runs inside the Personal Command shell, where the shell decides who can sign in. Apple's private relay gives a different email address, so prefer the subject if you hide your email: a refused sign-in writes its subject to the application log, ready to copy. Removing an entry stops new sign-ins, while existing sessions and tokens last until they expire or are revoked.
7. Add your signing team in Xcode. Regenerate provisioning profiles after enabling Sign in with Apple. Test a first-time login and returning login on each platform, including Apple's private email relay option.

Web sign-in requires a registered HTTPS domain. The browser-binding cookie is Secure and SameSite=None because Apple sends the callback as a cross-site form POST. The application session is HttpOnly, Secure in production, and SameSite=Lax. Browser mutations additionally require the configured Origin.

## Verification behavior

The backend exchanges the authorization code directly with Apple. It generates a short-lived ES256 client secret, fetches Apple's public keys, and validates the returned ID token's RS256 signature, issuer, audience, expiration, issued-at claim, subject, and nonce. The server-issued challenge is consumed atomically before exchanging the code. Web state is also bound to the originating browser cookie. Native challenges are tied to an allowed bundle ID.

The application issues its own opaque session after verification. Only a SHA-256 hash is stored in the database. Native clients keep the raw session token in Keychain, scoped to the backend origin. API tokens expire after 90 days, sessions after 30 days.

Apple refresh tokens are encrypted with a key derived from `SECRET_KEY`. Account deletion first revokes the stored Apple grant, then deletes account data and credentials. Keep `SECRET_KEY` stable and backed up securely; rotating it requires a planned migration of encrypted Apple refresh tokens. If Apple is unreachable, account deletion reports an error and preserves the account for retry.

The first release has no server-to-server Apple account-change notifications or periodic Apple refresh-token verification. A user's existing local session may remain valid until its 30-day expiry after external revocation at Apple. Add Apple's revocation notifications and session invalidation before release if immediate remote revocation is required.

## Distribution

Local unsigned builds do not constitute an App Store or TestFlight release. Complete the Apple Developer identifiers, provisioning, signing, App Store Connect records, privacy disclosures, screenshots, and review steps for your account. The app includes account deletion in settings. Supply your own privacy policy and support URL before submission.

Official references:

- [Configure Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web)
- [Sign in with Apple REST API](https://developer.apple.com/documentation/signinwithapplerestapi)
- [Generate and validate tokens](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
