# DigitalOcean deployment

## Inputs still needed

- Intended DigitalOcean account/team, region, and either App Platform or a Droplet.
- A GitHub repository containing this source, if using App Platform.
- The production domain and DNS access.
- Apple Developer Team ID, key ID, private key, web Services ID, and grouped native bundle IDs.
- The Apple accounts allowed to sign in, for `ALLOWED_APPLE_ACCOUNTS`, unless the app runs inside the Personal Command shell. See [Apple setup](apple-auth.md).

`doctl` may have multiple saved contexts. Select the intended context explicitly; do not assume the current account is the right one. No deployment or resource creation has been performed.

## Option A: App Platform

1. Push the source to your repository.
2. Create a production Managed PostgreSQL cluster named `taskwell-db` in the intended region. Create the database and user named `taskwell`, or update the spec to match existing names. Enable backups and restrict trusted sources to the application.
3. Update `.do/app.yaml`: repository, branch, region, cluster name, public URL, and Apple identifiers. Add your custom domain in App Platform. Both the service and migration job must use the same source revision.
4. Set `SECRET_KEY` and `APPLE_PRIVATE_KEY` as encrypted App Platform secrets. Replace the template values in the deployment form or a private copy of the spec. Do not commit secrets. Generate a strong secret with `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`.
5. Validate the template schema with `doctl apps spec validate .do/app.yaml --schema-only`. After replacing placeholders, validate against your selected account and create the app through App Platform or `doctl apps create --spec PRIVATE_SPEC_PATH`.
6. The PRE_DEPLOY job runs `alembic upgrade head`. The application does not auto-create tables in production. Deploying multiple instances is safe for credential consumption and task version checks because those operations are atomic in PostgreSQL.
7. Configure DNS and verify HTTPS before enabling Apple's return URL. Check `/health`, sign in, create a task on one client and read it from another, and verify token revocation through MCP.

The service uses one application process per container and a per-process sign-in rate limiter. Add edge rate limiting or a shared limiter before scaling to multiple instances. `CLIENT_IP_HEADER` tells the limiter which header holds the client address. The spec sets [`do-connecting-ip`](https://docs.digitalocean.com/support/where-can-i-find-the-client-ip-address-of-a-request-connecting-to-my-app); after deploying, confirm in your logs or with a test request that it holds the real client address, because without it every client shares one limit. `TASKWELL_API_URL` inside the container points to its own loopback API for HTTP MCP tool calls. The platform terminates TLS.

## Option B: Ubuntu Droplet with Docker

Provision a supported Ubuntu Droplet with Docker Compose and point your domain's A/AAAA records at it. Copy the repository to the server. Allow ports 80/443, and restrict SSH to your administration sources. PostgreSQL is not exposed to the internet by the Compose configuration.

```sh
cp .env.example .env
# Edit .env with the real domain, strong secrets, and Apple configuration.
docker compose up -d --build
```

The migration service must succeed before the app starts. Caddy obtains HTTPS certificates and proxies to the app, which trusts the client address Caddy reports (`CLIENT_IP_HEADER` in `compose.yaml`). Do not publish the app's port directly, since a client could then choose its own address. PostgreSQL and Caddy data are persisted in named volumes. Use an alphanumeric database password in the template URL, or percent-encode special characters in a custom `DATABASE_URL`.

```sh
docker compose logs --tail=100 app migrate caddy
curl https://YOUR_DOMAIN/health
```

Set up database backups to separate storage and test restoration. Before updating, make a backup, build the new image, run migrations once, then replace the application. Keep old images available for rollback; do not downgrade a database migration without checking compatibility. Never run `docker compose down -v` on production unless you intend to erase the database.

## Operational behavior

- `/health` checks database connectivity. Configure uptime monitoring against the deployed HTTPS endpoint.
- The API description (`/docs`, `/redoc`, `/openapi.json`) is not served in production.
- The API process removes expired sessions, tokens and sign-in challenges every hour, along with reminder delivery records older than 30 days.
- Request bodies are limited to 100 KB, including chunked requests. Fingerprinted files in `/assets/` are cached permanently, and everything else served to browsers revalidates, so a deploy reaches open and returning browsers without blank pages.
- API and auth responses use `Cache-Control: no-store`. Web sessions are HttpOnly and Secure in production.
- Personal access tokens and sessions are revocable database credentials. Keep the database connection string, Apple key and secret key private.
- The `.env` files, database files, build caches, and native signing material are excluded from Git and Docker build context.
- Use a single custom public origin. Update `PUBLIC_URL`, Apple return URLs, native connection settings, and MCP configuration together when changing domains.
- API schema changes belong in a new Alembic revision. The initial migration is immutable once deployed.

References: [DigitalOcean App Platform specification](https://docs.digitalocean.com/products/app-platform/reference/app-spec/), [container deployments](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/).

## Reminders and push

Configure the optional VAPID and APNs environment variables listed in [reminder setup](reminders.md) on the API service. Keep their private keys in encrypted environment variables. The API process runs the durable reminder loop every 15 seconds when a provider is configured. Migrate through revision 0003 before deploying this version.
