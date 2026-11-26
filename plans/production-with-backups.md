# Plan: Production deployment over HTTPS (slice 8)

Spec: [`mvp-slices.md`, section 8](mvp-slices.md#8-production-with-backups).

## Goal

Run the full application (nginx with Certbot HTTPS, frontend SPA, NestJS backend, extraction worker, and Postgres) on a VPS via Docker Compose so restaurant staff can sign in and upload documents over HTTPS from their phones, manage accounts on the server, and verify every deploy with a post-deploy smoke script.

## Out of scope

- **Nightly backups, restore script, and restore drill:** Deferred out of the MVP by explicit user decision (see *Decisions & Deviations* below). Will be planned in a dedicated follow-up slice once the app is running optimally in production.
- Monitoring, metrics, and alerting (`mvp-slices.md` slice 8 Out).
- Multi-tenancy (`one-way-doors.md`, postponed on purpose).
- Changes to the database schema, domain logic, API routes, or frontend screens.
- Live VPS provisioning, DNS setup, or real Let's Encrypt certificate issuance during implementation/CI (performed manually by the operator on the VPS using the scripts and runbook produced here).
- `memory.md`: this slice fixes no review findings.

## Decisions & Deviations

Deviations from existing design/specs:

- **Backups and restore deferred out of MVP (`system-design.md` Operations, `plans/mvp-slices.md` slice 8 & open question 16):** Per the user's explicit decision ("dejar fuera del mvp los backups. Simplifica mucho todo. Voy a dejar el producto funcionando de manera optima y luego planifico"), nightly `pg_dump` + `UPLOAD_DIR` off-VPS backups, the restore script, acceptance item #3, and the restore drill test are excluded from this slice. `plans/mvp-slices.md` and `system-design.md` will be updated in Step 1 to record this decision and close open question 16 as deferred.

Non-obvious architectural and operational decisions within the existing design:

1. **Separate `docker-compose.prod.yml` and `.env.production.example` (keep `docker-compose.yml` untouched for local dev/tests).** `docker-compose.yml` publishes Postgres on `127.0.0.1:5432` with local dev credentials (`facturas`/`facturas`) that `backend` Vitest suites depend on. Production gets its own `docker-compose.prod.yml` and `.env.production.example` template with required credentials, no published DB or backend host ports, and log rotation (`max-size: 10m`, `max-file: 3`).
2. **Zero new `@Public()` routes (`agents.md`, `backend/test/routes.spec.ts`).** Instead of adding an unauthenticated `/api/health` route, the `backend` container healthcheck requests `http://127.0.0.1:3000/api/auth/me` and succeeds only on HTTP `401` — proving both that NestJS is listening and that the global `SessionGuard` is active.
3. **Safe HTTP-only bootstrap before the first Certbot certificate exists.** On a fresh VPS, Let's Encrypt certificates do not exist yet, so nginx cannot boot directly into an HTTPS config. `nginx/entrypoint.sh` renders `http-only.conf.template` when the certificate files are absent — serving **only** `/.well-known/acme-challenge/` on port 80 and returning `503` for every other path so login credentials and `/api` are never exposed over plain HTTP. Once Certbot issues the cert (via `deploy/init-cert.sh`), restarting nginx switches it to `https.conf.template` (port 80 redirects to `https://${APP_DOMAIN}$request_uri` using the configured domain rather than `$host` to prevent open-redirect header injection; port 443 serves TLS 1.2/1.3, HSTS, security headers, the built frontend SPA, and `/api/` proxy).
4. **Automatic certificate renewal reload without Docker socket access.** The `certbot` service runs `certbot renew --webroot -w /var/www/certbot --quiet` every 12 hours, and `nginx/entrypoint.sh` runs a lightweight background loop issuing `nginx -s reload` every 6 hours while in HTTPS mode. Neither container mounts `/var/run/docker.sock`.
5. **Frontend built inside `nginx/Dockerfile` (multi-stage).** Stage 1 builds `frontend/` with `node:24-slim` (`npm ci && npm run build`) and Stage 2 copies `frontend/dist` into `nginx:1.27-alpine`. This avoids shared-volume asset races during deploys and keeps Node out of the nginx runtime image.
6. **Backend + worker share one compiled `runtime` image (`backend/Dockerfile`), running as non-root `node` (UID/GID 1000:1000).** `ImageStore.write` writes uploaded photos with mode `0600`, so `backend` and `worker` must run as the same UID/GID and share the `uploads-data` volume at `/data/uploads` (created `chown node:node` and `chmod 0700` in the image). `nginx` never mounts `uploads-data` and additionally returns `404` for `/uploads/`.
7. **Strict environment isolation across containers (`system-design.md` Extraction).** `backend` receives `DATABASE_URL`, `JWT_SECRET`, `UPLOAD_DIR`, and `NODE_ENV=production` — never `ANTHROPIC_API_KEY`, `LLM_MODEL`, or `RESTAURANT_CUIT`. `worker` receives `DATABASE_URL`, `UPLOAD_DIR`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `RESTAURANT_CUIT`, and `NODE_ENV=production` — never `JWT_SECRET`. `migrate` (Compose `profiles: ["ops"]`, built from the `migrator` target of `backend/Dockerfile`) receives only `DATABASE_URL` and runs `npx prisma migrate deploy` explicitly on deploy rather than implicitly on container start.
8. **Compiled user-management CLI for the production container.** `backend/scripts/users.ts` currently runs via `tsx` (a `devDependency` pruned from the production `runtime` image). Extracting its body into `backend/src/users/users-cli.ts` with entry point `backend/src/users-cli.ts` lets `nest build` compile `dist/users-cli.js`, while `backend/scripts/users.ts` stays a thin wrapper so local `npm run user:*` and `scripts/users.spec.ts` stay unchanged. In production, `docker compose -f docker-compose.prod.yml --env-file .env.production exec backend npm run user:create:prod -- ...` runs on plain `node` with zero devDependencies.
9. **Upload size limit and login rate limiting in nginx.** Nginx sets `client_max_body_size 1m` globally and `client_max_body_size 75m` (10 pages × 7 MB + multipart overhead, matching `MAX_PAGES` and `MAX_PHOTO_BYTES` in `backend/src/uploads/photo.ts`) specifically on `location = /api/uploads`. `location = /api/auth/login` adds a light per-IP rate limit (`10r/m`, `burst=10 nodelay`, returning `429`) complementing the backend's per-email `LoginAttempts` limiter without blocking staff sharing restaurant Wi-Fi.
10. **Non-destructive post-deploy smoke script + isolated local stack verifier.** `deploy/smoke.sh` is safe to run against live production after every deploy (read-only checks only; creates zero documents/uploads and triggers zero LLM calls). `deploy/verify-stack.sh` exercises the full Docker Compose production stack locally in an isolated Compose project (`-p facturas-prod-verify`) on unprivileged ports (`18080`/`18443`) using a temporary self-signed cert, `RESTAURANT_TEST_CUIT` (`30000000112`), and a dummy `ANTHROPIC_API_KEY`, stopping `worker` before testing photo upload so zero network requests ever leave the machine.

## Interface

### Backend code & npm scripts (`backend/`)

- `backend/src/main.ts`: calls `app.enableShutdownHooks()` so `SIGTERM`/`SIGINT` shuts down HTTP and Prisma cleanly.
- `backend/src/users/users-cli.ts`: exports `runUsersCli(argv: string[]): Promise<number>` (extracted verbatim from `backend/scripts/users.ts`).
- `backend/src/users-cli.ts`: compiled CLI entry point (`process.exitCode = await runUsersCli(process.argv.slice(2));`), built by `npm run build` into `dist/users-cli.js`.
- `backend/scripts/users.ts`: thin wrapper calling `runUsersCli(process.argv.slice(2))` (preserves `npm run user:*` and `scripts/users.spec.ts`).
- `backend/package.json` scripts added:
  - `user:create:prod`: `node dist/users-cli.js create`
  - `user:reset-password:prod`: `node dist/users-cli.js reset-password`
  - `user:disable:prod`: `node dist/users-cli.js disable`

### Containerization & reverse proxy

- `.dockerignore`: excludes `.git`, `samples`, `.env`, `.env.*` (except `*.example`), `**/node_modules`, `**/dist`, `**/build`, `**/coverage`, `**/*.tsbuildinfo`, `plans`, `design`, temp/log files.
- `backend/Dockerfile`: multi-stage (`builder`, `migrator`, `prod-deps`, `runtime`) on `node:24-slim`.
- `nginx/Dockerfile`: multi-stage (`frontend-build` on `node:24-slim`, `runtime` on `nginx:1.27-alpine`).
- `nginx/entrypoint.sh`: validates `APP_DOMAIN`, selects `https.conf.template` or `http-only.conf.template` based on cert presence, runs `nginx -t`, runs 6-hour reload loop in HTTPS mode, and handles `SIGTERM`/`SIGINT`.
- `nginx/templates/http-only.conf.template` & `nginx/templates/https.conf.template`.
- `nginx/snippets/security-headers.conf` & `nginx/snippets/proxy-params.conf`.
- `.env.production.example`: template for `APP_DOMAIN`, `CERTBOT_EMAIL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `RESTAURANT_CUIT`.
- `docker-compose.prod.yml`: services `db`, `migrate` (`profiles: ["ops"]`), `backend`, `worker`, `nginx`, `certbot`; named volumes `db-data`, `uploads-data`, `certbot-www`, `certbot-conf`; host ports `${HTTP_PORT:-80}:80` and `${HTTPS_PORT:-443}:443` on `nginx` only.

### Operational & verification scripts (`deploy/`)

- `deploy/init-cert.sh [--env-file <path>] [--staging]`: issues the first Let's Encrypt certificate via Certbot HTTP-01 webroot, restarts `nginx` into HTTPS mode, and starts `certbot` for automatic renewals.
- `deploy/smoke.sh --domain <domain> [--http-port 80] [--https-port 443] [--insecure] [--email <email>]`: post-deploy read-only verification script (reads password from `SMOKE_PASSWORD` or stdin when `--email` is given; never prints secrets; `--insecure` is off by default and only for local self-signed certs).
- `deploy/verify-stack.sh`: local end-to-end Docker Compose verification harness (isolated project name, self-signed cert, unprivileged ports, zero external calls, full cleanup on exit).

## Behaviors to test

1. **User CLI parity (`backend/scripts/users.spec.ts` + compiled CLI inside `backend` container):**
   - Existing `users.spec.ts` suite passes unchanged after extracting `src/users/users-cli.ts`.
   - Inside the built production `backend` container (with no `devDependencies`/`tsx`), `npm run user:create:prod`, `npm run user:reset-password:prod`, and `npm run user:disable:prod` create a user, reset password (revoking prior session cookies), and disable the user (revoking prior session cookies), without printing passwords.
2. **HTTP-only bootstrap safety (`deploy/verify-stack.sh`):**
   - When no certificate exists in `certbot-conf`, `nginx` starts without crashing, serves files placed under `/.well-known/acme-challenge/`, and returns `503` on `/` and `/api/auth/login` (never serves the app or accepts credentials over plain HTTP).
3. **HTTPS, HTTP→HTTPS redirect, SPA routing, and security headers (`deploy/smoke.sh` via `deploy/verify-stack.sh`):**
   - `GET http://<domain>/...` returns `301` with `Location: https://<domain>/...` (even when a forged `Host` header is sent, `Location` uses `${APP_DOMAIN}`).
   - `GET https://<domain>/` and SPA deep links (e.g., `/a-resolver`) return `200` `text/html` with `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy`.
   - Built `/assets/*` files are served with `Cache-Control: public, immutable`, while `/index.html` is served with `Cache-Control: no-cache`.
4. **Authentication and cookie flags over HTTPS (`deploy/smoke.sh` + `backend/test/routes.spec.ts`):**
   - Every route except `POST /api/auth/login` returns `401` without a session (`routes.spec.ts` and live HTTP checks against `/api/auth/me`, `/api/suppliers`, `/api/images/:id`).
   - `POST /api/auth/login` over HTTPS returns `200` and sets `session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/api`.
   - `GET /api/auth/me` and `GET /api/suppliers` return `200` with the session cookie; `POST /api/auth/logout` returns `204`.
5. **Upload, authenticated image access, and non-static image isolation (`deploy/verify-stack.sh`):**
   - With `worker` stopped (preventing any LLM call), uploading a generated valid photo via HTTPS `POST /api/uploads` (with `X-Requested-With: XMLHttpRequest` and session cookie) returns `201`.
   - `GET /api/images/:id` with the session cookie returns `200` with exact byte parity, `Cache-Control: private, no-store`, and `sandbox` CSP; without a cookie it returns `401`.
   - Requesting `/uploads/<storage_key>` returns `404`, and requesting `/<storage_key>` never returns `image/*` or the photo bytes.
6. **Container & secret isolation (`deploy/verify-stack.sh`):**
   - `backend` starts and passes its healthcheck without `ANTHROPIC_API_KEY`, `LLM_MODEL`, or `RESTAURANT_CUIT` in its environment.
   - `worker` starts, passes `ExtractionConfig`, connects to Postgres, and stays running on an empty queue without `JWT_SECRET` in its environment (and makes zero external calls).
   - Both `backend` and `worker` run as non-root `node` with the same UID/GID and read/write `/data/uploads`; `nginx` has no `/data/uploads` mount.
   - `db` and `backend` publish no host ports.
   - Built images contain neither `samples/` nor `.env` files.
7. **Repo hygiene & existing test suites:**
   - `backend`: `npm run lint` (including `check:cuits` scanning all new Dockerfiles, nginx templates, Compose files, and shell scripts), `npm run typecheck`, `npm test`, and `npm run build` all pass.
   - `frontend`: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` all pass.
   - Local `docker-compose.yml` (`docker compose up -d db`) remains functional for `backend` Vitest suites.

## Steps

One commit per step. "All checks" means `npm run lint`, `npm run typecheck`, and `npm test` in the touched app(s).

1. **Update design and slice docs for deferred backups**
   - Update `plans/mvp-slices.md` (section 8 *Goal*, *Rules*, *Acceptance*, *Tests*, *Out*, *Doors*, and *Open questions* #16) to record that backups and restore are deferred out of the MVP by user decision.
   - Update `system-design.md` (*Operations* and *Out of scope*) to reflect that automated off-VPS backups are deferred out of the MVP.
   - Verify: `backend` `npm run check:cuits` passes.

2. **Prepare backend for production runtime (`SIGTERM` hooks + compiled users CLI)**
   - Add `app.enableShutdownHooks()` to `backend/src/main.ts`.
   - Extract `backend/scripts/users.ts` logic into `backend/src/users/users-cli.ts` (`runUsersCli`), add compiled entry `backend/src/users-cli.ts`, reduce `backend/scripts/users.ts` to a thin wrapper, and add `user:create:prod`, `user:reset-password:prod`, and `user:disable:prod` scripts to `backend/package.json`.
   - Verify: `backend` all checks + `npm run build` pass, and `dist/users-cli.js` is emitted.

3. **Add `.dockerignore`, `backend/Dockerfile`, and `nginx/` reverse proxy image & templates**
   - Add root `.dockerignore` excluding `samples/`, `.env*`, `.git`, build artifacts, and `node_modules/`.
   - Add `backend/Dockerfile` (`builder`, `migrator`, `prod-deps`, `runtime` stages on `node:24-slim`, non-root `USER node`, `/data/uploads` owned by `node:node` mode `0700`).
   - Add `nginx/Dockerfile` (`frontend-build` + `nginx:1.27-alpine`), `nginx/entrypoint.sh`, `nginx/snippets/security-headers.conf`, `nginx/snippets/proxy-params.conf`, `nginx/templates/http-only.conf.template`, and `nginx/templates/https.conf.template`.
   - Verify: `docker build` succeeds for both `backend/Dockerfile` (`runtime` and `migrator` targets) and `nginx/Dockerfile`; `backend` `npm run check:cuits` passes.

4. **Add `docker-compose.prod.yml` and `.env.production.example`**
   - Add `.env.production.example` with every production variable documented and no real secrets or CUITs.
   - Add `docker-compose.prod.yml` defining `db`, `migrate` (`profiles: ["ops"]`), `backend`, `worker`, `nginx`, and `certbot` with strict secret/volume/port separation, log rotation, and `backend` healthcheck (`401` on `/api/auth/me`).
   - Verify: `docker compose -f docker-compose.prod.yml --env-file .env.production.example config` (with placeholder env vars for required fields) validates cleanly; `docker-compose.yml` is unchanged; `backend` `npm run check:cuits` passes.

5. **Add `deploy/init-cert.sh`, `deploy/smoke.sh`, `deploy/verify-stack.sh`, and update `README.md`**
   - Add `deploy/init-cert.sh` (first-time Certbot issuance + nginx switch to HTTPS + starting `certbot`, with optional `--staging`).
   - Add `deploy/smoke.sh` (read-only post-deploy smoke script safe for production).
   - Add `deploy/verify-stack.sh` (local end-to-end Docker Compose verification harness with self-signed TLS, `RESTAURANT_TEST_CUIT`, dummy `ANTHROPIC_API_KEY`, stopped worker during upload test, and guaranteed `down -v` cleanup).
   - Update `README.md` (`## Deployment`) with exact production deployment, migration, Certbot bootstrap, server user-management, and smoke-test instructions, plus an explicit warning that off-VPS backups are not yet configured (do not run `down -v` in production).
   - Verify: run `./deploy/verify-stack.sh` to green, and run `backend` and `frontend` all checks + builds.

## Doors

No **`one-way (execution-time)`** doors: implementation and verification run strictly locally using an isolated Docker Compose project (`-p facturas-prod-verify`), a local self-signed certificate, `RESTAURANT_TEST_CUIT`, and a dummy `ANTHROPIC_API_KEY` (with `worker` stopped before any test upload is queued). Nothing hits Let's Encrypt, Anthropic, a VPS, or any non-test database during implementation or tests. (Running `deploy/init-cert.sh` or deploying to the real VPS happens only after human review and merge.)

| Part | Door | Note |
| --- | --- | --- |
| Production reverse proxy, TLS/Certbot config, Docker Compose exposure, and first live deployment (`nginx/`, `docker-compose.prod.yml`, `deploy/init-cert.sh`, `backend/Dockerfile`, `.dockerignore`) | **One-way (merge-time)** | Listed in `one-way-doors.md` ("Authentication and access to documents and images") and `plans/mvp-slices.md` ("authentication exposed to the internet, and the first real data. From here on, migrations run on real data"). **Blast radius:** once deployed to the VPS with real financial records, a misconfigured nginx location, static mount of `UPLOAD_DIR`, plain-HTTP exposure of login/API, open DB port, or leaked secret in an image layer could expose private restaurant financial data and images to the internet; and once real data is persisted, every future Prisma migration runs on live data. **How this plan shrinks it:** zero new `@Public()` routes (`routes.spec.ts` + `401` backend healthcheck); `nginx` never mounts `uploads-data` and returns `404` on `/uploads/`; bootstrap HTTP-only mode serves only `/.well-known/acme-challenge/` and returns `503` everywhere else; HTTPS mode redirects port 80 to fixed `https://${APP_DOMAIN}$request_uri` (no `$host` injection) and enforces `Secure; HttpOnly; SameSite=Strict` cookies via `NODE_ENV=production`; only `nginx` publishes ports (`80`/`443`); `backend` never receives `ANTHROPIC_API_KEY` and `worker` never receives `JWT_SECRET`; `.dockerignore` blocks `samples/` and `.env*`; migrations run only via explicit `migrate` service (`prisma migrate deploy`); and `deploy/verify-stack.sh` + `deploy/smoke.sh` verify these invariants end-to-end. **Human review before merge:** inspect `nginx/templates/https.conf.template`, `nginx/templates/http-only.conf.template`, `nginx/entrypoint.sh`, `docker-compose.prod.yml` (ports, volumes, env vars), `backend/Dockerfile`, `nginx/Dockerfile`, `.dockerignore`, and `deploy/init-cert.sh`. |
| Deferring off-VPS backups and restore out of MVP (`plans/mvp-slices.md`, `system-design.md`, `README.md`) | **One-way (merge-time)** | Listed in `one-way-doors.md` ("Backups and restore (a failure only shows up once the data is gone)"). **Blast radius:** until a follow-up backup slice is implemented and restore-tested, Postgres (`db-data`) and uploaded photos (`uploads-data`) exist only on the single VPS disk, so VPS storage loss or accidental `down -v` would lose persisted app data. **How this plan shrinks it:** persistent named Docker volumes survive rebuilds/restarts, `migrate` only runs non-destructive `prisma migrate deploy` explicitly, and `README.md` explicitly warns operators that off-VPS backups are not yet configured and never to run `down -v` in production. **Human review before merge:** confirm acceptance of operating without automated off-VPS backups (e.g., keeping paper originals in the binder) until the backup slice is planned and shipped. |
| Backend graceful shutdown (`backend/src/main.ts`) and compiled user CLI (`backend/src/users/users-cli.ts`, `backend/src/users-cli.ts`, `backend/package.json`) | **Two-way** | Refactor of existing `backend/scripts/users.ts` into `src/` with identical behavior and tests (`users.spec.ts`), plus `app.enableShutdownHooks()`. Cleanly reversible with `git revert`. |
| Operational verification scripts (`deploy/smoke.sh`, `deploy/verify-stack.sh`) and deployment docs (`README.md`) | **Two-way** | Read-only post-deploy checks, isolated local Docker verifier, and documentation. Cleanly reversible with `git revert`. |
