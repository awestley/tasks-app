# Apple authentication simulation

Run from the repository root with `postman simulation run postman/simulations/apple-auth/apple-auth.sim.yaml --port 4900 --output ndjson`. The observed member address is `http://localhost:4900/apple`; supply it as `APPLE_SIMULATION_URL` to the API tests.

The mock models `/auth/token`, `/auth/keys`, and `/auth/revoke` from Apple's public contract. It generates ephemeral RSA keys. Authorization codes are base64url fixture JSON carrying a nonce and optional invalid-claim overrides. These codes are only for this local simulation. No real user information or provider credentials are present.

October 26, 2026: the application completed real HTTP token exchanges and JWKS requests against this member. The revocation path was also served. Thirty-two SQLite API tests passed, including ten Apple cases. Replays were rejected by the application before reaching Apple. No simulation members stayed silent.

CLI 1.73.0 required the member path to name `config.yaml`, rather than the mock directory. Use the checked-in file path. The owning provider's mock was not searched in a signed-in Postman workspace; this is a local fixture derived from public documentation. Live Apple setup and signing are still unverified.
