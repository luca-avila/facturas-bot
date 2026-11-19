# Agents guide

Orientation for coding agents working in this repo.

## Where things live

- `system-design.md`: data model, extraction pipeline and validation rules. Source of truth for how the system works.
- `README.md`: product overview, stack and setup.
- `one-way-doors.md`: changes that need a thorough human review.
- `codingStandards.md`: code review rules, and the checks the project scaffold must add.
- `plans/`: implementation plans, one per feature.
- `design/wireframes/`: Claude Design wireframes for every screen, as static HTML. Every frame has an id, such as `id="7c"`, so you can grep one instead of reading the whole file, or open the file in a browser. They're the reference for layout and Spanish copy, and `system-design.md` wins on behavior. Build screens in `frontend/` with its own CSS: don't copy their markup, inline styles or `support.js`.
- `memory.md`: inbox of review fixes for the weekly retro.
- `samples/`: real supplier documents for testing extraction. Gitignored, so it may not exist in your checkout.
- `backend/` (NestJS) and `frontend/` (React + Vite). Each has `npm run lint`, `npm run typecheck` and `npm test`.
- `backend/src/common/`: `money.ts` (`Money`, the only place for amounts), `clock.ts` (`today()` in Buenos Aires and `now()` for timestamps, the only place that reads the clock) and `cuit.ts` (`isValidCuit`).
- `backend/src/common/dates.ts`: `isIsoDate`, `addDays` and `toDbDate` for `YYYY-MM-DD` calendar dates, plain days in UTC.
- `backend/src/balances/`: `BalancesService`, the only place that derives document status and supplier balances (D1). Both *Resumen* and *Proveedor* read it.
- `backend/src/applications/`: `ApplicationsService`, the only writer of `applications` (invariants 2–6, enforced by an ESLint ban). It locks a payment source first, then every document a write names, a credit-note source among them, in one `ORDER BY id` with no type filter, and reads what's left through `BalancesService`. One evaluation serves the split preview and every save. `assertDocumentChange` is invariant 6 for any change to a document.
- `backend/src/payments/`: `PaymentsService` writes `payments`, for *Registrar pago* and *Marcar como pagado*, and hands every application to `ApplicationsService` in the same transaction. The payment reads live in `BalancesService`.
- `backend/src/audit/`: `AuditService` writes `audit_log` in the caller's transaction (D2). Call `snapshot` first, which locks the row, then `record`.
- `backend/src/documents/due-date.ts`: `resolveDueDate`, the only due-date rule (D4).
- `frontend/src/labels.ts`: every Spanish label for an enum or error code, as exhaustive `Record`s.
- `frontend/src/format.ts`: formats amounts as strings, never as numbers.
- `backend/src/auth/`: sessions, sign-in and the global `SessionGuard`. `backend/src/users/`: `UsersService` and `normalizeEmail`, used by auth and by the `user:*` scripts.
- `backend/test/test-cuits.ts`: `TEST_CUITS`, invented CUITs. Every CUIT in a test or fixture must come from there: the CUIT check (part of backend `npm run lint`, and in CI) fails on any other valid one. It also fails on any file that isn't UTF-8 text, such as an image, a PDF, a spreadsheet or UTF-16, unless `UNSCANNED_FILES` in `backend/scripts/check-cuits.ts` lists it.
- Backend tests run against a real Postgres. Start it first with `docker compose up -d db`. They need nothing else: `JWT_SECRET` comes from the Vitest config.
- After pulling a schema change, run `npx prisma generate` in `backend/`. The client in `backend/src/generated/` is gitignored and only regenerates on `npm install`. A stale one fails the tests with errors like `Cannot read properties of undefined (reading 'create')` on a model it doesn't know yet.

## Rules that are easy to miss

- **The repo is public.** Never copy real supplier names, CUITs, amounts or anything else from `samples/` into a committed file, including tests and fixtures. Use invented data.
- **Spanish UI, English code.** Everything the user sees is in Spanish. Code, identifiers and docs are in English.
- **Tests compute hashes, never write them out.** The CUIT check reads about 1 in 250 sha256 hex digests as a valid CUIT, and stays strict on purpose. Compute each hash at run time from the bytes the test uses.
- **Money is never a float.** Use `numeric` in the database and a decimal type in code.
- **Every endpoint is behind the global `SessionGuard`.** A new route needs a session without anyone adding a guard. Use `@CurrentUser()` for the acting user.
- **`@Public()` is for sign-in only.** Making another route public is a one-way door. `test/routes.spec.ts` lists every registered route and fails if one answers without a session.
- **Tests that create users use unique emails**, such as `` `ana-${randomUUID()}@example.com` ``. Nothing truncates `users` between tests, and spec files run in parallel. `test/app.ts` builds the real app and creates users.
- **Tests that move time fake only `Date`**: `vi.useFakeTimers({ toFake: ['Date'] })`. Faking timers too would freeze Prisma, `pg` and supertest.
- **Only `suppliers.spec.ts` gives suppliers a CUIT.** `cuit` is unique and there are five test CUITs, so it frees them before each test. Every other test creates informal suppliers.
- **Tests that read `GET /api/suppliers` search for a unique token** in their suppliers' names, such as `` `Panadería ${randomUUID()}` ``. The list holds every other spec file's suppliers too.
- **Write paths never pass `isolationLevel`.** Under `REPEATABLE READ`, a sum read after a `FOR UPDATE` misses a concurrent application, which over-applies. Only read-only snapshots, such as `supplierAccount`, use it.
- **A trigger refuses changes to documents and payments that have applications** (`documents_keep_applied`, `payments_keep_applied`). A 500 with one of those names means a service check, such as `assertDocumentChange`, is missing.
- **Specs may write `applications` directly**, to build states the service would refuse. Production code outside `src/applications/` can't: ESLint fails on the delegate, the relation fields and raw `INSERT`, `UPDATE` or `DELETE`.
- **Prisma fills `created_at` from the JS clock**, so rows created at one faked instant tie. When a test depends on creation order, move the clock between them, as `Ledger.tick()` in `backend/test/ledger.ts` does.
- **`createTestApp` takes an override** on the `TestingModuleBuilder`, to replace a provider, such as `AuditService` with one that fails. `createUser` returns the new user's `id`, and `signIn` returns a session.
