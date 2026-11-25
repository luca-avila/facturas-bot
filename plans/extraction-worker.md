# Plan: Extraction to *Sin revisar* or *Error* (slice 5)

Spec: [`mvp-slices.md`, section 5](mvp-slices.md#5-extraction-to-sin-revisar-or-error). Branch: `feat/extraction-worker`.

## Goal

A worker process reads each uploaded document with Claude Haiku 5.5. The document leaves *Procesando* on its own and lands in *Sin revisar*, where it counts as debt, or in *Error*, with the reasons in Spanish. *A resolver* lists the *Error* documents, *Resumen* warns how many there are and how much they add up to, and *Documento* shows the data read next to the photo.

## Out of scope

- Every action on an *Error* document: fixing, accepting, *Definir plazo*, *Elegir proveedor*, *Reintentar*, *Cargar a mano*, *Descartar* (slice 6), and the grouped case at the top of *A resolver* (6a).
- The checks that can be accepted: `totals_mismatch`, `lines_mismatch`, `wrong_recipient` and `duplicate_suspected` (slice 7). The schema already reads what they need (recipient CUIT, subtotal, taxes, lines).
- Re-extraction of any kind ([question 11](mvp-slices.md#open-questions)). A job only ever writes to a document that is still `processing`.
- Suggesting a term from the printed one (slice 6). `printedTermDays` and `printedDueDate` are only kept in `raw_output`.
- Deleting suppliers the worker created ([question 14](mvp-slices.md#open-questions)).
- Using corrections as an evaluation set, and comparing compressed with original photos (no originals exist yet).
- The worker's container, Compose service and deployment (slice 8). The worker runs with `npm run start:worker` here.
- The *A resolver* counter in the navigation, the bottom navigation bar (0b), the per-supplier error line in *Resumen* rows (2a, "2 con error · …"), the payment status chip and *Pagos* section in *Documento* (5b), the desktop side-by-side layout (5h), page swiping and zoom controls in *Foto* (5c), and thumbnails in *A resolver* (6b). See *Decisions*.
- *Subidas* refreshing itself.
- Removing EXIF from what is sent. See *Doors*.
- Frontend DOM or component tests, as in earlier slices.
- `memory.md`: this plan fixes no review finding.

## Decisions

Defaults chosen within the spec. Step 1 writes them into `system-design.md`, and step 4 adds the extraction test's figures.

1. **The worker is its own process.** `backend/src/worker.ts` starts a Nest application context (`NestFactory.createApplicationContext(WorkerModule)`), with no HTTP server. `AppModule` never imports `ExtractionModule`, so the backend never holds the API key and can't call the LLM. One job at a time.
2. **"Retries three times" means four attempts**: the first one plus three retries. After attempt 1, 2 and 3 fail, the job waits 30 s, 2 min and 8 min (30 s × 4ⁿ⁻¹). The fourth failure ends the job, and the document goes to *Error* with `extraction_failed`. A bad API key therefore takes about 10.5 minutes to reach *Error*.
3. **Times.** Each call times out after 3 minutes (`CALL_TIMEOUT_MS = 180_000`). A lease lasts 5 minutes (`LEASE_MS = 300_000`), longer than a call, so a live worker never loses its job to a second one. An idle worker looks for work every 5 s (`POLL_MS = 5_000`).
4. **What a failed attempt is.** Any of these:
   - the SDK throws an `AnthropicError`. That includes every HTTP and connection error (`APIError`), and also JSON the SDK can't parse or that fails the Zod schema: the probe showed `parse()` **throws** for those, with no status, instead of returning a null `parsed_output`;
   - `stop_reason` is `max_tokens`, `refusal` or `model_context_window_exceeded`. This is checked before `parsed_output`, because a `refusal` with valid JSON text still parses;
   - `parsed_output` is null;
   - a stored image can't be read.

   `last_error` keeps the error's class, its status if any, and its message, cut to 1,000 characters. The SDK's messages never include the key. Logs only show the job id, the class and the status, never a message, since a parse error can quote what was read.
5. **Two cases end a job at once, with no call.**
   - The document was deleted, or isn't `processing`. The job becomes `failed` with a `last_error`, and the document isn't touched. Nothing from a deleted document is ever sent.
   - The pages add up to more than `MAX_IMAGE_BYTES_PER_CALL = 22_000_000` bytes. In base64 that's about 29.3 MB, under the API's 32 MB request limit. Only originals uploaded after compression failed can get there (ten of 7 MiB). The document goes to *Error* with `extraction_failed`, and *Cargar a mano* in slice 6 is the way out.
6. **The attempt number is the fencing token.** Claiming a job increments `attempts`. Every later write for that attempt locks the job row and checks `status = 'running' AND attempts = <claimed>`. If it doesn't match, because the lease expired and another run took the job, the write is dropped. A worker that stalled can't write a second result.
7. **Claiming** (a short transaction, committed before the call, E1):
   - The query is `SELECT … FROM extraction_jobs WHERE (status = 'queued' AND run_after <= $now) OR (status = 'running' AND locked_until < $now) ORDER BY run_after, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`. `$now` always comes from `now()` in `clock.ts`, never from SQL `now()`, so tests can move time.
   - A `running` job whose lease expired after its last attempt (`attempts >= MAX_ATTEMPTS`) ends as in decision 2, with no call.
   - Otherwise the job becomes `running`, with `attempts + 1`, `locked_until = now + LEASE_MS`, and the current `model` and `prompt_version`.
8. **Writing the result is one transaction**, only while the document is `processing` (E1–E4).
   - It locks in this order: the job (`FOR UPDATE`, fence check), then the document (`audit.snapshot`, which locks), then the supplier (`FOR SHARE`, or the row it inserts). A person setting the supplier's term waits for the write or is waited for, so `supplier_term_missing` is decided under a lock (C1).
   - It replaces all of the document's lines and taxes, and writes them for *Error* documents too, so *Documento* can show them.
   - It writes one `audit_log` entry for the document (`update`), and one for a supplier it creates (`create`), both with no `user_id` (D2). Lines and taxes get no entry: they're never edited in the MVP, and `raw_output` keeps what was read.
   - The job becomes `succeeded` with `raw_output`, which is the model's JSON text as parsed before Zod, written once (E3).
9. **Resolving the supplier.**
   - The CUIT is the printed one with spaces, dots and hyphens removed. Missing, not 11 digits, a wrong check digit, or equal to `RESTAURANT_CUIT` gives `supplier_unresolved`.
   - A supplier with that CUIT already exists: it's the supplier.
   - A new CUIT with a printed name creates the supplier, with the trimmed name as `name` and `legal_name`, the CUIT, and no term. It's inserted with `createManyAndReturn({ skipDuplicates: true })` (`ON CONFLICT DO NOTHING`), then read back, so a person saving the same CUIT at the same moment can't make the write fail.
   - A new CUIT with no legible name gives `supplier_unresolved`, and creates nothing.
   - A photo that isn't a document never resolves or creates a supplier.
10. **Mapping what was read.** Pure functions, no database. Anything that doesn't fit its column becomes null, never an error:
    - Amounts go through `Money.fromString`. A `total` that isn't positive is null, so `missing_total`. A negative `subtotal` is null.
    - Dates must pass `isIsoDate`.
    - A `number` with no digits is null. A `letter` comes from a Zod enum.
    - Line and tax decimals must fit their column (`quantity` 3 decimals, `unit_price` 4, rates 2 and at most 999.99). Otherwise that value is null and the line stays.
    - A line with a blank description is skipped, and positions are renumbered from 1. A tax with no readable amount or a blank label is skipped.
    - `cae` is kept only as 14 digits.
    - `printedDueDate`, `caeDueDate` and `printedTermDays` are never read by the write. `due_date` only comes from `resolveDueDate` with the supplier's term (D4). A credit note never gets one.
11. **The schema gives the CAE expiry its own field, `caeDueDate`**, which isn't stored anywhere else. It's the misread the design worries about most, and giving it a place of its own makes it less likely to end up in `printedDueDate`. Factura-a-01's label checks this in the extraction test.
12. **Issues** are stored as `[{ "code": "…" }]`, in this fixed order: `extraction_failed`, `unsupported_document`, `supplier_unresolved`, `missing_total`, `missing_issue_date`, `supplier_term_missing`, `duplicate_number`. The API sends the codes only. `unsupported_document` is always alone: such a document gets no fields, lines, taxes or supplier.
13. **`duplicate_number`.** The write checks the invariant 7 set first: same supplier, type, letter and `number_normalized`, not deleted, `unreviewed` or `reviewed`. If a concurrent write gets past that check, the unique index raises P2002 on `tx.document.update` (model API, so `uniqueViolationIndex` recognizes it). The whole transaction then runs once more with the duplicate already known, and ends in *Error* with `duplicate_number`. The attempt didn't fail.
14. **The SDK client is pinned down.** `new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: CALL_TIMEOUT_MS, logLevel: 'warn', fetch })`.
    - Passing `apiKey` stops the SDK from reading other credentials from the environment.
    - Passing `baseURL` stops `ANTHROPIC_BASE_URL` from sending the photos anywhere else.
    - Passing `logLevel` stops `ANTHROPIC_LOG=debug` from printing requests.
    - `fetch` comes from an `LLM_FETCH` provider, `globalThis.fetch` by default, so tests run the real SDK against a fake.
    - No `system`, no `thinking` (adaptive is Haiku 5.5's default), and no sampling parameters, which return 400 on API version `2026-10-21`.
15. **`PROMPT_VERSION` covers everything in `prompt.ts`**: the prompt, the schema, the effort and `max_tokens`. It starts at `'1'`, and stays `'1'` through the extraction test, because nothing is stored before this branch merges. After that, any change bumps it (E4).
16. **Backend tests never reach the network.**
    - A Vitest setup file replaces `globalThis.fetch` with one that throws.
    - The Vitest config sets `ANTHROPIC_API_KEY` to a fake value, `LLM_MODEL` to `claude-haiku-5-5` and `RESTAURANT_CUIT` to a test CUIT. That matters because `loadRootEnv()` in `vitest.config.ts` loads the real `.env`.
    - Worker tests pass a fake through `LLM_FETCH`.
17. **The *Error* warning's amount** adds up the totals of *Error* documents that aren't credit notes. A credit note in *Error* is counted but adds nothing, since it would lower the debt and not raise it. It names the supplier only when every *Error* document has the same known one. `GET /api/suppliers` returns it in the same snapshot as the balances, so *Resumen* makes one request and has one failure state.
18. **Screens.**
    - *A resolver* is read-only. It has no thumbnails (as in *Subidas*), no actions or grouping until slice 6, and it's ordered oldest upload first. Each row's date is the upload date, because an unreadable document has no other.
    - *Documento* uses the *Datos* and *Foto* tabs (5b, 5c) at every width. It checks again every 3 s while *Procesando*.
    - The navigation gets an *A resolver* link with no counter.
19. **Each spec file that gives suppliers a CUIT has its own group of test CUITs**, and frees only that group before each test. Spec files run in parallel against one database, and `suppliers.spec.ts` currently frees all five CUITs. That would steal the worker specs' suppliers' CUITs in the middle of a test.
20. **The extraction test (the gate) picks the effort**: the lowest of `low`, `medium`, `high`, `xhigh` and `max` at which all five samples pass. It never saves its output, and it prints values only with `--values`.

**Verified facts.** These were checked on 2026-11-24 in a scratch directory outside the repo, which isn't open to the implementer. They used `@anthropic-ai/sdk` 1.8.0 and `zod` 4.6.7 on Node 24, with a fake `fetch` and no network.

- Package age.
  - `@anthropic-ai/sdk` 1.8.0 was published 2026-11-10, 14 days ago. 1.9.0 to 1.14.0 are all newer than two weeks.
  - `zod` 4.6.7 was published 2026-10-12.
  - Pin both exactly.
- What `client.messages.parse()` sends.
  - With `model`, `max_tokens`, `output_config: { effort, format: zodOutputFormat(schema) }` and one user message holding an image block and then a text block, the body's keys are exactly `max_tokens, messages, model, output_config`, and the content order is `image, text`.
  - `output_config` is `{ effort, format: { type: 'json_schema', schema } }`.
  - Nullable fields become `type: [x, "null"]` or `anyOf`, and objects get `additionalProperties: false`.
  - The headers include `anthropic-version: 2026-10-21` and the key as `authorization: Bearer …`.
- Retries and errors.
  - With `maxRetries: 0`, a 529 calls `fetch` once. With the default, it calls it three times.
  - A 401 throws `AuthenticationError` (`status` 401), a 529 throws `OverloadedError`, and a network failure throws `APIConnectionError`. All three are `instanceof APIError` and `instanceof AnthropicError`.
- Parsing.
  - Truncated JSON, or JSON that breaks the schema (such as 1.5 for `z.number().int()`), makes `parse()` throw an `AnthropicError` that isn't an `APIError` and has no `status`. Its message starts "Failed to parse structured output".
  - Hence no `.int()`, `.regex()` or `.min()` in the schema: one odd field would fail the whole attempt. The mapping checks values instead.
  - `stop_reason: 'max_tokens'` with only a thinking block gives `parsed_output: null`. So does `refusal` with no content.
  - `refusal` with valid JSON text gives a filled `parsed_output`, so `stop_reason` must be checked first.
- The constructor.
  - Passing `apiKey` means no credential is read from the environment.
  - Without `baseURL`, the SDK uses `ANTHROPIC_BASE_URL` when it's set.
  - `ANTHROPIC_LOG` and `ANTHROPIC_CUSTOM_HEADERS` are read from the environment, and the `logLevel` option wins over `ANTHROPIC_LOG`.
- Haiku 5.5, from the Claude API reference.
  - It accepts `effort` from `low` to `max`, and its default is `medium`.
  - Thinking is adaptive and on by default.
  - Any `temperature`, `top_p` or `top_k` returns 400 on API version `2026-10-21`. So do `budget_tokens` and assistant prefill.
  - It costs US$0.10 per million input tokens and US$0.50 per million output tokens, for prompts up to 100K tokens.
- The migration. `prisma migrate diff` from the current schema to the one under *Interface* generates exactly the enum, columns, tables, unique index, index and foreign keys listed under *Migration* (Prisma 7.10.1).
- The Prisma client in `src/generated/` has `createManyAndReturn` with `skipDuplicates` on `supplier`.

Not verified, because no database was running: the `CHECK`s and the trigger, `SKIP LOCKED`, and `createManyAndReturn` against Postgres. Steps 5, 8 and 9 prove each with a test. Also not verified: how many tokens a 1650×2200 image costs on Haiku 5.5, and how well it reads the samples. Step 4 checks both.

## Interface

### Schema (`backend/prisma/schema.prisma`)

Add to `Document`:

```prisma
  subtotal         Decimal?       @db.Decimal(14, 2)
  cae              String?
  /// Open validation issues, as [{ "code": "…" }], in the order of ISSUE_CODES.
  issues           Json           @default("[]")
  lines            DocumentLine[]
  taxes            DocumentTax[]
```

Add to `ExtractionJob`:

```prisma
  /// Set while running: the lease. Null otherwise.
  lockedUntil   DateTime? @map("locked_until") @db.Timestamptz(6)
  model         String?
  promptVersion String?   @map("prompt_version")
  /// The model's JSON, written once (E3).
  rawOutput     Json?     @map("raw_output")
  lastError     String?   @map("last_error")
```

New:

```prisma
/// Rows never change: a run replaces all of a document's lines.
model DocumentLine {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId  String   @map("document_id") @db.Uuid
  document    Document @relation(fields: [documentId], references: [id], onDelete: Restrict)
  position    Int
  productCode String?  @map("product_code")
  description String
  quantity    Decimal? @db.Decimal(14, 3)
  unit        String?
  packageText String?  @map("package_text")
  unitPrice   Decimal? @map("unit_price") @db.Decimal(16, 4)
  ivaRate     Decimal? @map("iva_rate") @db.Decimal(5, 2)
  discountPct Decimal? @map("discount_pct") @db.Decimal(5, 2)
  lineTotal   Decimal? @map("line_total") @db.Decimal(14, 2)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@unique([documentId, position])
  @@map("document_lines")
}

enum TaxKind {
  iva
  iva_perception
  iibb_perception
  other

  @@map("tax_kind")
}

/// Rows never change: a run replaces all of a document's taxes.
model DocumentTax {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId String   @map("document_id") @db.Uuid
  document   Document @relation(fields: [documentId], references: [id], onDelete: Restrict)
  kind       TaxKind
  label      String
  rate       Decimal? @db.Decimal(5, 2)
  base       Decimal? @db.Decimal(14, 2)
  amount     Decimal  @db.Decimal(14, 2)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([documentId])
  @@map("document_taxes")
}
```

### Migration

`npx prisma migrate dev --create-only --name extraction` generates:

- `CREATE TYPE "tax_kind"`.
- On `documents`: `cae TEXT`, `issues JSONB NOT NULL DEFAULT '[]'` and `subtotal DECIMAL(14,2)`.
- On `extraction_jobs`: `last_error`, `locked_until`, `model`, `prompt_version` and `raw_output`.
- The two tables.
- `document_lines_document_id_position_key` and `document_taxes_document_id_idx`.
- Two `ON DELETE RESTRICT` foreign keys.

Append by hand:

```sql
-- Added by hand: rules Prisma can't express.
ALTER TABLE "documents" ADD CONSTRAINT "documents_issues_array" CHECK (jsonb_typeof("issues") = 'array');
ALTER TABLE "documents" ADD CONSTRAINT "documents_subtotal_non_negative" CHECK ("subtotal" >= 0);
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_position_positive" CHECK ("position" >= 1);
-- A running job always holds a lease, and only a running one does.
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_running_leased" CHECK (("status" = 'running') = ("locked_until" IS NOT NULL));
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_succeeded_output" CHECK (
  "status" <> 'succeeded' OR ("raw_output" IS NOT NULL AND "model" IS NOT NULL AND "prompt_version" IS NOT NULL)
);

-- E3: raw_output is written once and never edited. No ERRCODE, as in documents_keep_applied.
CREATE FUNCTION "extraction_jobs_keep_raw_output"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."raw_output" IS NOT NULL AND NEW."raw_output" IS DISTINCT FROM OLD."raw_output" THEN
    RAISE EXCEPTION 'extraction_jobs_keep_raw_output: job % already has its raw_output', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "extraction_jobs_keep_raw_output" BEFORE UPDATE ON "extraction_jobs"
  FOR EACH ROW EXECUTE FUNCTION "extraction_jobs_keep_raw_output"();
```

There's no `CHECK` that an *Error* document has issues: about nine places in the specs insert *Error* documents directly (`test/ledger.ts` `errorDocument()` among them), and slice 7's accepted issues change the shape anyway.

### Environment

The worker refuses to start without these, naming the variable and never printing its value. The backend doesn't read them. `README.md` already lists all three. Add them to `.env.example`:

```bash
# Claude API key for the extraction worker. Only the worker reads it.
ANTHROPIC_API_KEY=
# Extraction model, decision 8 in system-design.md.
LLM_MODEL=claude-haiku-5-5
# The restaurant's own CUIT, 11 digits. It never resolves a supplier.
RESTAURANT_CUIT=
```

The rules are: `ANTHROPIC_API_KEY` and `LLM_MODEL` not blank after trimming, and `RESTAURANT_CUIT` 11 digits that pass `isValidCuit`. The worker also needs `DATABASE_URL` and `UPLOAD_DIR`, through the existing services.

`vitest.config.ts`, under `test.env`:
- `ANTHROPIC_API_KEY: 'test-key-not-valid'`
- `LLM_MODEL: 'claude-haiku-5-5'`
- `RESTAURANT_CUIT: RESTAURANT_TEST_CUIT`, imported from `test/test-cuits.ts`.

Add `setupFiles: ['./test/no-network.ts']`. That file sets `globalThis.fetch` to a function that throws `Tests never reach the network: pass a fake through LLM_FETCH.`. Nothing in the backend or its tests uses `fetch` today.

### Backend modules

`backend/src/documents/issues.ts`:

```ts
/** Every issue code, in the order they're stored (decision 12). */
export const ISSUE_CODES = [
  'extraction_failed',
  'unsupported_document',
  'supplier_unresolved',
  'missing_total',
  'missing_issue_date',
  'supplier_term_missing',
  'duplicate_number',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
export interface Issue { code: IssueCode }
```

`backend/src/uploads/image-store.module.ts`: a new `ImageStoreModule` that provides and exports `UploadsConfig` and `ImageStore`, the existing classes, unchanged. `UploadsModule` imports it instead of providing them. `ImageStore` is still the only code that touches `UPLOAD_DIR`.

`backend/src/audit/audit.service.ts`: add `recordByWorker(tx, entry: Omit<AuditEntry, 'userId'>)`, which inserts `user_id` NULL. `record` keeps `userId: string`, so a person's write can't leave it out by mistake. Only `src/extraction/` calls `recordByWorker`.

`backend/src/extraction/`:

| File | What it holds |
| --- | --- |
| `prompt.ts` | `PROMPT_VERSION`, `EXTRACTION_EFFORT`, `MAX_TOKENS = 16_000`, `PROMPT`, `EXTRACTION_SCHEMA` and `type ExtractionOutput = z.infer<…>`. Everything E4 covers, in one file. |
| `extraction-request.ts` | `buildExtractionRequest({ model, effort, pages })`, pure. The worker and the gate both use it. |
| `anthropic-client.ts` | `createAnthropicClient({ apiKey, fetch })` (decision 14), the `LLM_FETCH` and `ANTHROPIC_CLIENT` tokens, and the timing constants `CALL_TIMEOUT_MS`. |
| `extraction-call.ts` | `ExtractionCall`, a plain class: `constructor(client, model)` and `run(pages, effort = EXTRACTION_EFFORT): Promise<CallOutcome>`. It's the only code that sends anything to Anthropic. |
| `extraction-mapping.ts` | `mapExtraction(output): MappedExtraction`, pure (decision 10). |
| `extraction-checks.ts` | `checkExtraction(input): IssueCode[]`, pure. |
| `extraction-config.ts` | `ExtractionConfig`: `apiKey`, `model`, `restaurantCuit`, validated in the constructor. |
| `duplicate-number-check.ts` | `DuplicateNumberCheck`, injectable: `exists(tx, { documentId, supplierId, type, letter, numberNormalized }): Promise<boolean>`. It's a provider of its own only so a test can make it miss. |
| `extraction-writer.ts` | `ExtractionWriter`: the write transaction (decisions 8, 9 and 13) and the final failure. |
| `extraction-worker.ts` | `ExtractionWorker`: claim, attempt, retry, and the loop. `MAX_ATTEMPTS`, `LEASE_MS`, `POLL_MS`, `MAX_IMAGE_BYTES_PER_CALL` and `backoffMs(attempt)`. |
| `extraction.module.ts` | `ExtractionModule`: imports `AuditModule` and `ImageStoreModule`. It provides the rest, with `LLM_FETCH` defaulting to `globalThis.fetch`, and exports `ExtractionWorker`. |
| `worker.module.ts` | `WorkerModule`: `PrismaModule` and `ExtractionModule`. |

`backend/src/worker.ts`:
1. Calls `loadRootEnv()`.
2. Creates the application context. A config error exits with code 1 and the message.
3. Calls `worker.run(signal)` until `SIGTERM` or `SIGINT` aborts it. A call already in flight finishes first, and an abandoned one is picked up again when its lease expires.
4. Closes the context.

Package scripts:
- `"start:worker": "nest start --entryFile worker"`
- `"start:worker:dev": "nest start --watch --entryFile worker"`
- `"start:worker:prod": "node dist/worker"`
- `"extraction:test": "tsx scripts/extraction-test.ts"`

Types:

```ts
export interface PageImage { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer }

export type CallOutcome =
  | { ok: true; output: ExtractionOutput; rawOutput: unknown; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: string };

export type MappedExtraction =
  | { kind: 'unsupported' }
  | {
      kind: 'document';
      type: 'invoice' | 'delivery_note' | 'credit_note';
      letter: 'A' | 'B' | 'C' | 'M' | 'X' | null;
      number: string | null;            // trimmed, as printed
      numberNormalized: string | null;  // normalizeNumber(number)
      issueDate: string | null;         // YYYY-MM-DD
      supplierCuit: string | null;      // 11 digits with a valid check digit
      supplierName: string | null;      // trimmed, never blank
      subtotal: string | null;          // Money.toString()
      total: string | null;             // positive
      cae: string | null;               // 14 digits
      lines: MappedLine[];              // positions 1..n
      taxes: MappedTax[];
    };

export interface ExtractionCheckInput {
  mapped: MappedExtraction;
  supplier: { resolved: false } | { resolved: true; paymentTermDays: number | null };
  duplicateNumber: boolean;
}
```

`ExtractionWorker`, the interface the specs drive:

```ts
/**
 * Claims and handles at most one job. True when it claimed one. `only` limits
 * the claim to those documents' jobs, for specs: the shared test database
 * holds every spec file's queued uploads.
 */
runOnce(only?: { documentIds: readonly string[] }): Promise<boolean>;

/** Calls runOnce until the signal aborts, sleeping POLL_MS when idle or after an error. */
run(signal: AbortSignal): Promise<void>;
```

`runOnce`:
1. **Claim** (decision 7), in one transaction.
   - If the document is deleted or not `processing`, end the job and return true (decision 5).
   - If the pages' `size_bytes` add up to more than `MAX_IMAGE_BYTES_PER_CALL`, end the job and return true (decision 5).
   - If it's an expired lease at the last attempt, end the job and return true (decision 2).
   - Otherwise mark it `running` and commit. The result is the job id, the document id, the attempt number, and the pages in order: `storage_key` and `mime_type`.
2. **Read and call**, outside any transaction. Read each page with `ImageStore.read`, then `ExtractionCall.run(pages)`. A thrown error becomes `{ ok: false, error }`.
3. **Failed attempt.** In a transaction: lock the job and check the fence.
   - Below `MAX_ATTEMPTS`: `status = 'queued'`, `run_after = now + backoffMs(attempt)`, `locked_until = null`, and `last_error`.
   - At `MAX_ATTEMPTS`: `ExtractionWriter.fail`, below.
4. **Success.** `ExtractionWriter.write(job, outcome)`.
5. Return true. An error from step 3 or 4 that isn't handled (the database is down, say) propagates to `run`, which logs it. The lease brings the job back.

`ExtractionWriter.write`, in one transaction:
1. Lock the job and check the fence. If the fence doesn't match, return `'lost'`.
2. `before = audit.snapshot(tx, 'documents', id)`. If the document is deleted or not `processing`: job `failed`, `raw_output` saved, `last_error = 'document no longer processing'`, `locked_until = null`. Return.
3. `mapped = mapExtraction(output)`.
4. Resolve the supplier (decision 9). An existing one is read `FOR SHARE`. A new one gets `recordByWorker` `suppliers` `create`, with `after` from `audit.snapshot`.
5. `due = resolveDueDate({ type, issueDate, typedDueDate: null, paymentTermDays })`, only with a resolved supplier, a type and an issue date. `'due_date_required'` means no due date.
6. `duplicate = knownDuplicate || (resolved && numberNormalized !== null && await duplicateCheck.exists(tx, …))`.
7. `issues = checkExtraction({ mapped, supplier, duplicateNumber: duplicate })`.
8. `tx.documentLine.deleteMany` and `tx.documentTax.deleteMany` for the document, then `createMany` for each, unless it's unsupported.
9. `tx.document.update` with:
   - every field mapped and resolved: `type`, `letter`, `number`, `numberNormalized`, `issueDate`, `dueDate`, `dueDateSource`, `subtotal`, `total`, `cae` and `supplierId`;
   - `issues: issues.map((code) => ({ code }))`;
   - `reviewStatus: issues.length === 0 ? 'unreviewed' : 'error'`.

   It goes through the model API, so a duplicate surfaces as P2002.
10. `after = audit.snapshot`, then `recordByWorker` `documents` `update`.
11. Job: `status = 'succeeded'`, `raw_output`, `locked_until = null`.

If P2002 on `documents_number_unique` escapes the transaction, run it once more with `knownDuplicate = true` (decision 13). Any other error propagates.

`ExtractionWriter.fail(tx, job, lastError)` is the final failure. Job: `failed`, `locked_until = null`, `last_error`. If the document is still `processing` and not deleted, it gets `issues = [{ code: 'extraction_failed' }]`, `review_status = 'error'` and a `recordByWorker` `update`. A document that is deleted or no longer `processing` isn't touched.

`checkExtraction`:
- An unsupported photo gives `['unsupported_document']`.
- Otherwise, in the order of `ISSUE_CODES`:
  - `supplier_unresolved` when the supplier isn't resolved;
  - `missing_total` when `total` is null;
  - `missing_issue_date` when `issueDate` is null;
  - `supplier_term_missing` for an invoice or delivery note whose resolved supplier has no term;
  - `duplicate_number` when `duplicateNumber`.

  `extraction_failed` only comes from `fail`.

No issues means the document meets invariant 1: type, supplier, issue date, total, and a due date for an invoice or delivery note. `documents_counted_complete` backs that up.

Logs (Nest `Logger`): claimed, failed attempt (job id, attempt, error class and status, next `run_after`), finished (job id, document status, tokens in and out, seconds), and lost fence. Never document content, the prompt, `last_error` text or the key.

### The call (`prompt.ts`, `extraction-request.ts`)

`buildExtractionRequest({ model, effort, pages })` returns:

```ts
{
  model,
  max_tokens: MAX_TOKENS,
  output_config: { effort, format: zodOutputFormat(EXTRACTION_SCHEMA) },
  messages: [{
    role: 'user',
    content: [
      ...pages.map((page) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: page.mimeType, data: page.bytes.toString('base64') },
      })),
      { type: 'text' as const, text: PROMPT },
    ],
  }],
}
```

`zodOutputFormat` comes from `@anthropic-ai/sdk/helpers/zod` and `z` from `zod/v4`, the same entry the helper uses.

`ExtractionCall.run`:
1. Calls `client.messages.parse(request)`.
2. `stop_reason` in `max_tokens`, `refusal` or `model_context_window_exceeded` is a failure: `stop_reason <value>`.
3. Then `parsed_output === null` is a failure: `no structured output`.
4. Otherwise it's `ok`. `rawOutput` is `JSON.parse` of the first `text` block, and `usage` is `input_tokens` and `output_tokens`.

It catches `AnthropicError` only, which covers parse and HTTP errors, and describes it as `<class> <status>: <message>`, cut to 1,000 characters. Anything else propagates to `runOnce`, which turns an image read error into a failed attempt in the same way.

`PROMPT`, verbatim:

```text
These photos are the pages of one document that a restaurant in Argentina received from a supplier, in page order. Read it and fill in the schema.

- Copy what is printed. When a field isn't printed, can't be read, or you aren't sure, use null. Never guess, and never work out a value that isn't printed.
- Amounts are decimal strings with a dot for decimals and no thousands separator or currency sign. Argentine documents print "1.234,50", which is "1234.50". Amounts are positive, also on a credit note.
- Dates are YYYY-MM-DD. Printed dates are day/month/year, so 03/11/2026 is "2026-11-03".
- The supplier is the issuer, in the header. The restaurant is the customer. Several CUITs can appear on the page: never put the customer's CUIT in supplierCuit.
- The CAE expiry date (Fecha de Vto. de CAE, Vto. CAE) is not a payment due date. It goes in caeDueDate only.
- Ignore handwriting, stamps, highlighter, and text showing through from the back of the page or from another page.
- If the photos don't show an invoice, a delivery note or a credit note, set isDocument to false and type to "other", leave every other field null and the lists empty.
```

`EXTRACTION_SCHEMA`, verbatim. It has no `.int()`, `.regex()` or `.min()`: see *Verified facts*.

```ts
const decimal = (what: string) =>
  z.string().nullable().describe(
    `${what}, as a decimal string such as "1234.50". Null if it isn't printed or can't be read.`,
  );
const date = (what: string) =>
  z.string().nullable().describe(`${what}, as YYYY-MM-DD. Null if it isn't printed or can't be read.`);

export const EXTRACTION_SCHEMA = z.object({
  isDocument: z.boolean().describe(
    'True only if the photos show an invoice (factura), a delivery note (remito) or a credit note (nota de crédito).',
  ),
  type: z.enum(['invoice', 'delivery_note', 'credit_note', 'other']).describe(
    'factura: invoice. remito: delivery_note. nota de crédito: credit_note. Anything else, including a nota de débito, a presupuesto or a recibo: other.',
  ),
  letter: z.enum(['A', 'B', 'C', 'M', 'X']).nullable().describe('The large letter in the box at the top.'),
  number: z.string().nullable().describe('The document number as printed, with its point of sale, such as "0003-00012345".'),
  issueDate: date('The issue date (fecha de emisión)'),
  supplierCuit: z.string().nullable().describe("The issuer's CUIT, from the header, as printed."),
  supplierName: z.string().nullable().describe("The issuer's business name (razón social), as printed."),
  recipientCuit: z.string().nullable().describe("The customer's CUIT (Señor/es, Cliente), as printed."),
  subtotal: decimal('The amount before taxes'),
  taxes: z.array(z.object({
    kind: z.enum(['iva', 'iva_perception', 'iibb_perception', 'other']).describe(
      'iva: IVA at one rate. iva_perception: percepción de IVA. iibb_perception: percepción de Ingresos Brutos. other: any other tax.',
    ),
    label: z.string().describe('The tax as printed, such as "IVA 21%".'),
    rate: decimal('The rate as a percentage, such as "21.00"'),
    base: decimal('The amount the tax applies to'),
    amount: decimal('The tax amount'),
  })).describe('Each tax amount printed with the totals, one per row. Empty if there are none.'),
  total: decimal('The final total. On a delivery note with no total, its declared or insured value'),
  cae: z.string().nullable().describe('The CAE number, as printed.'),
  caeDueDate: date('The CAE expiry (Fecha de Vto. de CAE). It is not a payment due date'),
  printedDueDate: date('A payment due date printed as such (Vencimiento, Fecha de vencimiento del pago). Never the CAE expiry'),
  printedTermDays: z.number().nullable().describe('The payment term in days, if printed, such as 30 for "30 días". Null otherwise.'),
  lines: z.array(z.object({
    productCode: z.string().nullable().describe('The item code, if printed.'),
    description: z.string().describe('The item description, as printed.'),
    quantity: decimal('The quantity'),
    unit: z.string().nullable().describe('The unit, such as "kg" or "un".'),
    packageText: z.string().nullable().describe('The packaging, as printed, such as "x 25 kg" or "caja x 12".'),
    unitPrice: decimal('The unit price'),
    ivaRate: decimal('The IVA rate as a percentage'),
    discountPct: decimal('The discount as a percentage'),
    lineTotal: decimal('The line total'),
  })).describe('The item rows, in printed order, without the subtotal, tax or total rows. Empty if there are none.'),
});
```

Field names match `samples/labels.json`, so the gate compares them without a translation table.

### HTTP (prefix `/api`, every route behind the global `SessionGuard`)

**`GET /api/error-documents`** (new). A new `ErrorDocumentsController` in `DocumentsModule`, which now imports `BalancesModule`, calls `BalancesService.errorDocuments()`. It returns 200 with:

```json
{
  "summary": { "count": 2, "amount": "152300.00", "supplierName": "Bebidas Norte" },
  "documents": [
    {
      "id": "…",
      "type": "invoice",
      "letter": "A",
      "number": "0001-00004521",
      "supplier": { "id": "…", "name": "Bebidas Norte" },
      "issueDate": "2026-11-08",
      "total": "98700.00",
      "createdByName": "Martín",
      "createdOn": "2026-11-08",
      "issues": ["supplier_term_missing"]
    }
  ]
}
```

- `documents` are the `error` ones that aren't deleted, oldest upload first (`created_at, id`).
- `type`, `letter`, `number`, `supplier`, `issueDate` and `total` can each be null. `createdOn` is the upload date in Buenos Aires.
- `summary` is `summarizeErrors(rows)` from `backend/src/balances/error-summary.ts`, a pure function:
  - `count`: every row;
  - `amount`: the sum, with `Money`, of the non-null totals of rows that aren't credit notes;
  - `supplierName`: the name when every row has the same non-null supplier, otherwise null.

**`GET /api/suppliers`** gains `"errors": { "count", "amount", "supplierName" }`, the same `summarizeErrors` over the same rows. `listSuppliers` moves its query and the error rows into one batch transaction with `isolationLevel: RepeatableRead` (read-only, so it's allowed), as `detail()` does.

**`GET /api/documents/:id`** keeps every field and adds:

```json
{
  "supplier": { "id": "…", "name": "…" },
  "issueDate": "2026-10-21",
  "dueDate": "2026-11-20",
  "dueDateSource": "supplier_term",
  "subtotal": "41322.31",
  "total": "50000.00",
  "cae": "…",
  "notes": null,
  "issues": [],
  "lines": [
    { "position": 1, "productCode": null, "description": "…", "quantity": "4.000", "unit": "un",
      "packageText": "x 25 kg", "unitPrice": "6198.3500", "ivaRate": "21.00", "discountPct": null, "lineTotal": "24793.40" }
  ],
  "taxes": [{ "kind": "iva", "label": "IVA 21%", "rate": "21.00", "base": "41322.31", "amount": "8677.69" }]
}
```

- Numbers are Postgres `::text`, so they keep their column's scale.
- Lines come by `position`, taxes by `kind, label, amount, id`.
- A `processing` document has nulls and empty lists.
- Everything comes from one `RepeatableRead` snapshot: the document with its supplier, images, lines and taxes.

### Test support (`backend/test/`)

- **`test-cuits.ts`** becomes named groups. `TEST_CUITS` becomes their union and is still what the CUIT check reads.
  - `SUPPLIER_SPEC_CUITS`: the existing five, for `suppliers.spec.ts` only.
  - `RESTAURANT_TEST_CUIT`: Vitest's `RESTAURANT_CUIT`. No supplier ever has it.
  - `EXTRACTION_RESULT_CUITS`: two, for `extraction-result.spec.ts`.
  - `EXTRACTION_WORKER_CUITS`: one, for `extraction-worker.spec.ts`.
  - `EXTRACTION_FLOW_CUITS`: one, for `extraction-flow.spec.ts`.

  Generate the five new ones in step 2 by running `isValidCuit` over invented bodies in the same `30000000…` series, and never take one from `samples/`. This plan doesn't write them out: the CUIT check scans `plans/` too, and would fail until they're in `test-cuits.ts`.
- **`suppliers.spec.ts`** frees `SUPPLIER_SPEC_CUITS` in `beforeEach` instead of `TEST_CUITS`. Each extraction spec file frees its own group the same way.
- **`fake-llm.ts`**: `FakeLlm`, whose `fetch` goes to `LLM_FETCH`.
  - It records each request: the URL, the parsed JSON body and the headers, with the key replaced.
  - It answers from a queue:
    - `reply(output, { stopReason? })` builds a real Messages API body: a `thinking` block, then the `text` block with `JSON.stringify(output)`, plus `usage`;
    - `replyText(text, stopReason)`, for truncated or invalid JSON;
    - `replyEmpty(stopReason)`;
    - `replyStatus(status)`, with a JSON error body;
    - `failNetwork()`;
    - `hold()`, which returns `release()`, for the stale-worker test.

    An empty queue throws.
- **`extraction-outputs.ts`**: `invoiceOutput(overrides)`, `creditNoteOutput(…)` and `notADocumentOutput()`. They hold invented names, such as `` `Distribuidora ${randomUUID()}` ``, CUITs from the file's group, and invented amounts that add up.
- **`worker.ts`**: `createTestWorker(fakeLlm, override?)` compiles `WorkerModule` with `LLM_FETCH` overridden, plus `override` (for `DuplicateNumberCheck`). It returns `{ worker, close }`.
- **`no-network.ts`**: see *Environment*.

Documents for worker specs come from `POST /api/uploads` with `jpeg()` from `test/photos.ts` (random bytes per call, so no same-image refusal), through `createTestApp()` in the same file.

### Frontend

`accounts-api.ts`:
- Types: `IssueCode`, `TaxKind`, `DocumentLine`, `DocumentTax`, `ErrorSummary`, `ErrorDocumentRow` and `ErrorDocumentList`.
- `DocumentDetail` gains the fields above, and `SupplierList` gains `errors: ErrorSummary`.
- `listErrorDocuments(): Promise<ApiResult<ErrorDocumentList>>`.

`labels.ts`, `ISSUE_MESSAGES: Record<IssueCode, string>`:

| Code | Message |
| --- | --- |
| `extraction_failed` | No pudimos leer el documento. |
| `unsupported_document` | Esto no parece una factura, un remito ni una nota de crédito. |
| `supplier_unresolved` | No pudimos identificar al proveedor: falta el CUIT, no es válido, es el del restaurante o no se lee el nombre. |
| `missing_total` | Falta el total. |
| `missing_issue_date` | Falta la fecha de emisión. |
| `supplier_term_missing` | El proveedor no tiene plazo de pago, así que no se puede calcular el vencimiento. |
| `duplicate_number` | Ya existe un documento de este proveedor con el mismo tipo, letra y número. |

`format.ts`:
- `formatDecimal(value, minDecimals)` works on strings only.
  - `"4.000", 0` → `4`; `"2.500", 0` → `2,5`; `"6198.3500", 2` → `6.198,35`; `"21.00", 0` → `21`; `"-1.50", 0` → `−1,5`.
  - It throws on anything that isn't `-?\d+(\.\d+)?`.
- `errorBanner(summary)` returns `{ title, detail }`, with the cases under *Behaviors*.

Screens:
- ***Resumen* (2a).** When `errors.count > 0`, a callout above the summary card shows `title` in bold, then `detail`, then *Ver A resolver →* linking to `/a-resolver`.
- ***A resolver* (6b, 6c).** It's at `/a-resolver`, between *Resumen* and *Subir* in the navigation.
  - The heading is *A resolver*, then `N documentos · $ X fuera del saldo`. `1 documento` in the singular, and no amount part when it's `0.00`.
  - Each row is a link to `/documentos/:id` with `state: { from: 'a-resolver' }`.
    - Line 1 is the supplier's name, or *Proveedor sin identificar* when `supplier_unresolved` is among the issues, otherwise *Sin datos*. On the right is the total, or *sin total*.
    - Line 2 is the document title when the type is known, then the upload date and *Subido por {name}*, joined by ` · `.
    - Then one line per issue, from `ISSUE_MESSAGES`.
  - Empty (6c): *No hay nada para resolver.* and *Todos los documentos cuentan en el saldo.*
  - Failure: *No pudimos cargar los documentos con error.*, *Revisá la conexión.* and *Reintentar*.
- ***Documento* (5a–5d, 5g).**
  - **While `processing`**, it shows what slice 4 shows and checks again 3 s after each response. The last response stays on screen. A failed check keeps it and tries again on the next tick, and checking stops on unmount or when the status changes. No *Cargando…* flicker.
  - **The back link** is *← A resolver* when `location.state.from === 'a-resolver'`, otherwise *← Subidas*, as now.
  - **For an *Error* document**, a callout at the top shows *No cuenta en el saldo. No admite pagos.* and one line per issue. There are no actions.
  - **The *Datos* and *Foto (N)* tabs** appear when the document has images and isn't `processing`. A manual document shows *Datos* only, with no tabs.
  - ***Datos*, read-only.** A missing value shows `—`. The fields are:
    - *Proveedor*, linking to `/proveedores/:id`;
    - *Tipo*;
    - *Letra · Número*;
    - *Fecha de emisión*;
    - *Vencimiento*, with `DUE_DATE_SOURCE_LABELS` under it;
    - *Subtotal*;
    - one row per tax: its label and amount;
    - *Total*;
    - *CAE*;
    - *Notas*;
    - *Ítems (N)* as a `<details>`. Each line shows its description, then `{quantity} {unit} × {unit price}` when present, and its line total, with `formatDecimal` and `formatMoney`.

    Then, for `unreviewed`, *Leído automáticamente · pasó todos los controles*. Then *Subido por*, as now.
  - ***Foto*** shows the pages, as slice 4 does.
- **CSS** uses the existing tokens, in light and dark.

### Gate (`backend/scripts/extraction-test.ts`, `npm run extraction:test`)

- It reads the key and model from `.env` with `loadRootEnv()`, and the five `samples/*.jpeg`, with their type from `inspectPhoto`.
- It builds the client with `createAnthropicClient`, and calls `ExtractionCall.run` for every sample at every effort level. That's 25 calls, the same request the worker sends. `--effort=<level>` runs one level.
- **factura-a-01** is compared with `samples/labels.json`:
  - `type`, `letter`, `issueDate` and `printedDueDate` must be equal. `printedDueDate` equal to the label shows the CAE expiry wasn't taken for it.
  - `number` must match after `normalizeNumber`.
  - `supplierCuit`, `recipientCuit` and `cae` must have the same digits.
  - `supplierName` must match after folding case and accents and collapsing spaces.
  - `subtotal` and `total` must be equal as `Money`.
  - `printedTermDays` must be equal.
  - `taxes` must hold the same rows by `kind` and `amount`, with `rate` and `base` equal where the label has them.
  - `lines.length` must equal `lineCount`, and the sum of `lineTotal` must equal `lineTotalSum`.
- **The other four** are judged by checks:
  - `isDocument`, and `type` and `letter` match the file name (`factura-a` is an invoice with letter A, `remito-x` a delivery note with X);
  - `supplierCuit` passes `isValidCuit` once normalized, and isn't `recipientCuit`;
  - `issueDate` passes `isIsoDate`;
  - `total` is a positive `Money`;
  - with taxes and a subtotal, `subtotal + Σ taxes` is within $1.00 of `total`;
  - with lines, `Σ lineTotal` is within $1.00 of `subtotal` or of `total`.

  A check without its inputs reports *skipped*, not failed.
- Every call must end with a parsed output. A failed call fails that sample. A 400 on one effort level marks the level unsupported.
- **The 2200 px check.** `messages.countTokens` is called with the prompt alone and with the prompt plus a white 1650×2200 PNG built in the script with `zlib`. The PNG holds no real data. The difference is the image's tokens, and it must be under 4,784.
- **Output** goes to stdout only:
  - one row per sample and level, with ✓ or ✗ per field name, input and output tokens, US$ cost (decimal.js, US$0.10 and US$0.50 per million tokens), and seconds;
  - a summary per level: samples passed, average tokens and cost per document;
  - the image's token count.

  `--values` adds the expected and read values. Without it, no value from a sample is printed.
- It exits 1 when no level passes all five, or the image count is 4,784 or more.

## Behaviors to test

Through the interfaces above. "Worker" cases run `runOnce({ documentIds })` on the real Postgres with `FakeLlm`. Dates are faked with `vi.useFakeTimers({ toFake: ['Date'] })`.

**The call** (`extraction-call.spec.ts`, real SDK, fake `fetch`, no database)
- The request carries the pages in order, each in base64 with its own media type, then the instructions. It has the model from the config, the effort passed in, `max_tokens` 16,000, and the schema.
- The body has exactly `max_tokens`, `messages`, `model` and `output_config`: no `temperature`, `top_p`, `top_k`, `thinking` or `system`.
- An overloaded API (529) is asked once, not three times.
- Each of `max_tokens`, `refusal` and `model_context_window_exceeded` is a failed attempt, including a `refusal` whose text is valid JSON.
- A response with no text is a failed attempt.
- Truncated JSON is a failed attempt. So is JSON that breaks the schema (a `type` of `receipt`).
- A rejected key (401) is a failed attempt that names the class and 401, and never contains the key.
- A network failure is a failed attempt.
- A good response returns the output, the JSON exactly as written, and the token counts.
- `createAnthropicClient` ignores `ANTHROPIC_BASE_URL` (stubbed with `vi.stubEnv`): the request still goes to `https://api.anthropic.com`.

**Reading what was printed** (`extraction-mapping.spec.ts`, pure)
- A CUIT printed with hyphens, dots or spaces is read as its 11 digits. One with a wrong check digit, or with 10 digits, reads as none.
- A total of `0.00`, a negative total, or a total with three decimals reads as none. A negative subtotal reads as none.
- An issue date printed `21/10/2026`, or the impossible `2026-02-30`, reads as none.
- A number with no digits (`s/n`) reads as none. `0003-00012345` keeps its text and normalizes to its digits.
- A quantity with four decimals, or a rate of 1000, reads as none, and its line stays.
- A line with a blank description is dropped, and the others are numbered 1, 2, 3 in order.
- A tax with no amount, or a blank label, is dropped.
- A CAE that isn't 14 digits reads as none.
- A photo marked as not a document, or typed `other`, is unsupported, and nothing else is read from it.
- The printed due date, the CAE expiry and the printed term never appear in what's read.

**Checks** (`extraction-checks.spec.ts`, pure: a passing and a failing case for each code, V1)
- `unsupported_document`: an unsupported photo gives only that code, and a document gives none of it.
- `supplier_unresolved`: an unresolved supplier, against a resolved one.
- `missing_total` and `missing_issue_date`: a missing value, against a present one.
- `supplier_term_missing`:
  - an invoice and a delivery note from a supplier with no term get it;
  - the same with a term of 0 days doesn't;
  - a credit note from a supplier with no term doesn't;
  - an unresolved supplier gives `supplier_unresolved` only.
- `duplicate_number`: flagged, against not flagged.
- Several issues at once come in the fixed order, whatever order they're found in.
- An invoice with no issues has everything invariant 1 needs.

**Claiming, leases and retries** (`extraction-worker.spec.ts`)
- **A first attempt.** A queued upload whose time has come is claimed: `running`, attempt 1, a lease until now + 5 min, and the model and prompt version recorded. Exactly one request is sent.
- **Not yet due.** A job whose retry time hasn't come isn't claimed, nothing is sent, and `runOnce` answers false.
- **Locked elsewhere.** A job another transaction holds `FOR UPDATE` is skipped, not waited for.
- **A live lease** isn't taken. Once it expires (acceptance 5), the job is claimed again as attempt 2. The document ends with one set of lines and taxes and one `update` entry.
- **A stalled worker.** The first worker's call is held. The lease expires, and a second `runOnce` claims and finishes the job. When the first call returns, its result is dropped: the lines, taxes, document and audit entries are those of the second run only.
- **An expired lease after the last attempt** ends the job as `failed` and the document in *Error* with `extraction_failed`, and nothing is sent.
- **Deleted while waiting.** A document deleted while queued: its job ends as `failed` with a `last_error`, nothing is sent, and the document keeps no issues.
- **Too big to send.** Pages adding up to more than 22,000,000 bytes, set directly in `size_bytes`, end in `extraction_failed` with nothing sent.
- **Retries.**
  - A failed first attempt puts the job back in the queue for 30 s, with no lease and a `last_error`.
  - At 29 s nothing is claimed, and at 30 s it is.
  - The second and third failures wait 2 min and 8 min.
  - The fourth failure ends the job as `failed`. The document goes to *Error* with `extraction_failed`, and gets one `update` entry with no user. No supplier is created.
- **A bad key (acceptance 4).** A 401 on every attempt ends in `extraction_failed` after four attempts, and `last_error` mentions 401.
- **A failure, then a success.** The job ends `succeeded` and the document has its data.
- **Each failing stop reason** counts as a failed attempt in the worker: `attempts` goes up and the job is queued again.
- **Deleted during the call.** A document deleted while its call is held: the result isn't written. The job ends `failed` with its `raw_output` kept, and the document stays deleted, with no lines.

**Writing the result** (`extraction-result.spec.ts`)
- **Known supplier with a term.** An invoice from a known supplier with a 30-day term, with everything printed:
  - it lands in *Sin revisar*, due 30 days after its issue date, by the supplier's term;
  - its subtotal, total, CAE, letter and number are stored, along with its lines in order and its taxes, and it has no issues;
  - it gets one `update` entry with no user, from `processing` to `unreviewed`;
  - the job is `succeeded`, with `raw_output` equal to what the model wrote.
- **Printed dates are ignored.** The same invoice with a printed due date and a CAE expiry gets the term's due date, not either printed date.
- **New supplier (acceptance 1).** An invoice with an unknown valid CUIT and a printed name:
  - creates the supplier, with that name as name and legal name, that CUIT, and no term, plus a `suppliers` `create` entry with no user;
  - lands in *Error* with `supplier_term_missing` and no due date.
- **New CUIT, no name.** An unknown valid CUIT with no printed name gives `supplier_unresolved` and creates no supplier.
- **The restaurant's own CUIT (acceptance 6)** as the supplier's gives `supplier_unresolved`. No supplier has it.
- **A bad CUIT.** One with a wrong check digit, or none at all, gives `supplier_unresolved`.
- **A delivery note** from a known supplier with no term gives `supplier_term_missing`.
- **Credit notes.**
  - A credit note from a known supplier with a term lands in *Sin revisar* with no due date.
  - One from a new supplier also lands in *Sin revisar*. That's the behavior question 14 accepted, tested so it's visible.
- **Missing values.** A missing total gives `missing_total`. A missing issue date gives `missing_issue_date` and no due date. Both missing, with an unresolved supplier, give the three codes in order.
- **A photo that isn't a document (acceptance 3).**
  - It gives *Error* with `unsupported_document` only.
  - It has no type, supplier, lines or taxes.
  - No supplier is created, even when the output carries a CUIT and a name.
- **Same number.** An invoice with the same supplier, type, letter and number as a document in *Sin revisar* gives `duplicate_number`.
  - The same number written with other separators is still a duplicate.
  - It isn't a duplicate when the other document is deleted, in *Error*, or has another letter.
- **A duplicate only the index catches.** With `DuplicateNumberCheck` made to answer false, it still ends in *Error* with `duplicate_number`. The job is `succeeded` with one attempt, so it isn't a failed attempt.
- **Running a job twice** leaves one set of lines and taxes. The test sets the document back to `processing` and the job back to `queued` directly, then runs again with fewer lines.

**The flow** (`extraction-flow.spec.ts`, acceptance 1 and 2, over HTTP plus the worker)
- An upload whose supplier is new ends in *Error* with `supplier_term_missing`:
  - `GET /api/error-documents` lists it with its issue and total;
  - `GET /api/suppliers` has `errors.count` of at least 1, with the new supplier listed at zero.
- `PUT /api/suppliers/:id` sets a 30-day term, then a second upload from that supplier:
  - lands in *Sin revisar*, due 30 days after its issue date;
  - counts in `GET /api/suppliers/:id`;
  - takes a payment through `POST /api/payments` with an application to it.
- The first document stays in *Error*. Re-checking it is slice 6.

**Reads**
- `GET /api/documents/:id` (`documents.spec.ts` and `uploads.spec.ts`):
  - for an extracted invoice, it returns the supplier, dates, due-date source, subtotal, total, CAE, issues, lines by position (at their column's scale, such as `"4.000"` and `"6198.3500"`), and taxes in order;
  - an upload still `processing` returns nulls and empty lists;
  - a manual document returns its supplier, dates, total, due date and notes, with no lines.

  Update the two whole-body assertions.
- `GET /api/error-documents` (`error-documents.spec.ts`):
  - this file's *Error* documents appear oldest first, with their issues;
  - one that's deleted, one in *Sin revisar* and one in *Procesando* don't;
  - `summary` always equals `summarizeErrors` of the `documents` in the same response, which holds whatever other spec files add.
- `summarizeErrors` (`error-summary.spec.ts`, pure):
  - two documents of one supplier give its name and the sum;
  - two suppliers, or one unknown supplier, give no name;
  - a credit note is counted and adds nothing;
  - a document with no total is counted and adds nothing;
  - none gives `0`, `"0.00"` and no name.
- `GET /api/suppliers`: `errors` is there. `balances.spec.ts` changes its whole-body assertion to check `suppliers`, `totals` and `today` separately, since `errors` is global.
- `routes.spec.ts` lists `get /api/error-documents` and checks its 401.

**Tables** (`extraction-tables.spec.ts`)
- Each hand-written rule refuses its case by name:
  - `issues` as an object;
  - a subtotal of −0.01;
  - a line at position 0;
  - a `running` job with no lease, and a `queued` one with a lease;
  - a `succeeded` job with no `raw_output`;
  - changing a `raw_output` that's set.
- `document_lines_document_id_position_key` refuses a repeated position.
- Valid rows pass: a subtotal of 0, setting `raw_output` the first time, and changing another column of a job that has one.

**Config and audit**
- `ExtractionConfig` (`extraction-config.spec.ts`):
  - a missing or blank key or model is refused, naming the variable and not the value;
  - a `RESTAURANT_CUIT` with a wrong check digit, or with hyphens, is refused;
  - valid values pass.
- `recordByWorker` (`audit.service.spec.ts`) writes an entry with no `user_id`, and rolls back with its transaction.

**Frontend** (`format.spec.ts`, plus a new `error-banner.spec.ts`)
- `formatDecimal`: the cases under *Interface*, and it throws on `1,5`, `abc` and an empty string.
- `errorBanner`:
  - `1`, `"98700.00"`, *Bebidas Norte* → *1 documento de Bebidas Norte con error* / *por $ 98.700,00 no está incluido en el saldo.*;
  - `3`, `"10.00"`, no name → *3 documentos con error* / *por $ 10,00 no están incluidos en el saldo.*;
  - `2`, `"0.00"` → *2 documentos con error* / *No están incluidos en el saldo.*
- `ISSUE_MESSAGES` is checked by the compiler: a missing code doesn't build.

## Steps

One commit per step. Backend steps need `docker compose up -d db`, and after the schema change, `npx prisma generate`. "All checks" means `npm run lint`, `npm run typecheck` and `npm test` in the apps the step touches. **Never start the worker against the dev database**: it would send whatever is queued there to Anthropic. Every check in these steps uses tests or a worker that exits before claiming anything.

1. **Record the decisions**
   - In `system-design.md`, *Extraction*:
     - Under *Worker*: decisions 1–7 in short. Four attempts, backoff 30 s, 2 min and 8 min, a 5-minute lease, a 3-minute call timeout, the attempt as fencing token, what counts as a failed attempt (including that `parse()` throws on bad JSON), and the two cases that end a job with no call.
     - Under *Call*: the client options from decision 14, and the `caeDueDate` field.
   - In *Validation*:
     - Issues are stored as `[{ "code" }]` in a fixed order, and `unsupported_document` is always alone.
     - The worker writes lines and taxes for *Error* documents too.
     - The *Error* warning's amount leaves credit notes out (decision 17).
   - In *Screens*, *Where the wireframes differ from this file on purpose*:
     - ***A resolver* (6a–6c):** no thumbnails, no actions and no grouping until slice 6, the upload date on each row, and no counter in the navigation yet.
     - ***Resumen* (2a):** only the warning above the totals, no line per supplier yet.
     - ***Documento* (5b, 5c, 5h):** *Datos* and *Foto* tabs at every width, and no payment section yet.
   - Verify: backend `npm run lint` passes, since `check:cuits` scans the docs.
2. **Test setup**
   - Split `test/test-cuits.ts` into groups, with five newly generated valid CUITs (see *Test support*). `suppliers.spec.ts` frees only `SUPPLIER_SPEC_CUITS`.
   - Add `test/no-network.ts`, `setupFiles`, and the three variables in `vitest.config.ts`.
   - Verify:
     - All checks pass.
     - The CUIT check passes, with the new CUITs counted as test CUITs.
     - A throwaway spec that calls `fetch('https://example.com')` fails with the no-network message. Delete it.
3. **The call**
   - `npm install --save-exact @anthropic-ai/sdk@1.8.0 zod@4.6.7`.
   - Add `prompt.ts` with `EXTRACTION_EFFORT = 'medium'` for now, `extraction-request.ts`, `anthropic-client.ts`, `extraction-call.ts`, `test/fake-llm.ts` and `extraction-call.spec.ts`.
   - Verify: all checks pass, and `package.json` shows both versions without `^` or `~`.
4. **Run the extraction test (the gate)**
   - This needs the user's approval of this plan's doors. Sending the five samples was approved on 2026-11-24 (`mvp-slices.md`).
   - Add `scripts/extraction-test.ts` and the `extraction:test` script. Run `npm run extraction:test` once without `--values`. With `--values`, only look at the fields that failed. Write nothing it prints to a file in the repo.
   - **STOP and report to the user**, with field and check names only and no values, if any of these happen. Don't tune the prompt to get past them: each run sends the samples again, and the prompt is the user's call.
     - No effort level passes all five.
     - The 1650×2200 image counts 4,784 tokens or more. That would make the 2200 px setting in `photos.ts`, a one-way door, wrong.
     - Any call fails with 401, 403 or 429, or more than one call fails for another reason.
   - Otherwise:
     - Set `EXTRACTION_EFFORT` to the lowest level that passes all five.
     - In `system-design.md`, *Extraction*, replace the estimate with what was measured, with no values from the samples: the date, the model, the chosen effort, samples passing per level, average input and output tokens and US$ per one-page document, and the 1650×2200 image's token count.
   - Verify: all checks pass, and `git status` shows only the script, `package.json`, `prompt.ts` and `system-design.md`.
5. **Tables and migration**
   - Change the schema, generate the migration with `--create-only`, append the hand-written block, migrate, and generate.
   - Add `extraction-tables.spec.ts`.
   - Verify:
     - All checks pass.
     - `\d extraction_jobs` shows the two `CHECK`s and the trigger, and `\d document_lines` shows the index and the `CHECK`.
     - `npx prisma migrate dev --create-only --name probe` generates nothing, and in particular no `DROP`. Delete the probe migration.
6. **Mapping and checks**
   - Add `documents/issues.ts`, `extraction-mapping.ts`, `extraction-checks.ts` and their specs.
   - Verify: all checks pass.
7. **The worker process**
   - Move `UploadsConfig` and `ImageStore` into `ImageStoreModule`.
   - Add `recordByWorker` with its test.
   - Add `ExtractionConfig` with its spec, `ExtractionWorker` with `run` and a `runOnce` that only answers false for now, `ExtractionModule`, `WorkerModule`, `src/worker.ts`, the three `start:worker` scripts, `.env.example`, and `test/worker.ts`.
   - Verify:
     - All checks pass.
     - `ANTHROPIC_API_KEY= npm run start:worker` exits 1 with a message that names `ANTHROPIC_API_KEY`. `RESTAURANT_CUIT=123 npm run start:worker` exits 1 naming `RESTAURANT_CUIT`.
     - `npm run build` emits `dist/worker.js`.
8. **Claiming, leases and retries**
   - Add the claim, the fence, backoff, `ExtractionWriter.fail`, and the two endings with no call.
   - Add `extraction-worker.spec.ts`, except the cases that need `write`, which come in step 9.
   - Verify:
     - All checks pass.
     - `npx vitest run src/extraction` passes five times in a row.
     - With `FOR UPDATE SKIP LOCKED` changed to `FOR UPDATE`, the locked-elsewhere test fails: it times out. Restore it.
9. **Writing the result**
   - Add `ExtractionWriter.write`, `DuplicateNumberCheck`, supplier resolution, and the retry on the index.
   - Add `test/extraction-outputs.ts`, `extraction-result.spec.ts`, and the rest of `extraction-worker.spec.ts`.
   - Verify:
     - All checks pass, and the extraction specs pass five times in a row.
     - With the fence check commented out, the stalled-worker test fails. Restore it.
10. **Reads**
    - Add `summarizeErrors`, `BalancesService.errorDocuments()`, `GET /api/error-documents`, `errors` in `GET /api/suppliers`, and the new `DocumentDetail` fields.
    - Add `error-summary.spec.ts`, `error-documents.spec.ts`, `extraction-flow.spec.ts`, the updated whole-body assertions, and the route in `routes.spec.ts`.
    - Verify: all checks pass.
11. **Frontend foundations**
    - Add the types, `listErrorDocuments`, `ISSUE_MESSAGES`, `formatDecimal`, `errorBanner`, and their tests.
    - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
12. **Screens**
    - Add the *Resumen* warning, *A resolver* with its route and nav link, the *Documento* changes, and the CSS.
    - Verify:
      - The frontend checks pass.
      - With the backend in dev mode and no worker running, set documents' states directly in `psql` on the dev database: an *Error* upload with two issues, a manual document, and one still *Procesando*. Check the three screens at 390 px, in light and dark.
      - Then `UPDATE` the *Procesando* one to `unreviewed`, with the fields invariant 1 needs, and watch *Documento* switch on its own within 3 s.
13. **Docs**
    - `agents.md`, under *Where things live*:
      - `backend/src/extraction/`: the worker. `ExtractionCall` is the only code that sends anything to Anthropic. `ExtractionWorker` and `ExtractionWriter` are the only writers of `document_lines` and `document_taxes`, and of `extraction_jobs` after an upload creates them. `prompt.ts` holds the prompt, schema, effort and `max_tokens`: changing any of them bumps `PROMPT_VERSION` (E4). `backend/src/worker.ts` is the worker's own process.
      - `backend/src/documents/issues.ts`: every issue code, in stored order.
      - Change the `backend/src/uploads/` line to say `UploadsService` creates `extraction_jobs`. Add that `ImageStoreModule` shares `ImageStore` with the worker.
    - `agents.md`, under *Rules that are easy to miss*:
      - Replace the CUIT rule: *Each spec file that gives suppliers a CUIT has its own group in `backend/test/test-cuits.ts`, and frees only that group before each test. `RESTAURANT_TEST_CUIT` is never a supplier's.*
      - *Worker specs call `runOnce({ documentIds })` with their own documents. The shared test database holds every spec file's queued uploads.*
      - *Backend tests never reach the network: `test/no-network.ts` replaces `fetch`, and worker specs pass a `FakeLlm` through `LLM_FETCH`.*
      - *The worker's write locks the job, then the document, then the supplier. A new writer that locks a supplier and then its documents must not lock a `processing` one.*
      - *`AuditService.recordByWorker` is for `src/extraction/` only. Every other entry has a user (D2).*
      - *Starting the worker sends every queued upload in that database to Anthropic. Delete the uploads you don't want sent first: a deleted document's job ends without a call.*
    - `README.md`: under *Or run locally*, a line that the worker sends each upload's photos to Anthropic, and that `npm run extraction:test` runs the gate against `samples/`.
    - Verify: all checks pass in both apps.

**Hand-off note for the user**
- `.env` needs `ANTHROPIC_API_KEY`, `LLM_MODEL=claude-haiku-5-5` and `RESTAURANT_CUIT`. The key names are already there.
- Before the first `npm run start:worker`, list what's queued in the dev database:

  ```sql
  SELECT d.id, d.created_at FROM extraction_jobs j JOIN documents d ON d.id = j.document_id
  WHERE j.status = 'queued' AND d.deleted_at IS NULL;
  ```

  Delete any you don't want sent with `DELETE /api/documents/:id`.

**Manual acceptance at the end.** Only send the five approved samples, or documents with invented data. Any other real document is a new decision to send data out.
1. Run the backend, the frontend and `npm run start:worker`.
   - Upload a document from a supplier the app doesn't know. *Documento* shows *Procesando*, then switches to *Error* on its own, with *El proveedor no tiene plazo de pago…*.
   - *A resolver* lists it. *Resumen* warns about *1 documento de {Proveedor} con error* and its amount, and the new supplier is listed at $ 0,00.
2. Set that supplier's term in *Editar proveedor*, and upload another of its documents.
   - It lands in *Sin revisar*, due on its issue date plus the term.
   - *Proveedor* counts it, and *Registrar pago* can pay it.
   - *Datos* shows its lines and taxes next to *Foto*.
3. Upload a photo of something that isn't a document. It ends in *Error* with *Esto no parece una factura…*.
4. Set `ANTHROPIC_API_KEY=invalid` and restart the worker. Upload a document with invented data. After about 10.5 minutes, it ends in *Error* with *No pudimos leer el documento.*, and `psql` shows `attempts = 4` and a `last_error` that mentions 401. Restore the key.
5. Upload a document, and `kill -9` the worker as soon as it logs the claim. Restart it.
   - The job is claimed again only after the 5-minute lease expires.
   - `psql` shows one set of `document_lines` and one worker `update` entry for the document.
6. Set `RESTAURANT_CUIT` in `.env` to a known supplier's CUIT, restart the worker, and upload one of that supplier's documents. It gives *No pudimos identificar al proveedor…*. Restore it.

## Doors

| Part | Door | Note |
| --- | --- | --- |
| Sending document photos to Anthropic: the worker and the gate | **One-way** (sending data out of the system) | See below. |
| Creating suppliers from a printed CUIT | **One-way** (rows the app can't delete or merge) | See below. |
| `duplicate_number`: the precheck and the retry on the index | **One-way** (document deduplication) | See below. |
| Writing only to `processing` documents, and the fence | **One-way** guard (re-running extraction on documents with data) | No re-extraction is built. The `processing` check under the document's lock and the fence are what keep a late or repeated run from overwriting data. Both have tests (stalled worker, deleted during the call, running twice). |
| `due_date` from the term only | Two-way | It only comes from `resolveDueDate` (D4). The printed date and the CAE expiry never reach it, and tests show it. |
| Tables, enum, columns, `CHECK`s, trigger and migration | Two-way | Only additions, on tables with no real data. `prisma migrate reset` undoes them in development. |
| `recordByWorker` and the worker's `audit_log` entries | Two-way now | A missing entry can't be recreated later, but there's no real data yet. |
| `GET /api/error-documents` and the extra fields in two reads | Two-way | Reads behind the existing `SessionGuard`, with no new `@Public()`. `routes.spec.ts` lists the route and checks the 401. They filter `deleted_at` (D3). |
| Test CUIT groups, the no-network setup file, and the Vitest variables | Two-way | They don't touch `testDatabaseUrl` or `isTestDatabaseName`. |
| Frontend screens and copy | Two-way | The backend decides every status. |

**Blast radius today.** No real supplier documents exist in the app before slice 8. The gate sends the five samples, which the user approved on 2026-11-24. The worker sends whatever is uploaded to the database it runs against, which in development means test uploads. Every risk below starts with the first real upload in production.

**Sending documents to Anthropic**
- *If it's wrong*: photos of the restaurant's financial documents, with supplier names, CUITs, amounts and the restaurant's own data, reach a third party, and can't be taken back. The same goes for photos sent by mistake: a deleted document, the wrong database, or a host other than Anthropic's.
- *How the plan shrinks it*:
  - There's one call site, `ExtractionCall`, built from one function that tests pin down. The body has exactly four keys, the pages and the prompt, and no other field.
  - The base URL is fixed in code, so `ANTHROPIC_BASE_URL` can't send the photos elsewhere. The key is read only from `ANTHROPIC_API_KEY`, only by the worker, and never logged. `ANTHROPIC_LOG` can't turn on request logging.
  - Nothing is sent for a deleted document or one that isn't `processing`, checked at the claim. A document deleted during a call keeps the result out of the database.
  - The bytes sent are the stored ones, nothing added. Logs carry ids, classes, statuses and token counts, never content.
  - Only the worker process can send, and it won't start without its three variables. The backend can't send. Tests can't reach the network at all.
  - The gate needs the user's approval of this plan, sends only `samples/`, and saves nothing. Its values only print with `--values`.
  - At most four attempts per document, and nothing over 22 MB.
- *Limits*:
  - An original uploaded after compression failed keeps its EXIF, including location if the phone wrote it (slice 4's door). It's sent as stored, because E5 keeps images as uploaded. Removing EXIF from the copy sent, never the stored one, is possible later, and is the user's call.
  - Anthropic keeps API data under the organization's retention settings. Check them in the Claude Console before slice 8.
  - The manual acceptance sends whatever is uploaded. Use the samples or invented documents.

**Suppliers created by the worker**
- *If it's wrong*: a valid but misread CUIT creates a supplier that can't be deleted or merged, and stays in *Resumen*. A credit note on it would lower the wrong supplier's balance unseen. A name read wrong stays until someone edits it.
- *How the plan shrinks it* (question 14):
  - The restaurant's own CUIT never resolves a supplier.
  - A new CUIT needs a legible printed name, so nothing is made up.
  - A new supplier has no term, so its first invoice or delivery note stops in *Error*, where a person sees it.
  - The insert can't fail on a concurrent one (`skipDuplicates`).
  - Every created supplier has an `audit_log` `create` entry with no user, so all of them can be found later.
  - A test shows the credit-note case, so it's a known behavior, not a surprise.
- *Limit*: no way to delete a leftover supplier until it's asked for.

**`duplicate_number`**
- *If it's wrong*: a missed duplicate counts the same debt twice. A false one stops a real document in *Error*, where a person sees it.
- *How the plan shrinks it*:
  - The precheck uses exactly the invariant 7 set. The unique index decides in the end, and its violation becomes `duplicate_number`, not a failed attempt. A test forces the index path.
  - Numbers are compared through `number_normalized`, which a `CHECK` ties to `number`.
- *Limit*: a document with no number, or with a misread one, isn't caught. That's `duplicate_suspected` in slice 7.

**Look closely at**
- `ExtractionCall.run`: it checks `stop_reason` before `parsed_output`, catches `AnthropicError` around `parse()`, and puts nothing from the key or the request in `last_error`.
- `createAnthropicClient`: `baseURL`, `maxRetries: 0`, `timeout`, `logLevel` and `apiKey` are all passed explicitly.
- The claim: the document check comes before any call, the claim commits before the call, and `$now` comes from `now()`.
- Every write after the call: it locks the job first and checks `status = 'running' AND attempts = <claimed>`, in the same transaction as the document update.
- `ExtractionWriter.write`: `audit.snapshot` locks the document before the `processing` check, and the supplier is read `FOR SHARE`. The document update goes through the model API, and the retry on P2002 happens only for `documents_number_unique`, once.
- That `printedDueDate`, `caeDueDate` and `printedTermDays` are read nowhere in `src/`. `grep` should find them only in `prompt.ts` and the gate.
- `prompt.ts`: changing any of it after merge must bump `PROMPT_VERSION` (E4).
