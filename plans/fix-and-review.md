# Plan: Fix and review (slice 6)

Spec: [`mvp-slices.md`, section 6](mvp-slices.md#6-fix-and-review). Branch: `feat/fix-and-review`.

## Goal

From *A resolver* and *Documento*, a person fixes what blocked an *Error* document (set a supplier's payment term with a suggested value and live due-date preview, choose a supplier, retry a failed extraction, type data by hand, edit header fields, or discard it) or confirms and edits *Sin revisar* and *Revisado* documents. Valid saves leave the document *Revisado* in that user's name; setting a supplier's term unblocks that supplier's *Error* documents into *Sin revisar*.

## Out of scope

- Acceptable validation codes (`duplicate_suspected`, `totals_mismatch`, `lines_mismatch`, `wrong_recipient`) and accepting issues (slice 7).
- Re-extracting documents that already have data (open question 11: out of MVP; *Reintentar* is strictly for `extraction_failed`).
- Editing `document_lines` or `document_taxes` (open question 8: header-only in MVP).
- Thumbnails in *A resolver* (omitted for the same E5 and mobile-data reasons as *Subidas*), the navigation counter badge (0b), the *Pagos aplicados* card in *Documento* (5b/5e), and the desktop side-by-side layout / zoom / rotate viewer (5c/5h).
- Frontend DOM or component tests (pure logic helpers get unit tests; backend specs test all API and database invariants against Postgres).
- `memory.md`: this slice fixes no review findings.

## Decisions & Deviations

Deviations from existing design/specs: none. Confirmed answers to open questions 2 and 11 in `mvp-slices.md`, and defaults within `system-design.md`:

1. **Failed re-check on *Sin revisar* (open question 2).** Saving an edit on an `unreviewed` document that would leave any blocking issue is **rejected** with field errors, just like on a `reviewed` document. Neither `unreviewed` nor `reviewed` ever moves back to `error`, keeping its previous valid data and preventing applied documents from dropping out of the balance.
2. **Re-extraction (open question 11).** Excluded from the MVP. `POST /api/documents/:id/retry` only runs on `error` documents with `extraction_failed`, `source = 'upload'`, and no extracted header fields, lines, or taxes.
3. **Resolving *Error* documents (confirmed behavior).**
   - Saving an *Error* document via `PUT /api/documents/:id`—whether from *Documento* (edit / *Cargar a mano*) or from the *Elegir proveedor* quick action in *A resolver*—**requires every blocking issue to pass**. Partial fixes that still leave a blocking issue (for example, selecting a supplier with no term and no typed due date, or leaving `total` or `issueDate` missing) are rejected with field errors, leaving the document unchanged in `error`.
   - When all checks pass, `PUT /api/documents/:id` sets `review_status = 'reviewed'`, `issues = []`, `reviewed_by = user.id`, and `reviewed_at = now()` (invariant 8).
4. **Confirming *Sin revisar* as-is.** `POST /api/documents/:id/review` confirms an `unreviewed` (or idempotently `reviewed`) document without changing fields, setting `review_status = 'reviewed'`, `reviewed_by = user.id`, and `reviewed_at = now()`. It refuses `processing` and `error` documents with 409 `not_editable`.
5. **Editable header fields and `due_date` rule (D4).**
   - `PUT /api/documents/:id` accepts `supplierId`, `type`, `letter`, `number`, `issueDate`, `dueDate`, `dueDateSource` (`'supplier_term' | 'manual' | null`), `subtotal`, `total`, and `notes`. `cae`, `document_lines`, `document_taxes`, and `extraction_jobs.raw_output` are never modified.
   - `upload` documents only allow `'invoice' | 'delivery_note' | 'credit_note'`; `manual` documents allow all four `DocumentType` values.
   - For `'credit_note'`, `dueDate` and `dueDateSource` must both be `null`.
   - For `'opening_balance'`, `letter`, `number`, and `subtotal` must be `null`, and `dueDateSource` is `'manual'` when `dueDate` is set or `null` when empty (`due_date_before_issue` does not apply).
   - For `'invoice'` and `'delivery_note'`:
     - When `dueDateSource === 'manual'`, `dueDate` is required (`due_date_required`), must be a valid ISO date (`due_date_invalid`), and must satisfy `dueDate >= issueDate` (`due_date_before_issue`). When a `manual` document's `issueDate` is edited, its typed `dueDate` never moves; if `issueDate > dueDate`, the save is refused with `due_date_before_issue`.
     - When `dueDateSource === 'supplier_term'`, `dueDate` in the request body must be `null` (server computes it). If the document was already `'invoice' | 'delivery_note'` with `dueDateSource === 'supplier_term'` for the **same** `supplierId` (and non-null `issueDate` and `dueDate`), the server preserves the original term (`diffDays(oldIssueDate, oldDueDate)`) and computes `addDays(newIssueDate, originalTermDays)`, so changing the supplier's term later still never moves existing documents. Otherwise (an *Error* document with no due date yet, a switch from `'manual'` to `'supplier_term'`, a `type` change from `'credit_note'`, or a `supplierId` change), `resolveDueDate` uses the target supplier's current `paymentTermDays` (returning 400 `due_date_required` if `null`).
6. **Setting a supplier's term (*Definir plazo*).**
   - `PUT /api/suppliers/:id` (*Editar proveedor*) continues to leave existing documents untouched (`extraction-flow.spec.ts` relies on this).
   - *Definir plazo* uses dedicated endpoints: `POST /api/suppliers/:id/term/preview` and `POST /api/suppliers/:id/term`, backed by one shared evaluation function (D1).
   - Setting the term updates `suppliers.payment_term_days` and re-checks **only** that supplier's non-deleted `error` documents that have `supplier_term_missing`. For each one:
     - Removes `supplier_term_missing` from `issues`.
     - If `issueDate` is present (and `type` is `'invoice' | 'delivery_note'`), computes `dueDate` and `dueDateSource = 'supplier_term'` via `resolveDueDate`.
     - Checks `duplicate_number` via `DuplicateNumberCheck` (plus any earlier document in the same batch being unblocked) so two duplicate *Error* rows for the same supplier don't collide on save; `P2002` on `documents_number_unique` from a concurrent insert retries the transaction once marking that document with `duplicate_number`.
     - Documents with zero remaining issues become `unreviewed` (with `reviewed_at = null, reviewed_by = null`); documents with remaining issues (e.g., `missing_total`, `missing_issue_date`, `duplicate_number`) stay `error` with updated `issues` and `dueDate`.
   - **Lock order (C1 / `agents.md`):** `setTerm` locks the supplier first (`audit.snapshot`), then locks **only** `WHERE supplier_id = :id AND deleted_at IS NULL AND review_status = 'error' ORDER BY id FOR UPDATE`. It never locks `processing` documents, avoiding any deadlock with `ExtractionWriter`.
7. **Suggested term from `raw_output`.** A pure helper `suggestTermDays(rawOutput, documentIssueDate)` reads the latest `succeeded` job's `raw_output`: if `printedTermDays` is an integer in `0..365`, returns it; else if `printedDueDate` is a valid ISO date and an issue date exists (document's `issue_date` or `raw_output.issueDate`) with `0 <= diffDays(issueDate, printedDueDate) <= 365`, returns that difference; else `null`. Never saved without user confirmation.
8. **Grouping in *A resolver* (`6a`).** Suppliers with 2 or more `supplier_term_missing` documents are grouped in a card at the top of *A resolver* with one *Definir plazo* button (suggesting a term only when all non-null suggestions in that group agree on one number). Single `supplier_term_missing` documents stay in the regular list with their own *Definir plazo* button.
9. **Module boundaries.** `DuplicateNumberCheck` moves from `src/extraction/` to `src/documents/` (and filters `AND id <> ${query.documentId}::uuid`), exported by `DocumentsModule` so `SuppliersModule` and `DocumentsService` share it with `ExtractionModule` without `AppModule` ever importing `ExtractionModule`.

## Interface

### Backend shared helpers & errors

- `backend/src/common/dates.ts`: add `diffDays(from: string, to: string): number` (exact calendar day difference in UTC: `to - from`).
- `backend/src/common/field-errors.ts`: add `'supplier_required' | 'subtotal_invalid' | 'not_editable'` to `FieldErrorCode`.
- `backend/src/documents/due-date.ts`: add `suggestTermDays(rawOutput: unknown, documentIssueDate: string | null): number | null`.
- `backend/src/documents/duplicate-number-check.ts`: moved from `src/extraction/duplicate-number-check.ts`, adding `AND id <> ${query.documentId}::uuid`.

### Backend HTTP endpoints (all behind global `SessionGuard`)

1. **`PUT /api/documents/:id`** (returns `204` empty body; `404` if unknown/deleted/bad UUID; `400` with `{ errors }` on validation errors; `409` with `{ errors }` on `duplicate_number`, `document_has_applications`, or `not_editable` when `processing`).
   Request body (`UpdateDocumentInput`):
   ```ts
   {
     supplierId: string | null; // '' or null -> 400 supplier_required
     type: DocumentType;
     letter: string | null;
     number: string | null;
     issueDate: string;
     dueDate: string | null;
     dueDateSource: DueDateSource | null;
     subtotal: string | null;
     total: string;
     notes: string | null;
   }
   ```
2. **`POST /api/documents/:id/review`** (returns `204`; `404` if unknown/deleted/bad UUID; `409` `not_editable` if `processing` or `error`).
3. **`POST /api/documents/:id/retry`** (returns `204`; `404` if unknown/deleted/bad UUID; `409` `not_editable` unless `source === 'upload'`, `reviewStatus === 'error'`, `issues` includes `'extraction_failed'`, and `type === null && supplierId === null && issueDate === null && total === null` with 0 lines and 0 taxes). Resets document to `processing` (`issues: []`) and inserts a new `queued` `ExtractionJob` (`attempts: 0, runAfter: now()`) while keeping previous job rows, with `audit_log` (`documents`, `update`, `userId`).
4. **`POST /api/suppliers/:id/term/preview`** (returns `200` `TermPreview`; `404` if supplier missing/bad UUID; `400` `payment_term_invalid` if not integer `0..365`).
   Request body: `{ paymentTermDays: number }`.
   Response (`TermPreview`):
   ```ts
   export interface TermPreviewDocument {
     id: string;
     type: 'invoice' | 'delivery_note';
     letter: string | null;
     number: string | null;
     issueDate: string | null;
     dueDate: string | null;
     willUnblock: boolean;
     remainingIssues: IssueCode[];
   }
   export interface TermPreview {
     paymentTermDays: number;
     documents: TermPreviewDocument[];
     unblockedCount: number;
   }
   ```
5. **`POST /api/suppliers/:id/term`** (returns `200` `TermPreview`; same validation/errors and same evaluation logic as preview, inside a transaction that updates `suppliers.payment_term_days` and re-checks the supplier's `error` documents, writing `audit_log` for the supplier and every changed document).

### Read DTO extensions

- **`DocumentDetail`** (`GET /api/documents/:id`):
  - `supplier: { id: string; name: string; paymentTermDays: number | null } | null`
  - `reviewedByName: string | null`, `reviewedOn: string | null`, `reviewedTime: string | null`
  - `appliedAmount: string` (from `BalancesService.documentApplied` inside the same `RepeatableRead` snapshot)
  - `suggestedTermDays: number | null` (from latest `succeeded` job's `raw_output`)
- **`ErrorDocumentRow`** (`GET /api/error-documents`):
  - `suggestedTermDays: number | null` (from latest `succeeded` job's `raw_output`)

### Frontend

- `frontend/src/accounts-api.ts`: types and API functions `updateDocument`, `reviewDocument`, `retryDocument`, `previewSupplierTerm`, `setSupplierTerm`, plus updated `DocumentDetail`, `ErrorDocumentRow`, `FieldErrorCode`.
- `frontend/src/labels.ts`: labels for `supplier_required`, `subtotal_invalid`, `not_editable`, and updated `document_has_applications` covering both editing and discarding.
- `frontend/src/screens/TermSheet.tsx`: shared *Definir plazo* sheet with live preview from `previewSupplierTerm` and confirm via `setSupplierTerm`.
- `frontend/src/screens/AResolver.tsx` + `resolver-groups.ts`: grouped `supplier_term_missing` banner/cards (`6a`), inline quick actions per issue (`6b`: *Definir plazo*, *Elegir proveedor*, *Reintentar*, *Cargar a mano*, *Descartar*), and toast notice after setting term (`6c`).
- `frontend/src/screens/Documento.tsx` + `document-edit.ts`: header edit form (`5b`, `5d`, `5e`, `5f`, `5g`), *Marcar como revisado*, *Definir plazo* / *Vencimiento a mano*, *Reintentar* / *Cargar a mano* on `extraction_failed`, *Descartar*, locked `Proveedor` & `Tipo` + min `Total` hint when `appliedAmount !== '0.00'`, and `Revisado por` line.

## Behaviors to test

Tested through the HTTP endpoints and exported helpers against real Postgres:

1. **Allowed & forbidden status transitions** (table-driven):
   - `error` (missing field / unresolved supplier / missing term) -> `reviewed` on valid `PUT`, setting `reviewedById` and `reviewedAt` (invariant 8) and clearing `issues`.
   - `error` -> partial `PUT` leaving any blocking issue (e.g., supplier without term and no typed due date, missing total, missing issue date) is rejected (`400`) and keeps `review_status = 'error'`.
   - `unreviewed` -> `reviewed` via `POST /review` (keeps fields intact, sets `reviewedById`/`reviewedAt`) and via `PUT`.
   - `unreviewed` -> invalid `PUT` (cleared total, cleared issueDate, or supplier without term and no manual dueDate) is rejected (`400`) and stays `unreviewed` with old data intact (never goes to `error`).
   - `reviewed` -> valid `PUT` stays `reviewed` with updated `reviewedById`/`reviewedAt`.
   - `reviewed` -> invalid `PUT` is rejected (`400`) and stays `reviewed` with old data intact (never goes to `error`).
   - `processing` -> `PUT`, `POST /review`, and `POST /retry` are all rejected (`409 not_editable`).
   - `error` -> `POST /review` is rejected (`409 not_editable`).
2. **Due-date preservation & rules on edit**:
   - Editing `issueDate` on a `supplier_term` document recomputes `dueDate` using the term the document was created with (`oldDueDate - oldIssueDate`), even after the supplier's `paymentTermDays` changed.
   - Switching from `supplier_term` to `manual`, or from `manual` to `supplier_term`, updates `dueDateSource` and `dueDate` accordingly.
   - Editing `issueDate` on a `manual` invoice/delivery note leaves `dueDate` unchanged, and rejects with `due_date_before_issue` if `newIssueDate > manualDueDate`.
   - Opening balances allow `dueDate < issueDate` and `dueDate = null`, and reject `dueDateSource = 'supplier_term'`.
   - Credit notes reject any non-null `dueDate` / `dueDateSource`.
3. **Invariant 6 on edit & delete**:
   - Document with received or given applications: changing `supplierId`, changing `type`, or lowering `total` below applied is rejected with `409 document_has_applications`; lowering `total` to equal applied, keeping supplier/type, and editing `number`/`issueDate`/`notes` succeeds.
4. **Invariant 7 & read-only preservation on edit**:
   - `PUT` colliding with an existing counted document's `(supplierId, type, letter, numberNormalized)` (including null `letter`) is rejected with `409 duplicate_number`.
   - `PUT` never modifies `document_lines`, `document_taxes`, or `extraction_jobs.raw_output`, and writes an `audit_log` `update` entry with `userId` (rolling back if audit fails).
5. **Retry (`POST /retry`)**:
   - On `error` + `extraction_failed` upload with no data: moves to `processing`, clears `issues`, adds a second `queued` `extraction_jobs` row while preserving the first `failed` row, writes `audit_log`, and can then be claimed by `ExtractionWorker.runOnce`.
   - Rejected (`409 not_editable`) when `reviewStatus !== 'error'`, or `issues` lacks `extraction_failed`, or `source === 'manual'`, or any extracted field/line/tax exists.
6. **Supplier term preview & save (`POST /suppliers/:id/term/preview` & `POST /suppliers/:id/term`)**:
   - Preview matches save: returns the exact same documents, computed `dueDate`s, `willUnblock`, `remainingIssues`, and `unblockedCount`, without mutating DB.
   - Save updates `suppliers.payment_term_days`, writes `audit_log` for supplier and every changed `error` document, moves unblocked `error` docs to `unreviewed` (with `reviewedAt = null, reviewedById = null`), leaves docs with other issues (e.g. `missing_total`, `missing_issue_date`, `duplicate_number`) in `error` with updated `issues` and `dueDate`, and never touches `unreviewed`, `reviewed`, `processing`, `deleted`, or other suppliers' documents.
   - Batch duplicate in `error`: two `error` invoices of the same supplier with the same `(type, letter, numberNormalized)` unblock only the oldest one; the second stays `error` with `duplicate_number`.
   - Concurrency: setting term while another request creates a conflicting document (or two concurrent `setTerm` calls) leaves no invariant violation; a parallel worker job for a `processing` document of that supplier does not deadlock.
   - `suggestTermDays` pure tests: `printedTermDays` valid/out-of-range/float, fallback to `printedDueDate - issueDate`, negative diff rejected, null/malformed `raw_output`.
7. **Discarding (`DELETE /api/documents/:id`) & routes**:
   - Discarding an *Error* document sets `deleted_at` and writes `audit_log` (`delete` with `userId`), dropping it from `GET /api/error-documents`.
   - `routes.spec.ts` lists all 5 new routes and verifies `401` without a session.
8. **Frontend pure tests**:
   - `resolver-groups.spec.ts`: grouping threshold (`>= 2`), matching vs disagreeing `suggestedTermDays`, ungrouped order preserved.
   - `document-edit.spec.ts`: dirty detection, locked state when `appliedAmount !== '0.00'`, payload builder for each `DocumentType` and `dueDateSource`.

## Steps

One commit per step. "All checks" means `npm run lint`, `npm run typecheck`, and `npm test` in the apps touched.

1. **Record answered decisions in docs**
   - In `system-design.md`:
     - Under *Review status*: note that `unreviewed` also never goes back to `error` on edit (rejected just like `reviewed`), and saving an *Error* document requires all blocking issues to be resolved.
     - Under *Screens* (*Where the wireframes differ*): update the *A resolver (6a–6c)* and *Documento (5b, 5c, 5h)* notes to reflect slice 6 (grouping and quick actions enabled; thumbnails, nav counter, *Pagos aplicados* card, and desktop side-by-side viewer deferred).
   - In `plans/mvp-slices.md`:
     - Update Slice 6 *Rules* and *Open questions* 2 and 11 with the confirmed user answers (no `unreviewed -> error`, re-extraction out of MVP, *Elegir proveedor* -> `reviewed`, *Guardar* on `error` requires all blocking issues resolved).
   - Verify: backend `npm run lint` (`check:cuits`) passes.

2. **Shared backend helpers & `DuplicateNumberCheck` relocation**
   - Add `diffDays` to `backend/src/common/dates.ts` (+ `dates.spec.ts`).
   - Add `supplier_required`, `subtotal_invalid`, `not_editable` to `backend/src/common/field-errors.ts`.
   - Add `suggestTermDays` to `backend/src/documents/due-date.ts` (+ `due-date.spec.ts`).
   - Move `DuplicateNumberCheck` to `backend/src/documents/duplicate-number-check.ts` with `AND id <> ${query.documentId}::uuid`; update `ExtractionModule`, `ExtractionWriter`, `DocumentsModule` (export `DuplicateNumberCheck`), and `extraction-result.spec.ts` import.
   - Verify: backend all checks pass.

3. **Document detail read extensions & `ErrorDocumentRow.suggestedTermDays`**
   - Update `DocumentsService.detail` (and `DocumentDetail`) to include `supplier.paymentTermDays`, `reviewedByName`, `reviewedOn`, `reviewedTime`, `appliedAmount` (via `BalancesService.documentApplied` in the same `RepeatableRead` transaction), and `suggestedTermDays`.
   - Update `BalancesService.errorDocuments` (and `ErrorDocumentRow`) to read latest `succeeded` job's `raw_output` and attach `suggestedTermDays`.
   - Update whole-body assertions in `documents.spec.ts`, `uploads.spec.ts`, and `error-documents.spec.ts`, and add tests for `suggestedTermDays`, `reviewedByName`, and `appliedAmount`.
   - Verify: backend all checks pass.

4. **Document update, review, and retry endpoints**
   - Add `parseUpdateDocumentInput` in `backend/src/documents/document-input.ts`.
   - Implement `DocumentsService.update`, `DocumentsService.review`, and `DocumentsService.retry`, and wire `PUT /api/documents/:id`, `POST /api/documents/:id/review`, and `POST /api/documents/:id/retry` in `DocumentsController`.
   - Update `routes.spec.ts` and add comprehensive integration tests in `documents.spec.ts` (transitions, due-date preservation & manual bounds, invariant 6, invariant 7, `raw_output`/lines/taxes untouched, audit rollback, retry job history & worker claim).
   - Verify: backend all checks pass (`npx vitest run src/documents` passes cleanly).

5. **Supplier term preview and save endpoints**
   - Add `parseTermInput` in `backend/src/suppliers/supplier-input.ts`.
   - Import `DocumentsModule` into `SuppliersModule`. Implement `SuppliersService.previewTerm` and `SuppliersService.setTerm` sharing one evaluator, enforcing lock order (`suppliers` -> `error` documents only) and handling `P2002` retry on `documents_number_unique`.
   - Wire `POST /api/suppliers/:id/term/preview` and `POST /api/suppliers/:id/term` in `SuppliersController`.
   - Update `routes.spec.ts` and add tests in `suppliers.spec.ts` (and `extraction-flow.spec.ts` for unblocking the first stuck document).
   - Verify: backend all checks pass (run `src/suppliers` and `src/extraction` specs multiple times to confirm concurrency stability).

6. **Frontend foundations & unit tests**
   - Update `frontend/src/accounts-api.ts` and `frontend/src/labels.ts` (including updated `document_has_applications` message).
   - Add `frontend/src/screens/resolver-groups.ts` + `resolver-groups.spec.ts` and `frontend/src/screens/document-edit.ts` + `document-edit.spec.ts`.
   - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass.

7. **Frontend screens (*Definir plazo*, *A resolver*, *Documento*)**
   - Add `frontend/src/screens/TermSheet.tsx`.
   - Update `frontend/src/screens/AResolver.tsx` (grouped term cards, quick actions, notice banner) and `frontend/src/screens/Documento.tsx` (editable header form, *Marcar como revisado*, *Definir plazo* / *Vencimiento a mano*, *Reintentar* / *Cargar a mano*, *Descartar*, locked applied fields, `Revisado por`), plus CSS in `frontend/src/index.css` matching light and dark tokens.
   - Verify: frontend all checks + build pass; run through all 7 manual acceptance scenarios from `mvp-slices.md` in dev mode against Postgres.

## Doors

No **`one-way (execution-time)`** doors: nothing in this slice sends data outside the system, calls an LLM, touches non-test databases, or alters test-harness guards.

| Part | Door | Note |
| --- | --- | --- |
| `PUT /api/documents/:id` and `POST /api/documents/:id/review` | **Two-way** | Reversible with `git revert`. Enforces invariant 6 (`ApplicationsService.assertDocumentChange` under row lock, backed by `documents_keep_applied` trigger), invariant 7 (`documents_number_unique`), invariant 8 (`documents_reviewed_by_iff_reviewed`), `due_date` rule (D4), and writes `audit_log` with `userId` in the same transaction (D2). Never modifies `lines`, `taxes`, or `raw_output`. |
| `POST /api/documents/:id/retry` | **Two-way** (one-way guard) | Guarded so it is strictly limited to `upload` documents in `error` with `extraction_failed` and **no** extracted data (`type`, `supplierId`, `issueDate`, `total`, `lines`, `taxes` all empty). Keeps previous `extraction_jobs` rows intact. Never re-extracts documents with data. |
| `POST /api/suppliers/:id/term/preview` and `POST /api/suppliers/:id/term` | **Two-way** | Preview and save share one evaluator (D1). Save locks supplier then only `error` documents (never `processing` rows), moves unblocked docs to `unreviewed` (never `reviewed`), and audits supplier and every changed document with `userId` (D2). |
| `DELETE /api/documents/:id` (*Descartar*) | **Two-way** | Existing soft-delete endpoint (`deleted_at` + `audit_log` + invariant 6). |
| Frontend screens, helpers, and route guards | **Two-way** | Backend enforces all status transitions, locks, and validation rules; all 5 new endpoints sit behind global `SessionGuard` (verified by `routes.spec.ts`). |
