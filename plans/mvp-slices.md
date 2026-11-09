# MVP plan: vertical slices

> This plan turns [`system-design.md`](../system-design.md) into eight slices. If the two disagree, the design wins and this file gets fixed. Each slice becomes one `/feature` run, except slice 1, which is split into two. Each run's planner writes the detailed `plans/<slug>.md`.

## Rules for every slice

- Each slice runs end to end, from a Spanish screen or an endpoint through the backend to Postgres, and can be tested by hand when it's done. Slice 1a is the exception: it only sets up the tooling.
- A slice only creates the columns it uses. An enum is created with all its values when the invariants are written over it.
- The [coding standards](../codingStandards.md) apply throughout. Each slice lists only the rules it's the first to exercise.
- Money, locks and constraints are tested against a real Postgres, never mocks.
- Test data is invented. Test CUITs come from the allowlist added in slice 1a.

## 1. Skeleton and accounts

**Goal.** A person created by the script signs in from their phone and sees an empty Spanish shell. Nothing else answers without a session.

This slice is split into two `/feature` runs, in [`slice-1-skeleton-and-accounts/`](slice-1-skeleton-and-accounts/). Those files hold its detail.
- [1a. Scaffold](slice-1-skeleton-and-accounts/1a-scaffold.md): the apps, the checks and the Postgres test harness. Two-way.
- [1b. Accounts](slice-1-skeleton-and-accounts/1b-accounts.md): `users`, sessions and the Spanish shell. One-way: authentication.

**Why split.** The checks gate in `/feature` needs `lint`, `typecheck` and `test` to exist before a feature can go through it. And the authentication diff needs a thorough human review, which the scaffold's configs and lockfiles would bury.

## 2. Supplier accounts from manual entry

**Goal.** Create suppliers, type in documents and opening balances, and see each supplier's *Sin vencer*, *Vencido* and *Total* in *Resumen* and *Proveedor*.

**Design.**
- [Decisions 2 and 6](../system-design.md#decisions)
- [Review status](../system-design.md#review-status): manual documents start as `reviewed`
- [Invariants](../system-design.md#invariants) 1, 7 and 8
- [Derived values](../system-design.md#derived-values)
- [Due dates](../system-design.md#due-dates)
- [Validation](../system-design.md#validation): CUIT rules for suppliers created by hand
- [Screens](../system-design.md#screens)

**Schema.**
- `suppliers`: all columns.
- `documents`: `type`, `source`, `review_status`, `supplier_id`, `letter`, `number`, `number_normalized`, `issue_date`, `due_date`, `due_date_source`, `total`, `notes`, `created_by`, `reviewed_at`, `reviewed_by`, `deleted_at`. The `review_status` enum gets all four values, though only `reviewed` can be reached here.
- `audit_log`: all columns.

**Rules.**
- Now:
  - Invariants 1, 7 and 8 are `CHECK`s and a partial unique index. Under invariant 7, two documents with a null `letter` still collide.
  - `total > 0` and `payment_term_days >= 0`.
  - A CUIT has 11 digits and a valid check digit. It's required unless the supplier is informal.
  - There is one due-date function (D4): the issue date plus the term, or a date a person types. Credit notes get no due date. An opening balance may get a typed one. Changing a term leaves existing documents alone.
  - There is one balance query (D1). It only counts `unreviewed` and `reviewed` documents that aren't deleted (D3), and `applied` is 0 until slice 3.
  - Changes to documents and terms write `audit_log` in the same transaction (D2).
  - Every enum has an exhaustive set of Spanish labels.
  - Manual entry refuses to save when invariant 1 or 7 would fail, for example an invoice from a supplier with no term and no typed due date. Whether more checks run is [question 1](#open-questions).
- Later: invariant 6 in slice 3, and the validation codes in slices 5 and 7.

**Acceptance.**
1. Create a supplier with a 30-day term. A CUIT with a wrong check digit is rejected with a Spanish message.
2. An invoice issued 31 days ago shows as *Vencido*. One issued 30 days ago is due today, so it shows as *Sin vencer*.
3. An opening balance with a past due date counts as *Vencido*. One without a due date counts as *Sin vencer*.
4. A credit note lowers *Total*.
5. Change the term to 45 days. Existing due dates don't move.
6. A second document with the same supplier, type, letter and number is rejected.
7. Delete a document. It drops out of the balance, and `audit_log` holds the before and after of every step.

**Tests.**
- The due-date function, for each document type.
- Status boundaries in Buenos Aires time: a document due today is pending, and one due yesterday is overdue.
- The balance query leaves out deleted, `processing` and `error` rows (inserted directly), and subtracts credit notes.
- The database rejects rows that break invariant 1, 7 (including the null-letter case) or 8.
- The CUIT check digit.
- When the audit write fails, the change is rolled back too.

**Out.** Payments, *Pagado*, uploads, *Error* and *Sin revisar*, lines and taxes, and filters ([question 12](#open-questions)).

**Doors.** Two-way: these are new tables on an empty database.

## 3. Payments and applications

**Goal.** Record a payment and split it across documents, oldest due first, with every row editable. Whatever is left stays as credit. Credit notes can be applied too, and nothing is ever over-applied.

**Design.**
- [Decision 2](../system-design.md#decisions)
- `payments` and `applications` in [Data model](../system-design.md#data-model)
- [Invariants](../system-design.md#invariants) 2–6
- [Derived values](../system-design.md#derived-values)
- [Review status](../system-design.md#review-status): an `error` document can't take payments
- *Pagos* in [Screens](../system-design.md#screens)

**Schema.**
- `payments`: all columns.
- `applications`: all columns. `amount > 0`, and exactly one of `payment_id` and `credit_note_id` is set.

**Rules.**
- Now:
  - Invariants 2–6 live in one `ApplicationsService`. Its transaction locks the document and the payment or credit note in a fixed order. An ESLint import rule keeps any other code from writing `applications`.
  - Neither side of an application can be deleted or in `processing` or `error`.
  - Editing or deleting a document enforces invariant 6.
  - *Marcar como pagado* creates the payment and its application in one transaction.
  - A partly paid document shows *Pago parcial* with what's left. Credit notes show *Disponible* or *Aplicada*.
  - Payments and applications write `audit_log`.
- Later, or blocked:
  - Editing or deleting a payment, and removing an application ([question 3](#open-questions)).
  - Applying existing credit to a later document ([question 4](#open-questions)).

**Acceptance.** These steps start from slice 2's data.
1. Invoice A for 100 is due first, and invoice B for 50 is due later. A transfer of 120 suggests 100 for A and 20 for B. After saving, A is *Pagado* and B shows *Pago parcial* with 30 left.
2. Record a payment of 80 and apply none of it. The supplier's balance drops by 80, which stays as credit.
3. In a new payment, applying 40 to B is rejected with a Spanish message.
4. Deleting A, changing its supplier or lowering its total to 90 is rejected.
5. Apply a credit note of 30 to B. B is *Pagado* and the note is *Aplicada*. Which screen this happens on depends on question 4.
6. *Marcar como pagado* on a new invoice leaves it *Pagado*, with one payment and one application.
7. An eCheq keeps its number and its value date.

**Tests.**
- A request that breaks any of invariants 2–5 is rejected, and nothing is written.
- Two concurrent applications that each fit alone but not together: exactly one succeeds.
- The invariant 6 cases.
- Status and outstanding amount with partial applications.
- Credit from a payment's leftover and from a partly applied credit note.
- The order of the suggested split.
- *Marcar como pagado* is atomic.

**Out.** Editing and deleting payments, reports and reminders.

**Doors.** Two-way: nothing real is stored until slice 8.

## 4. Upload and view the photo

**Goal.** Take one or more photos of a document on the phone, upload them, and see them in *Documento* as *Procesando*.

**Design.**
- [Decision 3](../system-design.md#decisions)
- Capture and Upload in [Extraction](../system-design.md#extraction)
- Same image in [Duplicates](../system-design.md#duplicates)
- `document_images` and `extraction_jobs` in [Data model](../system-design.md#data-model)

**Schema.**
- `document_images`: all columns.
- `extraction_jobs`: `document_id`, `status`, `attempts`, `run_after`.
- `documents`: no new columns. An upload starts with `source = upload`, `review_status = processing`, and no type or supplier.

**Rules.**
- Now:
  - The browser compresses each photo: long side up to 2200 px, JPEG quality around 0.85, EXIF orientation applied, and no other filters. If compression fails, the original is uploaded when it's a JPEG, PNG or WebP under 7 MB. Anything else, HEIC included, gets a Spanish message.
  - The server checks type and size again. It stores the bytes untouched (E5), under a random key in `UPLOAD_DIR`. Then one transaction creates the document, its images and its job.
  - A `sha256` the database already has returns the existing document and creates nothing ([question 6](#open-questions)).
  - Images are only served through an authenticated endpoint.
- Later: the worker, in slice 5.

**Acceptance.**
1. On the local network, use the phone to photograph a printed two-page document with invented data. *Documento* shows both pages in order, *Procesando*, and *Subido por* with my name.
2. Upload the same file again. It opens the same document, and the database still has only one.
3. Opening the image URL in a private window returns 401.
4. A HEIC file on a desktop browser, or an oversized file, gets the Spanish message.
5. *Resumen* doesn't change.

**Tests.**
- The upload transaction is all or nothing.
- A known `sha256` returns the existing id and writes nothing.
- Served bytes have the same hash as the uploaded ones.
- The image endpoint refuses requests without a session.
- Rejected types and sizes.
- A frontend unit test for the compression options.

**Out.** Extraction, a list of documents in *Procesando* ([question 7](#open-questions)), and cleanup of files whose transaction failed.

**Doors.** One-way: compression settings, deduplication and access to images. The blast radius stays small: nothing real is uploaded before slice 8, and slice 5's extraction test confirms the 2200 px first.

## 5. Extraction to *Sin revisar* or *Error*

**Goal.** The worker reads each upload with Haiku. It leaves the document in *Sin revisar*, where it counts as debt, or in *Error*, with the reason in Spanish.

**Gate.** Run the [extraction test](../system-design.md#extraction) first. It runs the samples at each effort level and compares them against hand-labeled values, all kept in the gitignored `samples/`. It sets `output_config.effort`, confirms the 2200 px and measures cost from `usage`.

**Design.**
- [Decisions 3, 4 and 8](../system-design.md#decisions)
- [Flow](../system-design.md#flow)
- Worker, Call and Prompt in [Extraction](../system-design.md#extraction)
- The codes that can't be accepted, in [Validation](../system-design.md#validation)
- [Due dates](../system-design.md#due-dates)

**Schema.**
- `documents`: add `issues` (`jsonb not null default '[]'`), `subtotal` and `cae`.
- `document_lines` and `document_taxes`: all columns.
- `extraction_jobs`: add `locked_until`, `model`, `prompt_version`, `raw_output` and `last_error`.

**Rules.**
- Now:
  - **Worker.** It claims jobs with `FOR UPDATE SKIP LOCKED` and holds a lease. It retries three times with backoff, with `maxRetries: 0` in the SDK. An attempt fails on `max_tokens`, on `refusal` or when `parsed_output` is null.
  - **Call.** `messages.parse` with a Zod schema and the images before the text. The model comes from `LLM_MODEL`, effort is set explicitly, `max_tokens` is around 16,000, and no sampling parameters are sent.
  - **E1–E4.** No LLM call runs inside a transaction. `raw_output` is written once, and `prompt_version` is set. The result is written in one transaction that replaces the lines and taxes, and only if the document is still `processing`.
  - **Schema extras.** The Zod schema also asks for what the tables don't hold: the supplier's CUIT and printed name, the recipient's CUIT, any printed payment term (for slice 6's suggestion), and whether the photo is a document at all.
  - **Supplier.** A valid CUIT that isn't in the database creates the supplier, using the printed name. An invalid or missing one gives `supplier_unresolved`. `due_date` only comes from slice 2's function.
  - **Checks (V1).** `extraction_failed`, `unsupported_document`, `supplier_unresolved`, `missing_total`, `missing_issue_date`, `supplier_term_missing` and `duplicate_number`. `duplicate_number` compares against the same set of documents as invariant 7. A unique-index violation on write also becomes `duplicate_number`.
  - **Screens.** *A resolver* is read-only, *Resumen* warns about *Error* documents, and *Documento* shows the data next to the image.
  - **Audit.** The worker's `audit_log` entries have no `user_id`.
- Later: fixing documents in slice 6, and the codes that can be accepted in slice 7.

**Acceptance.**
1. Upload a document from a supplier the app doesn't know. It goes from *Procesando* to *Error* in *A resolver*, with the missing-term reason in Spanish. The supplier now exists, and *Resumen* warns about one document and its amount.
2. Set that supplier's term (slice 2) and upload another of their documents. It lands in *Sin revisar*, its due date is the issue date plus the term, it counts in *Proveedor*, and it can take a payment.
3. A photo that isn't a document gives `unsupported_document`.
4. With a bad API key, the document ends in `extraction_failed` after the retries, and `last_error` is saved.
5. Kill the worker mid-job. Once the lease expires, the job runs again, and only one result is written.

**Tests.**
- Mapping from invented LLM outputs, with the SDK client mocked.
- A passing and a failing case for each code.
- A printed due date or CAE expiry never reaches `due_date`.
- Claiming, leasing, retries and backoff, on a real Postgres.
- Running a job twice leaves one set of lines and taxes.
- Each failing stop reason counts as a failed attempt.
- No sampling parameters are sent in the request.

**Out.** Fixing and accepting, re-extraction, the consistency checks, and using corrections as an evaluation set.

**Doors.** One-way: documents are sent to an LLM provider for the first time. That includes the samples the extraction test sends.

## 6. Fix and review

**Goal.** From *A resolver* and *Documento*, a person fixes what blocked a document, or confirms one that's *Sin revisar*. The document becomes *Revisado* in their name.

**Design.**
- [Review status](../system-design.md#review-status)
- [Due dates](../system-design.md#due-dates): the term is set once and triggers a re-check, the term is suggested, and a person can type a date
- The "can be accepted" column in [Validation](../system-design.md#validation)
- [Screens](../system-design.md#screens)

**Schema.** None.

**Rules.**
- Now:
  - Saving runs the checks again. If they pass, the document becomes `reviewed`, with `reviewed_by` and `reviewed_at` set to whoever saved it (invariant 8).
  - A `reviewed` document never goes back to `error`, so a save that would leave a blocking issue is rejected. For `unreviewed` documents, see [question 2](#open-questions).
  - Each blocking code has a way out:
    - choose the supplier
    - set the term: the app suggests one from `raw_output`, a person confirms it, and that re-checks the supplier's documents in *Error* ([question 10](#open-questions))
    - type in the due date
    - discard the document (soft delete)
    - retry `extraction_failed`, which adds a new job row
    - type the data in by hand
  - Invariant 6 still applies, and every change is audited with the user who made it.
- Later: accepting issues in slice 7, and re-extracting a document that already has data ([question 11](#open-questions)).

**Acceptance.**
1. Open the document left stuck in slice 5. Set the term from *A resolver* with the suggested value. That document and the supplier's other stuck documents leave *Error*.
2. Fix the issue date on a *Sin revisar* document. It becomes *Revisado*, with my name and the time.
3. Clear the total on a *Revisado* document. The save is rejected, and the document stays *Revisado*.
4. On a `supplier_unresolved` document, choose the supplier. The document leaves *Error*.
5. On an `extraction_failed` document, *Reintentar* adds a second job row and keeps the first. Typing the data in leaves it *Revisado*.
6. Discard an `unsupported_document`. It leaves the tray but stays in the database with `deleted_at` set.

**Tests.**
- A table of allowed and forbidden status changes.
- `reviewed` can never go to `error`.
- Invariant 8 holds on every path.
- Setting a term only touches that supplier's documents in *Error*, and goes through the due-date function.
- A suggested term is never saved without a person confirming it.
- `raw_output` doesn't change when a document is edited.
- A retry keeps the earlier jobs.
- Discarding is a soft delete with an audit entry.

**Out.** The codes that can be accepted, re-extraction, and editing lines and taxes until [question 8](#open-questions) is answered.

**Doors.** Two-way, as long as retry stays limited to documents with no data.

## 7. Duplicates and consistency checks

**Goal.** Catch likely duplicates and misread sums before they reach the balance, and let a person accept the ones that are right as printed.

**Design.**
- The codes that can be accepted, the $1 tolerance and the skip rules, in [Validation](../system-design.md#validation)
- Rule 3 in [Duplicates](../system-design.md#duplicates)
- [Decision 1](../system-design.md#decisions)

**Schema.** None. Accepted issues stay in `issues`, and `RESTAURANT_CUIT` comes from the environment.

**Rules.**
- Now:
  - `duplicate_suspected`: same supplier, issue date and total, where at least one of the two documents has no number.
  - `totals_mismatch`: skipped when the document has no taxes.
  - `lines_mismatch`: the sum of lines matches neither `subtotal` nor `total`. Skipped when there are no lines.
  - `wrong_recipient`: see [question 9](#open-questions).
  - Equal amounts alone never make a duplicate. There's no `base × rate` check and no per-line `quantity × unit_price` check.
  - Accepting an issue marks it as accepted. Once every remaining issue is accepted, the document becomes `reviewed` by whoever accepted the last one. Blocking codes can't be accepted.

**Acceptance.**
1. Upload two different photos of the same delivery note with no number. The second goes to *Error* as a possible duplicate. Accepting the issue makes it *Revisado*, and discarding it removes it.
2. Set `RESTAURANT_CUIT` locally to another test CUIT and upload a document. It gets `wrong_recipient`.
3. Change an extracted subtotal by 5 and save. `totals_mismatch` appears and asks to be accepted. Changing it by 0.50 passes.
4. A document with no taxes never gets `totals_mismatch`.

**Tests.**
- A passing and a failing case for each code.
- The tolerance boundary, at exactly $1 and just over.
- The skip rules.
- The same total on a different day isn't a duplicate.
- Two numbered documents with the same date and total don't get `duplicate_suspected`.
- The API refuses to accept a blocking code.

**Out.** Linking delivery notes to invoices, and QR checks, which are both out of scope.

**Doors.** One-way: deduplication. Its tests cover both false positives and false negatives.

## 8. Production with backups

**Goal.** Restaurant staff use the app over HTTPS from their phones, and nightly backups have been restored at least once.

**Design.** [Operations](../system-design.md#operations), and Worker in [Extraction](../system-design.md#extraction).

**Schema.** None.

**Rules.**
- Now:
  - Docker Compose runs nginx, the backend, the worker and Postgres, with Certbot for HTTPS.
  - `UPLOAD_DIR` lives on a volume.
  - Every night, a `pg_dump` and a copy of `UPLOAD_DIR` go to storage outside the VPS ([question 16](#open-questions)).
  - There's a restore script.
  - The user scripts run on the server.

**Acceptance.**
1. Sign in from a phone over HTTPS. Plain HTTP redirects to HTTPS.
2. Upload a document and see it reach *Sin revisar* or *Error*.
3. Restore last night's backup into a fresh database and folder. *Resumen* and the images match.
4. Images can't be reached as static files.

**Tests.**
- A smoke script that runs after each deploy.
- A restore drill that compares row counts and balance totals.

**Out.** Monitoring and alerts, and multi-tenancy.

**Doors.** One-way: backups and restore, authentication exposed to the internet, and the first real data. From here on, migrations run on real data.

## Order

| # | Slice | Why here |
| --- | --- | --- |
| 1 | Skeleton and accounts | Every document and payment needs `created_by`, and auth added later is how an endpoint ends up open. |
| 2 | Supplier accounts | Balance and status are the core. Invariants 1, 7 and 8 and the due-date rule get settled before anything feeds them. |
| 3 | Payments and applications | This is where money is easiest to lose: invariants 2–6, locks and concurrency. |
| 4 | Upload and view | The pipeline needs it, and its three one-way doors are best settled before any real photo arrives. |
| 5 | Extraction | It brings in the review states and sends data out of the system for the first time. |
| 6 | Fix and review | It completes the review states: the way out of *Error* and the path to *Revisado*. |
| 7 | Duplicates and consistency checks | It hardens what's already flowing. Every code it adds can be accepted, so it blocks less. |
| 8 | Production | It goes last so every earlier migration runs on an empty database. |

**First slice where you can upload a photo and see the document:** slice 4 shows the photo in *Documento*, as *Procesando*. Slice 5 is the first to show the extracted data next to it.

## Not in any slice

- Everything in [Out of scope](../system-design.md#out-of-scope).
- The items on the README roadmap: reports, tax filters and cost per dish.
- Comparing `raw_output` with people's corrections. Slice 5 already keeps the data for it.

## Open questions

1. **Checks on manual entry** (slice 2). Manual documents start as `reviewed`, but the design doesn't say which checks run when someone types one in. The plan only applies what invariants 1 and 7 force. Should `duplicate_suspected` or `supplier_term_missing` apply too? If so, where does the document go when one fails, given it can't start in `error`?
2. **A failed re-check on *Sin revisar*** (slice 6). If saving leaves a blocking issue, does the document go to `error`, or is the save rejected? The document may already have applications. In `error`, it drops out of the balance while the payments applied to it stay used up.
3. **Changing money after the fact** (slice 3). Can a payment be edited or deleted once it's applied? Can an application be removed or changed, given the table has no `deleted_at` or `updated_at`? Does invariant 6 also protect a credit note that has already given credit? Slice 3 ships without these actions until this is answered.
4. **Applying existing credit** (slice 3). *Pagos* splits a new payment. Where does someone apply a credit note, or a payment's leftover, to a document that arrives later?
5. ***Total* when there's credit** (slice 2). Is *Total* in *Resumen* the balance after credit? If so, should credit get its own column, since *Sin vencer* + *Vencido* won't add up to *Total*?
6. **Edge cases of the same-image check** (slice 4, one-way). If a `sha256` belongs to a discarded document, does the upload still return that document? What happens when only some of the photos in an upload match?
7. **Where *Procesando* documents are listed** (slice 4). They have no supplier yet, so neither *Proveedor* nor *A resolver* lists them. How does someone find one again after the upload?
8. **Editing lines and taxes** (slice 6). Can *Documento* edit them, or only the header fields, with mismatches accepted instead? The answer changes the size of slice 6.
9. **`wrong_recipient` with no recipient CUIT** (slice 7). Is that an issue, or is the check skipped?
10. **What a re-check leaves behind** (slices 6 and 7).
    - When a new term unblocks documents, do they become `unreviewed` or `reviewed`? That includes the document the person was looking at.
    - After an edit, does an accepted issue that still triggers stay accepted?
    - When someone edits the issue date of a document whose due date came from the term, is the due date recomputed with the supplier's current term?
11. **Re-extraction** (slice 6). Retry is planned only for `extraction_failed`, which has no data to overwrite. Is re-extracting a document that already has data part of the MVP? It's a one-way door.
12. **Filters and search** (slices 2 and 3). The README promises them, but the design doesn't name any. Which ones are in the MVP?
13. **Opening balances** (slices 2 and 3). Is "up to two per supplier" enforced, or is it just how they're meant to be used? Where do documents with no due date go in the oldest-due-first suggestion?
14. **Suppliers created from a misread CUIT** (slice 5). A CUIT that's valid but wrong creates a supplier that can't be deleted or merged, and it stays in *Resumen*. Is that acceptable for the MVP?
15. **Session length** (slice 1b). The design says sessions are long-lived but gives no duration.
16. **Where backups go** (slice 8). The storage outside the VPS isn't chosen yet, and sending backups there is data leaving the system. Where should they go?
