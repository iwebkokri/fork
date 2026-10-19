# Deployment guide (single-host Docker stack)

Everything needed to run FORKSY on one server with Docker: PostgreSQL, the API, the website / admin console / restaurant portal, and automatic HTTPS.
Security requirements are in [SECURITY.md](SECURITY.md) (section 5, the production checklist). Payments setup is in [payments.md](payments.md) and
[integrations.md](integrations.md).

## What runs

| Service | Image | Purpose |
|---|---|---|
| `db` | `postgres:16-alpine` | the database (volume `dbdata`) |
| `migrate` | the API image | **one-shot**: applies pending database migrations, then exits |
| `api` | the API image (`backend/Dockerfile`) | NestJS API + Socket.IO; starts only after `migrate` succeeded. Volumes `uploads`, `private-uploads` |
| `web` | `admin/Dockerfile` (nginx) | static build of the Admin Console (`/`), Restaurant Portal (`/portal`) and customer website (`/order`) |
| `proxy` | `caddy:2-alpine` | optional (`--profile proxy`): automatic Let's Encrypt HTTPS for `APP_DOMAIN` and `API_DOMAIN` |

## First deployment

You need a server with Docker + Docker Compose v2, two DNS names pointing at it (for example `app.example.ca` and `api.example.ca`), and your
Stripe **live** keys.

1. **Get the code** and copy the two environment templates:
   ```bash
   git clone https://github.com/iwebkokri/fork.git && cd fork
   cp deploy/.env.example deploy/.env
   cp backend/.env.production.example backend/.env.production
   ```
2. **Edit `deploy/.env`**: `APP_DOMAIN`, `API_DOMAIN`, and a long random `DB_PASSWORD`.
3. **Edit `backend/.env.production`** and fill in every empty value. The ones the API will not start without:
   - `JWT_SECRET` and `DATA_ENCRYPTION_KEY`: two different random strings of 32+ characters
     (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
   - `PUBLIC_URL`, `WEB_URL`, `CORS_ORIGINS`: the real `https://` URLs (they must match step 2). `CORS_ORIGINS` is a comma separated list; an entry may be a subdomain pattern: `CORS_ORIGINS=https://app.example.ca,https://example.ca,https://*.example.ca` lets the domain and every subdomain call the API (HTTP and Socket.IO). `https://*.example.ca` does not cover `example.ca` itself, so list both. Localhost and a bare `*` are refused in production.
   - `SEED_SUPERADMIN_EMAIL` and a strong, unique `SEED_SUPERADMIN_PASSWORD`.
   - **`STRIPE_SECRET_KEY` (`sk_live_...`), `STRIPE_PUBLISHABLE_KEY` (`pk_live_...`), `STRIPE_WEBHOOK_SECRET`.** The API refuses to start
     without live Stripe keys, so for the *first* start they must be in this file. Later you can manage them on the Integrations page
     (a value saved there wins over the file). Create the webhook endpoint in the Stripe dashboard first; the URL is
     `https://<API_DOMAIN>/api/v1/webhooks/stripe` ([integrations.md](integrations.md) lists the events).
4. **Build and start.** Compose starts `db`, then `migrate` (creates the schema), then `api`, then `web`:
   ```bash
   docker compose --env-file deploy/.env --profile proxy up -d --build
   ```
5. **Create the first Super Admin** (once). This also loads the foundation data (cities, zones, tax classes, commission tiers, cuisines,
   settings). It does **not** create demo restaurants, drivers or customers:
   ```bash
   docker compose --env-file deploy/.env run --rm --no-deps api node dist/database/seed
   ```
6. **Sign in** at `https://<APP_DOMAIN>` with the Super Admin from step 3. Because `ENFORCE_2FA=true`, the sign-in asks you to set up an
   authenticator app first. Then change anything you want under Settings, add your restaurants, and open **System > Integrations** to check
   Stripe (**Test connection**).
7. You can now delete the two `SEED_SUPERADMIN_*` lines from `backend/.env.production`.

Health check: `https://<API_DOMAIN>/api/v1/health` returns 200.

**Optional: automatic verification of drivers and businesses (Certn).** In `backend/.env.production` set `CERTN_API_KEY` and
`CERTN_WEBHOOK_SECRET` (a long random string; the same value goes into the Certn webhook settings), recreate the API
(`docker compose --env-file deploy/.env --profile proxy up -d`) and enter `https://<API_DOMAIN>/api/v1/public/webhooks/certn` as the callback
URL in the Certn dashboard. **System > Verification** then shows *Certn connected* and the Automatic method can be chosen. Until then only instant
registration and manual verification are available. Details: [verification.md](verification.md#certn-setup).

## Database schema and migrations

Production never auto-creates tables: `DB_SYNC=true` is refused. The schema lives in `backend/src/database/migrations/` (the baseline is
`...-InitialSchema.ts`, all tables) and is applied by `node dist/database/migrate`, which is what the `migrate` service runs. It is safe to run
repeatedly and from several machines at once: a Postgres advisory lock lets one runner work, and all pending migrations run in one transaction
(all or nothing). A migration history is kept in the `schema_migrations` table.

If the API is started while migrations are pending it stops with *"the database schema is not up to date"* instead of failing on the first query.
(`DB_MIGRATIONS_RUN=true` applies them when the API connects; leave it off when you run more than one API instance.)

**For developers: changing an entity** (adding or altering a column, table, index, enum) now also needs a migration:

```bash
cd backend
npm run migration:run                                              # your dev DB must be at the current migrations
npm run migration:generate -- src/database/migrations/AddFooToBar  # writes <timestamp>-AddFooToBar.ts from the difference
# read the generated file, then commit it together with the entity change
npm run migration:check                                            # must print "No changes in database schema were found"
```

CI runs `migration:run` on an empty PostgreSQL and then `migration:check`, so a pull request that changes entities without a migration fails.
In development nothing changes: `DB_SYNC=true` (the default outside production) still builds your local tables from the entities, and
`npm run seed` still loads the demo data. Other commands: `npm run migration:show` (what has run), `npm run migration:revert` (undo the last one;
for production prefer a database backup restore).

Two entity-writing rules that keep `migration:check` quiet: do not set `enumName` on enum columns, and write fractional numeric defaults through
`MoneyColumn` / `PctColumn` (they handle it). Both caused endless "differences" while the baseline was created.

## Demo stores on a new site

A site without restaurants can show three demo stores (a supermarket, an Asian market, a halal butcher) so there is something to look at: `docker compose --env-file deploy/.env exec -e DEMO_STORES_PASSWORD='...'
api node dist/database/seed-demo-stores` (the password of their demo owner accounts, at least 12 characters, there is no default), and `... node dist/database/seed-demo-stores --remove` takes them out again.
To fill every delivery zone (Mississauga, Brampton and, with three zones each, Edmonton and Winnipeg) with a few demo restaurants, cafes and stores, run `... node dist/database/seed-demo-locations` the same way
(45 places, one owner account each, `--remove` takes them out; the cities and zones stay).
Details: docs/store-types.md ("Demo data").

## Updating a running system

```bash
git pull
docker compose --env-file deploy/.env --profile proxy up -d --build   # rebuilds, runs pending migrations, restarts api + web
```

Take a database backup before every update that contains a new migration (below).

## Watching the server and the load

Super Admins get a live **System Health** page (**System > System Health**): server CPU / RAM / swap / disk, request rate and response time, database, TLS certificate expiry and
the load-balancing view. Build with `GIT_SHA=$(git rev-parse --short HEAD) docker compose --env-file deploy/.env build` and each instance shows which commit it runs.
Running more than one API instance is **not supported yet** (the page lists the five blockers); see [system-health.md](system-health.md).

## Backups

- **Database:** `docker compose exec db pg_dump -U forksy -Fc forksy > forksy-$(date +%F).dump` (adjust user / database to `deploy/.env`). Store
  copies off the server and test a restore regularly: `pg_restore --clean --if-exists -d forksy file.dump`.
- **Uploaded files:** the `uploads` volume (public images) and `private-uploads` (proof-of-delivery photos; keep per the retention setting).
- **Secrets:** keep a copy of `deploy/.env` and `backend/.env.production` in a password manager. If `DATA_ENCRYPTION_KEY` is lost, the stored
  integration secrets and two-factor seeds cannot be decrypted.

## Refusing to start: what the messages mean

The API checks its own configuration and refuses to boot rather than run insecurely. The message lists every problem. Typical ones: a missing or
short `JWT_SECRET` / `DATA_ENCRYPTION_KEY`; `CORS_ORIGINS` or `PUBLIC_URL` not `https://`; `ENFORCE_2FA` not `true`; a well-known `DB_PASSWORD` or
admin password; Stripe keys missing or not live; demo accounts present in the database; pending migrations. There is deliberately no override flag.

## Alternative: the website on Vercel, the API on a container host

The **API cannot run on Vercel**: it needs WebSockets (Socket.IO: live chat, driver offers, notifications), long-running background timers and cron
jobs (dispatch offer loop, order automation, payouts), a writable disk for uploads, and in-memory state. Vercel's serverless functions keep none
of these. What does work on Vercel is the static website (admin console, restaurant portal and customer website are one React build). So split it:

- **API + PostgreSQL** on something that runs a container or a long-lived Node process: the VPS stack above, or Render / Railway / Fly.io with a
  managed Postgres. Follow the first-deployment steps for `backend/.env.production` and run `node dist/database/migrate` and the seed once.
- **Website** on Vercel, imported from this repository:
  - **Root Directory:** `admin`. **Application Preset:** *Create React App*. Do **not** pick *Services* (it would try to deploy the API as functions).
  - Build command `npm run build` and output directory `build` (the defaults). `admin/vercel.json` adds the catch-all rewrite the single-page apps
    need (`/portal/...`, `/order/...` refreshes) and the security headers nginx sends in the Docker stack.
  - **Environment variables** (Production). They are baked into the build, so changing one needs a redeploy:

    ```
    REACT_APP_API_URL=https://api.example.ca/api/v1
    REACT_APP_WS_URL=https://api.example.ca
    REACT_APP_CSP_CONNECT=https://api.example.ca wss://api.example.ca https://api.stripe.com https://m.stripe.network https://r.stripe.com
    REACT_APP_CSP_IMG=https://api.example.ca https://*.stripe.com
    REACT_APP_CSP_SCRIPT=https://js.stripe.com
    REACT_APP_CSP_FRAME=https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com
    DISABLE_ESLINT_PLUGIN=true
    GENERATE_SOURCEMAP=false
    INLINE_RUNTIME_CHUNK=false
    ```

    `DISABLE_ESLINT_PLUGIN=true` matters: Vercel sets `CI=true`, and Create React App then fails the build on lint warnings.
  - On the API side set `CORS_ORIGINS` and `WEB_URL` to the Vercel address (or your custom domain), `PUBLIC_URL` to the API's own https URL, and
    point the Stripe webhook at the API, not at Vercel.
- Vercel's free **Hobby** plan is for non-commercial use only; a live marketplace needs **Pro**.

## API documentation (Swagger) in production

The interactive API docs (`/docs`) and the OpenAPI file (`/docs-json`) are **off** in production. To read them safely, switch them on and put a
password in front of them at the proxy:

1. Add `SWAGGER_ENABLED=true` to `backend/.env.production` and recreate the API: `docker compose --env-file deploy/.env up -d --force-recreate api`.
2. Create a password hash: `docker compose --env-file deploy/.env exec proxy caddy hash-password --plaintext "a-long-random-password"`.
3. Copy `deploy/caddy.d/docs-auth.caddy.example` to `deploy/caddy.d/docs-auth.caddy` and paste the hash in. That file is git-ignored, so the hash
   never reaches GitHub. (`deploy/Caddyfile` imports every `deploy/caddy.d/*.caddy` file; use more of them for other private proxy settings.)
4. Reload the proxy: `docker compose --env-file deploy/.env exec proxy caddy reload --config /etc/caddy/Caddyfile`.

`/docs` and `/docs-json` then ask for the user name `apidocs` and your password; nothing else changes. To call protected endpoints from the Swagger page,
sign in with `POST /api/v1/auth/login` (and `/auth/2fa/verify`) and paste the access token into **Authorize**.

## What is not covered here

- **One API instance.** Running several would need shared storage for the upload volumes and sticky sessions (or a Socket.IO adapter) for realtime.
  Neither is set up.
- **Volumetric DDoS** is not something the application can stop; put Cloudflare (or similar) in front and set `TRUST_PROXY=2`.
- **Object storage / CDN** for images, malware scanning and managed Postgres with point-in-time recovery are listed as recommendations in
  [SECURITY.md](SECURITY.md).

## What has been verified

On a clean PostgreSQL (plain Node, no Docker): the baseline migration creates all tables and matches the entities exactly (`migration:check`: no
changes); `migrate` is repeatable; the API in `NODE_ENV=production` refuses to start before migrating and starts healthy after migrate + seed with
demo data off (one Super Admin, 4 cities, 9 zones, 0 restaurants, audit-log trigger installed). The Dockerfiles, `docker-compose.yml` and the CI
job were written and syntax-checked but **have not been run end to end**: Docker was not available where this was prepared. The first
`docker compose up` is the real test; send the log if anything fails.
