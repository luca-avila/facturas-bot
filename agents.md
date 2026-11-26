# Agents guide

Orientation for coding agents working in this repo.

## Where things live

- `system-design.md`: data model, extraction pipeline and validation rules. Source of truth for how the system works.
- `README.md`: product overview, stack and setup.
- `one-way-doors.md`: changes that need a thorough human review.
- `codingStandards.md`: code review rules.
- `plans/`: implementation plans, one per feature, and the reviewer's report on each, `<slug>.review.md`, which ends with the merge danger section.
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
- `frontend/src/screens/screen-test.tsx`: helpers for screen tests, `*.spec.tsx`, which run in jsdom. `stubApi` replaces `fetch` with routes that can share state, so a save changes the next read, and `renderAt` renders a screen at its route. Any frontend test that logs `console.error` fails (`frontend/test/setup.ts`): that's where React reports duplicate keys and updates outside `act()`.
- `backend/src/uploads/`: `UploadsService` is the only writer of `document_images`, and creates `extraction_jobs`, as `DocumentsService.retry` does (ESLint ban). It takes `ADVISORY_LOCKS.uploads` before the same-image check. `ImageStore` is the only code that touches `UPLOAD_DIR`, and it writes bytes as they arrive (E5). `ImageStoreModule` shares `ImageStore` with the worker.
- `backend/src/extraction/`: the worker. `ExtractionCall` is the only code that sends anything to Anthropic. `ExtractionWorker` and `ExtractionWriter` are the only writers of `document_lines` and `document_taxes`, and update `extraction_jobs` after an upload or a retry creates them (ESLint ban). `prompt.ts` holds the prompt, schema, effort and `max_tokens`: changing any of them bumps `PROMPT_VERSION` (E4). `backend/src/worker.ts` is the worker's own process.
- `backend/src/documents/issues.ts`: every issue code, in stored order.
- `backend/src/common/advisory-locks.ts`: every advisory lock key.
- `frontend/src/photos.ts`: the only place for compression settings, a one-way door.
- `backend/src/auth/`: sessions, sign-in and the global `SessionGuard`. `backend/src/users/`: `UsersService` and `normalizeEmail`, used by auth and by the `user:*` scripts.
- `backend/test/test-cuits.ts`: `TEST_CUITS`, invented CUITs. Every CUIT in a test or fixture must come from there: the CUIT check (part of backend `npm run lint`, and in CI) fails on any other valid one. It also fails on any file that isn't UTF-8 text, such as an image, a PDF, a spreadsheet or UTF-16, unless `UNSCANNED_FILES` in `backend/scripts/check-cuits.ts` lists it.
- Backend tests run against a real Postgres. Start it first with `docker compose up -d db`. They need nothing else: `JWT_SECRET` comes from the Vitest config.
- After pulling a schema change, run `npx prisma generate` in `backend/`. The client in `backend/src/generated/` is gitignored and only regenerates on `npm install`. A stale one fails the tests with errors like `Cannot read properties of undefined (reading 'create')` on a model it doesn't know yet.

## Rules that are easy to miss

- **The repo is public.** Never copy real supplier names, CUITs, amounts or anything else from `samples/` into a committed file, including tests and fixtures. Use invented data.
- **Spanish UI, English code.** Everything the user sees is in Spanish. Code, identifiers and docs are in English.
- **Every review fix gets a `memory.md` line, including one that lands later**, from an answered open question or a follow-up plan. Its commit message starts with `review:`. A plan that fixes review findings never puts `memory.md` out of scope.
- **Tests compute hashes, never write them out.** The CUIT check reads about 1 in 250 sha256 hex digests as a valid CUIT, and stays strict on purpose. Compute each hash at run time from the bytes the test uses.
- **Money is never a float.** Use `numeric` in the database and a decimal type in code.
- **Every endpoint is behind the global `SessionGuard`.** A new route needs a session without anyone adding a guard. Use `@CurrentUser()` for the acting user.
- **`@Public()` is for sign-in only.** Making another route public is a one-way door. `test/routes.spec.ts` lists every registered route and fails if one answers without a session.
- **Tests that create users use unique emails**, such as `` `ana-${randomUUID()}@example.com` ``. Nothing truncates `users` between tests, and spec files run in parallel. `test/app.ts` builds the real app and creates users.
- **Tests that move time fake only `Date`**: `vi.useFakeTimers({ toFake: ['Date'] })`. Faking timers too would freeze Prisma, `pg` and supertest.
- **Each spec file that gives suppliers a CUIT has its own group in `backend/test/test-cuits.ts`**, and frees only that group before each test. `RESTAURANT_TEST_CUIT` is never a supplier's.
- **Worker specs call `runOnce({ documentIds })` with their own documents.** The shared test database holds every spec file's queued uploads.
- **Backend tests never reach the network**: `test/no-network.ts` replaces `fetch`, and worker specs pass a `FakeLlm` through `LLM_FETCH`.
- **The worker's write locks the job, then the document, then the supplier.** A new writer that locks a supplier and then its documents must not lock a `processing` one.
- **`AuditService.recordByWorker` is for `src/extraction/` only.** Every other entry has a user (D2).
- **Starting the worker sends every queued upload in that database to Anthropic.** Delete the uploads you don't want sent first: a deleted document's job ends without a call.
- **Tests that read `GET /api/suppliers` search for a unique token** in their suppliers' names, such as `` `Panadería ${randomUUID()}` ``. The list holds every other spec file's suppliers too.
- **Write paths never pass `isolationLevel`.** Under `REPEATABLE READ`, a sum read after a `FOR UPDATE` misses a concurrent application, which over-applies. Only read-only snapshots, such as `supplierAccount`, use it.
- **A trigger refuses changes to documents and payments that have applications** (`documents_keep_applied`, `payments_keep_applied`). A 500 with one of those names means a service check, such as `assertDocumentChange`, is missing.
- **Specs may write `applications` directly**, to build states the service would refuse. Production code outside `src/applications/` can't: ESLint fails on the delegate, the relation fields and raw `INSERT`, `UPDATE` or `DELETE`.
- **Prisma fills `created_at` from the JS clock**, so rows created at one faked instant tie. When a test depends on creation order, move the clock between them, as `Ledger.tick()` in `backend/test/ledger.ts` does.
- **`createTestApp` takes an override** on the `TestingModuleBuilder`, to replace a provider, such as `AuditService` with one that fails. `createUser` returns the new user's `id`, and `signIn` returns a session.
- **Tests build photos with `backend/test/photos.ts`.** Never commit an image file: the CUIT check fails on binaries.
- **Tests get `UPLOAD_DIR` from the Vitest config.** The backend won't start without it in `.env`.
- **Uploads in a spec file that checks files on disk use their own `UPLOAD_DIR`**, through `vi.stubEnv` before `createTestApp()`.
- **The phone reaches the dev server over plain HTTP, which isn't a secure context.** `crypto.randomUUID`, `crypto.subtle` and `getUserMedia` don't exist there.
