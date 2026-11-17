# Plan: Supplier accounts (slice 2)

Spec: [`mvp-slices.md`, section 2](mvp-slices.md#2-supplier-accounts-from-manual-entry). Branch: `feat/supplier-accounts`.

## Goal

A signed-in person creates suppliers, types in invoices, delivery notes, credit notes and opening balances, and deletes a mistaken one. *Resumen* shows each supplier's *Sin vencer*, *Vencido*, *Crédito* and *Total*, plus their totals. *Proveedor* shows the same four figures and the supplier's documents. Every change to suppliers and documents leaves an `audit_log` entry with who made it and the row before and after.

## Out of scope

- Payments, applications, *Pagado*, *Pago parcial*, *Disponible*/*Aplicada*, *Registrar pago* and *Crédito a favor* actions (slice 3). `applied` is 0 everywhere.
- Uploads, photos, *Procesando*, *Subidas*, *Error*, *A resolver*, the Resumen warning about *Error* documents, `issues`, and the *Documento* screen (slices 4–6).
- Editing a document. A mistaken one is deleted and typed again. Editing the header is slice 6.
- Restoring a deleted document, and hard deletes.
- Deleting or merging suppliers.
- Validation codes (slices 5 and 7), `duplicate_suspected` on manual entry, `RESTAURANT_CUIT`.
- Filters in *Proveedor* (payment status is slice 3; type and date ranges aren't in the MVP).
- The desktop layouts (wireframes 2d, 3d and the 9b side panel), and the bottom navigation bar (0b), which only makes sense once other list screens exist. Screens are built mobile first in the existing 480 px column.
- Formatting the CUIT with hyphens while typing, and checking it when the field loses focus. It's checked on save.
- Limiting how many opening balances a supplier has ([question 13](mvp-slices.md#open-questions)).
- Frontend DOM or component tests, and their dependencies.
- nginx's SPA fallback for the new frontend routes (slice 8).

## Decisions

These were checked on 2026-11-17 against Prisma 7.10.1, Postgres 16 and react-router 8.5.1, with probes in a scratch copy of the backend. They aren't open to the implementer.

**Verified facts**
- A partial unique index and `CHECK` constraints written by hand in `migration.sql` survive the next `prisma migrate dev`: Prisma doesn't try to drop them. Don't turn on Prisma's `partialIndexes` preview feature, since it can't express `NULLS NOT DISTINCT`.
- Prisma's default for an optional relation is `ON DELETE SET NULL`. Every relation in this slice sets `onDelete: Restrict`, because suppliers and users are never deleted and a financial row must never lose its owner silently.
- A unique violation, inside or outside an interactive transaction, throws `PrismaClientKnownRequestError` with code `P2002`. The index name is at `error.meta.driverAdapterError.cause.constraint.index` (`suppliers_cuit_key` or `documents_number_unique`). A `CHECK` violation throws code `P2039`; it's a bug, so it stays a 500.
- `@db.Date` fields come back from Prisma as UTC midnight, even with `TZ=America/Argentina/Buenos_Aires`. `new Date('2026-11-09')` writes that same day.
- In `$queryRaw`, `numeric` comes back as a Prisma `Decimal` and `date` as a `Date`. Cast to text in SQL (`::text`, `to_char(…, 'YYYY-MM-DD')`) and the API passes the strings through. `COALESCE(SUM(x), 0.00)::text` gives `"0.00"`, while `COALESCE(SUM(x), 0)::text` gives `"0"`. `date - date` comes back as a JS number.
- `to_jsonb(row)` keeps every column. Read back with `->>`, `total` is `"86900.50"`, a date is `"2026-12-09"` and a timestamp is `"2026-11-17T12:00:00+00:00"`. Read as a JSON value in JS, amounts become floats, so tests read audit amounts with `->>`.
- `Intl.Collator('es', { sensitivity: 'base' })` sorts *Abeja, árbol, nube, Ñandú, Oso, Zeta*. Folding with `normalize('NFD')` and removing `\p{M}` makes *panaderia ñandu* match *Panadería ÑANDÚ*.
- react-router 8.5.1 still exports the declarative API (`BrowserRouter`, `Routes`, `Route`, `Link`, `Navigate`, `useNavigate`, `useParams`, `useSearchParams`). Its peers are React `>=19.2.7`, which the frontend's `^19.3.1` satisfies, and Node `>=22.22`. Vite's dev server already falls back to `index.html` for unknown paths.

**One balance implementation (D1)**
- `BalancesService` (`backend/src/balances/`) holds the only SQL that derives `outstanding`, `unapplied`, `status`, `days_to_due` and the supplier sums. Both screens read it. Slice 3 changes `outstanding` and `unapplied` there and nowhere else.
- `today` comes from `today()` in `clock.ts` and goes into the SQL as a parameter. Never use `CURRENT_DATE`: it depends on the session time zone and tests can't fake it.
- The SQL returns every supplier with its four sums. The service then filters by search, sorts and adds up the totals row with `Money`, so the totals row is the sum of the rows by construction. This scans all suppliers in memory, which is fine at about 60.
- A credit note has no `status` in this slice (`null`). Slice 3 adds `paid`, `available` and `applied`.

**Audit (D2)**
- `audit_log.entity` is the table name (`suppliers` or `documents`). `action` is `create`, `update` or `delete`.
- `before` and `after` are `to_jsonb` snapshots of the whole row, taken in the same transaction as the write. `before` is SQL `NULL` on create (`Prisma.DbNull`, not JSON `null`).
- Every write to `suppliers` is audited, not only term changes. It's a superset of D2 and keeps "the before and after of every step" in acceptance 7 true.
- `user_id` is always the session user in this slice.

**Due dates (D4)**
- One function, `resolveDueDate`, in `backend/src/documents/due-date.ts`. Nothing else computes a due date. Its rules are under Interface.
- The manual-entry form doesn't show the computed due date before saving. An empty *Vencimiento* means "use the supplier's term", and the hint says so. The wireframe (8a) prefills it, but that would compute a due date in the frontend.

**Search and sort in *Resumen***
- Search matches part of the name or the legal name, ignoring case and accents. An empty or blank `q` matches everything.
- `sort=overdue` (default): largest *Vencido* first. `sort=total`: largest *Total* first. `sort=name`: A–Z with the Spanish collator. Ties go by name, then by id.

**Input and errors**
- The backend returns codes, never Spanish, like slice 1b. The frontend maps each code to Spanish through an exhaustive `Record`.
- Every documented body key must be present, with its documented JSON type. Anything else is a malformed request: 400 `{ "errors": [] }`. The forms never send one.
- A user mistake gives 400 `{ "errors": [{ "field", "code" }] }`, with every field error found in one pass. Conflicts give 409 with the same shape.
- An unknown id in the path, or one that isn't a UUID, gives 404. Move the UUID regex from `UsersService` to `backend/src/common/uuid.ts` (`isUuid`) and use it in both places.

**Choices a human may want to revisit** (none is in the design; each has a one-line reason)
1. **A payment term is 0 to 365 days.** Without an upper bound, a large term overflows the due date and gives a 500. The real terms go from 7 to 60.
2. **Dates are real calendar days from 1900 to 2999.** Postgres has no year 0, and this catches a mistyped year.
3. **A document number must contain at least one digit.** A number like *s/n* would normalize to nothing and escape invariant 7. A document without a number leaves the field empty.
4. **Deleting is a *Descartar* button on each row of *Proveedor*,** with a native confirm. The wireframes put *Descartar* in the *Documento* screen's menu, but that screen arrives with photos in slice 4.
5. **Extra `CHECK`s** encode rules the design states but doesn't number: CUIT digits, `number_normalized` matches `number`, a credit note has no due date, an opening balance never has a `supplier_term` due date, and `due_date` and `due_date_source` are set together.
6. **The opening-balance hint** in 8a says *Hasta 2 por proveedor*, which reads like a rule. It becomes *Uno para lo vencido y otro para lo que todavía no venció. Copiá los montos de la planilla.*

**Tests and shared data**
- `cuit` is unique and there are only five test CUITs, while spec files run in parallel against one database. So:
  - Only `backend/src/suppliers/suppliers.spec.ts` creates suppliers with a CUIT. Its `beforeEach` sets `cuit = NULL` on every supplier holding a test CUIT, with raw SQL.
  - Every other test creates informal suppliers (`cuit` null).
- `GET /api/suppliers` returns every supplier in the database, including other spec files'. Tests that read it give their suppliers a unique token in the name, such as `` `Panadería ${randomUUID()}` ``, and search for it.
- Tests that depend on the date fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`), and set it **before signing in**, so the session is issued at the fake time.
- Document numbers in tests use the `0001-00004521` shape. An 11-digit run of digits written in a test can trip the CUIT check.
- `createTestApp` takes an optional `override` callback on the `TestingModuleBuilder`, so a spec can replace `AuditService` with one that fails. `createUser` also returns the new user's `id`.

## Interface

### Schema (`backend/prisma/schema.prisma`, validated with Prisma 7.10.1)

`User` gets the back-relations Prisma requires:

```prisma
  documentsCreated  Document[] @relation("DocumentCreatedBy")
  documentsReviewed Document[] @relation("DocumentReviewedBy")
  auditEntries      AuditLog[]
```

New enums and models:

```prisma
enum DocumentType {
  invoice
  delivery_note
  credit_note
  opening_balance

  @@map("document_type")
}

enum DocumentSource {
  upload
  manual

  @@map("document_source")
}

enum ReviewStatus {
  processing
  error
  unreviewed
  reviewed

  @@map("review_status")
}

enum DueDateSource {
  supplier_term
  manual

  @@map("due_date_source")
}

model Supplier {
  id              String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name            String
  legalName       String?    @map("legal_name")
  cuit            String?    @unique @db.Char(11)
  paymentTermDays Int?       @map("payment_term_days")
  notes           String?
  createdAt       DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime   @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  documents       Document[]

  @@map("suppliers")
}

model Document {
  id               String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  type             DocumentType?
  source           DocumentSource
  reviewStatus     ReviewStatus   @map("review_status")
  supplierId       String?        @map("supplier_id") @db.Uuid
  supplier         Supplier?      @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  letter           String?
  number           String?
  numberNormalized String?        @map("number_normalized")
  issueDate        DateTime?      @map("issue_date") @db.Date
  dueDate          DateTime?      @map("due_date") @db.Date
  dueDateSource    DueDateSource? @map("due_date_source")
  total            Decimal?       @db.Decimal(14, 2)
  notes            String?
  createdById      String         @map("created_by") @db.Uuid
  createdBy        User           @relation("DocumentCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  reviewedAt       DateTime?      @map("reviewed_at") @db.Timestamptz(6)
  reviewedById     String?        @map("reviewed_by") @db.Uuid
  reviewedBy       User?          @relation("DocumentReviewedBy", fields: [reviewedById], references: [id], onDelete: Restrict)
  deletedAt        DateTime?      @map("deleted_at") @db.Timestamptz(6)
  createdAt        DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime       @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("documents")
}

model AuditLog {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId    String?  @map("user_id") @db.Uuid
  user      User?    @relation(fields: [userId], references: [id], onDelete: Restrict)
  entity    String
  entityId  String   @map("entity_id") @db.Uuid
  action    String
  before    Json?
  after     Json?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@map("audit_log")
}
```

Generate `prisma/migrations/<timestamp>_suppliers_documents_audit/` with `--create-only`, then append this block by hand (it was applied and checked case by case):

```sql
-- Added by hand: rules Prisma can't express.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_cuit_digits" CHECK ("cuit" ~ '^[0-9]{11}$');
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_days_non_negative" CHECK ("payment_term_days" >= 0);

ALTER TABLE "documents" ADD CONSTRAINT "documents_total_positive" CHECK ("total" > 0);

-- Invariant 1: a counted document is complete, and invoices and delivery notes have a due date.
ALTER TABLE "documents" ADD CONSTRAINT "documents_counted_complete" CHECK (
  "review_status" NOT IN ('unreviewed', 'reviewed')
  OR ("type" IS NOT NULL AND "supplier_id" IS NOT NULL AND "issue_date" IS NOT NULL AND "total" IS NOT NULL
      AND ("type" NOT IN ('invoice', 'delivery_note') OR "due_date" IS NOT NULL))
);

-- Invariant 8: reviewed_at and reviewed_by are set if and only if the document is reviewed.
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_iff_reviewed" CHECK (
  ("review_status" = 'reviewed') = ("reviewed_at" IS NOT NULL AND "reviewed_by" IS NOT NULL)
  AND ("reviewed_at" IS NULL) = ("reviewed_by" IS NULL)
);

-- No writer can store a number_normalized that disagrees with number, so invariant 7 can't be bypassed.
ALTER TABLE "documents" ADD CONSTRAINT "documents_number_normalized" CHECK (
  "number_normalized" IS NOT DISTINCT FROM NULLIF(regexp_replace("number", '[^0-9]', '', 'g'), '')
);

-- Due-date rules from system-design.md.
ALTER TABLE "documents" ADD CONSTRAINT "documents_due_date_source" CHECK (("due_date" IS NULL) = ("due_date_source" IS NULL));
ALTER TABLE "documents" ADD CONSTRAINT "documents_credit_note_no_due_date" CHECK ("type" IS DISTINCT FROM 'credit_note' OR "due_date" IS NULL);
ALTER TABLE "documents" ADD CONSTRAINT "documents_opening_balance_no_term" CHECK ("type" IS DISTINCT FROM 'opening_balance' OR "due_date_source" IS DISTINCT FROM 'supplier_term');

-- Invariant 7. NULLS NOT DISTINCT, so two documents with no letter still collide.
CREATE UNIQUE INDEX "documents_number_unique" ON "documents" ("supplier_id", "type", "letter", "number_normalized") NULLS NOT DISTINCT
  WHERE "deleted_at" IS NULL AND "review_status" IN ('unreviewed', 'reviewed') AND "number_normalized" IS NOT NULL;
```

`NULLS NOT DISTINCT` needs Postgres 15 or later. `docker-compose.yml` runs 17.

### HTTP (prefix `/api`, JSON bodies, every route behind the global `SessionGuard`)

| Method and path | Success | Errors |
| --- | --- | --- |
| `GET /api/suppliers?q=&sort=` | 200 `SupplierList` | 400 `{ errors: [] }` for an unknown `sort` or a repeated parameter |
| `POST /api/suppliers`, body `SupplierInput` | 201 `{ id }` | 400 field errors, 409 `cuit_taken` |
| `GET /api/suppliers/:id` | 200 `SupplierAccount` | 404 |
| `PUT /api/suppliers/:id`, body `SupplierInput` | 204 | 400, 404, 409 `cuit_taken` |
| `POST /api/documents`, body `DocumentInput` | 201 `{ id }` | 400 field errors, 409 `duplicate_number` |
| `DELETE /api/documents/:id` | 204 | 404, also for a document that's already deleted |

`POST` handlers keep Nest's 201. `PUT` and `DELETE` use `@HttpCode(204)`. All amounts in responses are strings with exactly two decimals, such as `"0.00"` or `"-15000.00"`. All dates are `YYYY-MM-DD`.

```ts
type SupplierSort = 'overdue' | 'name' | 'total';

interface SupplierList {
  suppliers: {
    id: string;
    name: string;
    legalName: string | null;
    paymentTermDays: number | null; // the manual-entry form needs it
    notDue: string;
    overdue: string;
    credit: string; // positive; it's subtracted
    balance: string; // notDue + overdue − credit, negative when the supplier owes the restaurant
  }[];
  totals: { notDue: string; overdue: string; credit: string; balance: string };
}

interface SupplierAccount {
  id: string;
  name: string;
  legalName: string | null;
  cuit: string | null; // 11 digits, null for an informal supplier
  paymentTermDays: number | null;
  notes: string | null;
  notDue: string;
  overdue: string;
  credit: string;
  balance: string;
  // Counted documents only, by due date, then issue date, then creation. No due date goes last.
  documents: {
    id: string;
    type: DocumentType;
    letter: string | null;
    number: string | null;
    issueDate: string;
    dueDate: string | null;
    total: string;
    reviewStatus: 'unreviewed' | 'reviewed';
    status: 'pending' | 'overdue' | null; // null for credit notes
    daysToDue: number | null; // dueDate − today; null without a due date
  }[];
}

interface SupplierInput {
  name: string;
  legalName: string | null;
  cuit: string | null;
  paymentTermDays: number | null;
  notes: string | null;
}

interface DocumentInput {
  supplierId: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  total: string; // "86900.50": dot decimal, no thousands separator
  notes: string | null;
}
```

**Supplier body rules**

| Key | JSON type | Rule | Code |
| --- | --- | --- | --- |
| `name` | string | Trimmed, not empty | `name_required` |
| `legalName` | string or null | Trimmed. Empty becomes null | |
| `cuit` | string or null | Null means informal. A string loses its hyphens and spaces. Then it can't be empty, must pass `isValidCuit`, and can't belong to another supplier | `cuit_required`, `cuit_invalid`, `cuit_taken` (409) |
| `paymentTermDays` | number or null | Null means not set yet. Otherwise an integer from 0 to 365 | `payment_term_invalid` |
| `notes` | string or null | Trimmed. Empty becomes null | |

**Document body rules**

| Key | JSON type | Rule | Code |
| --- | --- | --- | --- |
| `supplierId` | string | A UUID of an existing supplier | Malformed |
| `type` | string | One of the four types | Malformed |
| `letter` | string or null | Null, or `A`, `B`, `C`, `M` or `X`. Null for an opening balance | Malformed |
| `number` | string or null | Trimmed. Empty becomes null. Null for an opening balance (malformed otherwise). When set, it has at least one digit | `number_invalid` |
| `issueDate` | string | A real date from 1900 to 2999, `YYYY-MM-DD`. The empty string counts as invalid | `issue_date_invalid` |
| `dueDate` | string or null | Null, or a date with the same rules. Null for a credit note (malformed otherwise). Required when `resolveDueDate` says so | `due_date_invalid`, `due_date_required` |
| `total` | string | Read by `Money.fromString` (up to 12 integer digits and 2 decimals), and above zero | `total_invalid` |
| `notes` | string or null | Trimmed. Empty becomes null | |

A document that breaks invariant 7 gets 409 `{ errors: [{ field: 'number', code: 'duplicate_number' }] }`.

**Order of work in `POST /api/documents`**
1. Parse the body. A malformed body returns 400 `{ errors: [] }`. Field errors return 400 with all of them.
2. In one transaction:
   1. Read the supplier. If it's missing, return 400 `{ errors: [] }`.
   2. Call `resolveDueDate`. If it returns `due_date_required`, return 400 with that error.
   3. Insert with `source = manual`, `review_status = reviewed`, `created_by` and `reviewed_by` set to the session user, `reviewed_at = now()`, and `number_normalized = normalizeNumber(number)`.
   4. Write the `create` audit entry.
3. Outside the transaction, map `P2002` on `documents_number_unique` to 409 `duplicate_number`. Any other error stays a 500.

**`DELETE /api/documents/:id`**, in one transaction:
1. Snapshot the row, which locks it.
2. If there's no row, or it's already deleted, return 404.
3. Set `deleted_at = now()`.
4. Write a `delete` audit entry with both snapshots.

**`PUT /api/suppliers/:id`**, in one transaction:
1. Snapshot the row, which locks it. Return 404 if it's missing.
2. Update every field.
3. Write an `update` audit entry.

`P2002` on `suppliers_cuit_key` becomes 409 `cuit_taken`, on create and on update. Updating a term never touches documents.

### Backend modules

- `backend/src/common/money.ts`
  - `fromString` rejects more than 12 integer digits: the pattern becomes `^-?\d{1,12}(\.\d{1,2})?$`.
  - Adds `isPositive(): boolean` and `compare(other: Money): number` (negative, zero or positive).
- `backend/src/common/dates.ts`
  - `isIsoDate(value: string): boolean`: `YYYY-MM-DD`, a real calendar day, years 1900 to 2999.
  - `addDays(date: string, days: number): string`: plain days in UTC, so month ends and leap days work.
  - `toDbDate(date: string): Date`: UTC midnight, for writing `@db.Date` fields.
- `backend/src/common/uuid.ts`: `isUuid(value: string): boolean`.
- `backend/src/common/field-errors.ts`
  - `FieldErrorCode`: the 11 codes, `name_required`, `cuit_required`, `cuit_invalid`, `cuit_taken`, `payment_term_invalid`, `number_invalid`, `issue_date_invalid`, `due_date_invalid`, `due_date_required`, `total_invalid` and `duplicate_number`.
  - `FieldError { field: string; code: FieldErrorCode }`.
  - Helpers that build the 400 and 409 exceptions with an `{ errors }` body.
- `backend/src/audit/` (`AuditModule`, exports `AuditService`)
  - `type AuditEntity = 'suppliers' | 'documents'`, mapped to fixed table identifiers, never interpolated from input.
  - `snapshot(tx: Prisma.TransactionClient, entity: AuditEntity, id: string): Promise<Prisma.JsonObject | null>`: `SELECT to_jsonb(t) … FOR UPDATE`. Call it first in a transaction that changes the row.
  - `record(tx, { userId: string; entity; entityId: string; action: 'create' | 'update' | 'delete'; before: Prisma.JsonObject | null; after: Prisma.JsonObject | null }): Promise<void>`.
- `backend/src/documents/due-date.ts`

  ```ts
  export function resolveDueDate(input: {
    type: DocumentType;
    issueDate: string;
    typedDueDate: string | null;
    paymentTermDays: number | null;
  }): { dueDate: string | null; source: DueDateSource | null } | 'due_date_required';
  ```

  | Type | Typed date | Supplier term | Result |
  | --- | --- | --- | --- |
  | `invoice`, `delivery_note` | Set | Any | The typed date, `manual` |
  | `invoice`, `delivery_note` | Null | Set | `addDays(issueDate, term)`, `supplier_term` |
  | `invoice`, `delivery_note` | Null | Null | `due_date_required` |
  | `opening_balance` | Set | Any, ignored | The typed date, `manual` |
  | `opening_balance` | Null | Any, ignored | No due date |
  | `credit_note` | Null | Any, ignored | No due date |
  | `credit_note` | Set | Any | Throws: the parser already rejects this |

- `backend/src/documents/document-number.ts`: `normalizeNumber(number: string): string | null`, digits only, null when there are none. Slice 5's worker will reuse it.
- `backend/src/documents/` (`DocumentsModule`): `DocumentsController` and `DocumentsService` (`createManual(input, user)`, `delete(id, user)`).
- `backend/src/suppliers/` (`SuppliersModule`): `SuppliersController` (all four supplier routes) and `SuppliersService` (`create(input, user)`, `update(id, input, user)`). The two `GET`s call `BalancesService`.
- `backend/src/balances/` (`BalancesModule`, exports `BalancesService`)
  - `listSuppliers({ q, sort }): Promise<SupplierList>`.
  - `supplierAccount(id): Promise<SupplierAccount | null>`.
- `AppModule` imports the four new modules. Controllers use `@CurrentUser()` for the acting user.

**The balance SQL.** Verified on Postgres 16 with today as a parameter. Keep the derivation in one fragment that both queries compose with `Prisma.sql`:

```sql
-- counted(today): the only derivation. Slice 3 changes outstanding and unapplied here.
SELECT d.id, d.supplier_id, d.type, d.review_status, d.letter, d.number,
       to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
       to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
       d.due_date AS due_date_value, d.issue_date AS issue_date_value, d.created_at,
       d.total::text AS total,
       CASE WHEN d.type = 'credit_note' THEN 0.00 ELSE d.total END AS outstanding,
       CASE WHEN d.type = 'credit_note' THEN d.total ELSE 0.00 END AS unapplied,
       CASE WHEN d.type = 'credit_note' THEN NULL
            WHEN d.due_date < ${today}::date THEN 'overdue'
            ELSE 'pending' END AS status,
       d.due_date - ${today}::date AS days_to_due
FROM documents d
WHERE d.deleted_at IS NULL AND d.review_status IN ('unreviewed', 'reviewed')
```

```sql
-- Supplier sums, for every supplier or for one.
WITH counted AS (…)
SELECT s.id, s.name, s.legal_name, s.cuit, s.payment_term_days, s.notes,
  COALESCE(SUM(c.outstanding) FILTER (WHERE c.status = 'pending'), 0.00)::text AS not_due,
  COALESCE(SUM(c.outstanding) FILTER (WHERE c.status = 'overdue'), 0.00)::text AS overdue,
  COALESCE(SUM(c.unapplied), 0.00)::text AS credit,
  (COALESCE(SUM(c.outstanding), 0.00) - COALESCE(SUM(c.unapplied), 0.00))::text AS balance
FROM suppliers s LEFT JOIN counted c ON c.supplier_id = s.id
GROUP BY s.id
```

Documents for *Proveedor* come from `counted` filtered by supplier, ordered by `due_date_value ASC NULLS LAST, issue_date_value, created_at, id`.

### Frontend

**Dependency.** `react-router` `^8.5.1`. `main.tsx` wraps `App` in `BrowserRouter`.

**Routes** (rendered by `Shell` inside `<main>`; the paths are Spanish because people see them)

| Path | Screen | Wireframe |
| --- | --- | --- |
| `/` | *Resumen* | 2a, 2b, 2c |
| `/proveedores/nuevo` | *Proveedor nuevo* | 9a |
| `/proveedores/:id` | *Proveedor* | 3a, 3c |
| `/proveedores/:id/editar` | *Editar proveedor* | 9b |
| `/proveedores/:id/cargar` | *Cargar documento*, supplier preselected. `?tipo=saldo-inicial` preselects *Saldo inicial* | 8a, 8b |
| anything else | `<Navigate to="/" replace />` | |

The header keeps *Facturas*, the user's name and *Cerrar sesión*. *Facturas* links to `/`.

**`frontend/src/accounts-api.ts`**

```ts
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'unavailable' | 'not_found' | 'unauthorized' }
  | { ok: false; error: 'rejected'; fieldErrors: FieldError[] };

listSuppliers(params: { q: string; sort: SupplierSort }): Promise<ApiResult<SupplierList>>
getSupplier(id: string): Promise<ApiResult<SupplierAccount>>
createSupplier(input: SupplierInput): Promise<ApiResult<{ id: string }>>
updateSupplier(id: string, input: SupplierInput): Promise<ApiResult<void>>
createDocument(input: DocumentInput): Promise<ApiResult<{ id: string }>>
deleteDocument(id: string): Promise<ApiResult<void>>
onUnauthorized(handler: () => void): () => void // returns the unsubscribe function
```

- It also holds the types mirroring the backend: `DocumentType`, `DocumentSource`, `ReviewStatus`, `DueDateSource`, `DocumentStatus` (`pending | overdue`), `SupplierSort`, `FieldErrorCode`, and the request and response shapes above.
- Status mapping:
  - 2xx gives the value.
  - 400 or 409 gives `rejected` with the body's `errors`, possibly empty.
  - 404 gives `not_found`.
  - 401 gives `unauthorized` and calls the registered handlers.
  - Anything else, including a rejected `fetch`, gives `unavailable`.
- `listSuppliers` requests `/api/suppliers?sort=<sort>` and appends `&q=<q>` only when `q` isn't blank, through `URLSearchParams`.
- `App` registers a handler that switches to the sign-in screen, so an expired session in any screen goes back to sign-in.

**`frontend/src/format.ts`** (string work only: the frontend never turns an amount into a number)
- `formatMoney(amount)`: `"599280.50"` → `"$ 599.280,50"`, `"-15000.00"` → `"− $ 15.000,00"`.
  - U+2212 for the minus.
  - A no-break space (U+00A0) after `$` and after `−`.
  - Throws on anything that isn't `^-?\d+\.\d{2}$`.
- `formatCredit(amount)`: `"0.00"` → `"$ 0,00"`. Anything else → `"− "` + `formatMoney(amount)`, with a no-break space.
- `parseAmountInput(text)`: an amount typed in Argentine format → the canonical string, or `null`.
  - Accepts optional `$` and spaces around the number, then digits with optional `.` thousands separators in groups of three, then an optional `,` and one or two decimals.
  - `"86.900,50"` → `"86900.50"`, `"86900,5"` → `"86900.5"`, `"$ 1.500"` → `"1500"`.
  - Rejects `"86900.50"` (a dot followed by two digits isn't a thousands group), `"8.69.00"`, `"-5"`, `"1,505"`, letters and the empty string.
  - It doesn't check the size or the sign: the backend does.
- `formatDate("2026-10-01")` → `"01/10/2026"`.
- `formatDueIn(daysToDue)`: `0` → `"hoy"`, `1` → `"en 1 día"`, `8` → `"en 8 días"`, `-1` → `"hace 1 día"`, `-42` → `"hace 42 días"`.
- `formatCuit("30000000015")` → `"30-00000001-5"`.
- `documentTitle({ type, letter, number })`:
  - `"Factura A 0003-00012345"`.
  - `"Remito s/n"` when there's no number.
  - `"Saldo inicial"` for an opening balance.

The frontend may check whether an amount string is exactly `"0.00"` to hide or relabel it, and may branch on the sign of `daysToDue`, which the backend computed. It never adds, subtracts or compares amounts, and never compares dates (D1).

**`frontend/src/labels.ts`** (exhaustive `Record`s, so a missing label doesn't compile)

| Record | Values |
| --- | --- |
| `DOCUMENT_TYPE_LABELS` | invoice *Factura*, delivery_note *Remito*, credit_note *Nota de crédito*, opening_balance *Saldo inicial* |
| `REVIEW_STATUS_LABELS` | processing *Procesando*, error *Error*, unreviewed *Sin revisar*, reviewed *Revisado* |
| `DOCUMENT_SOURCE_LABELS` | upload *Subido*, manual *Cargado a mano* |
| `DUE_DATE_SOURCE_LABELS` | supplier_term *Según el plazo del proveedor*, manual *Ingresado a mano* |
| `DOCUMENT_STATUS_LABELS` | pending *Sin vencer*, overdue *Vencido* |
| `SUPPLIER_SORT_LABELS` | overdue *Vencido primero*, name *A–Z*, total *Mayor total* |
| `FIELD_ERROR_MESSAGES` | See the table below |

| Code | Spanish message |
| --- | --- |
| `name_required` | Ingresá el nombre. |
| `cuit_required` | Ingresá el CUIT o marcá que es un proveedor informal. |
| `cuit_invalid` | El CUIT no es válido. |
| `cuit_taken` | Ya hay un proveedor con ese CUIT. |
| `payment_term_invalid` | Ingresá un plazo de 0 a 365 días, o dejalo vacío. |
| `number_invalid` | El número tiene que tener al menos un dígito. |
| `issue_date_invalid` | Ingresá una fecha de emisión válida. |
| `due_date_invalid` | Ingresá un vencimiento válido. |
| `due_date_required` | Este proveedor no tiene plazo de pago: ingresá el vencimiento o definí el plazo. |
| `total_invalid` | Ingresá un total mayor a cero, como 86.900,50. |
| `duplicate_number` | Ya existe un documento de este proveedor con el mismo tipo, letra y número. |

Other messages:
- A `rejected` response with no field errors: *No se pudo guardar. Revisá los datos y volvé a intentar.*
- `unavailable`: *No se pudo conectar con el servidor. Volvé a intentar.*
- An amount `parseAmountInput` can't read shows the `total_invalid` message, without a request.

**Screens** (`frontend/src/screens/`; copy from the wireframes, with this file winning where they differ)

- **`Resumen.tsx`** (2a, 2b, 2c)
  - Title *Resumen*.
  - A summary card from `totals`: *Total a pagar* (`balance`), *Vencido*, *Sin vencer*, *Crédito* (`formatCredit`).
  - A search field (*Buscar proveedor*) and a sort select (`SUPPLIER_SORT_LABELS`). Both live in the URL (`?q=&orden=`), so coming back from *Proveedor* keeps them.
  - Requests run on every change. Only the latest response is applied.
  - One row per supplier, which opens *Proveedor*:
    - The name and *Total*.
    - A second line: *Vencido $ … · Sin vencer $ …*, plus *· Crédito − $ …* when credit isn't `"0.00"`. When all three are `"0.00"` it says *Al día*.
  - A *+ Proveedor nuevo* button.
  - States:
    - *Cargando…* while loading.
    - No suppliers at all: *Todavía no hay proveedores.*
    - No matches: *No hay proveedores que coincidan con “{q}”.* and *Buscá por el nombre que usan ustedes o por la razón social.*
    - A failed load: *No pudimos cargar el resumen.*, *Revisá la conexión.* and a *Reintentar* button.
- **`Proveedor.tsx`** (3a, 3c)
  - *← Resumen*, which keeps the search, and *Editar proveedor*.
  - The name, then the legal name and *CUIT 30-00000001-5*, or *Proveedor informal* when there's no CUIT.
  - *Plazo de pago: 30 días · Cambiar*, or *Plazo de pago: sin definir · Definir plazo*. Both go to *Editar proveedor*.
  - *Notas: …* when there are notes.
  - Four figures: *Sin vencer*, *Vencido*, *Crédito a favor* and *Total*.
  - A *Cargar documento* button.
  - *Documentos ({n})*, one row each:
    - `documentTitle` and the total. A credit note's total goes through `formatCredit`.
    - A second line: *Vence {fecha} · {formatDueIn}*, or *Sin vencimiento*. A credit note shows *Emitida {fecha}*.
    - A status badge (`DOCUMENT_STATUS_LABELS`), and a quiet *Sin revisar* marker for `unreviewed`.
    - A *Descartar* button. It confirms with *¿Descartar {título}? Deja de contar en el saldo del proveedor.*, deletes and reloads.
  - No documents (3c, without *Subir una foto*): *Todavía no hay documentos de este proveedor.*, *Si le debían plata antes de usar la app, cargá el saldo de la planilla como Saldo inicial.* and a *Cargar saldo inicial* button.
  - 404: *No encontramos este proveedor.* with *← Resumen*.
- **`SupplierForm.tsx`**, for new and edit (9a, 9b)
  - *Cancelar* and the title, *Proveedor nuevo* or *Editar proveedor*.
  - Fields:
    - *Nombre (como lo llaman ustedes)*.
    - *Razón social*.
    - A *Proveedor informal* checkbox with *No tiene CUIT*. When checked, it hides *CUIT* and sends `cuit: null`.
    - *CUIT*.
    - *Plazo de pago* with *días* and the hint *0 = paga al recibir. Si todavía no lo sabés, dejalo vacío.* It sends an integer when the field is only digits, null when it's empty, and shows `payment_term_invalid` otherwise.
    - *Notas*, with the placeholder *Opcional*.
  - When editing, once the term differs from the saved one, it shows *antes: {n}* and *No cambia el vencimiento de los documentos ya cargados.*
  - The button says *Guardar proveedor* or *Guardar cambios*, and *Guardando…* while saving. Field errors show under their field.
  - On success it goes to *Proveedor*.
- **`DocumentForm.tsx`** (8a, 8b)
  - *Cancelar* and *Cargar documento*.
  - *Proveedor*: a select of every supplier, from `listSuppliers({ q: '', sort: 'name' })`, preselected from the URL.
  - *Tipo*: *Factura* (default), *Remito*, *Nota de crédito* or *Saldo inicial*. For *Saldo inicial* it shows the hint *Uno para lo vencido y otro para lo que todavía no venció. Copiá los montos de la planilla.*
  - *Letra* (a select: none, A, B, C, M, X) and *Número*. Both are hidden for *Saldo inicial*.
  - *Fecha de emisión*, or *Fecha* for *Saldo inicial*: a native date input.
  - *Vencimiento*: a native date input. It sends null when it's empty.
    - Invoice or delivery note, supplier with a term: optional, with *Si lo dejás vacío, vence {n} días después de la fecha de emisión, según el plazo del proveedor.*
    - Invoice or delivery note, supplier without a term: required, with *{Proveedor} no tiene plazo de pago: ingresá el vencimiento a mano o definí el plazo.* *definí el plazo* links to *Editar proveedor*.
    - *Saldo inicial*: optional, with *Si no tiene vencimiento, cuenta como sin vencer.*
    - *Nota de crédito*: hidden.
  - *Total*, with `inputmode="decimal"` and the placeholder *$ 0,00*.
  - *Notas*.
  - Buttons:
    - *Guardar* goes back to *Proveedor*.
    - *Guardar y cargar otro* keeps the supplier and the type, clears the rest, and shows *Guardado.*
- **`index.css`**
  - Styles for lists, the summary card, badges, `select`, `textarea` and the checkbox.
  - `select` and `textarea` get the same 16 px font rule as inputs, so iOS doesn't zoom.
  - Keep the color tokens and dark mode.

## Behaviors to test

Backend tests go through HTTP with supertest against `createTestApp()` and a real Postgres, unless the item says it inserts rows directly. Frontend tests are unit tests in the Node environment. `fetch` is stubbed with `vi.stubGlobal`, and the stub returns errors as well as successes.

**Suppliers** (`suppliers.spec.ts`, the only spec that uses test CUITs)
- Ana creates *Panadería El Ceibo*, with its legal name, the CUIT typed as `30-00000001-5`, a 30-day term and notes.
  - It's stored with the CUIT as 11 digits.
  - `audit_log` has one `create` entry for it, by Ana, with `before` null and `after->>'payment_term_days'` = `'30'`.
- A CUIT with a wrong check digit (`30-00000001-6`) is refused with `cuit_invalid`. No supplier and no audit entry are written.
- Ten digits, or letters, give `cuit_invalid`. A CUIT of only hyphens and spaces gives `cuit_required`.
- Two informal suppliers (CUIT null) can both be created.
- A second supplier with Ana's CUIT gets 409 `cuit_taken`, and there's still one supplier with it. Updating another supplier to that CUIT gets the same.
- Turning a supplier informal frees its CUIT for another supplier.
- A blank name gives `name_required`. A blank name and a bad CUIT together give both errors.
- Terms of `-1`, `366` and `1.5` give `payment_term_invalid`. `0`, `365` and null are accepted.
- A malformed body is refused with 400 and no field errors: not an object, a number as the name, a missing key, or a string as the term.
- Updating the term from 30 to 45 writes an `update` entry with `before->>'payment_term_days'` = `'30'` and `after` = `'45'`.
- `PUT` on an unknown id, or on a non-UUID id, returns 404.

**Resumen** (`balances.spec.ts`; suppliers are informal and named with a unique token)
- A supplier with no documents shows `"0.00"` in all four figures.
- Searching part of a legal name finds the supplier, ignoring case and accents. Searching part of the name finds it too. A search that matches nothing returns no rows and totals of `"0.00"`.
- The totals equal the sum of the returned rows, column by column.
- `sort=total` puts the largest *Total* first. The default puts the largest *Vencido* first. `sort=name` gives *Abeja, árbol, Ñandú, Oso*.
- `sort=newest` returns 400.

**Balances and status** (`balances.spec.ts`; rows are inserted directly, and the date is faked before signing in)
- Status in Buenos Aires time, with a document due 2026-11-09 and one due 2026-11-08:
  - At `2026-11-10T02:59:59Z`, it's still the 9th in Buenos Aires. The first is *Sin vencer* with `daysToDue` 0, and the second is *Vencido* with `daysToDue` -1.
  - At `2026-11-10T03:00:00Z`, the first becomes *Vencido*.
- Deleted documents, and documents in `processing` or `error`, don't count anywhere and aren't listed. An `unreviewed` one counts, with `reviewStatus` `unreviewed`.
- An invoice of 100.00 that isn't due, and a credit note of 30.00: *Sin vencer* 100.00, *Crédito* 30.00, *Total* 70.00. The credit note is listed with status null.
- A credit note larger than the debt makes *Total* negative, such as `"-20.00"`.
- An opening balance with a past due date counts as *Vencido*. One without a due date counts as *Sin vencer*, with `daysToDue` null.
- Documents are listed by due date, with those without one last.
- `GET` on an unknown id, or on a non-UUID id, returns 404.

**Manual entry** (`documents.spec.ts`; informal suppliers, date faked to 2026-11-09 before signing in)
- With a 30-day term, Ana enters an invoice issued 2026-10-09 without a due date.
  - It's stored with due date 2026-11-08 and `due_date_source` `supplier_term`.
  - It's `manual`, `reviewed`, `created_by` and `reviewed_by` Ana, and `reviewed_at` is the faked instant.
  - It shows as *Vencido* in the account.
  - One issued 2026-10-10 shows as *Sin vencer*, due today. This is acceptance 2.
  - Its `create` audit entry has `after->>'total'` = `'86900.50'` when the total was sent as `"86900.5"`.
- A typed due date wins over the term and is stored as `manual`. A delivery note behaves like an invoice.
- An invoice from a supplier with no term and no due date is refused with `due_date_required`, and nothing is written. With a typed due date it's saved as `manual`.
- An opening balance never uses the term. Without a due date it's saved with none, even when the supplier has a term. With a typed date it's `manual`.
- A credit note with a due date, or an opening balance with a letter or a number, is refused with 400 and no field errors.
- Changing the supplier's term from 30 to 45 leaves the invoice's due date as it was, and the next invoice uses 45. This is acceptance 5.
- Duplicates (acceptance 6):
  - A second invoice with the same supplier, letter and number gets 409 `duplicate_number`, and nothing is written.
  - The same holds for `0001-00004521` against `0001 00004521`, and for two invoices with no letter.
  - The same number is accepted with another type, another letter or another supplier.
  - Once the first is deleted, the number can be entered again.
- `"s/n"` as the number gives `number_invalid`.
- These totals give `total_invalid`: `"0"`, `"-5.00"`, `"1.005"`, `"1,50"`, `""` and `"1000000000000.00"` (13 integer digits).
- `"999999999999.99"` is stored and read back exactly.
- These issue dates give `issue_date_invalid`: `"2026-02-30"`, `"1899-12-31"`, `"3000-01-01"` and `""`.
- An unknown supplier id is refused with 400 and no field errors.

**Deleting** (`documents.spec.ts`; acceptance 7)
- Deleting a document:
  - sets `deleted_at` to the faked instant
  - drops it from the account and from *Resumen*
  - writes a `delete` entry by Ana, with `before->>'deleted_at'` null and `after->>'deleted_at'` set
- Deleting it again, an unknown id or a non-UUID id returns 404.
- After creating a supplier, two documents, changing the term and deleting one document, `audit_log` holds one entry for each step, in order, each with Ana's `user_id`.

**Rollback** (`audit-rollback.spec.ts`, with `AuditService` replaced by a subclass whose `record` throws after the write)
- Creating a supplier returns 500, and no supplier with that name exists.
- Updating a term returns 500, and the term is unchanged.
- Entering a document returns 500, and no document with that number exists.
- Deleting returns 500, and the document isn't deleted.

**Database** (`documents-table.spec.ts`, `suppliers-table.spec.ts`; rows inserted directly)
- Invariant 1: a reviewed invoice without a due date, or an unreviewed document without a total, is refused. A reviewed opening balance without a due date is accepted. An `error` document with nothing but its source is accepted.
- Invariant 7: these collide:
  - two reviewed documents with the same supplier, type, letter and number
  - the same with no letter on either
  - an `unreviewed` one against a `reviewed` one
- Invariant 7: these don't collide: a deleted one, and one in `error`.
- Invariant 8: a reviewed document without `reviewed_by` is refused, and so is an unreviewed one with `reviewed_at` and `reviewed_by`.
- `total` of 0 is refused. A `number_normalized` that disagrees with `number` is refused.
- A credit note with a due date, an opening balance with a `supplier_term` due date, and a due date without a source are all refused.
- `payment_term_days` of -1 is refused. A CUIT of ten digits or with letters is refused.

**Units**
- `resolveDueDate`, one case per row of its table, plus a term of 0, which makes the due date the issue date.
- `addDays`:
  - `2026-01-31` + 30 = `2026-03-02`.
  - `2028-02-28` + 1 = `2028-02-29`.
  - `2026-12-15` + 30 = `2027-01-14`.
- `isIsoDate` rejects:
  - `2026-02-29`
  - `2026-13-01`
  - `1899-12-31`
  - `3000-01-01`
  - `26-11-09`
  - `2026-11-9`
- `isIsoDate` accepts `2028-02-29`.
- `normalizeNumber`: `0001-00004521` gives `000100004521`, and `s/n` gives null.
- `Money`:
  - rejects 13 integer digits and accepts 12
  - adding a cent to `999999999999.99` stays exact (already tested)
  - `isPositive` is false for 0 and negatives
  - `compare` orders `-1.00`, `0.00`, `0.01`, `10.00`
- `isUuid`. `UsersService.findById` keeps its non-UUID test.

**Routes** (`test/routes.spec.ts`)
- The listing includes the six new routes.
- They return 401 without a session, like every route except sign-in.

**Frontend**
- `format.spec.ts`: every example in the `format.ts` list above, including the rejections, and `formatMoney` throwing on `"1.5"`.
- `accounts-api.spec.ts`:
  - Each function calls the right URL and method, with a JSON body and `Content-Type: application/json` where there's a body.
  - `listSuppliers` leaves out a blank `q`.
  - 200, 201 and 204 give the value.
  - 400 and 409 with `errors` give `rejected` with those errors.
  - 404 gives `not_found`.
  - 401 gives `unauthorized` and calls the registered handler, and an unsubscribed handler isn't called.
  - 500 and a rejected `fetch` give `unavailable`.

## Steps

One commit per step. Backend steps need `docker compose up -d db`. "Verify" lists what proves the step is done.

1. **Common helpers**
   - Change `Money` (12-digit limit, `isPositive`, `compare`).
   - Add `dates.ts`, `uuid.ts` and `field-errors.ts`. Switch `UsersService` to `isUuid`.
   - Add their tests.
   - Verify: backend `npm test`, `npm run lint` and `npm run typecheck` pass.
2. **Tables and migration**
   - Add the enums, the three models and the `User` back-relations.
   - Run `npx prisma migrate dev --name suppliers_documents_audit --create-only`, append the hand-written block, run `npx prisma migrate dev`, then `npx prisma generate`.
   - Add `documents-table.spec.ts` and `suppliers-table.spec.ts`.
   - Verify:
     - `npm test` passes. The harness applies the migration to `facturas_test`.
     - `\d documents` in the dev database shows `documents_number_unique` with `NULLS NOT DISTINCT` and its `WHERE`, and seven `CHECK`s. `\d suppliers` shows two.
     - Run `npx prisma migrate dev --create-only --name probe`. Whatever it generates has no `DROP`. Delete the probe migration.
3. **Audit, due dates and the test helper**
   - Add `AuditModule`, `resolveDueDate`, `normalizeNumber` and their unit tests.
   - Give `createTestApp` its `override` callback and make `createUser` return the id.
   - Verify: all three checks pass.
4. **Supplier writes**
   - Add `SuppliersModule` with `POST` and `PUT`, input parsing, the CUIT rules and the audit entries.
   - Add the write tests from *Suppliers*, and the supplier cases of *Rollback*.
   - Verify: all three checks pass.
5. **Balances and the two `GET`s**
   - Add `BalancesModule` and the `GET` routes.
   - Add *Resumen* and *Balances and status*, and add the routes to `routes.spec.ts`.
   - Verify:
     - All three checks pass.
     - With `start:dev`, sign in with `curl`, create a supplier, and read `/api/suppliers` and `/api/suppliers/<id>`.
6. **Manual entry and deleting**
   - Add `DocumentsModule` with `POST` and `DELETE`.
   - Add *Manual entry* and *Deleting*, the rest of *Rollback*, and the two routes to `routes.spec.ts`.
   - Verify: all three checks pass.
7. **Frontend foundations**
   - Add `react-router`, `BrowserRouter`, `accounts-api.ts`, `format.ts`, `labels.ts` and their tests.
   - Register the unauthorized handler in `App`.
   - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
8. **Screens**
   - Add the four screens, the routes in `Shell` and the CSS.
   - Verify:
     - The frontend checks pass.
     - With both apps in dev mode, go through the manual acceptance below at 390 px wide, in light and dark mode.
9. **Docs**
   - In `agents.md`, under *Where things live*:
     - `backend/src/balances/` is the only place that derives status and balances (D1).
     - `backend/src/audit/` writes `audit_log` in the caller's transaction (D2).
     - `backend/src/documents/due-date.ts` is the only due-date rule (D4).
     - `backend/src/common/dates.ts`.
     - `frontend/src/labels.ts` holds every Spanish label for an enum or error code.
     - `frontend/src/format.ts` formats amounts as strings, never numbers.
   - In `agents.md`, under *Rules that are easy to miss*:
     - Only `suppliers.spec.ts` gives suppliers a CUIT, and it frees the test CUITs before each test.
     - Tests that read `GET /api/suppliers` search for a unique token in their suppliers' names.
     - `createTestApp` takes an override to replace a provider.
   - Verify: all checks pass in both apps. `check:cuits` scans docs too.

**Manual acceptance at the end** (from the spec; invented names, test CUITs)
1. Create *Panadería El Ceibo*, legal name *El Ceibo S.R.L.*, with a 30-day term.
   - `30-00000001-6` shows *El CUIT no es válido.*
   - `30-00000001-5` saves.
2. Enter an invoice issued 31 days ago and one issued 30 days ago, both without a due date. The first is *Vencido* and the second is *Sin vencer*, due *hoy*.
3. Enter an opening balance with a past due date and one without. The first counts as *Vencido* and the second as *Sin vencer*.
4. Enter a credit note. It shows in *Crédito* and lowers *Total*. In *Resumen*, the summary card matches the sum of the rows.
5. Change the term to 45 days. *antes: 30* and the warning appear. The existing due dates don't move.
6. Enter the first invoice's letter and number again. It's refused with the duplicate message.
7. Delete a document. It drops out of the balance. In `psql`, `SELECT entity, action, user_id, before, after FROM audit_log ORDER BY created_at` shows every step with its before and after.
8. Create *Lácteos La Pradera* with legal name *La Pradera S.R.L.*. *Resumen* finds it by typing *pradera*. Sorting by *Mayor total* puts the biggest debt first.

## Doors

| Part | Door | Note |
| --- | --- | --- |
| Invariant 7: `documents_number_unique`, `normalizeNumber` and the `documents_number_normalized` check | **One-way, small blast radius** | It's document deduplication, which `one-way-doors.md` lists. The spec calls the whole slice two-way because the tables are new. Under "when in doubt, treat it as one-way", the plan flags this part so a human confirms it. |
| Tables, enums and the migration | Two-way | New tables on an empty database. No real data exists until slice 8. In development, `prisma migrate reset` undoes them. |
| The other `CHECK`s (invariants 1 and 8, totals, terms, CUIT digits, due-date rules) | Two-way | Constraints on empty tables. A wrong one can be dropped by the next migration. |
| The balance SQL, status and *Resumen* sorting | Two-way | Status and balances are derived, never stored, so a fix only changes what's shown. |
| `audit_log` writes | Two-way now | A missing entry can't be recreated later. Today no real change exists to lose. |
| Soft delete | Two-way | `one-way-doors.md` says so: normal deletion is soft. Nothing is hard-deleted. |
| The six endpoints | Two-way | They're behind the existing global `SessionGuard`, with no new `@Public()`. `routes.spec.ts` lists them and checks the 401. |
| `Money.fromString` limit | Two-way | It has no callers yet. |
| Frontend router, screens and copy | Two-way | The backend enforces every rule. |

**Blast radius of invariant 7**
- **Today**: none. Only test and developer data exist, and nothing real is stored before slice 8.
- **From slice 8**, it fails in one of two ways:
  - **False negative**: a document typed twice isn't caught, and the debt is overstated with no warning. This is the dangerous one.
  - **False positive**: a real document is refused as a duplicate. The person sees the message, so it's visible, but they can't record that debt.
- Slice 5 reuses the same set of documents for `duplicate_number`, so whatever this index decides also applies to extraction.

**How the plan shrinks it**
- The database enforces it, so concurrent saves can't both pass. The API maps the violation to 409 instead of checking first.
- `NULLS NOT DISTINCT` makes two documents with no letter collide, which a plain unique index would miss.
- The `documents_number_normalized` check means no writer, including slice 5's worker, can store a normalized number that disagrees with the printed one.
- A number must contain a digit, so a typed *s/n* can't slip past the index.
- The tests cover both directions:
  - **Caught**: separators, no letter, `unreviewed` against `reviewed`.
  - **Allowed**: another type, letter or supplier, a deleted document, and one in `error`.
- Until slice 8, the index can be redefined by a plain migration, with no data to check against it.

**Known limits**
- Normalizing keeps leading zeros, as the design defines it, so `0003-00012345` and `3-12345` don't collide.
- A supplier figure above 999.999.999.999,99 fails the request, because `Money.fromString` won't read it.
- *Resumen* filters and sorts in memory, which is fine for about 60 suppliers.

**Look closely at**
- The hand-written block in the migration: the index's column list, `NULLS NOT DISTINCT` and its `WHERE`.
- `normalizeNumber`.
- The `P2002` mapping, which must check the constraint name, so a different unique violation isn't reported as a duplicate.
- The `counted` SQL: the `deleted_at` and `review_status` filters (D3), and `today` passed as a parameter.
- That every write to `suppliers` and `documents` calls `AuditService.record` inside its transaction (D2).
