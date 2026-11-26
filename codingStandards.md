# Coding standards

Rules for code review. This file only holds what needs judgment: if a linter, a type or a test can catch something, it belongs there instead.

- Every rule can be answered yes or no by reading a diff.
- Rule IDs are stable. When a review fix relates to a rule, use its ID as the category in `memory.md`, so the retro can count repeats.
- New rules come from the retro. When a tool starts covering a rule, delete the rule.

Generic style advice doesn't belong here, and neither do the test and typing rules already in the agent prompts.

## Data integrity

### D1. Status and balance have one implementation
Only the backend query computes them. The frontend renders what it receives, and neither value is ever stored.
Why: two implementations end up showing different debts.
Check: arithmetic on amounts or comparisons of due dates in `frontend/`, or a status or balance column in a migration.

### D2. Financial changes write `audit_log` in the same transaction
This covers documents, payments, applications and supplier terms. The entry carries the acting user in `user_id`, which stays empty only for changes made by the worker.
Why: it's the only record of who changed a financial value and what it was before.
Check: a write to those tables with no audit entry in the same transaction, or an entry without `user_id` for a change a person made.

### D3. Reads exclude soft-deleted rows
Every query on `documents` or `payments` filters on `deleted_at`, unless it's explicitly meant to see deleted rows.
Why: a deleted document that still adds to a balance is a wrong debt.
Check: a new query on those tables without that filter.

### D4. `due_date` has one rule
It's either `issue_date + payment_term_days`, computed in one function, or typed by a person.
Why: printed dates can look right and still pass every other check.
Check: code that writes `due_date` from extraction output.

## Concurrency

### C1. A check still holds when its write lands
A read that decides a write, such as a limit, what's left to apply or a duplicate, comes after a lock on what it read, or runs in the same synchronous step that records the write, or is backed by a constraint. Locks follow the one order in `agents.md`: an existing payment first, then every document in one `ORDER BY id FOR UPDATE`. A response built from several reads takes them in one snapshot.
Why: parallel sign-ins got past the rate limit, a supplier's figures disagreed with its own document list, and two saves deadlocked. Each passed its tests, and each was found in review.
Check: an `await` between a check and the write it guards, a `FOR UPDATE` outside that order, or a response built from two queries outside one transaction.

## Extraction

### E1. No LLM calls inside a database transaction
Why: a slow call would hold locks and a connection for as long as it takes.
Check: a call to the LLM client inside a transaction callback.

### E2. A job can run twice
Why: when a lease expires after a crash, another run picks up the job.
Check: a job step that writes without accounting for what an earlier run may have left.

### E4. Changing the prompt or the schema bumps `prompt_version`
Why: otherwise a result can't be traced to what produced it.
Check: a diff that touches either one and leaves `prompt_version` as it was.

### E5. Images stay as uploaded
The server never resizes or re-encodes them.
Why: each lossy pass hurts legibility, and originals aren't kept.
Check: server code that transforms image bytes.

## Validation

### V1. Validations only decide
A validation returns issues and the caller writes the result. Each one has a code, a Spanish message, and a test with a passing case and a failing case.
Why: an untested check is a silent path into the balance.
Check: a validation that writes to the database, or one that's missing any of the above.
