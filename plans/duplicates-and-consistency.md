# Plan: Duplicates and consistency checks (slice 7)

Spec: [`mvp-slices.md`, section 7](mvp-slices.md#7-duplicates-and-consistency-checks).

## Goal

Add the four acceptable validation checks (`duplicate_suspected`, `totals_mismatch`, `lines_mismatch`, and `wrong_recipient`) to extraction, document editing, supplier term unblocking, and manual entry (for `duplicate_suspected`), so likely duplicates and misread sums stop before reaching balances while letting users explicitly accept valid printed documents and promote them to *Revisado*.

## Out of scope

- Side-by-side duplicate comparison screen (`6e` in wireframes): excluded from the MVP by user decision; *Documento* and *A resolver* show the suspected-duplicate warning with a direct link to the existing document plus accept/discard actions.
- Linking delivery notes to invoices and QR cross-checks (`system-design.md` Out of scope).
- `base × rate = tax` checks and per-line `quantity × unit_price` checks (`system-design.md` Validation).
- Database schema migrations: `documents.issues` (`jsonb not null default '[]'`) already stores issue objects, and `RESTAURANT_CUIT` already comes from `ExtractionConfig`.
- Editing `document_lines` or `document_taxes` (header-only in MVP).
- `memory.md`: this slice fixes no review findings.

## Decisions & Deviations

Deviations from existing design/specs:

- **Wireframe `6e` (*Posible duplicado · comparar*) omitted:** Per user decision, the side-by-side photo/field comparison screen (`6e`) and the *Comparar* button (`6b`) are deferred out of the MVP. Instead, `duplicate_suspected` shows its Spanish warning with a link (*Ver el existente*) to the matching document and direct *Aceptar igual* / *Descartar* actions in *A resolver* and *Documento*.

Confirmed answers to open questions 1, 9, and 10 in `plans/mvp-slices.md`, and design details within `system-design.md`:

1. **Manual entry checks `duplicate_suspected` (open question 1).** `POST /api/documents` checks `duplicate_suspected` (for types other than `opening_balance`). When a match exists and `allowSuspectedDuplicate` is not `true`, it returns `409 Conflict` with `{ errors: [{ field: 'document', code: 'duplicate_suspected', documentId }] }`. *Cargar documento* shows an inline warning with a link to the existing document and asks whether to *Guardar igual* (resending with `allowSuspectedDuplicate: true`). Saving with `allowSuspectedDuplicate: true` still creates the manual document directly as `reviewed`, recording `{ code: 'duplicate_suspected', acceptedBy, acceptedAt }` in `issues` when a match existed.
2. **`wrong_recipient` defaults to `RESTAURANT_CUIT` when missing/invalid (open question 9).** When `raw_output.recipientCuit` is missing, blank, or fails `isValidCuit`, it defaults to `RESTAURANT_CUIT` and `wrong_recipient` is skipped. `wrong_recipient` only triggers when extraction reads a valid 11-digit recipient CUIT that differs from `RESTAURANT_CUIT`.
3. **Accepted issues are NOT auto-preserved on edit (open question 10a).** Whenever a person saves header edits via `PUT /api/documents/:id`, every acceptable check is re-evaluated from scratch (including `wrong_recipient` if previously present on the document, since `recipientCuit` is immutable from extraction). An issue that was accepted before and still triggers after the edit requires explicit acceptance again.
4. **Edit behavior when acceptable issues trigger (open question 10b + `system-design.md` Review status):**
   - **On `error` documents:** All blocking checks must still pass (rejected with `400`/`409` field errors as in slice 6). When all blocking checks pass and acceptable issues trigger without being listed in `acceptIssues`, `PUT /api/documents/:id` **saves the edited header fields and keeps `review_status = 'error'`** (`reviewed_by = null`, `reviewed_at = null`) with the triggered acceptable issues stored open in `issues`, so the user can accept or further edit them. If zero acceptable issues trigger (or all triggered ones are included in `acceptIssues`), it becomes `reviewed`.
   - **On `unreviewed` and `reviewed` documents:** Per `system-design.md` and invariant 6 (`documents_keep_applied`), neither state ever returns to `error`. If an edit triggers any acceptable issue not listed in `acceptIssues`, `PUT /api/documents/:id` rejects with `409 Conflict` naming the triggered acceptable issue codes (and `documentId` for `duplicate_suspected`), writing nothing. *Documento* shows the triggered issue(s) and asks to confirm (*Aceptar y guardar*), resending `PUT` with `acceptIssues`. When all triggered issues are accepted, the document saves as `reviewed` with those issues recorded as accepted in the acting user's name.
5. **Tolerance and skip rules (`system-design.md` Validation & `extraction-test.ts`):**
   - Tolerance is exact `Money.fromString('1.00')`: `|a - b| <= 1.00` passes; `|a - b| > 1.00` (`>= 1.01`) fails.
   - `totals_mismatch`: skipped when `taxes.length === 0`, `subtotal === null`, or `total === null`. Otherwise checks `|subtotal + Σ(tax.amount) - total| <= 1.00`.
   - `lines_mismatch`: skipped when `lines.length === 0`, when any line has `lineTotal === null` (e.g., delivery notes with items and no prices), or when both `subtotal` and `total` are `null`. Otherwise passes when `|Σ(line.lineTotal) - subtotal| <= 1.00` (if `subtotal !== null`) OR `|Σ(line.lineTotal) - total| <= 1.00` (if `total !== null`).
6. **`duplicate_suspected` matching set (`system-design.md` Duplicates #3):**
   - Matches non-deleted documents (`deleted_at IS NULL`, D3) in `review_status IN ('unreviewed', 'reviewed')` with `type <> 'opening_balance'`, `id <> documentId`, same `supplier_id`, same `issue_date`, same `total`, where at least one of the two documents has `number_normalized IS NULL`.
   - Ignores `type` and `letter` across `invoice`, `delivery_note`, and `credit_note` (so an unnumbered delivery note and its invoice on the same date with the same total catch each other). `opening_balance` is excluded both as subject and as candidate, since opening balances are cutover totals, never purchases, and never carry numbers.
7. **Concurrency lock order for deduplication (C1).** Add `ADVISORY_LOCKS.documentDuplicates = 2` in `backend/src/common/advisory-locks.ts`. Every transaction that can introduce or promote a counted document's `(supplier_id, issue_date, total, number_normalized)` acquires `pg_advisory_xact_lock(ADVISORY_LOCKS.documentDuplicates)` as the **very first statement** of `$transaction` (holding zero other locks, making deadlocks with every existing row lock impossible):
   - `ExtractionWriter.writeIn`
   - `DocumentsService.createManual` (when `type !== 'opening_balance'`)
   - `DocumentsService.update` (when `type !== 'opening_balance'`)
   - `DocumentsService.acceptIssue`
   - `SuppliersService.setTerm`
8. **Stored `issues` JSONB shape & backward-compatible DTOs.**
   - `documents.issues` stores `StoredIssue[]`: `{ code: IssueCode, acceptedBy?: string, acceptedAt?: string }` in `ISSUE_CODES` order. Existing `[{ "code": "..." }]` rows remain valid without migration.
   - `ErrorDocumentRow.issues` and `DocumentDetail.issues` continue to expose `IssueCode[]` containing **open** (unaccepted) codes only, keeping existing API contracts intact. `DocumentDetail` adds `acceptedIssues` (with resolved user name and Buenos Aires date/time), `suspectedDuplicate`, and backend-computed `consistencySummary` (zero frontend arithmetic, D1). `ErrorDocumentRow` adds `suspectedDuplicateId`.
9. **Module boundaries.** `DuplicateSuspectedCheck` and `consistency-checks.ts` live in `backend/src/documents/` and are exported by `DocumentsModule`, so `ExtractionModule` and `SuppliersModule` share them without `AppModule` ever importing `ExtractionModule` or reading `RESTAURANT_CUIT`.
10. **Setting a supplier's term (`SuppliersService.setTerm`).** Preserves already-accepted issues on `error` documents (setting a supplier term is not editing a document), re-checks both `duplicate_number` and `duplicate_suspected` against counted rows and earlier unblocked rows in the same batch, and unblocks to `unreviewed` only when zero open issues remain.

## Interface

### Backend shared helpers (`backend/src/common/` & `backend/src/documents/`)

- `backend/src/common/advisory-locks.ts`: add `documentDuplicates: 2`.
- `backend/src/common/body.ts`: add `bodyWithOptionalKeys(body, requiredKeys, optionalKeys)` (still rejects unknown keys with `400`).
- `backend/src/common/field-errors.ts`:
  - Extend `FieldErrorCode` with `'duplicate_suspected' | 'totals_mismatch' | 'lines_mismatch' | 'wrong_recipient' | 'issue_not_acceptable'`.
  - Extend `FieldError` with optional `documentId?: string`.
- `backend/src/documents/issues.ts`:
  - Add `'duplicate_suspected'`, `'totals_mismatch'`, `'lines_mismatch'`, `'wrong_recipient'` to `ISSUE_CODES` in `system-design.md` order.
  - Export `ACCEPTABLE_ISSUE_CODES`, `AcceptableIssueCode`, `StoredIssue`, `isIssueCode`, `isAcceptableIssueCode`, `isAcceptedIssue`, `normalizeStoredIssues`, `openIssueCodes`, `sortStoredIssues`.
- `backend/src/documents/consistency-checks.ts` (pure, V1):
  - `AMOUNT_TOLERANCE = Money.fromString('1.00')`
  - `checkTotalsMismatch(input: { subtotal: Money | null; total: Money | null; taxes: readonly { amount: Money }[] }): boolean`
  - `checkLinesMismatch(input: { subtotal: Money | null; total: Money | null; lines: readonly { lineTotal: Money | null }[] }): boolean`
  - `checkWrongRecipient(recipientCuit: string | null, restaurantCuit: string): boolean`
  - `summarizeConsistency(input: { subtotal: Money | null; taxes: readonly { amount: Money }[]; lines: readonly { lineTotal: Money | null }[] }): ConsistencySummary`
- `backend/src/documents/duplicate-suspected-check.ts`:
  - `DuplicateSuspectedCheck` injectable provider with `findMatch(tx, query: { documentId: string | null; supplierId: string; issueDate: string; total: string; hasNumber: boolean }): Promise<SuspectedDuplicateRef | null>`.

### Backend HTTP endpoints (all behind global `SessionGuard`)

1. **`POST /api/documents/:id/issues/:code/accept`** (new):
   - Returns `204 No Content`.
   - `404` if `id` is not a UUID, unknown, or soft-deleted.
   - `400` with `{ errors: [{ field: 'code', code: 'issue_not_acceptable' }] }` if `code` is a blocking `IssueCode`; `400` malformed if `code` is not a known `IssueCode`.
   - `409` `not_editable` if document is not in `error` or `code` is not present in its `issues`.
   - Idempotent `204` if `code` is already accepted on that `error` document.
   - Otherwise marks `code` accepted (`acceptedBy: user.id`, `acceptedAt: now().toISOString()`). When zero open issues remain, re-checks `duplicate_number` and (unless already accepted) `duplicate_suspected` under `ADVISORY_LOCKS.documentDuplicates`; if none trigger, transitions document to `reviewed` with `reviewedById: user.id`, `reviewedAt: now()`; if a new concurrent duplicate triggers, adds it as open and keeps `error`. Writes `audit_log` (`documents`, `update`, `userId: user.id`) in the same transaction (D2).
2. **`POST /api/documents`** (extended):
   - Accepts optional `allowSuspectedDuplicate?: boolean` (default `false`).
   - Checks `duplicate_number` first, then `duplicate_suspected` (for `type !== 'opening_balance'`) under `ADVISORY_LOCKS.documentDuplicates`.
   - Returns `409` `{ errors: [{ field: 'document', code: 'duplicate_suspected', documentId }] }` if matched and `allowSuspectedDuplicate !== true`.
3. **`PUT /api/documents/:id`** (extended):
   - Accepts optional `acceptIssues?: AcceptableIssueCode[]` (default `[]`; passing a blocking or invalid code returns `400`).
   - Re-evaluates acceptable checks under `ADVISORY_LOCKS.documentDuplicates` without auto-preserving prior acceptances.
   - On `error`: saves edited header; stays `error` if any triggered acceptable issue is not in `acceptIssues`, or becomes `reviewed` if none remain open.
   - On `unreviewed` / `reviewed`: returns `409` `{ errors: [...] }` (naming every unaccepted triggered issue, with `documentId` for `duplicate_suspected`) when `unaccepted.length > 0`; otherwise saves as `reviewed` recording accepted issues in `user.id`'s name.
4. **Read DTO extensions:**
   - `GET /api/documents/:id` (`DocumentDetail`):
     - `issues: IssueCode[]` (open codes only, in `ISSUE_CODES` order)
     - `acceptedIssues: { code: AcceptableIssueCode; acceptedByName: string; acceptedOn: string; acceptedTime: string }[]`
     - `suspectedDuplicate: { id: string; type: Exclude<DocumentType, 'opening_balance'>; letter: string | null; number: string | null; issueDate: string; total: string } | null`
     - `consistencySummary: { taxSum: string | null; subtotalPlusTaxes: string | null; lineTotalSum: string | null }`
   - `GET /api/error-documents` (`ErrorDocumentRow`):
     - `issues: IssueCode[]` (open codes only, in `ISSUE_CODES` order)
     - `suspectedDuplicateId: string | null`
   - `POST /api/suppliers/:id/term/preview` and `POST /api/suppliers/:id/term`:
     - Unchanged response shape (`TermPreview`), with `remainingIssues` listing open issues (including newly detected `duplicate_suspected`) and preserving previously accepted issues on save.

### Frontend (`frontend/src/`)

- `frontend/src/accounts-api.ts`: extend `IssueCode`, `AcceptableIssueCode`, `FieldErrorCode`, `FieldError.documentId`, `DocumentInput.allowSuspectedDuplicate`, `UpdateDocumentInput.acceptIssues`, `DocumentDetail`, `ErrorDocumentRow`; add `acceptDocumentIssue(id, code)`.
- `frontend/src/labels.ts`: add Spanish labels to exhaustive `ISSUE_MESSAGES` and `FIELD_ERROR_MESSAGES`, plus accept-action labels.
- `frontend/src/screens/Documento.tsx`:
  - Open acceptable issue cards (with backend-computed `consistencySummary` figures or *Ver el existente* link for `duplicate_suspected`, and *Aceptar como está* / *Aceptar igual* / *Aceptar CUIT* buttons, disabled while unsaved form edits are dirty).
  - Struck-through accepted issues list (`Aceptado por <nombre> · fecha hora`).
  - Save confirmation prompt on `unreviewed`/`reviewed` documents when `PUT` returns `409` with acceptable issue codes (*Aceptar y guardar*), cleared on any field edit.
  - Distinct post-save notice when saving an `error` document leaves acceptable issues pending vs promotes to *Revisado*.
- `frontend/src/screens/AResolver.tsx`:
  - Inline accept quick actions (*Aceptar igual*, *Aceptar como está*, *Aceptar CUIT*), *Ver el existente* link when `suspectedDuplicateId !== null`, and *Descartar* on `duplicate_suspected`.
  - Updated *Elegir proveedor* notice that handles a document remaining in *Error* due to an open acceptable issue.
- `frontend/src/screens/DocumentForm.tsx`:
  - Inline suspected-duplicate confirmation panel on `409 duplicate_suspected` with *Ver el existente* link and *Guardar igual* (preserving *Guardar* vs *Guardar y cargar otro*), cleared on any field change.

## Behaviors to test

Tested through the public helpers, worker harness, HTTP endpoints against real Postgres (using invented `TEST_CUITS` only), and frontend screen tests (`*.spec.tsx`):

1. **Pure consistency & recipient checks (`consistency-checks.spec.ts`, V1):**
   - `totals_mismatch`: passes when exact, passes at exactly `+$1.00` and `-$1.00`, fails at `+$1.01` and `-$1.01`; skipped when there are no taxes, when `subtotal` is null, or when `total` is null.
   - `lines_mismatch`: passes when line sum matches `subtotal` within `$1.00` (even when differing from `total`), passes when line sum matches `total` within `$1.00` (tax-inclusive lines, even when differing from `subtotal`), fails when differing by `$1.01` from both; skipped when there are no lines or when any line has `lineTotal === null`.
   - `wrong_recipient`: passes when `recipientCuit === restaurantCuit`, passes (skipped) when `recipientCuit === null`, fails when `recipientCuit` is a valid CUIT different from `restaurantCuit`.
2. **Extraction mapping & worker (`extraction-mapping.spec.ts`, `extraction-checks.spec.ts`, `extraction-result.spec.ts`):**
   - `mapExtraction` normalizes valid `recipientCuit` (with/without hyphens) to 11 digits and maps missing/invalid `recipientCuit` to `null`.
   - Worker produces `totals_mismatch`, `lines_mismatch`, `wrong_recipient`, and `duplicate_suspected` in `ISSUE_CODES` order, sending the document to `error` (and leaving lines/taxes readable).
   - Delivery note with no taxes, no prices on lines, and no recipient CUIT passes cleanly to `unreviewed` (all skip rules hold).
   - Two different photos of the same unnumbered delivery note (same supplier, date, total): first reaches `unreviewed`, second reaches `error` with `duplicate_suspected`.
   - Same supplier and total on a different `issue_date` does NOT trigger `duplicate_suspected`.
   - Two numbered documents with the same supplier, date, and total (different numbers) do NOT trigger `duplicate_suspected`.
   - Numbered invoice + unnumbered delivery note with same supplier, date, and total DOES trigger `duplicate_suspected` (in either arrival order).
   - Deleted document or `error` document or `opening_balance` with same supplier, date, and total does NOT trigger `duplicate_suspected`.
   - Setting `RESTAURANT_CUIT` different from extracted valid `recipientCuit` produces `wrong_recipient`; matching `RESTAURANT_CUIT` or missing/invalid `recipientCuit` passes.
3. **Accepting issues (`documents.spec.ts`, `routes.spec.ts`):**
   - `POST /api/documents/:id/issues/:code/accept` requires a session (`401` in `routes.spec.ts`).
   - Refuses every blocking code (`extraction_failed`, `unsupported_document`, `supplier_unresolved`, `missing_total`, `missing_issue_date`, `supplier_term_missing`, `duplicate_number`) with `400 issue_not_acceptable`, leaving the document untouched.
   - Refuses unknown code (`400`), non-`error` document (`409 not_editable`), and acceptable code not present on the document (`409 not_editable`).
   - Accepting one of two open issues marks it accepted (`acceptedBy`, `acceptedAt`), writes `audit_log` with `userId`, keeps document in `error`, hides it from `DocumentDetail.issues` and `ErrorDocumentRow.issues`, and exposes it in `DocumentDetail.acceptedIssues` with the user's name and Buenos Aires timestamp.
   - Accepting the last open issue promotes the document to `reviewed` (`reviewed_by = user.id`, `reviewed_at = now()`), makes it count in *Proveedor*/*Resumen*, and writes `audit_log`.
   - If a concurrent duplicate number or unnumbered duplicate arrived before accepting the last non-duplicate issue, the accept endpoint records the accepted issue, adds the new duplicate issue as open, and keeps the document in `error`.
4. **Manual entry `duplicate_suspected` (`documents.spec.ts`):**
   - `POST /api/documents` rejects a suspected duplicate with `409 duplicate_suspected` including `documentId` of the matching document, writing nothing.
   - Resending with `allowSuspectedDuplicate: true` creates the document as `reviewed`, records accepted `duplicate_suspected` in `issues`, and writes `audit_log`.
   - Two numbered manual documents (different numbers) on same supplier/date/total, same total on different day, and `opening_balance` on same date/total all succeed without warning.
   - **Concurrency race:** Two concurrent `POST /api/documents` calls with the same supplier, date, total, and no number (`allowSuspectedDuplicate: false`) — exactly one succeeds (`201`) and the other is rejected with `409 duplicate_suspected`.
5. **Editing & re-checks (`documents.spec.ts`):**
   - Editing an `unreviewed`/`reviewed` document's `subtotal` by `$5.00` (with stored taxes) is rejected with `409 totals_mismatch` (document stays unchanged, never moves to `error`); resending with `acceptIssues: ['totals_mismatch']` succeeds (`204`), marks `reviewed`, and records acceptance.
   - Editing `subtotal` by `$0.50` passes immediately (`204`) with `issues: []`.
   - Editing an `unreviewed`/`reviewed` document that already had an accepted issue (e.g., `totals_mismatch` or `wrong_recipient`) so it still triggers requires re-acceptance (`409` without `acceptIssues`; succeeds with `acceptIssues`, updating `acceptedBy`/`acceptedAt`).
   - Editing an `error` document so all blocking checks pass while an acceptable issue triggers (without `acceptIssues`) saves the edited header fields, keeps `review_status = 'error'` with the open acceptable issue(s), and writes `audit_log`.
   - Editing an `error` document where `wrong_recipient` was previously accepted still resets `wrong_recipient` to open on save (requiring re-acceptance).
   - Passing a blocking code in `acceptIssues` is rejected with `400`.
6. **Supplier term unblocking (`suppliers.spec.ts`):**
   - `previewTerm` and `setTerm` keep an `error` document in `error` when it has `supplier_term_missing` plus an open acceptable issue (e.g., `totals_mismatch`).
   - `setTerm` unblocks to `unreviewed` when an `error` document has `supplier_term_missing` plus an already-accepted issue (preserving the accepted issue metadata).
   - Two unnumbered `error` delivery notes for the same supplier, date, and total both waiting on a term: `setTerm` unblocks the first to `unreviewed` and marks the second with `duplicate_suspected` in `error`.
7. **Frontend screens (`Documento.spec.tsx`, `AResolver.spec.tsx`, `DocumentForm.spec.tsx`):**
   - *Documento*: displays open acceptable issue cards (with backend `consistencySummary` / existing-doc link), accepts the last issue and transitions to *Revisado*, renders accepted issues struck through with user name, handles `409` acceptable-issue confirmation (*Aceptar y guardar*) on `unreviewed`/`reviewed` edit, and shows pending-issues notice when editing an `error` document leaves acceptable issues open.
   - *A resolver*: shows inline accept actions and *Ver el existente* link for `duplicate_suspected`, and removes resolved documents on accept.
   - *Cargar documento*: shows suspected-duplicate warning with link to existing document and saves on *Guardar igual* (for both *Guardar* and *Guardar y cargar otro*).

## Steps

One commit per step. "All checks" means `npm run lint`, `npm run typecheck`, and `npm test` in the touched app(s).

1. **Record answered decisions in docs**
   - Update `plans/mvp-slices.md` (Slice 7 *Rules* and *Open questions* 1, 9, 10) with the confirmed user answers (manual entry checks `duplicate_suspected`, missing/invalid recipient CUIT defaults to `RESTAURANT_CUIT`, editing re-requests acceptance and saves `error` docs staying in `error`, no side-by-side comparison screen `6e` in MVP).
   - Update `system-design.md` (*Validation*, *Review status*, and *Screens: Where the wireframes differ* for `6b`/`6e`).
   - Update `agents.md` to mention `ADVISORY_LOCKS.documentDuplicates` in the lock-order rule.
   - Verify: backend `npm run lint` passes.

2. **Issue codes, pure consistency checks, and `DuplicateSuspectedCheck`**
   - Update `backend/src/common/advisory-locks.ts` (`documentDuplicates: 2`), `backend/src/common/body.ts` (`bodyWithOptionalKeys`), and `backend/src/common/field-errors.ts` (new error codes + optional `documentId`).
   - Extend `backend/src/documents/issues.ts` with the 4 acceptable codes, `StoredIssue`, and helpers.
   - Add `backend/src/documents/consistency-checks.ts` + `consistency-checks.spec.ts` (V1 pure checks, tolerance boundaries, skip rules, `summarizeConsistency`).
   - Add `backend/src/documents/duplicate-suspected-check.ts` and export it from `DocumentsModule`.
   - Verify: backend all checks pass.

3. **Extraction pipeline: map `recipientCuit` and run all 4 acceptable checks**
   - Update `backend/src/extraction/extraction-mapping.ts` (`recipientCuit`) and `extraction-mapping.spec.ts`.
   - Update `backend/src/extraction/extraction-checks.ts` and `extraction-checks.spec.ts` to evaluate `duplicate_suspected`, `totals_mismatch`, `lines_mismatch`, and `wrong_recipient`.
   - Update `backend/src/extraction/extraction-writer.ts` to take `ADVISORY_LOCKS.documentDuplicates` first in `writeIn`, inject `DuplicateSuspectedCheck`, and pass all check inputs to `checkExtraction`.
   - Add integration tests in `extraction-result.spec.ts` (covering each new code, tolerance, skip rules, false-positive/false-negative duplicate cases) and adjust any pre-existing fixture assertions if needed.
   - Verify: backend all checks pass.

4. **Read DTO extensions (`DocumentDetail` & `ErrorDocumentRow`)**
   - Update `DocumentsService.detail` (in its existing `RepeatableRead` snapshot) to filter `issues` to open codes, resolve `acceptedIssues` (joining `users` for names, Buenos Aires date/time), resolve `suspectedDuplicate` via `DuplicateSuspectedCheck`, and attach `consistencySummary`.
   - Update `BalancesService.errorDocuments` (and `balances.types.ts`) to expose open `issues` only and `suspectedDuplicateId`.
   - Update affected whole-object assertions in `documents.spec.ts`, `uploads.spec.ts`, and `error-documents.spec.ts`, plus add tests for `acceptedIssues`, `suspectedDuplicate`, `consistencySummary`, and `suspectedDuplicateId`.
   - Verify: backend all checks pass.

5. **Accept issue, manual entry `duplicate_suspected`, edit re-checks, and `setTerm`**
   - Update `backend/src/documents/document-input.ts` (`allowSuspectedDuplicate` on `parseDocumentInput`, `acceptIssues` on `parseUpdateDocumentInput`).
   - Implement `DocumentsService.acceptIssue` and wire `POST /api/documents/:id/issues/:code/accept` in `DocumentsController`.
   - Update `DocumentsService.createManual` and `DocumentsService.update` with `ADVISORY_LOCKS.documentDuplicates`, duplicate/consistency re-checks, `error`-stays-`error` save behavior, and `unreviewed`/`reviewed` `409` confirmation flow.
   - Update `SuppliersService.previewTerm` and `SuppliersService.setTerm` to take `ADVISORY_LOCKS.documentDuplicates` first, preserve accepted issues, and evaluate `duplicate_suspected` (DB + batch).
   - Update `backend/test/routes.spec.ts` and add comprehensive backend tests in `documents.spec.ts` and `suppliers.spec.ts` (including concurrent duplicate race).
   - Verify: backend all checks pass.

6. **Frontend API types, labels, and screens (*Documento*, *A resolver*, *Cargar documento*)**
   - Update `frontend/src/accounts-api.ts` and `frontend/src/labels.ts`.
   - Update `frontend/src/screens/Documento.tsx`, `frontend/src/screens/AResolver.tsx`, `frontend/src/screens/DocumentForm.tsx`, and `frontend/src/index.css`.
   - Add/update screen tests in `Documento.spec.tsx`, `AResolver.spec.tsx`, and `DocumentForm.spec.tsx` (ensuring zero `console.error`).
   - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass, and backend all checks pass.

## Doors

No **`one-way (execution-time)`** doors: nothing in this slice sends data outside the system, calls an LLM (all worker tests use `FakeLlm` and invented `TEST_CUITS`), touches non-test databases, or alters test-harness guards.

| Part | Door | Note |
| --- | --- | --- |
| Document deduplication (`duplicate_suspected`, `DuplicateSuspectedCheck`, and `ADVISORY_LOCKS.documentDuplicates`) | **One-way (merge-time)** | Listed in `one-way-doors.md` ("Document deduplication"). **Blast radius:** a false negative or concurrency race allows unnumbered documents to be loaded twice, silently overstating supplier debt once real data exists (slice 8); an incorrect lock order could deadlock concurrent document writes and extraction. **How this plan shrinks it:** one shared `DuplicateSuspectedCheck` across all 5 entry points (worker, manual entry, edit, accept-issue, and `setTerm` batch), `ADVISORY_LOCKS.documentDuplicates` acquired strictly first in every transaction (deadlock-free lowest lock rank), tests covering false negatives, false positives, and concurrent races on real Postgres, and soft/acceptable resolution (no hard deletes). **Human review before merge:** inspect `DuplicateSuspectedCheck` SQL predicates (`deleted_at IS NULL`, `review_status IN ('unreviewed', 'reviewed')`, `type <> 'opening_balance'`, `id <> documentId`, null-number condition), verify `ADVISORY_LOCKS.documentDuplicates` is the first lock in all 5 writers, and verify `acceptIssue` re-checks duplicates before promoting the last accepted issue to `reviewed`. |
| `POST /api/documents/:id/issues/:code/accept` and `PUT /api/documents/:id` state transitions | **One-way (merge-time)** | Guards which documents enter the counted balance and enforces that `unreviewed`/`reviewed` documents (which may have applied payments) never regress to `error` (invariant 6). **How this plan shrinks it:** explicit `ACCEPTABLE_ISSUE_CODES` allowlist rejecting all blocking codes (`400 issue_not_acceptable`), `audit_log` written with `userId` in every transaction (D2), DB trigger `documents_keep_applied` still backs invariant 6, and route sits behind global `SessionGuard` (verified by `routes.spec.ts`). **Human review before merge:** verify blocking codes can never be accepted through either endpoint, accepted issues are never silently preserved across edits, and `unreviewed`/`reviewed` can never return to `error`. |
| Pure consistency checks (`totals_mismatch`, `lines_mismatch`, `wrong_recipient`) and read DTO extensions | **Two-way** | Reversible with `git revert`. No database schema migration; stored in existing `documents.issues` JSONB. Tolerance (`$1.00`) and skip rules match `system-design.md` and `extraction-test.ts`. |
| Frontend screens (*Documento*, *A resolver*, *Cargar documento*), API client, and Spanish labels | **Two-way** | Reversible with `git revert`. Backend enforces all validation, locking, and transitions; frontend performs zero arithmetic on amounts (D1). |
