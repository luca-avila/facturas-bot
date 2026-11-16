# Plan: Accounts (slice 1b)

Spec: [`slice-1-skeleton-and-accounts/1b-accounts.md`](slice-1-skeleton-and-accounts/1b-accounts.md). Branch: `feat/accounts`.

## Goal

A person created with `npm run user:create` signs in from their phone and sees an empty Spanish shell with their name and *Cerrar sesión*. Every backend endpoint except sign-in answers 401 without a valid session. Resetting someone's password or disabling them signs them out on their next request.

## Out of scope

- HTTPS, deployment and everything else in slice 8. These go to slice 8:
  - Express `trust proxy` behind nginx.
  - A per-IP sign-in limit.
  - How the user scripts run in the production image (`tsx` is a dev dependency).
- Role enforcement, sign-up, email, password reset by email, people changing their own password, re-enabling a disabled user (there's no `user:enable`) and listing users.
- Revoking a single session on the server. There's no sessions table, so *Cerrar sesión* only deletes the cookie on that device. Only a password reset or `user:disable` revokes sessions, and they revoke all of them.
- `audit_log` (slice 2). The user scripts don't write audit entries.
- Rehashing passwords when the argon2 parameters change.
- Keeping sign-in failure counts across restarts or across processes.
- CSRF tokens. `SameSite=Strict` plus JSON-only bodies cover it (see Decisions).
- Any screen beyond the sign-in and the empty shell, plus a router, navigation and financial data.
- Frontend DOM or component tests, and their dependencies (`jsdom`, Testing Library).
- Truncating tables between tests. Tests make their own users with unique emails (see Decisions).
- `created_by` and other columns that point to `users`. Slice 2 adds them, using `@CurrentUser()` from this slice.

## Decisions

These were checked against the installed packages and the npm registry on 2026-11-13, with probes in a scratch copy of the backend. They aren't open to the implementer.

**Answers from the human** (the planner's questions)
1. The scripts **prompt for the password**. On a terminal they ask twice with hidden input. When stdin isn't a terminal, the password is the first line of stdin, read once. The minimum is **12 characters**.
2. Signing out is in: `POST /api/auth/logout`, which needs a session, and a *Cerrar sesión* button in the shell. Sign-in stays the only public endpoint.
3. The rate limit counts **only failed sign-ins**, **per normalized email**, **in memory**:
   - 5 failures within 15 minutes block that email until the window ends.
   - A successful sign-in resets the count.
   - There's no per-IP limit until slice 8. Until then, every request reaches the backend from the Vite proxy's address (later nginx's), so a per-IP limit would act as a global one.

**Session token: stateless, signed with HS256.**
- The cookie holds a JWT signed with `JWT_SECRET` (the variable the README already lists), using `jose` 6.
- Claims:
  - `sub`: the user id.
  - `passwordSetAt`: the user's `password_set_at` in epoch milliseconds, as read during that sign-in.
  - `iat`, and `exp` = time of last use + 30 days, both in seconds.
- Verification pins `algorithms: ['HS256']` and passes `currentDate: now()`.
- **Revocation by snapshot, not by timestamp comparison.** A request is rejected when the token's `passwordSetAt` differs from the user's current `password_set_at`.
  - This is "sessions issued before `password_set_at` are rejected", without its two traps:
    - JWT `iat` has second precision while `password_set_at` has microsecond precision, so a session issued in the same second as the password would be rejected.
    - A sign-in that read the user just before a concurrent reset would otherwise get a session stamped after the reset, and survive it.
  - Prisma returns `password_set_at` truncated to milliseconds every time, so equality is stable.
- **Renewal.** Every authenticated request re-signs the token with the same `sub` and `passwordSetAt` and a fresh `exp`, and sets the cookie again.
- **Expiry.** jose rejects a token from the second its `exp` is reached (verified), so exactly 30 days without use is expired.
- `JWT_SECRET` must be at least 32 characters, or the backend refuses to start. Changing it signs everyone out.

**Cookie**
- Name `session`.
- `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Max-Age` 30 days.
- `Secure` unless `NODE_ENV` is exactly `development`.
  - `start:dev` and `start:debug` set `NODE_ENV=development`.
  - Anything else, including a missing `NODE_ENV`, Vitest's `test`, and slice 8's image, keeps `Secure`.
  - This is how "only local development drops `Secure`" is enforced. Don't add a separate flag, and don't put `NODE_ENV` in `.env`, which gets copied to the server.
- Clearing uses the same name and `Path`. Clearing first removes any `session` cookie already queued on the response, so a logout response carries exactly one `session` cookie, and it expires the cookie. The guard queues a renewal before the handler runs.

**Passwords**
- `argon2` `~0.45.2`, argon2id with the library's defaults: 64 MiB, `t=3`, `p=4`, about 60 ms per hash here.
- The stored value is the library's PHC string, so it carries its parameters.
- npm 11 reports `argon2`'s install script as not covered by `allowScripts`, just like `esbuild` and `prisma` already. Don't approve it: the package ships prebuilt glibc and musl binaries that load without it.
- Sign-in for an unknown email still verifies the password against a dummy hash, so timing doesn't reveal which emails exist.
  - The dummy hash is computed at runtime, once, from a random value.
  - Don't write a hash literal in the source. It's the same CUIT-check risk as the hash rule in `agents.md`.
- Passwords are never trimmed, logged or printed.

**Emails**
- Normalized to `trim()` + `toLowerCase()` by one exported function, `normalizeEmail`, in `users/`. Creating, signing in and the rate limit all go through it.
- The table also gets `CHECK (email = lower(btrim(email)))`, so the unique index is effectively case-insensitive even for a writer that skips the service.
- The scripts accept an email when, after normalizing, it has exactly one `@` with something on each side and no whitespace.

**Global guard, default deny**
- One `SessionGuard`, registered with `APP_GUARD` in `AuthModule`, runs on every route of every module, now and in later slices.
- `@Public()` skips it and is used only on sign-in.
- The guard **throws** `UnauthorizedException`. Returning `false` gives 403 (verified).
- An unknown path like `/api/nope` keeps Nest's 404: routing fails before guards run.
  - Acceptance 4 is about real endpoints.
  - The route list is already public in the repo, so the 404 reveals nothing.
  - A catch-all route that returns 401 could shadow routes that later slices register after it.

**CSRF and body parsing**
- The app is created with `bodyParser: false`, and then only the JSON parser is turned on.
- A cross-site form or `text/plain` POST arrives with an empty body and fails validation with 400 (verified).
- A cross-site JSON POST needs a CORS preflight, and CORS stays off.
- With `SameSite=Strict` on top, no CSRF token is needed.

**Shared app setup.** `configureApp(app)` in `src/configure-app.ts` applies:
- the `/api` prefix
- the JSON-only body parser
- `cookie-parser` 1.4, with `@types/cookie-parser`

`main.ts` and the test helper both call it, so tests run the real wiring.

**Rate limiter**
- An in-memory `LoginAttempts` provider: a `Map` from normalized email to `{ windowStart, failures }`.
- `begin(email)` checks and counts in one synchronous call, before sign-in awaits anything:
  - If the email is blocked, it returns the seconds to wait and counts nothing.
  - Otherwise it counts the attempt as a failure up front. With no entry, or an expired one, it starts a window `{ now, 1 }`. Otherwise it increments `failures`.
  - A successful sign-in then clears the count.
  - Why up front: counting after the user lookup and the password check let parallel attempts all pass the check before any failure was counted (40 parallel wrong passwords gave 40 × 401). Decided by the human on 2026-11-16, over tracking in-flight attempts separately.
  - The cost: an attempt that ends in a 500 stays counted. Five during a database outage block the email for the rest of the window, or until a restart.
- An email is blocked while `now < windowStart + 15 min` and `failures >= 5`.
- `Retry-After` is the seconds left in the window, rounded up, at least 1.
- Expired entries are swept on every `begin`, so the map can't grow without bound.
- It reads time from `now()`.
- One backend process means one counter. A restart resets it.

**Clock.** `clock.ts` gets `now(): Date`, the only `new Date()` outside `today()`. Everything time-related uses it:
- token times
- `password_set_at` and `disabled_at`
- the rate limiter

Every timestamp this slice writes comes from the app clock, so tests control it.

**Tests and time**
- Use `vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime(...)`, and `vi.useRealTimers()` in `afterEach`.
- Faking anything but `Date` would freeze timers that Prisma, `pg` and supertest rely on.

**Tests and users**
- The test database is recreated per run, and spec files run in parallel against it.
- Every test creates the users it needs, with a unique email such as `` `ana-${randomUUID()}@example.com` ``, and nothing truncates `users`.
- Each spec file builds its own app, so rate-limit counters don't leak between files. Within a file, unique emails keep them apart.

**Test environment**
- `vitest.config.ts` sets `JWT_SECRET` in `test.env` to `randomBytes(32).toString('base64url')`, computed at load. Never write a secret or hash literal.
- Tests that need another environment use `vi.stubEnv` before building the app, and `vi.unstubAllEnvs()` after. So `AuthConfig` must read `process.env` when the app is created, not when a module is imported.

**Cookies in tests**
- Supertest's agent won't send a `Secure` cookie over HTTP.
- Tests read the `session` value from `Set-Cookie` with a small helper, and send `Cookie: session=<value>` themselves.
- That way they run with the production default, `Secure` on.

**Scripts**
- One entry point, `backend/scripts/users.ts <command>`, with `node:util` `parseArgs` in strict mode.
- `read` 6 handles the hidden prompt. It's npm's own package and needs Node `^24.15`; `.nvmrc` gives 24.22.
- The script builds `new PrismaService()` and `new UsersService(prisma)` directly, without a Nest container. Under `tsx`, decorated classes load fine (verified), and constructing by hand needs no decorator metadata.
- Output is in English, like `check-cuits`. It's operator tooling, not UI.
- Errors go to stderr with exit code 1. Success prints one line.

**Spanish text** (frontend only; the backend returns status codes, never Spanish)

| Where | Text |
| --- | --- |
| Sign-in heading | Iniciar sesión |
| Labels | Email, Contraseña |
| Button / while submitting | Entrar / Entrando… |
| 401 | El email o la contraseña no son correctos. |
| 429 | Demasiados intentos fallidos. Esperá unos minutos y volvé a intentar. |
| Network error or 5xx | No se pudo conectar con el servidor. Volvé a intentar. |
| While the session loads | Cargando… |
| Shell header | Facturas, the user's name, and a *Cerrar sesión* button |

- A disabled user sees the 401 text, like any failed sign-in.
- The sign-in error kinds map to text through an exhaustive `Record<SignInError, string>`.

**Frontend wiring**
- In `vite.config.ts`, `server.proxy` sends `/api` to `http://localhost:3000`, so the browser sees one origin and CORS stays off.
- `--host` isn't in the config, so a plain `npm run dev` doesn't expose the dev server on whatever network the laptop is on. The phone flow is `npm run dev -- --host`.

**Schema conventions** (this is the first model, so later slices copy them)
- Models are PascalCase and singular, with `@@map` to snake_case plural tables.
- Fields are camelCase, with `@map` to snake_case columns.
- Enum types are snake_case through `@@map`.
- `id` is `@db.Uuid` with `@default(dbgenerated("gen_random_uuid()"))`, so raw inserts in tests work.
- Timestamps are `@db.Timestamptz(6)`.
- `updated_at` has both `@default(now())` and `@updatedAt`.

## Interface

**Schema** (`backend/prisma/schema.prisma`, validated with Prisma 7.10.1)

```prisma
enum UserRole {
  admin
  staff

  @@map("user_role")
}

model User {
  id            String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email         String    @unique
  name          String
  passwordHash  String    @map("password_hash")
  passwordSetAt DateTime  @map("password_set_at") @db.Timestamptz(6)
  role          UserRole
  disabledAt    DateTime? @map("disabled_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("users")
}
```

The migration `prisma/migrations/<timestamp>_users/` is generated, then gets this line added by hand:

```sql
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));
```

**HTTP** (prefix `/api`, JSON bodies only)

| Method and path | Session | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/auth/login`, body `{ email, password }` | Public | 200 `{ name, email }`, sets the cookie | 400 when either field is missing or not a non-empty string. 401 for an unknown email, wrong password or disabled user, with no cookie. 429 with `Retry-After` while blocked, with no cookie. |
| `GET /api/auth/me` | Required | 200 `{ name, email }` | 401 |
| `POST /api/auth/logout` | Required | 204, clears the cookie | 401 |

Login uses `@HttpCode(200)` and logout `@HttpCode(204)`, since Nest's POST default is 201.

**Sign-in order** (`AuthService.signIn`). The order matters, so implement it as listed:
1. Normalize the email.
2. Call `LoginAttempts.begin`, before any await. If it blocks the email, return 429. Don't look up the user or verify the password. Otherwise the attempt is already counted as a failure.
3. Look up the user. Verify the password against their hash, or against the dummy hash when there's no user.
4. If there's no user, the password is wrong, or `disabled_at` is set: return 401. The failure was counted in step 2.
5. Otherwise, clear that email's failures, issue the session cookie from the row read in step 3, and return 200.

**Every request** (`SessionGuard`, global):
1. If the handler is `@Public()`, let it through.
2. Read the `session` cookie. If it's missing, return 401.
3. Verify the JWT (HS256 only, `currentDate: now()`). If it's invalid, expired or signed with another secret, return 401.
4. Load the user by `sub`. Return 401 when the user doesn't exist, `disabled_at` is set, or `password_set_at` differs from the token's `passwordSetAt`.
5. Attach `{ id, email, name, role }` to the request, and queue the renewed cookie on the response.

**For later slices**
- `@CurrentUser()` is a param decorator that returns `SessionUser { id, email, name, role }`. Slice 2 uses it for `created_by`.
- `@Public()` exists for sign-in only. Any other use is a one-way door.

**Configuration**
- `JWT_SECRET` is required, at least 32 characters. `.env.example` gets an empty `JWT_SECRET=` with a comment: generate it with `openssl rand -base64 48`, and changing it signs everyone out.
- `NODE_ENV=development` drops `Secure`, and only `start:dev`/`start:debug` set it.

**`UsersService`** (`backend/src/users/`, used by the scripts and by auth)
- `create({ email, name, role, password })`
  - Normalizes the email and trims the name.
  - Rejects:
    - an invalid email
    - an empty name
    - a role other than `admin`/`staff`
    - a password under 12 characters, counted in code points
    - an existing email, disabled users included
  - The duplicate check relies on the unique index: Prisma's `P2002` maps to the "already exists" error.
  - Sets `password_set_at = now()`.
- `resetPassword(email, password)`
  - Rejects an unknown email, a disabled user and a short password.
  - Sets a new hash and `password_set_at = now()`.
- `disable(email)`
  - Rejects an unknown email.
  - Sets `disabled_at = now()`.
  - On a user who's already disabled, it changes nothing, keeps the original `disabled_at`, and reports that.
- `findByEmail(email)` and `findById(id)` for auth.
- Errors are a `UserInputError` class with an English message.

**Scripts** (`backend/package.json`)
- `user:create`: `tsx scripts/users.ts create`, used as `npm run user:create -- --email ana@example.com --name Ana --role admin`. All three flags are required.
- `user:reset-password`: `tsx scripts/users.ts reset-password`, with `--email`.
- `user:disable`: `tsx scripts/users.ts disable`, with `--email`. No password.
- Getting the password (create and reset):
  - When `process.stdin.isTTY`, prompt `Password: ` and `Repeat password: ` with hidden input. A mismatch exits 1 with "Passwords don't match."
  - Otherwise, read the first line of stdin, without its line ending.
- Output: one line such as `Created ana@example.com (admin).`, `Reset the password for ana@example.com. Their sessions are signed out.` or `Disabled ana@example.com. Their sessions are signed out.` It never contains the password or the hash.
- Unknown flags, missing flags or an unknown command exit 1 with a usage line.

**Frontend** (`frontend/src/`)
- `api.ts`
  - `getSession(): Promise<SessionUser | null>` gives `null` on 401 and on network errors.
  - `signIn(email, password): Promise<{ ok: true; user: SessionUser } | { ok: false; error: SignInError }>`, where `SignInError = 'invalid_credentials' | 'rate_limited' | 'unavailable'`:
    - 401 gives `invalid_credentials`.
    - 429 gives `rate_limited`.
    - A network error, or any other status, gives `unavailable`.
  - `signOut(): Promise<void>`. Whatever happens, the caller shows the sign-in screen afterwards.
- `App.tsx`:
  - *Cargando…* while `getSession()` runs.
  - Then `SignIn` or `Shell`.
  - Sign-in success shows the shell with the returned user, and *Cerrar sesión* goes back to `SignIn`.
- `SignIn.tsx`:
  - An email input (`type="email"`, `autoComplete="username"`) and a password input (`autoComplete="current-password"`).
  - The button is disabled while submitting.
  - The error goes in a `role="alert"` element.
- `Shell.tsx`: a header with *Facturas*, the user's name and *Cerrar sesión*. The main area is empty.
- `index.css`:
  - Replace the template's demo layout (fixed 1126 px column, centered text, 56 px heading) with a minimal mobile-first one.
  - Inputs and buttons are full width with a font size of at least 16 px, so iOS doesn't zoom.
  - Keep the color tokens and dark mode.

## Behaviors to test

Backend tests go through HTTP, with supertest against an app built by the test helper:
- the real `AppModule`
- `configureApp`
- `bodyParser: false`
- a real Postgres

Users are created through `UsersService`. Frontend tests go through `api.ts`, with `fetch` stubbed by `vi.stubGlobal`; the stub returns errors as well as successes.

**Sign-in**
- Ana signs in with her email and password. She gets her name and email back, plus a `session` cookie.
- She can type her email with capitals and surrounding spaces, and still get in.
- A wrong password is refused with 401, and no cookie is set.
- An unknown email is refused the same way.
- A request with a missing password, a number as the email, or a form-encoded body is rejected with 400. It doesn't count as a failed attempt.
- After signing in, `GET /api/auth/me` returns her name.

**Disabled users**
- After `disable`, Ana can't sign in even with the right password, and she gets the same 401 as a wrong password.
- When Ana is disabled while signed in, her next request gets 401.

**Password reset**
- When Ana's password is reset while she's signed in, her next request with the old cookie gets 401.
- After the reset, her old password fails and the new one works. The new session works.
- A session from before the reset stays rejected even when it's otherwise valid and unexpired.

**Rate limit**
- Five wrong passwords for Ana each get 401. The sixth attempt gets 429 with a `Retry-After` header, and so does the right password, with no cookie.
- While Ana is blocked, Beto can still sign in.
- Fifteen minutes after Ana's first failure, the right password works again.
- Failures count per normalized email: `Ana@Example.com` and ` ana@example.com` share one count.
- An unknown email gets blocked after five failures too, so being blocked doesn't reveal whether an account exists.
- Four failures, then a success, then four more failures: Ana still gets in. The success reset the count.
- Twenty wrong passwords for Ana sent in parallel: exactly five get 401, the other fifteen get 429.

**Cookie**
- The `session` cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure`, with a 30-day `Max-Age`.
- With `NODE_ENV=development` it's the same, without `Secure`.

**Sliding expiry** (fake `Date`)
- A session signed in at T and not used again is rejected at exactly T + 30 days.
- Used at T + 30 days − 1 minute, it's accepted and gets a renewed cookie. That renewed cookie still works at T + 59 days, when the original would have expired.

**Every route**
- Every route registered on the real app returns 401 without a cookie, except `POST /api/auth/login`.
  - The test lists the routes from the Express router (`app.getHttpAdapter().getInstance().router.stack`, the layers with a `route`), and fills each `:param` with a random UUID.
  - It asserts the list includes the three auth routes, so a broken enumeration fails instead of passing on an empty list.
  - Future endpoints get covered without changing the test.
- These also get 401 on `/api/auth/me`:
  - a tampered token
  - a token signed with a different secret
  - a validly signed token for a user id that doesn't exist (not 500)

**Sign-out**
- `POST /api/auth/logout` with a session returns 204. The response has exactly one `session` cookie, and it expires it.
- Without a session, it returns 401.

**Startup**
- Building the app without `JWT_SECRET`, or with one under 32 characters, fails with a message that says how to generate one.

**Accounts** (`UsersService`, real Postgres)
- `create` stores:
  - the email normalized
  - the name trimmed
  - the role
  - an `$argon2id$` hash that doesn't contain the password
  - `disabled_at` empty
- A second `create` with the same email in other casing is refused, and there's still one row.
- A password of 11 characters is refused and nothing is written. Twelve is accepted.
- An invalid email, an empty name or an unknown role is refused.
- The database itself refuses an email that isn't normalized, inserted with raw SQL.
- `resetPassword` on an unknown email is refused, and so is a reset on a disabled user.
- `disable` on an unknown email is refused. Disabling twice keeps the first `disabled_at`.

**Scripts** (child process: `tsx scripts/users.ts`, password piped on stdin, test database from the worker's environment)
- `create` with the password on stdin exits 0, and that user can then sign in.
- `create` without `--role` exits 1 with usage, and creates nothing.
- The output never contains the password.

**Clock**
- `now()` returns the instant set with `vi.setSystemTime`.

**Frontend `api.ts`**
- `signIn` maps 200 to the user, 401 to `invalid_credentials`, 429 to `rate_limited`, and 500 or a rejected `fetch` to `unavailable`.
- It posts JSON to `/api/auth/login`.
- `getSession` maps 200 to the user, and 401 to `null`.

## Steps

One commit per step. Run the backend steps with `docker compose up -d db`. "Verify" lists what proves the step is done.

1. **`now()` in the clock**
   - Add `now()` to `clock.ts` and its test.
   - Verify: backend `npm test` and `npm run lint` pass.

2. **`users` table**
   - Add the enum and the model.
   - Run `npx prisma migrate dev --name users --create-only` against the dev database.
   - Append the `CHECK` to the generated `migration.sql`, then run `npx prisma migrate dev`.
   - Add the test where raw SQL can't insert an email that isn't normalized.
   - Verify:
     - `npm test` passes. The harness applies the migration to `facturas_test`.
     - `\d users` in the dev database shows the unique index and `users_email_normalized`.
     - `npm run check:cuits` passes on the new migration.

3. **Accounts service**
   - Add `argon2` (`~0.45.2`), `normalizeEmail`, the password helpers (12-character minimum, the dummy hash for unknown emails), `UserInputError` and `UsersService`, in `UsersModule`.
   - Add the tests from *Accounts*.
   - Verify: `npm test`, `npm run lint` and `npm run typecheck` pass. `npm ci` works without approving `argon2`'s install script.

4. **User scripts**
   - Add `read` 6, `scripts/users.ts` and the three npm scripts.
   - Add the child-process tests.
   - Verify:
     - Tests pass.
     - By hand on the dev database: `npm run user:create -- --email ana@example.com --name Ana --role admin` asks for the password twice without echoing it.
     - `user:disable` twice reports that the user is already disabled the second time.

5. **Sessions, sign-in and the global guard**
   - Add `jose` 6, `cookie-parser` and `@types/cookie-parser`.
   - Add `configureApp` and switch `main.ts` to `bodyParser: false` and `configureApp`.
   - Add `NODE_ENV=development` to `start:dev` and `start:debug`.
   - Add `JWT_SECRET` to `.env.example` and the random one to `vitest.config.ts`.
   - Add `AuthModule`:
     - `AuthConfig`
     - session tokens and the cookie
     - `SessionGuard` as `APP_GUARD`
     - `@Public()` and `@CurrentUser()`
     - `AuthService` and `AuthController` with login, me and logout
   - Leave the rate limiter out for now.
   - Add the test helper (build the app, read the `session` cookie, create a user with a unique email). Add every behavior above except *Rate limit*.
   - Verify:
     - All three checks pass.
     - With `JWT_SECRET` set in the local `.env`: `npm run start:dev` starts, and `curl -i localhost:3000/api/auth/me` returns 401.
     - Sign in with `curl` using Ana from step 4, then read `/api/auth/me` with the cookie.
     - Without `JWT_SECRET`, the backend refuses to start.

6. **Rate limit**
   - Add `LoginAttempts`, and wire it into `AuthService` in the order from Interface.
   - Add the *Rate limit* tests.
   - Verify: all three checks pass.

7. **Frontend**
   - Add the Vite proxy, `api.ts` and its tests, `SignIn`, `Shell`, `App` and the CSS.
   - Verify:
     - Frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
     - With the backend on `start:dev`, `npm run dev` signs Ana in at `http://localhost:5173`, shows *Ana* and *Cerrar sesión*, and signs out.

8. **Docs**
   - `agents.md`:
     - Every endpoint is behind the global `SessionGuard`.
     - Use `@CurrentUser()` for the acting user.
     - `@Public()` is for sign-in only; another public route is a one-way door.
     - `clock.ts` also has `now()`.
     - Backend tests need nothing new: `JWT_SECRET` comes from the Vitest config.
     - Tests that create users use unique emails. Tests that move time fake only `Date`.
   - `README.md`:
     - In the environment table, `JWT_SECRET` "Signs session cookies. At least 32 characters".
     - The account section says the scripts prompt for the password (at least 12 characters) or read it from stdin.
     - The local run section says `start:dev` is what lets the phone sign in over HTTP, and that the phone uses `npm run dev -- --host` and `http://<computer's LAN IP>:5173`.
   - Verify: all checks pass in both apps. `check:cuits` scans docs too.

**Manual acceptance at the end** (from the spec):
1. Run `npm run user:create` and sign in from the phone on the local network. The shell shows my name.
2. Enter a wrong password six times. The sixth shows *Demasiados intentos fallidos…*.
3. With the phone signed in, run `npm run user:reset-password` from another terminal, then reload the phone. It shows the sign-in screen.
   - Sign in again, run `npm run user:disable`, and reload. It's signed out, and the right password no longer works.
4. `curl -i http://localhost:3000/api/auth/me` and `curl -i -X POST http://localhost:3000/api/auth/logout` return 401.

## Doors

| Part | Door | Note |
| --- | --- | --- |
| `SessionGuard` as a global default-deny guard, `@Public()` only on sign-in | **One-way** | Authentication. Every later endpoint relies on it. |
| Session token, cookie attributes, revocation by `password_set_at` and `disabled_at`, `JWT_SECRET` | **One-way** | Authentication. A flaw here exposes financial data once slice 2 exists, and to the internet from slice 8. |
| Sign-in rate limit | **One-way** | Authentication. It's what limits password guessing. |
| `users` table and migration | Two-way | It's created on an empty database and no real data exists until slice 8. In development, `prisma migrate reset` undoes it. |
| Password hashing (argon2id, PHC string) | Two-way now | No real users exist until slice 8. After that, a hash can't be converted to another scheme, only replaced at the next sign-in. The PHC string keeps that possible. |
| User scripts | Two-way | They only write `users`, and they're run by hand. |
| Frontend sign-in and shell, Vite proxy | Two-way | The UI holds no secret; the backend enforces everything. |
| `NODE_ENV=development` in `start:dev` | Part of the cookie door | It's the only way `Secure` gets dropped. |

**Blast radius.**
- Today it's small:
  - The app runs only on the developer's machine and the local network.
  - Nothing except the users the scripts create is stored, and they hold only names, emails and hashes.
  - Financial data arrives in slice 2, and the internet in slice 8.
- The real risk is structural. Every later endpoint inherits this guard, the cookie and the revocation rule. A hole here becomes a hole in every slice, and once slice 8 puts it online, exposed data can't be taken back.

**How the plan shrinks it**
- **Default deny.** The guard is global, so a new endpoint is protected without anyone remembering to add it.
- **A test that grows with the app.** The route test lists the routes registered at runtime. Any future endpoint that answers without a session, or any new `@Public()`, fails it.
- **One public route.** Sign-in is the only one, and it's rate limited before any password work.
- **Revocation without clock precision.** The `passwordSetAt` snapshot compares exactly, so second-versus-microsecond precision and the reset race can't let a session through.
- **Secure by default.**
  - `Secure` drops only under `NODE_ENV=development`.
  - The secret is required and never committed.
  - The algorithm is pinned to HS256.
  - CORS stays off, bodies are JSON only, and the cookie is `SameSite=Strict`.
- **Cheap recovery.** If the token or cookie scheme proves wrong, changing `JWT_SECRET` signs everyone out at once, and a revert restores the old code. No session data is stored to migrate.

**Known limits, accepted with the human's answers**
- *Cerrar sesión* clears only that device's cookie. A copied cookie stays valid until 30 days without use, a password reset or `user:disable`.
- Someone who knows a staff email can block that person's sign-in for up to 15 minutes at a time.
- Restarting the backend resets the failure counts.
- Behind nginx in slice 8, `trust proxy` and a per-IP limit are still to do.

**Look closely at**
- `SessionGuard`: the order of checks, that it throws instead of returning `false`, and the renewal.
- Token verification: the algorithms, `currentDate`, and the `passwordSetAt` equality.
- The cookie options, and clearing on logout.
- `AuthService.signIn`: the limiter counts before any await, the dummy hash, and clearing on success.
- `configureApp`: JSON only, the prefix, `cookie-parser`.
- The `start:dev` script.
- The route-enumeration test.
