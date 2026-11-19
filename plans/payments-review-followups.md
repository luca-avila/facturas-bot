# Plan: Payments review follow-ups

Five fixes from the review of `feat/payments-and-applications`, all approved by the user. The work stays on that branch, from HEAD `02037b3`. No new branch.

Read first: `agents.md`, `codingStandards.md`, `one-way-doors.md`, and [`payments-and-applications.md`](payments-and-applications.md) for invariants 2–6 and the locks.

**Commits.** One commit per step, five in all. Messages end at the body, with no trailers of any kind: no `Co-Authored-By`, no `Claude-Session`, no `Signed-off-by`, and no "Generated with" line. This overrides any attribution reminder the harness adds. Every earlier commit on this branch carries a `Co-Authored-By` line, so don't copy the format from `git log`. The user will strip those after the review, and this plan doesn't touch history.

**Checks.** In `backend/` and in `frontend/`: `npm run lint`, `npm run typecheck` and `npm test`. Backend tests need `docker compose up -d db` first.

## Goal

- A request that names a credit note as a row, or an invoice as a credit-note source, gets its 409 instead of a 500 from a deadlock.
- *Registrar pago* opened without a supplier asks the person to pick one, instead of preselecting the first by name.
- *Pago registrado* lists each document once, with everything the payment applied to it.
- The ESLint ban on writing `applications` also catches a destructured delegate and schema-qualified SQL.
- The rollback tests for saving a payment and *Marcar como pagado* fail if the payment and its applications don't roll back together.

## Out of scope

- Editing or deleting payments, and any other change to what the split accepts or refuses.
- Rewriting the branch history to strip the existing trailers. The user will do that.
- `plans/payments-and-applications.md`. It stays as the record of the original plan, and this plan records the new lock order.
- `memory.md`, the reviewer's inbox.
- *Registrar pago* with a `?proveedor=` id that doesn't exist, from a stale link. It still shows an empty option, and *Siguiente* still gets the malformed-request message, as today.
- Lint cases that can't be detected from one literal: SQL built in a variable, a table name split around an interpolation (`${schema}.applications`), `Reflect.get(tx, 'application')`. Also `UPDATE ONLY`, `MERGE INTO` and `COPY`, which nobody uses and nobody asked for.
- Frontend DOM or component tests. The repo has none (Vitest runs with `environment: 'node'`), so items 2 and 3's screen changes are checked by hand.

## Decisions

**Item 1: the user picked option (b), on 2026-11-19.** There's no type filter on any lock. A payment source keeps its own lock first. A credit-note source is locked in the same `ORDER BY id FOR UPDATE` statement as the named rows. Each write then takes every document lock it needs in one id-ordered statement, or locks a single row, and payments are never locked after documents. So no two writers can wait on each other in a cycle, whatever ids a request names.

**Verified facts.** Checked on 2026-11-19 against Postgres 17.9 (the compose image, `deadlock_timeout` 1 s), in a scratch database that has since been dropped. These aren't open to the implementer.
- **The reported case.** A third connection holds credit note NC1 (id above invoice F's). A applies NC1 to F with today's code: it locks NC1, then F, so it waits on the holder with nothing locked. B, a payment with rows [NC1, F], locks F, then waits on NC1. When the holder commits, B gets 40P01, every time (3 of 3).
- **The mirror case.** A sends invoice F as a `credit_note` source with rows [G], where G's id is lower. B, a payment with rows [F, G], is a concurrent request. With the same holder setup on F, B gets 40P01 every time (2 of 2). This happens with today's code, and also with a type filter on the row lock only.
- **Option (b).** Both cases end without a deadlock (2 of 2 each). A waits on the holder while holding the lower id, and B waits on A. Once the holder commits, A finishes first, then B.
- **Why not filter on type.** A `FOR UPDATE` that filters on `type` skips a row whose type an uncommitted transaction is changing, and it doesn't wait (2 ms). The next statement then sees the new type, and the row was never locked. Slice 5's worker and slice 6's edit will change types, so a filtered lock would let a write read and apply to a document it never locked.
- **`pg_blocking_pids(pid)` shows who waits on whom.** Polling it tells a test when a request is waiting on a lock. It only lists the waiters of the given pids, so spec files running in parallel against the same test database don't interfere.

**Item 5.** For a new payment, an application can't commit on its own, because it references a payment the same transaction hasn't committed yet. So the "no payment" assertion is the one that catches applications escaping the payment's transaction. The tests also check which audit entry threw, which proves the request got as far as writing an application.

## Interface

There are no new endpoints and no new public methods. The HTTP contract is unchanged, except for one meaning in item 3.

- **Item 1.** `ApplicationsService`'s public methods are unchanged. The private `lockDocuments(tx, ids: string[])` takes ids instead of rows. Responses are unchanged:
  - a credit note sent as a row still gets 409 `not_applicable` on `applications.<id>`
  - an invoice sent as a `credit_note` source still gets 409 `not_applicable` on `source`
- **Item 2.** Only the *Registrar pago* screen changes.
- **Item 3.** `GET /api/payments/:id` keeps its shape. `PaymentDetail.applications` now has exactly one entry per document, and `amount` is the sum of what this payment applied to that document, across all its applications. The rows stay in split order.
- **Item 4.** New selectors in `backend/eslint.config.mjs`.
- **Item 5.** Test code only.

## Behaviors to test

**Lock order** (`backend/src/applications/apply-credit.spec.ts`, new `describe('lock order')`). Both cases go through HTTP and use the helpers in step 1. A third connection holds one document's row lock. Each case waits, through `pg_blocking_pids`, until the first request is waiting on that lock and the second is waiting too. Then it releases the lock. Neither request ever gets a 500.
- **A credit note named as a row while it's being applied.** Invoice F of 50.00 has the lower id, and credit note NC of 30.00 the higher. The holder locks NC.
  - First request: apply NC to F for 30.00. It gets 204.
  - Second request: a payment of 20.00 with rows NC 10.00 and F 10.00. It gets 409 `{ errors: [{ field: 'applications.<NC>', code: 'not_applicable' }] }`.
  - Afterwards, F's only application is 30.00, and the supplier has no payment.
- **The mirror case.** Invoice G of 50.00 has the lower id, and invoice F of 50.00 the higher. The holder locks F.
  - First request: apply with `source: { kind: 'credit_note', id: F }` and row G 10.00. It gets 409 `{ errors: [{ field: 'source', code: 'not_applicable' }] }`.
  - Second request: a payment of 20.00 with rows F 10.00 and G 10.00. It gets 201.
  - Afterwards, the applications are `[[G, '10.00'], [F, '10.00']]`.
- Both cases fail with today's code: one request gets a 500 after about 1 s, Postgres's deadlock timeout. Both pass five runs in a row with the fix.
- These existing tests stay green unchanged:
  - in `payments.spec.ts`, *invariants 4 and 5: refuses a row for a credit note with not_applicable*
  - in `apply-credit.spec.ts`, *an invoice sent as a credit note*
  - both concurrency suites

***Registrar pago*, by hand.** Run both apps in dev mode: backend `npm run start:dev`, frontend `npm run dev`. Sign in as a user made with `npm run user:create`.
- **Opened from *Pagos*, with no `?proveedor=`.**
  - *Proveedor* reads *Elegí un proveedor*, and no *Debe … · vencido …* line shows.
  - *Siguiente: repartir* is disabled.
  - Pressing Enter in *Monto* sends nothing: the network tab shows no `POST /api/applications/preview`.
  - *Cancelar* goes to `/pagos`.
- **Picking a supplier.** The placeholder disappears, *Debe … · vencido …* shows that supplier's figures, and *Siguiente* is enabled. The whole flow then saves as before.
- ***Atrás* from step 2** keeps the picked supplier.
- **Opened from *Proveedor*, with `?proveedor=<id>`.** That supplier comes preselected, as before.
- ***+ Registrar pago* on *Pagos* filtered by a supplier** comes preselected the same way.

**Payment detail** (`backend/src/payments/payments.spec.ts`, under `GET /api/payments/:id`)
- **New: one row per document.** Invoice A of 100.00 is due 2026-11-05, and invoice B of 50.00 is due 2026-11-20 (the `aAndB` helper).
  - Record a payment of 120.00 with rows B 20.00 and A 50.00.
  - Apply 30.00 of its leftover to A, through `POST /api/applications` with `source: { kind: 'payment', id }`.
  - The detail has `applied` 100.00, `unapplied` 20.00 and `status` `available`.
  - `applications` equals, in this order:
    - A with `amount` 80.00, `overdue`, `remaining` 20.00, `partial` true
    - B with `amount` 20.00, `pending`, `remaining` 30.00, `partial` true
  - Today's query fails it, because it returns A twice.
- The existing *lists what it applied, in split order* test stays green unchanged.
- **By hand:** *Pago registrado* for that payment shows one row for A, *aplicado $ 80,00*. The browser console shows no duplicate-key warning.

**Lint** (`backend/test/lint-bans.spec.ts`)
- **Errors in `src/main.ts`**, exactly one `no-restricted-syntax` each:
  - `const { application } = tx; application.create(…)`
  - `const { application: apps } = tx; apps.create(…)`
  - `prisma.$transaction(({ application }) => application.create(…))`
  - `` tx.$executeRaw`INSERT INTO public.applications …` ``
  - `'insert into "public"."applications" …'` in a string literal
  - `` tx.$executeRaw`UPDATE public.applications SET …` ``
  - `'DELETE FROM "public".applications'` in a string literal
- **Allowed in `src/main.ts`:**
  - `` tx.$queryRaw`SELECT SUM(amount) FROM public.applications WHERE …` ``
  - `'SELECT amount FROM "public"."applications"'`
  - an object literal `({ application: rows })`, which shows the new selector only fires on destructuring
- **Allowed in `src/applications/applications.service.ts` and in a spec file:** the destructured delegate.
- **The existing cases stay as they are,** including the reads `SELECT … FROM applications` and `{ applications: rows }`.

**Rollback** (`backend/src/audit/audit-rollback.spec.ts`). The failing audit service writes each entry, records its entity, and throws on the first entry for the entity the test chose. Each test checks the 500, that nothing is left, and which entities the service saw:

| Test | Fails on | Entities seen |
| --- | --- | --- |
| creating a supplier | `suppliers` | `['suppliers']` |
| updating a term | `suppliers` | `['suppliers']` |
| entering a document | `documents` | `['documents']` |
| deleting a document | `documents` | `['documents']` |
| saving a payment with a split | `applications` | `['payments', 'applications']` |
| applying credit | `applications` | `['applications']` |
| *Marcar como pagado* | `applications` | `['payments', 'applications']` |

- In the save and *Marcar como pagado* tests, the payment's own entry is written and passes. The application is then inserted, and its entry throws. The "no payment" assertion must fail if the payment commits apart from its applications. Step 5 proves that with a temporary change.

## Steps

### 1. Lock a credit-note source with the rows (item 1)

- **Write the tests first**, in `backend/src/applications/apply-credit.spec.ts`, as a new `describe('lock order')` after `describe('concurrency')`. The helpers live in the spec, since nothing else uses them:
  - `holdLock(documentId)`:
    - Opens `ledger.prisma.$transaction(async (tx) => …, { timeout: 10_000 })`.
    - Inside, it reads `SELECT pg_backend_pid() AS pid`, runs `SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`, then awaits a release promise.
    - It resolves `{ pid, release }` once the lock is held. `release()` resolves the promise and awaits the transaction.
    - It races its "locked" promise against the transaction's own promise, so a failed transaction rejects instead of hanging.
  - `waitersOn(pids: number[], count: number): Promise<number[]>`:
    - Polls `SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && ${pids}::int[]` every 10 ms with `setTimeout`, up to 300 times.
    - It returns the pids once there are at least `count`, and throws otherwise.
    - Use no `Date`: the spec fakes it, and the clock ban applies to specs.
  - **Each case:**
    1. Create a supplier.
    2. Generate two `randomUUID()`s and sort them. Postgres orders UUIDs the same way as their lowercase strings.
    3. Insert both documents with `ledger.insertDocument(supplier, { id, … })`. The credit note also takes `type: 'credit_note'`, `due_date: null` and `due_date_source: null`, which its `CHECK` requires.
    4. Run `holdLock` on the held document.
    5. Start the first request with `.then((res) => res)`. Supertest only sends a request once something calls `then`.
    6. Run `const [firstPid] = await waitersOn([holder.pid], 1)`.
    7. Start the second request.
    8. Run `await waitersOn([holder.pid, firstPid], 2)`. The second request always waits by now: with the fix, on the first request, which holds the lower id; without it, on the held row.
    9. Release the holder, await both responses, and assert as in *Behaviors to test*.
  - Check that both cases fail with the current code: one request gets a 500 (40P01) after about 1 s.
- **Change `backend/src/applications/applications.service.ts`:**
  - `lockDocuments(tx, ids: string[])` keeps its SQL, `SELECT id FROM documents WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`, with no type filter.
  - `applyCredit`:
    - For a `payment` source, lock the payment as today, then `lockDocuments(tx, rowIds)`.
    - For a `credit_note` source, drop the separate source lock and call `lockDocuments(tx, [source.id, ...rowIds])`.
  - `applyNewPayment` passes `rows.map((row) => row.documentId)`, and `lockToSettle` passes `[documentId]`.
- **Docs, worded along these lines:**
  - The class comment: *Every write locks in one fixed order. An existing payment source comes first. Then every document the write names, a credit-note source among them, is locked in one `ORDER BY id FOR UPDATE`, whatever its type. Payments are never locked after documents, so no two writers can wait on each other in a cycle, whatever a request names. The lock doesn't filter on type on purpose: a filtered lock skips, without waiting, a row whose type another transaction is changing. Then a new statement reads what's left through `BalancesService`.* Keep the existing sentence about `isolationLevel`.
  - `applyCredit`'s comment: *Locks a payment source first, then the documents. A credit-note source is locked with the documents, in id order.*
  - `lockDocuments`'s comment: *Locks these documents in `id` order, in one statement, whatever their type.*
  - `agents.md`, line 19: replace *It locks the source first, then the documents by id* with *It locks a payment source first, then every document a write names, a credit-note source among them, in one `ORDER BY id` with no type filter*.
- **Verify:**
  - The two new tests pass five runs in a row: `npx vitest run src/applications/apply-credit.spec.ts`, five times.
  - The three backend checks pass.
- **Commit:** `review: lock a credit-note source with the rows, in id order, so no request deadlocks`

### 2. *Registrar pago* starts without a supplier (item 2)

- **In `frontend/src/screens/RegistrarPago.tsx`:**
  - In the `listSuppliers` effect, keep `d.supplierId` as it is. Drop the fallback to `result.value.suppliers[0]?.id`, and keep the `paidOn` default.
  - The option shown when no supplier matches keeps its `value`, and its text becomes:
    - *Cargando…* while the list loads
    - *Elegí un proveedor* when `details.supplierId` is `''`
    - `''` otherwise, which only happens for an unknown `?proveedor=` id
  - Leave the option enabled: it disappears once a supplier is picked.
- **What already handles an empty supplier.** None of these change:
  - *Siguiente* is disabled on `supplierId === ''`, which also blocks the Enter key (a form whose default button is disabled doesn't submit).
  - `next()` is the only call to `previewSplit` with this supplier. Step 2's `useSplit` uses the source step 1 built.
  - *Debe … · vencido …* only shows for a matched supplier.
  - *Cancelar* goes to `/pagos` while nothing is picked.
- **Verify:**
  - The frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
  - The manual checks under *Behaviors to test*, at 390 px wide.
- **Commit:** `review: start Registrar pago without a supplier unless the link names one`

### 3. *Pago registrado* lists one row per document (item 3)

- **Write the new test first** in `backend/src/payments/payments.spec.ts`, and check that it fails because A appears twice.
- **In `BalancesService.payment`** (`backend/src/balances/balances.service.ts`), sum the applications per document before joining, as the supplier sums do:

  ```sql
  WITH counted AS (${this.counted(today())}),
  given AS (
    SELECT document_id, SUM(amount) AS amount
    FROM applications WHERE payment_id = ${id}::uuid
    GROUP BY document_id
  )
  SELECT c.id AS document_id, c.type, c.letter, c.number, g.amount::text AS amount,
         c.status, c.remaining::text AS remaining, c.partial
  FROM given g JOIN counted c ON c.id = g.document_id
  ORDER BY c.sort_date, c.issue_date_value, c.created_at, c.id
  ```

  Its comment adds that a document appears once, summed, when the payment applied to it more than once.
- **Types:**
  - In `backend/src/balances/balances.types.ts`, `PaymentDetail.applications` becomes *One per document, in split order.* `PaymentApplication.amount` becomes *What this payment applied to it, across all its applications to it.*
  - In `frontend/src/accounts-api.ts`, `PaymentDetail.applications` gets the same two comments.
- **In `frontend/src/screens/PagoRegistrado.tsx`:** key the rows by `application.documentId`, drop the `index` parameter, and delete the comment about a document appearing twice.
- **Verify:**
  - The new test passes, and the three checks pass in both apps.
  - The manual check under *Behaviors to test*.
- **Commit:** `review: list each document once in Pago registrado, with what the payment applied to it`

### 4. Extend the `applications` write ban (item 4)

- **Write the lint cases first** in `backend/test/lint-bans.spec.ts`:
  - Add the new writes to `applicationWrites` and the new reads to `applicationReads`.
  - Add the destructured delegate to *allows tx.application.create(…) in src/applications/ and in spec files*.
  - Run `npx vitest run test/lint-bans.spec.ts`. The new write cases fail, and the new read cases pass.
- **In `backend/eslint.config.mjs`:**
  - Add two selectors next to the delegate ones, with the comment *The delegate destructured, as `{ application }`, renamed, or in a parameter*:

    ```js
    { selector: "ObjectPattern > Property[key.name='application']", message: APPLICATIONS_MESSAGE },
    { selector: "ObjectPattern > Property[key.value='application']", message: APPLICATIONS_MESSAGE },
    ```

  - Allow an optional schema in `WRITE_SQL`, and change its comment to *Raw SQL, in template and string literals, with or without a schema*:

    ```js
    const WRITE_SQL = String.raw`/\b(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+("?\w+"?\s*\.\s*)?"?applications\b/i`;
    ```

    The schema group needs a dot, so `FOR UPDATE OF applications` and `applications_count` still don't match.
- **Verify:**
  - The lint spec passes.
  - The backend `npm run lint` passes, which shows nothing existing trips the new selector: no file outside `src/applications/` destructures an `application`.
  - Then `npm run typecheck` and `npm test`.
- **Commit:** `review: ban a destructured applications delegate and schema-qualified writes`

### 5. Make the payment rollback tests able to fail (item 5)

- **In `backend/src/audit/audit-rollback.spec.ts`, `FailingAuditService` gets two fields:**
  - `failOn: AuditEntity | null`, set by each test. With `null` nothing throws, so a test that forgets to set it fails on its `.expect(500)` instead of passing for nothing.
  - `entities: AuditEntity[]`, the entity of each entry asked for, in order. The last one is the entry that threw.
- **`record`** pushes the entity, calls `super.record`, then throws when `entry.entity === this.failOn`.
- **Setup:**
  - In `beforeAll`, take `app.get(AuditService)` and check it's an instance of `FailingAuditService`.
  - A `beforeEach` resets `failOn` to `null` and `entities` to `[]`.
- **Each test** sets `failOn` first. It keeps its current assertions and adds `entities`, as in the table under *Behaviors to test*.
- **Verify:**
  - The spec and the three backend checks pass.
  - **Temporary check, not committed:**
    1. In `PaymentsService.create`, move `applyNewPayment` into a second `this.prisma.$transaction`, after the one that inserts the payment.
    2. The *saving a payment* rollback test now fails on the payment count.
    3. Do the same in `markPaid`, and the *Marcar como pagado* test fails the same way.
    4. Revert both with `git checkout backend/src/payments/payments.service.ts`.
- **Commit:** `review: fail the payment rollback tests on the application's audit entry`

## Doors

| Part | Door | Note |
| --- | --- | --- |
| Item 1: lock order in `ApplicationsService` | Two-way now. **One-way in effect from slice 8**, as the feature plan's blast radius says of the whole write path | It only changes which rows are locked, and when. It writes no data and leaves the evaluation alone. It removes a 500 and opens no gap: every document a write reads is locked first, and nothing depends on a column another transaction can change. Review the order in `applyCredit` and the lack of a type filter. |
| Item 1: the two lock-order tests | Two-way | Test code. They hold one row for well under the 5 s Prisma transaction timeout. |
| Item 2: *Registrar pago* default | Two-way | UI only. It shrinks a real risk: from slice 8, a payment saved against the wrong supplier can only be fixed in SQL. |
| Item 3: payment detail grouping | Two-way | A read of derived values. Nothing is stored. |
| Item 4: lint ban | Two-way | Tooling only. |
| Item 5: rollback tests | Two-way | Test code only. |

Nothing here is on the [one-way list](../one-way-doors.md). No migration, no change to stored data, and no change to authentication.
