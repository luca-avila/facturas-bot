# Plan: Scaffold (slice 1a)

Spec: [`slice-1-skeleton-and-accounts/1a-scaffold.md`](slice-1-skeleton-and-accounts/1a-scaffold.md). Branch: `feat/scaffold`.

## Goal

`backend/` (NestJS) and `frontend/` (React + Vite) exist, and `npm run lint`, `npm run typecheck` and `npm test` pass in both. Tooling now catches three risks so a reviewer doesn't have to: money handled as a float, "today" in the wrong time zone, and real CUITs in the public repo. Backend tests run against a real, freshly migrated Postgres.

## Out of scope

- `users`, sign-in, sessions, the Spanish shell and every screen (1b). Connecting the frontend to the backend (dev proxy, API prefix, CORS, `vite --host` for the phone) is also 1b.
- Docker Compose for production, app containers, nginx, HTTPS, deployment (slice 8). This slice only adds a `db` service for local development.
- Running lint, typecheck or tests in CI. The spec asks for CI to run only the CUIT check.
- Isolating tests from each other inside one run (truncating tables or using transactions). There are no tables yet. Slice 2 adds that with its first tables.
- Exhaustive Spanish labels (slice 2), the `applications` import rule (slice 3), and validating supplier CUITs (slice 2, which reuses `isValidCuit` from this slice).
- `Money` operations other than `add`, such as subtract, compare or conversion from Prisma's `Decimal`. Slices 2 and 3 add them when they need them.
- A `now()` for timestamps in `clock.ts`. 1b adds it if sessions need it.
- Banning other float conversions (`Number(x)`, unary `+`, `Decimal#toNumber`). The spec only bans `parseFloat` and `toFixed`.
- Scanning git history, and detecting real supplier names or amounts. The check only covers CUITs in the files as they are now.
- A frontend `Money` or `clock.ts`. The frontend gets the bans with no exceptions (see Decisions).
- Prettier enforcement, the extraction worker and the Anthropic SDK.

## Decisions

These were checked against the npm registry and the current templates on 2026-11-09. They aren't open to the implementer.

**Generators and what to remove from their output**
- Backend: `npx @nestjs/cli@12 new backend` with npm, **ESM (with Vitest)** (the Nest 12 default), and `--skip-git`, because a nested `.git` inside the repo would break everything. Don't enable `@nestjs/observe`, since it sends telemetry to a third party. Check `nest new --help` for flags so it runs without prompts.
  - Delete the sample `AppController`, `AppService`, their spec, `test/app.e2e-spec.ts`, `vitest.config.e2e.ts` and the `test:e2e` script. The app ends up with an empty `AppModule` plus `PrismaModule`, and no endpoints, so 1b's global guard starts with nothing open.
  - Delete the generated `AGENTS.md` (it advertises Observe) and `README.md`. The root `agents.md` and `README.md` are the project's docs.
  - Delete `@nestjs/mau` and the `deploy` script, because deployment is slice 8, to the VPS.
- Frontend: `npm create vite@9 frontend -- --template react-ts`, with no install-and-start prompt.
  - Delete the demo: counter, logos, `App.css`, `src/assets`, `public/icons.svg` and the generated `README.md`.
  - `index.html` gets `lang="es"` and `<title>Facturas</title>`. `App` renders only `<h1>Facturas</h1>`, as a placeholder that 1b replaces with the shell.
- **ESLint, not oxlint.** Both templates now ship oxlint. The spec and `codingStandards.md` require ESLint rules (`no-restricted-syntax` selectors, and later `no-restricted-imports`), so remove `oxlint`, `oxlint-tsgolint`, `.oxlintrc.json` and `_oxlintrc.json`, and use ESLint 10 flat config with `typescript-eslint` 8.
  - Backend: `tseslint.configs.recommendedTypeChecked` with `projectService`. It includes `no-floating-promises`, which the Nest template enforced through oxlint. Turn typed rules off for `.mjs`/`.js` config files.
  - Frontend: `tseslint.configs.recommended`, `eslint-plugin-react-hooks` (recommended) and `eslint-plugin-react-refresh`.
  - Both run `eslint . --max-warnings 0`.
  - Ignore `dist/`, `coverage/` and `backend/src/generated/`.
- **Don't run `prisma init`.** It writes agent skills into `.claude/skills/`, `.agents/`, `.windsurf/` and `skills-lock.json`, and names the config `prisma7.config.ts`. Write `prisma/schema.prisma` and `prisma.config.ts` by hand.

**Version pins** (the lockfiles hold the exact versions)
- Node 24: `.nvmrc` at the repo root, used by CI. Update the README prerequisite from "Node.js 20+" to "Node.js 24".
- TypeScript `~6.0.3` in **both** apps. Vite's template pins `~7.0.2`, but `typescript-eslint` 8.72 supports only `<6.1.0`, and Nest's CLI uses 6.0.
- Prisma: `prisma`, `@prisma/client` and `@prisma/adapter-pg` at `~7.10.1`. npm's `latest` tag for `prisma` points to an **8.0 release candidate**, so `npm i prisma` without a version is wrong. Ignore the CLI's "major update available" banner.
- Vitest: the major the Nest template ships (4.x), the same in both apps.
- `decimal.js` 10, `pg` 8, `dotenv`, `tsx` 4. If this `dotenv` version logs on load, pass `quiet: true`.

**Prisma** (verified with 7.10.1 against a throwaway Postgres)
- Generator `prisma-client`, with `output = "../src/generated/prisma"`, `moduleFormat = "esm"` and `importFileExtension = "js"`. Without the last one, generated imports end in `.ts` and don't compile under Nest's `nodenext` build. The output goes under `src/` because `tsconfig.build.json` has `rootDir: ./src`. It's gitignored.
- `prisma.config.ts` reads `process.env.DATABASE_URL` directly, not the strict `env()` helper. That way `prisma generate`, and so `npm ci` in CI, works without a database URL. Add `"postinstall": "prisma generate"`.
- `PrismaClient` needs the `PrismaPg` adapter. Numeric columns come back as Prisma `Decimal`. `::text` gives the exact Postgres string.
- `prisma generate` works with zero models. `prisma migrate deploy` with zero migrations prints "No pending migrations to apply." and creates `_prisma_migrations`.

**Environment**
- There's one `.env`, at the repo root, as the README already says. It's used by `docker compose` and the backend. The backend loads `../.env` with dotenv in `prisma.config.ts`, `src/main.ts` and `vitest.config.ts`. npm scripts always run with the backend folder as cwd. A missing file isn't an error, and variables that are already set win.
- `.env.example` holds only `DATABASE_URL=postgresql://facturas:facturas@localhost:5432/facturas`, plus a comment pointing to `docker compose up -d db`. Other variables arrive with the slices that use them.
- `docker-compose.yml` has one service, `db`: `postgres:17-alpine`, the dev credentials above, the port bound to `127.0.0.1:5432`, a named volume and a `pg_isready` healthcheck. The major version can change freely until slice 8 puts real data in it.

**File layout**
- `backend/src/common/money.ts` is the only file allowed `parseFloat` and `toFixed`.
- `backend/src/common/clock.ts` is the only file allowed `new Date()`, `Date()` and `Date.now()`.
- `backend/src/common/cuit.ts` holds `isValidCuit`.
- `backend/test/test-cuits.ts` holds the allowlist.
- `backend/scripts/` holds the CUIT check CLI and its scanner.
- `backend/test/` holds the harness and the lint tests.
- `eslint-bans.mjs` at the repo root holds the bans, imported by both ESLint configs so they can't drift.
- Spec files are `*.spec.ts` in both apps.

**Partitioning the bans across ESLint rules** (load-bearing, verified)
- Money bans use `no-restricted-globals` (`parseFloat`) and `no-restricted-properties`: `Number.parseFloat`, `globalThis.parseFloat`, and `toFixed` on any object.
- Clock bans use `no-restricted-syntax` only:
  - `NewExpression[callee.name='Date'][arguments.length=0]`
  - `CallExpression[callee.name='Date']`
  - `CallExpression[callee.object.name='Date'][callee.property.name='now']`
- This lets `money.ts` turn off only the money rules and `clock.ts` only the clock rule, so neither exception lifts the other ban.
- `new Date(value)` with an argument isn't banned, because it doesn't read the clock.
- `Date.now()` and `Date()` are included because they're the same risk as `new Date()`. Once the scaffold row is deleted, nobody checks them by hand.
- Spec files aren't exempt. Tests set time with `vi.setSystemTime(...)`.

## Interface

**Repo**
- `docker compose up -d db` starts the local Postgres.
- `.github/workflows/cuit-check.yml` runs on every push and pull request with `permissions: contents: read`. It checks out the repo, sets up Node from `.nvmrc`, then runs `npm ci` and `npm run check:cuits` in `backend/`. Use the current major tags of `actions/checkout` and `actions/setup-node`.

**Backend scripts**
- `lint`: ESLint, then `check:cuits`, so the `/feature` checks gate runs the CUIT check locally.
- `typecheck`: `tsc --noEmit` over `src/`, `test/`, `scripts/` and the config files.
- `test`: `vitest run`.
- `check:cuits`: `tsx scripts/check-cuits.ts`.
- `start:dev` and `build`, from the template.

**Frontend scripts**
- `lint`: ESLint.
- `typecheck`: `tsc -b`.
- `test`: `vitest run`.
- `dev` and `build`, from the template.

**`Money`** (`backend/src/common/money.ts`) is an immutable class over `decimal.js`.
- `Money.fromString(value: string): Money`
  - Accepts `^-?\d+(\.\d{1,2})?$` only.
  - Throws on anything else: empty or padded strings, a comma, an exponent, a leading `+`, more than 2 decimals, `NaN`.
  - It never rounds: 3 decimals is an error, not a rounding.
- `add(other: Money): Money`
- `toString(): string`
  - Always exactly 2 decimals, which is the shape Postgres returns for `numeric(14,2)`.
  - Negative zero prints as `0.00`.

**`today(): string`** (`backend/src/common/clock.ts`)
- Returns the current date in `America/Argentina/Buenos_Aires` as `YYYY-MM-DD`.
- It doesn't depend on the machine's time zone.
- Use `Intl.DateTimeFormat(...).formatToParts`, not local getters.

**`isValidCuit(value: string): boolean`** (`backend/src/common/cuit.ts`)
- True only for exactly 11 ASCII digits whose check digit is right.
- Weights are `5,4,3,2,7,6,5,4,3,2`. Take the sum mod 11. A remainder of 0 gives check digit 0. Otherwise the check digit is `11 − remainder`, and a result of 10 means no valid CUIT exists for that body.
- Dashes aren't accepted. Callers normalize first.
- Slice 2 reuses this function. It's the only implementation.

**`TEST_CUITS`** (`backend/test/test-cuits.ts`) is a readonly list of invented CUITs, digits only, with a comment on each. The middle eight digits are zeros, so they can't belong to anyone. Later slices take their test CUITs from here.

| CUIT | Use |
| --- | --- |
| `30000000015` | test supplier (company) |
| `30000000023` | second test supplier |
| `30000000031` | third test supplier |
| `30000000090` | check digit 0 case |
| `20000000028` | test supplier (person) |

**CUIT check** has two parts.
- Scanner function in `backend/scripts/`, for example `findCuits(text, allowlist) → { line, column, masked }[]`.
  - A match is 11 digits, optionally with a dash after the 2nd digit and before the last, not preceded or followed by another digit. Letters next to it don't stop a match.
  - It's reported when `isValidCuit` of its digits is true and the digits aren't in the allowlist.
- CLI `scripts/check-cuits.ts`.
  - Finds the repo root with `git rev-parse --show-toplevel` from the cwd.
  - Scans every file git would commit: `git ls-files --cached --others --exclude-standard`, so a new file that isn't added yet is checked before its first commit.
  - Reads working-tree bytes, whatever the file type. Skips listed files that no longer exist.
  - Uses `TEST_CUITS` as the allowlist.
  - On findings, prints `path:line:column` and a masked value, then exits 1. **It never prints the full number**, because CI logs on a public repo are public.
  - Otherwise prints one line and exits 0.

**`PrismaModule` / `PrismaService`** (`backend/src/prisma/`)
- A global module imported by `AppModule`.
- `PrismaService` extends the generated `PrismaClient` with the `PrismaPg` adapter on `process.env.DATABASE_URL`.
- It connects on module init and disconnects on destroy.
- 1b uses it for `users`.

**Postgres test harness** (`backend/test/`, wired in `vitest.config.ts`)
- The test database is the database named in `DATABASE_URL` plus a `_test` suffix (`facturas_test`), on the same server. If the name already ends in `_test`, it's used as is. One helper derives it. The harness only ever drops a database whose name ends in `_test`.
- A Vitest `globalSetup` runs once per `npm test`:
  - Connect with `pg` to the `postgres` maintenance database, with a connection timeout of about 5 s.
  - `DROP DATABASE IF EXISTS … WITH (FORCE)`, then `CREATE DATABASE …`.
  - Run `prisma migrate deploy` in a child process with `DATABASE_URL` set to the test database.
  - Any error fails the whole run: Postgres down, `DATABASE_URL` missing (the message points to `.env.example`), or a migration failure. There is no "skip if no database" path.
- Inside test workers, `process.env.DATABASE_URL` is the test URL, through `test.env` or a setup file using the same helper. Anything that reads it, `PrismaService` included, hits the test database and never the dev one.
- Tests run with `TZ=UTC` (Vitest `test.env`), so a time-zone bug can't hide behind a developer machine that's already in Buenos Aires.

## Behaviors to test

Tests go through the interfaces above, against a real Postgres where a database is involved.

**Clock**
- At 00:30 UTC on 10 November 2026, today is `2026-11-09`.
- At 02:59:59 UTC it's still the 9th. At 03:00:00 UTC it's the 10th, because midnight in Buenos Aires is 03:00 UTC.
- Early January comes back zero-padded (`2026-01-05`).
- These hold with the process in UTC. They would fail for an implementation that used local getters.

**Money**
- `0.10 + 0.20` is exactly `0.30`.
- `999999999999.99 + 0.01` is exactly `1000000000000.00`, with no rounding at the top of the `numeric(14,2)` range.
- `-5.00 + 5.00` prints `0.00`, not `-0.00`.
- `1234.5` reads and prints as `1234.50`.
- Rejected with an error: `""`, `" 1.00"`, `"1,50"`, `"1.234,56"`, `"1e3"`, `"+1.00"`, `"1.005"`, `"abc"`.
- Round trip through Postgres:
  - Each value is cast with `SELECT $1::numeric(14,2)::text` through `PrismaService`.
  - `999999999999.99` and `0.10` come back as the same string, and `Money.fromString` of the result equals the original.
  - `1234.5` comes back as `1234.50`.

**CUIT check digit** (`isValidCuit`)
- Every `TEST_CUITS` entry is valid, including the check-digit-0 case `30000000090`.
- A wrong check digit is invalid: `30000000016`.
- A body with no possible check digit is invalid for any last digit: `20000000010`.
- 10 or 12 digits, dashes, letters and an empty string are invalid.

**CUIT scanner** (function, with an injected allowlist)
- An allowlisted CUIT is flagged when the injected allowlist leaves it out, so test sources only ever contain allowlisted literals:
  - without dashes: `30000000015`
  - with dashes: `30-00000001-5`
  - glued to letters: `CUIT30000000015`
- The same CUITs pass when they're on the allowlist.
- A wrong check digit (`30-00000001-6`) passes.
- A valid CUIT inside a longer run of digits (13 digits, such as `1300000000155`) passes. It isn't a CUIT.
- A finding reports the right line and column, and its masked value doesn't contain the full 11 digits.

**CUIT check CLI** (run as a child process in a temporary git repo made by the test)
- A tracked file with an off-allowlist CUIT makes the check exit 1 and name that file and line.
  - The test builds the number at runtime from pieces such as `['30', '00000005', '8'].join('')`, so the spec file itself never holds the literal.
- An untracked file that isn't ignored fails the check the same way.
- A gitignored file with the same CUIT doesn't fail the check.
- A file with only allowlisted CUITs and wrong check digits passes.
- A non-UTF-8 file, and a tracked file deleted from the working tree, don't crash the check.
- The output never contains the full number.

**Lint bans, backend** (ESLint's Node API with the real config, `lintText` with the `filePath` of an existing file)
- `lintText` needs a file that exists, because typed linting rejects paths the TypeScript project doesn't know.
- `parseFloat(...)`, `Number.parseFloat(...)` and `x.toFixed(2)` in `src/main.ts` are errors. In `src/common/money.ts` they aren't.
- `new Date()`, `Date()` and `Date.now()` in `src/main.ts` are errors. In `src/common/clock.ts` they aren't.
- Exceptions don't cross: `new Date()` in `money.ts` is an error, and so is `parseFloat` in `clock.ts`.
- Spec files aren't exempt: `new Date()` in `src/common/clock.spec.ts` is an error.
- `new Date('2026-11-09')` with an argument is allowed anywhere.

**Lint bans, frontend** (same approach)
- `parseFloat`, `toFixed`, `new Date()` and `Date.now()` in `src/main.tsx` are errors.
- `new Date(value)` is allowed.

**Harness**
- A query through `PrismaService` reaches a real Postgres.
- `current_database()` is the `_test` database, not the one in `.env`.
- `_prisma_migrations` exists, so the database was migrated by the harness.

## Steps

One commit per step. "Verify" lists what proves the step is done.

1. **Repo plumbing**
   - Fix the root `.gitignore`. `/node_modules` and `/dist` are anchored to the root today, so `backend/node_modules` wouldn't be ignored. Make `node_modules/`, `dist/`, `build/` and `coverage/` unanchored, and add `*.tsbuildinfo` and `backend/src/generated/`. Keep `/samples/` and the `.env*` rules.
   - Add `.nvmrc` (`24`), `docker-compose.yml` (`db` only) and `.env.example`.
   - Verify:
     - `docker compose up -d db` becomes healthy.
     - `git check-ignore backend/node_modules/x frontend/dist/x backend/src/generated/x` prints all three.

2. **Backend app**
   - Generate with Nest's CLI and clean it up as in Decisions.
   - Pin TypeScript.
   - Replace oxlint with the backend ESLint config, without the bans yet.
   - Add the `typecheck` script.
   - Verify:
     - `npm run lint`, `npm run typecheck` and `npm run build` pass.
     - `npm run start:dev` starts, and `GET /` answers 404.

3. **Prisma and the Postgres harness**
   - Add the schema with no models, `prisma.config.ts`, the `postinstall` and the pinned Prisma packages.
   - Add `PrismaModule`/`PrismaService` and load the root `.env`.
   - Add the global setup, the worker env (`DATABASE_URL` to the test database, `TZ=UTC`) and the harness test.
   - Verify:
     - With `db` up, `npm test` passes and `facturas_test` exists.
     - With `docker compose stop db`, `npm test` fails within seconds. This is acceptance 4.
     - Create a table by hand in `facturas_test`, run `npm test` again, and the table is gone.
     - With `db` up, `npm run start:dev` still starts.

4. **Clock**
   - Add `clock.ts` and its tests.
   - Verify: `npm test` passes. Swapping the implementation for local getters makes the 00:30 UTC test fail. Try it locally, don't commit it.

5. **Money**
   - Add `decimal.js`, then `money.ts` and its tests, including the Postgres round trip.
   - Verify: `npm test` passes.

6. **Lint bans**
   - Add `eslint-bans.mjs` at the root with the partition from Decisions. Wire it into the backend config with the `money.ts` and `clock.ts` exceptions.
   - Add the backend lint tests.
   - Verify:
     - `npm run lint` and `npm test` pass.
     - By hand, add `parseFloat('1')` and then `new Date()` to `src/main.ts`, and lint fails each time. This is acceptance 2 for the backend.

7. **CUIT check**
   - Add `isValidCuit`, `TEST_CUITS`, the scanner, the CLI and their tests.
   - Add `check:cuits` and chain it into `lint`.
   - Verify:
     - `npm run check:cuits` passes on the repo, `plans/` and docs included.
     - By hand, put an off-allowlist valid CUIT in a tracked file, and the check fails with a masked value. An allowlisted one passes, and so does one with a wrong check digit. This is acceptance 3. Revert it before committing.

8. **CI**
   - Add `.github/workflows/cuit-check.yml`.
   - Verify:
     - The YAML is valid. The steps match what runs locally from a clean `npm ci` in `backend/`.
     - Run `rm -rf node_modules && npm ci && npm run check:cuits` without a `.env`. It passes, which proves `postinstall` works with no `DATABASE_URL`.
     - Don't push. The human pushes the branch.

9. **Frontend app**
   - Generate with create-vite and clean it up as in Decisions. Pin TypeScript.
   - Replace oxlint with the frontend ESLint config, importing `eslint-bans.mjs` with no exceptions.
   - Add Vitest (node environment) and the frontend lint tests. Type-check the test files through `tsconfig.node.json` or a dedicated tsconfig.
   - Add the `typecheck` and `test` scripts.
   - Verify:
     - `npm run lint`, `npm run typecheck` and `npm test` pass.
     - `npm run dev` serves the page with the title *Facturas*.
     - By hand, `parseFloat` in `src/App.tsx` fails lint. That completes acceptance 2.

10. **Docs**
    - In `codingStandards.md`, delete the scaffold-table rows for:
      - "Money handled as a float"
      - "'Today' in the wrong time zone"
      - "Real data in the public repo"
    - Keep the rows for labels, `applications`, and broken money invariants.
    - In `agents.md`, replace "`backend/` and `frontend/` don't exist yet" with short pointers:
      - Where `Money`, `clock.ts`, `isValidCuit` and `TEST_CUITS` live.
      - That test CUITs must come from `TEST_CUITS`.
      - That backend tests need `docker compose up -d db`.
    - Change the README's Node prerequisite to 24.
    - Verify: all three checks pass in both apps, and `check:cuits` passes, since the docs are scanned too.

**Manual acceptance at the end** (from the spec):
1. The three checks pass in both apps.
2. Lint fails on the bans. Done in steps 6 and 9.
3. The CUIT check fails on an off-allowlist CUIT, and passes on an allowlisted one and on a wrong check digit. Done in step 7.
4. Backend tests fail with Postgres stopped. Done in step 3.
5. `npm run start:dev` and `npm run dev` both start.

## Doors

Every part is a **two-way door**. There's no data, no authentication and nothing leaves the system, so a revert undoes all of it.

| Part | Door | Note |
| --- | --- | --- |
| Backend and frontend apps, ESLint, Vitest, lockfiles | Two-way | Tooling only. |
| `PrismaModule`, empty schema, test harness | Two-way | No models and no migrations. The harness only drops databases whose names end in `_test`, so it can't touch the dev database or a future production one. |
| `docker-compose.yml` (`db`, `postgres:17-alpine`) | Two-way | Changing the Postgres major version is free until slice 8 stores real data. After that it needs a dump and restore, so slice 8 should confirm it. |
| `Money`, `clock.ts`, `isValidCuit` | Two-way | Nothing calls them yet. |
| CUIT check and CI workflow | Two-way | The workflow only reads code that's already public. It prints masked values only. |
| Deleting three rows from `codingStandards.md` | Two-way | A revert restores them. The check covers CUITs only. Real supplier names and amounts are still guarded only by the rule in `agents.md`, and from now on no review row covers them. |
| Third-party telemetry | Not opened | `@nestjs/observe` isn't installed. `prisma init`, which installs agent skills into `.claude/`, isn't run. |
