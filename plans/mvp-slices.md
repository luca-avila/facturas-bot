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

**Goal.** Create suppliers, type in documents and opening balances, and see each supplier's *Sin vencer*, *Vencido*, *Crédito* and *Total* in *Resumen* and *Proveedor*.

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
  - There is one due-date function (D4): the issue date plus the term, or a date a person types. Credit notes get no due date. An opening balance never uses the term: its due date is typed or left empty. Changing a term leaves existing documents alone.
  - There is one balance query (D1). It only counts `unreviewed` and `reviewed` documents that aren't deleted (D3), and `applied` is 0 until slice 3.
  - *Resumen* shows *Crédito* next to *Sin vencer* and *Vencido*, so the three add up to *Total*, and a totals row. All of it comes from the balance query. It searches suppliers by name or legal name, and sorts by most overdue (the default), A–Z or largest total.
  - Changes to documents and terms write `audit_log` in the same transaction (D2).
  - Every enum has an exhaustive set of Spanish labels.
  - `Money.fromString` rejects more than 12 integer digits, the most `numeric(14,2)` holds. Past that, `decimal.js` rounds to its default 20 significant digits, so `add` would round.
  - Manual entry refuses to save when invariant 1 or 7 would fail, for example an invoice from a supplier with no term and no typed due date. The only other check is that an invoice or delivery note can't have a typed due date earlier than its issue date ([question 1](#open-questions)).
  - Nothing limits how many opening balances a supplier has ([question 13](#open-questions)).
- Later: invariant 6 in slice 3, and the validation codes in slices 5 and 7.

**Acceptance.**
1. Create a supplier with a 30-day term. A CUIT with a wrong check digit is rejected with a Spanish message.
2. An invoice issued 31 days ago shows as *Vencido*. One issued 30 days ago is due today, so it shows as *Sin vencer*.
3. An opening balance with a past due date counts as *Vencido*. One without a due date counts as *Sin vencer*.
4. A credit note shows in *Crédito* and lowers *Total*. The totals row matches the sum of the rows.
5. Change the term to 45 days. Existing due dates don't move.
6. A second document with the same supplier, type, letter and number is rejected.
7. Delete a document. It drops out of the balance, and `audit_log` holds the before and after of every step.
8. *Resumen* finds a supplier by part of its legal name. Sorting by largest total puts the biggest debt first.

**Tests.**
- The due-date function, for each document type.
- Status boundaries in Buenos Aires time: a document due today is pending, and one due yesterday is overdue.
- The balance query leaves out deleted, `processing` and `error` rows (inserted directly), and subtracts credit notes.
- The database rejects rows that break invariant 1, 7 (including the null-letter case) or 8.
- The CUIT check digit.
- `Money.fromString` rejects 13 integer digits, and adding a cent to a 12-digit amount stays exact.
- When the audit write fails, the change is rolled back too.

**Out.** Payments, *Pagado*, uploads, *Error* and *Sin revisar*, lines and taxes, and the payment-status filter in *Proveedor*, which needs *Pagado*.

**Doors.** Two-way: these are new tables on an empty database.

## 3. Payments and applications

**Goal.** Record a payment and split it across documents, oldest due first, with every row editable. Whatever is left stays as credit. Credit notes can be applied too, and nothing is ever over-applied.

**Design.**
- [Decision 2](../system-design.md#decisions)
- `payments` and `applications` in [Data model](../system-design.md#data-model)
- [Invariants](../system-design.md#invariants) 2–6
- [Derived values](../system-design.md#derived-values)
- [Review status](../system-design.md#review-status): an `error` document can't take payments
- *Pagos* and *Proveedor* in [Screens](../system-design.md#screens)

**Schema.**
- `payments`: all columns.
- `applications`: all columns. `amount > 0`, and exactly one of `payment_id` and `credit_note_id` is set.

**Rules.**
- Now:
  - Invariants 2–6 live in one `ApplicationsService`. Its transaction locks the document and the payment or credit note in a fixed order. An ESLint import rule keeps any other code from writing `applications`.
  - Neither side of an application can be deleted or in `processing` or `error`.
  - Deleting a document enforces invariant 6, and a trigger on `documents` and `payments` refuses any change that breaks it. Editing arrives in slice 6.
  - *Marcar como pagado* creates the payment and its application in one transaction.
  - A partly paid document shows *Pago parcial* with what's left. Credit notes show *Disponible* or *Aplicada*.
  - Payments and applications write `audit_log`.
  - The suggested split, and the effect of each row as it's edited, come from a backend preview that runs the same code as the save (D1). The frontend does no arithmetic on amounts.
  - Existing credit, from a payment's leftover or a credit note, is applied from the *Crédito a favor* card in *Proveedor*, with the same split and through the same `ApplicationsService`.
  - *Proveedor* filters documents by payment status, *Con saldo* by default. *Pagos* lists payments and filters them by supplier.
- Later, or blocked:
  - Editing or deleting a payment, and removing an application ([question 3](#open-questions)).

**Acceptance.** These steps start from slice 2's data.
1. Invoice A for 100 is due first, and invoice B for 50 is due later. A transfer of 120 suggests 100 for A and 20 for B. After saving, A is *Pagado* and B shows *Pago parcial* with 30 left.
2. Record a payment of 80 and apply none of it. The supplier's balance drops by 80, which stays as credit.
3. In a new payment, applying 40 to B is rejected with a Spanish message.
4. Deleting A is rejected. Changing its supplier or lowering its total to 90 is rejected by the database, and slice 6 tries it from the screen.
5. From the *Crédito a favor* card in *Proveedor*, apply a credit note of 30 to B. B is *Pagado* and the note is *Aplicada*.
6. *Marcar como pagado* on a new invoice leaves it *Pagado*, with one payment and one application.
7. An eCheq keeps its number and its value date.
8. From *Crédito a favor*, apply 50 of step 2's unapplied 80 to a new invoice. 30 stays as credit.

**Tests.**
- A request that breaks any of invariants 2–5 is rejected, and nothing is written.
- Two concurrent applications that each fit alone but not together: exactly one succeeds.
- The invariant 6 cases.
- Status and outstanding amount with partial applications.
- Credit from a payment's leftover and from a partly applied credit note.
- The order of the suggested split.
- For the same split, the preview and the save give the same rows and the same leftover.
- *Marcar como pagado* is atomic.

**Out.** Editing and deleting payments, reports and reminders.

**Doors.** Two-way: nothing real is stored until slice 8.

## 4. Upload and view the photo

**Goal.** Take one or more photos of a document on the phone, upload them, see them in *Documento* as *Procesando*, and find them again in *Subidas*.

**Design.**
- [Decision 3](../system-design.md#decisions)
- *Subidas* in [Screens](../system-design.md#screens)
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
  - Same image ([question 6](#open-questions)). Photos are compared by `sha256` with the images of documents that aren't deleted, in any status.
    - If every photo is already in one document, even only some of its pages or in another order, the upload returns that document and creates nothing.
    - Any other match refuses the whole upload, and each matching page names the document that has it. That covers some photos matching and others not, and photos from two documents. Nothing is written, so no image ever belongs to two documents and no page is dropped silently.
    - The same photo twice in one upload is refused on that page.
    - A photo whose only document is deleted creates a new document, so deleting can be undone by uploading again.
    - The server hashes the bytes it receives, which are the bytes it stores. The upload transaction takes one `pg_advisory_xact_lock` that every upload shares, then checks again before inserting (C1), so a retry that arrives while the first request is still running can't create a second document. A unique index on `sha256` can't do this, because a deleted document's hash can come back.
  - Images are only served through an authenticated endpoint.
  - *Subidas* lists what was uploaded in the last 7 days, newest first, with *Mías* and *Todas*. A *Procesando* document stays listed however old it is.
- Later: the worker, in slice 5.

**Acceptance.**
1. On the local network, use the phone to photograph a printed two-page document with invented data. *Documento* shows both pages in order, *Procesando*, and *Subido por* with my name.
2. Upload the same file again. It opens the same document, and the database still has only one. Upload its first page together with a new photo. The upload is refused with a Spanish message on that page, and nothing is created.
3. Opening the image URL in a private window returns 401.
4. A HEIC file on a desktop browser, or an oversized file, gets the Spanish message.
5. *Resumen* doesn't change.
6. The upload shows in *Subidas* under *Mías* and *Todas*. Signed in as someone else, it shows under *Todas* only.

**Tests.**
- The upload transaction is all or nothing.
- Photos that are all in one document, all of its pages or some, in any order, return its id and write nothing.
- A partial match, or photos from two documents, is refused with a 409 and writes nothing.
- The same photo twice in one upload is refused.
- A photo whose only document is deleted creates a new document.
- Two identical uploads at the same time leave one document.
- Served bytes have the same hash as the uploaded ones.
- The image endpoint refuses requests without a session.
- Rejected types and sizes.
- A frontend unit test for the compression options.
- *Subidas* drops a finished document after 7 days, and keeps a *Procesando* one.

**Out.** Extraction, and cleanup of files whose transaction failed.

**Doors.** One-way: compression settings, deduplication and access to images. The blast radius stays small: nothing real is uploaded before slice 8, and slice 5's extraction test confirms the 2200 px first.

## 5. Extraction to *Sin revisar* or *Error*

**Goal.** The worker reads each upload with Haiku. It leaves the document in *Sin revisar*, where it counts as debt, or in *Error*, with the reason in Spanish.

**Gate.** Run the [extraction test](../system-design.md#extraction) first. It runs the five samples at each effort level, all kept in the gitignored `samples/`. Only `factura-a-01` is hand-labeled, in `samples/labels.json`. It's compared field by field, including that the CAE expiry isn't read as `printedDueDate`. The other four are judged by this slice's own checks: the CUIT check digit, subtotal plus taxes against the total, and lines against the subtotal or total. Their dates and numbers get checked by hand once the app shows them next to the photo. It sets `output_config.effort` and measures cost from `usage`. It also confirms the 2200 px. The samples are 900×1600, so it shows that Haiku reads them at that size, and from `usage` that a 2200 px image stays under the token limit. Comparing compressed and original photos waits until there are originals.

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
  - **Schema extras.** The Zod schema also asks for what the tables don't hold: the supplier's CUIT and printed name, the recipient's CUIT, any printed payment term, in days or as a payment date (for slice 6's suggestion, never for `due_date`), and whether the photo is a document at all.
  - **Supplier.** A valid CUIT that isn't in the database creates the supplier, using the printed name. An invalid or missing one gives `supplier_unresolved`. So does the restaurant's own CUIT, from `RESTAURANT_CUIT`, which arrives here instead of in slice 7, and a new CUIT with no legible printed name ([question 14](#open-questions)). `due_date` only comes from slice 2's function.
  - **Checks (V1).** `extraction_failed`, `unsupported_document`, `supplier_unresolved`, `missing_total`, `missing_issue_date`, `supplier_term_missing` and `duplicate_number`. `duplicate_number` compares against the same set of documents as invariant 7. A unique-index violation on write also becomes `duplicate_number`. `uniqueViolationIndex` only recognizes `P2002`, which Prisma's model API throws. A raw query (`$executeRaw`, `$queryRaw`) throws `P2010` for the same violation, so the worker writes documents through the model API, or extends the helper first and tests it with a real violation.
  - **Screens.** *A resolver* is read-only, *Resumen* warns about *Error* documents, and *Documento* shows the data next to the image.
  - **Audit.** The worker's `audit_log` entries have no `user_id`.
- Later: fixing documents in slice 6, and the codes that can be accepted in slice 7.

**Acceptance.**
1. Upload a document from a supplier the app doesn't know. It goes from *Procesando* to *Error* in *A resolver*, with the missing-term reason in Spanish. The supplier now exists, and *Resumen* warns about one document and its amount.
2. Set that supplier's term (slice 2) and upload another of their documents. It lands in *Sin revisar*, its due date is the issue date plus the term, it counts in *Proveedor*, and it can take a payment.
3. A photo that isn't a document gives `unsupported_document`.
4. With a bad API key, the document ends in `extraction_failed` after the retries, and `last_error` is saved.
5. Kill the worker mid-job. Once the lease expires, the job runs again, and only one result is written.
6. Set `RESTAURANT_CUIT` locally to a supplier's test CUIT and upload one of their documents. It gives `supplier_unresolved`.

**Tests.**
- Mapping from invented LLM outputs, with the SDK client mocked.
- The restaurant's own CUIT, or a new CUIT with no printed name, gives `supplier_unresolved` and creates no supplier.
- A passing and a failing case for each code.
- A printed due date or CAE expiry never reaches `due_date`.
- A duplicate number that only the unique index catches, through the worker's own write, ends as `duplicate_number`, not as a failed attempt.
- Claiming, leasing, retries and backoff, on a real Postgres.
- Running a job twice leaves one set of lines and taxes.
- Each failing stop reason counts as a failed attempt.
- No sampling parameters are sent in the request.

**Out.** Fixing and accepting, re-extraction, the consistency checks, and using corrections as an evaluation set.

**Doors.** One-way: documents are sent to an LLM provider for the first time. That includes the samples the extraction test sends. Sending the five samples to Anthropic was approved on 2026-11-24.

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
  - Saving runs the checks again, and on an `error` document (including *Elegir proveedor*) requires every blocking issue to pass. If they pass, the document becomes `reviewed`, with `reviewed_by` and `reviewed_at` set to whoever saved it (invariant 8).
  - Neither `unreviewed` nor `reviewed` ever goes back to `error`, so a save that would leave a blocking issue is rejected.
  - Each blocking code has a way out:
    - choose the supplier
    - set the term: the app suggests one from `raw_output`, and before a person confirms it, a backend preview shows the due dates it would give. Saving re-checks the supplier's documents in *Error*, and the ones that pass become *Sin revisar*
    - type in the due date
    - discard the document (soft delete)
    - retry `extraction_failed`, which adds a new job row
    - type the data in by hand
  - Only the header can be edited. Lines and taxes are read-only.
  - Correcting the issue date of a document whose due date came from the term recomputes it with the term it was created with, not the supplier's current one.
  - A `manual` due date doesn't move, so a corrected issue date can leave it earlier than the issue date. On an invoice or delivery note that save is refused with `due_date_before_issue`, as in manual entry.
  - Invariant 6 still applies, and every change is audited with the user who made it.
- Later: accepting issues in slice 7, and re-extracting a document that already has data ([question 11](#open-questions)).

**Acceptance.**
1. Open the document left stuck in slice 5. Set the term from *A resolver* with the suggested value. That document and the supplier's other stuck documents leave *Error* and become *Sin revisar*.
2. Fix the issue date on a *Sin revisar* document. It becomes *Revisado*, with my name and the time. Its due date moves by the same number of days, even if the supplier's term changed since it was created.
3. Clear the total on a *Revisado* document. The save is rejected, and the document stays *Revisado*.
4. On a `supplier_unresolved` document, choose the supplier. The document leaves *Error*.
5. On an `extraction_failed` document, *Reintentar* adds a second job row and keeps the first. Typing the data in leaves it *Revisado*.
6. Discard an `unsupported_document`. It leaves the tray but stays in the database with `deleted_at` set.
7. On a document with applications, changing the supplier or lowering the total below what's applied is rejected.

**Tests.**
- A table of allowed and forbidden status changes.
- `reviewed` can never go to `error`.
- Invariant 8 holds on every path.
- Setting a term only touches that supplier's documents in *Error*, goes through the due-date function, and leaves them `unreviewed`.
- A corrected issue date recomputes the due date with the original term, and leaves a `manual` due date alone. One that moves past a `manual` due date on an invoice or delivery note is refused.
- A suggested term is never saved without a person confirming it.
- `raw_output` doesn't change when a document is edited.
- A retry keeps the earlier jobs.
- Discarding is a soft delete with an audit entry.

**Out.** The codes that can be accepted, re-extraction, and editing lines and taxes, which waits for the reports that use them.

**Doors.** Two-way, as long as retry stays limited to documents with no data.

## 7. Duplicates and consistency checks

**Goal.** Catch likely duplicates and misread sums before they reach the balance, and let a person accept the ones that are right as printed.

**Design.**
- The codes that can be accepted, the $1 tolerance and the skip rules, in [Validation](../system-design.md#validation)
- Rule 3 in [Duplicates](../system-design.md#duplicates)
- [Decision 1](../system-design.md#decisions)

**Schema.** None. Accepted issues stay in `issues`, and `RESTAURANT_CUIT` already comes from the environment, since slice 5.

**Rules.**
- Now:
  - `duplicate_suspected`: same supplier, issue date and total, where at least one of the two documents has no number (`opening_balance` excluded on both sides).
  - `totals_mismatch`: skipped when the document has no taxes, no subtotal, or no total.
  - `lines_mismatch`: the sum of lines matches neither `subtotal` nor `total`. Skipped when there are no lines, when any line has no `line_total`, or when both `subtotal` and `total` are missing.
  - `wrong_recipient`: missing or invalid recipient CUIT defaults to `RESTAURANT_CUIT` and skips the check; only a valid 11-digit recipient CUIT different from `RESTAURANT_CUIT` triggers it ([question 9](#open-questions)).
  - Manual entry checks `duplicate_suspected` (except `opening_balance`), returning a 409 warning with a link to the existing document and asking whether to save anyway (`allowSuspectedDuplicate: true`), recording it as accepted ([question 1](#open-questions)).
  - Editing header fields re-evaluates acceptable checks without auto-preserving prior acceptances ([question 10](#open-questions)). On `error`, once blocking checks pass, edits save and stay `error` if unaccepted acceptable issues remain. On `unreviewed`/`reviewed`, unaccepted acceptable issues reject with 409 until confirmed.
  - No side-by-side duplicate comparison screen (`6e`) in the MVP: `duplicate_suspected` shows its warning with a link to the existing document and direct accept/discard actions.
  - Equal amounts alone never make a duplicate. There's no `base × rate` check and no per-line `quantity × unit_price` check.
  - Accepting an issue marks it as accepted. Once every remaining issue is accepted (and no concurrent duplicate appeared), the document becomes `reviewed` by whoever accepted the last one. Blocking codes can't be accepted.

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

**Goal.** Restaurant staff use the app over HTTPS from their phones, accounts are managed on the server, and each deploy is verified by a smoke script. Automated off-VPS backups and restore are deferred out of the MVP by user decision ([question 16](#open-questions)).

**Design.** [Operations](../system-design.md#operations), and Worker in [Extraction](../system-design.md#extraction).

**Schema.** None.

**Rules.**
- Now:
  - Docker Compose runs nginx, the backend, the worker and Postgres, with Certbot for HTTPS.
  - `UPLOAD_DIR` lives on a volume.
  - The user scripts run on the server.
- Later (deferred out of MVP):
  - Nightly `pg_dump` and a copy of `UPLOAD_DIR` to storage outside the VPS, plus a restore script and restore drill ([question 16](#open-questions)).

**Acceptance.**
1. Sign in from a phone over HTTPS. Plain HTTP redirects to HTTPS.
2. Upload a document and see it reach *Sin revisar* or *Error*.
3. Images can't be reached as static files.

**Tests.**
- A smoke script that runs after each deploy.
- An isolated local Docker Compose verification harness covering HTTP-only Certbot bootstrap, HTTPS redirect, security headers, auth cookies, upload/image isolation, secret separation, and server user scripts.

**Out.** Nightly backups and restore (deferred out of the MVP for a dedicated follow-up slice), monitoring and alerts, and multi-tenancy.

**Doors.** One-way: authentication and documents exposed to the internet, the first real data (from here on, migrations run on real data), and operating without automated off-VPS backups until the follow-up backup slice lands.

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

1. **Checks on manual entry** (slices 2 and 7). Manual documents start as `reviewed`, so they can't start in `error`.
   - Answered: in slice 2, manual entry only applies what invariants 1 and 7 force. `supplier_term_missing` needs no check of its own, because invariant 1 already makes the form ask for a term or a typed due date.
   - Answered: an invoice or delivery note with a typed due date earlier than its issue date is refused with `due_date_before_issue`. That catches a mistyped year, such as 2025 for 2026, which would make the document overdue at once. Opening balances are exempt: the overdue one is often typed with the cutover date as its issue date and a past due date.
   - Answered (slice 7): manual entry checks `duplicate_suspected` for types other than `opening_balance`. When a match exists, `POST /api/documents` returns `409` with the matching `documentId`, and the form shows an inline warning with a link to the existing document and asks whether to save anyway (`allowSuspectedDuplicate: true`). Saving anyway still creates the document as `reviewed`, recording `duplicate_suspected` as accepted.
2. **A failed re-check on *Sin revisar*** (slice 6). If saving leaves a blocking issue, does the document go to `error`, or is the save rejected? The document may already have applications. In `error`, it drops out of the balance while the payments applied to it stay used up.
   - Answered: the save is rejected with field errors, just like on a `reviewed` document. Neither `unreviewed` nor `reviewed` ever goes back to `error`. Saving an `error` document (including via *Elegir proveedor*) also requires every blocking issue to pass before becoming `reviewed`.
3. **Changing money after the fact** (slice 3). Can a payment be edited or deleted once it's applied? Can an application be removed or changed, given the table has no `deleted_at` or `updated_at`? Does invariant 6 also protect a credit note that has already given credit? Slice 3 ships without these actions until this is answered.
   - Answered: invariant 6 protects both sides of an application. A credit note or a payment that has given credit can't be deleted or change supplier, and can't drop below what it gave. Editing and deleting payments and removing applications stay open.
4. **Applying existing credit** (slice 3). Answered: from the *Crédito a favor* card in *Proveedor*, with the same split as *Pagos*.
5. ***Total* when there's credit** (slice 2). Answered: *Total* is the balance after credit, and *Resumen* gets a *Crédito* column so the row adds up.
6. **Edge cases of the same-image check** (slice 4, one-way). Answered: only documents that aren't deleted count, so a photo whose document was deleted can be uploaded again, and deleting can be undone. An upload whose photos are all in one document returns that document. Any other match refuses the whole upload, naming the document on each matching page. A shared advisory lock, not a unique index, keeps two uploads at the same time from both passing the check.
7. **Where *Procesando* documents are listed** (slice 4). Answered: in *Subidas*, a new screen with the last 7 days of uploads, where *Procesando* documents stay however old.
8. **Editing lines and taxes** (slice 6). Answered: only the header fields can be edited, and mismatches are accepted instead.
9. **`wrong_recipient` with no recipient CUIT** (slice 7). Answered: a missing, blank, or invalid recipient CUIT defaults to `RESTAURANT_CUIT` and skips the check. `wrong_recipient` only triggers when extraction reads a valid 11-digit recipient CUIT that differs from `RESTAURANT_CUIT`.
10. **What a re-check leaves behind** (slices 6 and 7).
    - Answered: documents a new term unblocks become `unreviewed`, including the one the person was looking at. Previously accepted issues are preserved when setting a supplier term.
    - Answered (slice 7): after a document edit, accepted issues are not auto-preserved — every acceptable check is re-evaluated and must be explicitly accepted again if it still triggers. On `error` documents, once blocking checks pass, edits save and stay `error` with open acceptable issues if not accepted in the save; on `unreviewed`/`reviewed`, unaccepted acceptable issues reject with `409` so the user confirms before saving as `reviewed`.
    - Answered: a corrected issue date recomputes the due date with the term the document was created with, not the supplier's current one.
11. **Re-extraction** (slice 6). Retry is planned only for `extraction_failed`, which has no data to overwrite. Is re-extracting a document that already has data part of the MVP? It's a one-way door.
    - Answered: out of the MVP. *Reintentar* is strictly for `upload` documents in `error` with `extraction_failed` and no extracted data.
12. **Filters and search** (slices 2 and 3). Answered: search and sort in *Resumen* (slice 2), the payment-status filter in *Proveedor* and the supplier filter in *Pagos* (slice 3), and *Mías* or *Todas* in *Subidas* (slice 4). See [Screens](../system-design.md#screens).
13. **Opening balances** (slices 2 and 3).
    - Answered: "up to two per supplier" is how they're meant to be used, not a rule. Nothing enforces it: a unique index can't tell the overdue one from the one that isn't, since only their due dates differ, and they're typed in once, at the start.
    - Answered: documents with no due date take their issue date's place in the oldest-due-first suggestion, by `COALESCE(due_date, issue_date)`, and *Proveedor* lists them in the same order. Put last, an opening balance without a due date would never be suggested while newer invoices keep arriving, and since it never becomes overdue, nothing would flag it.
14. **Suppliers created from a misread CUIT** (slice 5). A CUIT that's valid but wrong creates a supplier that can't be deleted or merged, and it stays in *Resumen*.
    - Answered: acceptable for the MVP, with two guards. The check digit catches any single misread digit, so a valid but wrong CUIT most likely comes from reading another CUIT on the page, usually the restaurant's. A supplier CUIT equal to `RESTAURANT_CUIT` gives `supplier_unresolved`, and so does a new CUIT with no legible printed name, so the worker never makes up a name.
    - Answered: the risk is a leftover row, not hidden debt. A new supplier has no term, so its first invoice or delivery note stops in *Error*, where a person sees it. Only a credit note can land on a wrong supplier unseen. If leftover suppliers show up, deleting one with no documents or payments is a small addition.
15. **Session length** (slice 1b). Answered: a session expires after 30 days without use, and each request renews it.
16. **Where backups go** (slice 8). The storage outside the VPS isn't chosen yet, and sending backups there is data leaving the system. Where should they go?
    - Deferred (slice 8): off-VPS nightly `pg_dump` + `UPLOAD_DIR` backups, the restore script, and the restore drill are deferred out of the MVP by user decision. They will be planned in a dedicated follow-up slice once the app is running cleanly in production.
