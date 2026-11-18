# Plan: Payments and applications (slice 3)

Spec: [`mvp-slices.md`, section 3](mvp-slices.md#3-payments-and-applications). Branch: `feat/payments-and-applications`.

## Goal

A signed-in person records a payment to a supplier, and the app suggests how to split it across that supplier's open documents, oldest first. Every row of the split can be edited, and whatever isn't applied stays as credit. *Marcar como pagado* settles one document in one step. Existing credit, from a payment's leftover or a credit note, is applied from *Proveedor*'s *Crédito a favor* card with the same split. Documents show *Pagado* or *Pago parcial*, credit notes show *Disponible* or *Aplicada*, and *Pagos* lists payments by supplier. Nothing is ever over-applied, and nothing with applications can be deleted.

## Out of scope

- Editing documents (slice 6). Invariant 6 is enforced now, but the only change a person can make in this slice is a delete.
- Editing or deleting payments, and removing or changing applications ([question 3](mvp-slices.md#open-questions)). So `ApplicationsService` gets no payment-side change check: nothing can change a payment yet, and the trigger guards it meanwhile.
- A database trigger for invariants 2–5. The spec puts them in `ApplicationsService`, behind a lint rule.
- *Usar crédito a favor* from a document or from a payment row (the other two entry points in 7h). The *Crédito a favor* card is the only one.
- Date ranges or type filters in *Pagos* or *Proveedor*. The design rules them out.
- The *Documento* screen (slice 4). *Marcar como pagado* lives on *Proveedor*'s rows.
- The desktop layouts (7i, 3d), the bottom navigation bar (0b), and frontend DOM or component tests.
- Reports, reminders, and nginx's SPA fallback for the new routes (slice 8).

## Decisions

**The user's answers (2026-11-18).** Step 1 writes them into the design docs.
1. No document edit endpoint. *Descartar* on a document with applications is refused with a Spanish message. `ApplicationsService` holds the invariant 6 check that slice 6's edit will call. A database trigger also refuses, while applications exist on either side: a soft delete, a change of supplier or type, a total below what's applied, and leaving `unreviewed` or `reviewed`. The editing half of acceptance 4 is tested at the service level and with direct SQL, and moves to slice 6's manual acceptance.
2. The split and *Proveedor*'s list both order by `COALESCE(due_date, issue_date)`. Put last, an opening balance without a due date would never be suggested while newer invoices keep arriving, and since it never becomes overdue, nothing would flag it.
3. Invariant 6 protects both sides of an application. A credit note or a payment that has given credit can't be deleted, change supplier, or drop below what it gave. Both the trigger and `ApplicationsService` check both sides.

The defaults from the planning questions also stand: *Marcar como pagado* sits on *Proveedor*'s rows, with a fixed amount that's refused if what's left changed; the payment-status filter treats credit notes as described below; the eCheq fields work as described below; and the result screen (7f) opens after saving a payment.

**Verified facts.** Checked on 2026-11-18 against Postgres 17 (the compose image), Prisma 7.10.1 with `@prisma/adapter-pg`, and the repo's ESLint 10, in a scratch database that has since been dropped. These aren't open to the implementer.
- The schema below validates. `prisma migrate diff` generates the SQL listed under *Migration*, and every relation gets `ON DELETE RESTRICT`.
- After the hand-written block is applied, `prisma migrate diff` from the database to the schema is an empty migration. The two trigger functions, the two triggers and the four `CHECK`s survive the next `migrate dev`.
- The trigger must `RAISE EXCEPTION` with the default SQLSTATE (`P0001`). A Prisma model write then fails with `PrismaClientKnownRequestError` code `P2039`, the same as a `CHECK` violation, with the trigger name in `message`. A raw query fails with `P2010`, also with the name. With `USING ERRCODE = 'restrict_violation'`, a model write gets `P2003` instead, Prisma's foreign key code, and the name disappears from the message. Don't set `ERRCODE`.
- Interactive transactions (`$transaction(async (tx) => …)`) run at `read committed`. If transaction A locks a document `FOR UPDATE` and inserts an application, transaction B's `SELECT … FOR UPDATE` on that document waits. Once A commits, a new statement in B sees A's application. Under `REPEATABLE READ`, that same `SUM` returns 0 after the wait, which would over-apply. **No write path passes `isolationLevel`.** `supplierAccount` keeps its `RepeatableRead`, because it only reads.
- An `UPDATE documents SET deleted_at = …` that waited on an apply's lock is refused by the trigger once the apply commits.
- `= ANY(${ids}::uuid[])` in `$queryRaw` binds a JS `string[]`, including an empty one.
- `SELECT … ORDER BY id FOR UPDATE` takes the row locks in `id` order.
- The lint selectors under *Lint ban* catch every write form tried: the delegate as `.application` and as `['application']`, nested writes through the relation fields, and raw `INSERT`, `UPDATE` and `DELETE` in template and string literals. They allow raw reads (`FROM applications`) and an `applications` key in a plain object. Merged with the clock selectors, both bans keep working, along with their file exceptions.
- The balance SQL under *Balance SQL* gives, for an opening balance of 40.00 issued 2026-09-30 without a due date, invoice A of 100.00 (fully applied), invoice B of 50.00 (20.00 applied), an unapplied credit note of 30.00, and an unapplied payment of 80.00: *Sin vencer* 70.00, *Vencido* 0.00, *Crédito* 110.00 and *Total* −40.00. The opening balance sorts first, and B is `pending`, `partial`, with 30.00 left.

**One derivation (D1)**
- `BalancesService` keeps the only SQL that derives `applied`, `remaining`, `outstanding`, `unapplied`, `partial` and `status`, for documents and for payments. *Resumen*, *Proveedor*, *Pagos*, the payment detail, the split preview and the save all read it.
- `ApplicationsService` reads what documents and sources have left through `BalancesService`, inside its own transaction, after taking its locks. It never sums `applications` itself.
- One rule is written twice: in the preview, a row becomes `paid` when it brings what's left to zero. `projectAfter` in `backend/src/balances/project.ts` holds it, next to the SQL, with a comment pointing at the `counted` `CASE`. A test pins the two together: after saving, the account shows exactly the statuses the preview predicted.

**Applications (invariants 2–6)**
- Only `backend/src/applications/` writes `applications`. The ESLint ban under *Lint ban* enforces this.
- Every write locks in one fixed order: first the source (an existing payment or credit note), then the receiving documents, with one `SELECT id FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`. A new payment needs no lock, because no other transaction can see it. No row is ever both a source and a receiver (invariant 5), and the delete path locks a single document, so no two transactions can wait on each other in a cycle.
- After the locks, a new statement reads what's left, through `BalancesService`.
- Both sides of every application must be counted. The receiving document must be an `invoice`, `delivery_note` or `opening_balance` in `unreviewed` or `reviewed`, not deleted. The source must be a payment that isn't deleted, or a counted `credit_note`. Both must belong to the same supplier.
- One evaluation function decides the split for the preview and for the save. The preview returns its errors with status 200. The save refuses with 409 and the same list.

**Audit (D2)**
- `AuditEntity` adds `payments` and `applications`. Each payment and each application gets a `create` entry, with `before` SQL `NULL` and `after` its `to_jsonb` snapshot, by the session user, in the write's transaction.
- A split writes one entry for the payment, if it's new, and one per application. Rows of zero are never written, so they get no entry.

**Input and errors.** These follow slice 2's conventions.
- A body that's malformed (a missing or unknown key, or a wrong JSON type) gets 400 `{ "errors": [] }`. Field mistakes get 400 with every error found in one pass. A clash with stored rows gets 409 with the same shape.
- An unknown `supplierId` for a new payment is a malformed request, as with documents. A document or source id inside a split, or in *Marcar como pagado*, that's unknown or unusable gives 409 `not_applicable`. Both cases look the same to the person: something changed while they were splitting.
- A row's field is `applications.<documentId>`.

**Choices a human may want to revisit.** None of these is in the design. Each has a one-line reason.
1. **The ban is `no-restricted-syntax`, not the "import rule" the spec names.** Every service imports `PrismaService`, so an import rule can't tell a write from a read.
2. **Spec files are exempt from the applications ban.** They have to build states the service would refuse, to test the trigger, the `CHECK`s and the derivation. The ban protects production paths. The clock and money bans still apply to specs.
3. **A trigger on `payments` too.** "Both sides" includes a payment that has given credit. Nothing changes payments in this slice, so it's only a backstop.
4. **`today` is added to `SupplierList` and `SupplierAccount`.** It lets the payment forms default *Fecha de pago* to today, as 7b asks, without the frontend reading the clock, which ESLint bans.
5. **One code, `document_has_applications`, covers every invariant 6 refusal.** Slice 6 may split it when editing makes the other cases reachable.
6. **Rows of zero are accepted and dropped.** A payment that applies nothing is valid (acceptance 2). Applying existing credit with nothing applied is refused with `nothing_to_apply`.
7. **The payment-status filter runs in the frontend, over the statuses the backend computed.** It uses an exhaustive `Record`, doesn't touch amounts or dates, and isn't kept in the URL. *Proveedor* already loads all of a supplier's documents.
8. ***Aplicar crédito* lists available credit notes first, then available payments,** each in the backend's order, and preselects the first. That way the frontend never compares dates.
9. ***Marcar como pagado* is its own route,** not a sheet, and has no *Notas* field, since 7g has none. Its payment is saved with `notes` null.
10. **The header gets *Resumen* and *Pagos* links** instead of the bottom bar (0b), whose other entries don't exist yet.
11. ***Pagos* lists every payment, newest first, without pagination.** At about 100 a month, that's fine for the MVP.
12. **An eCheq's *Fecha de cobro* is optional.** A value date on any other method is a malformed request, and a `CHECK` backs that up. Nothing compares it with *Fecha de pago*.

## Interface

### Schema (`backend/prisma/schema.prisma`, validated with Prisma 7.10.1)

Back-relations Prisma requires:

```prisma
// User
  paymentsCreated   Payment[]
// Supplier
  payments        Payment[]
// Document
  applicationsReceived Application[] @relation("ApplicationDocument")
  applicationsGiven    Application[] @relation("ApplicationCreditNote")
```

New enum and models:

```prisma
enum PaymentMethod {
  transfer
  echeq
  cash
  mercado_pago
  other

  @@map("payment_method")
}

model Payment {
  id                String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  supplierId        String        @map("supplier_id") @db.Uuid
  supplier          Supplier      @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  amount            Decimal       @db.Decimal(14, 2)
  paidOn            DateTime      @map("paid_on") @db.Date
  valueDate         DateTime?     @map("value_date") @db.Date
  method            PaymentMethod
  reference         String?
  notes             String?
  createdById       String        @map("created_by") @db.Uuid
  createdBy         User          @relation(fields: [createdById], references: [id], onDelete: Restrict)
  deletedAt         DateTime?     @map("deleted_at") @db.Timestamptz(6)
  createdAt         DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime      @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  applicationsGiven Application[]

  @@index([supplierId])
  @@map("payments")
}

model Application {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId   String    @map("document_id") @db.Uuid
  document     Document  @relation("ApplicationDocument", fields: [documentId], references: [id], onDelete: Restrict)
  paymentId    String?   @map("payment_id") @db.Uuid
  payment      Payment?  @relation(fields: [paymentId], references: [id], onDelete: Restrict)
  creditNoteId String?   @map("credit_note_id") @db.Uuid
  creditNote   Document? @relation("ApplicationCreditNote", fields: [creditNoteId], references: [id], onDelete: Restrict)
  amount       Decimal   @db.Decimal(14, 2)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([documentId])
  @@index([paymentId])
  @@index([creditNoteId])
  @@map("applications")
}
```

`applications` has no `updated_at` or `deleted_at`: its rows never change ([data model](../system-design.md#data-model)). The relation field names `applicationsReceived` and `applicationsGiven` are part of the lint ban, so don't rename them.

### Migration

Generate `prisma/migrations/<timestamp>_payments_applications/` with `--create-only`. It creates the `payment_method` enum, both tables, the four indexes and the five foreign keys. Then append this block by hand, which was applied and checked case by case:

```sql
-- Added by hand: rules Prisma can't express.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_value_date_echeq_only" CHECK ("value_date" IS NULL OR "method" = 'echeq');

ALTER TABLE "applications" ADD CONSTRAINT "applications_amount_positive" CHECK ("amount" > 0);
-- Exactly one source: a payment or a credit note.
ALTER TABLE "applications" ADD CONSTRAINT "applications_one_source" CHECK (("payment_id" IS NULL) <> ("credit_note_id" IS NULL));

-- Invariant 6, on both sides of an application: while a document has applications,
-- received or given, it stays counted, keeps its supplier and type, isn't deleted,
-- and its total covers what it received and what it gave. Hard deletes are already
-- refused by the RESTRICT foreign keys. No ERRCODE: the default P0001 reaches Prisma
-- as P2039 with this name in the message.
CREATE FUNCTION "documents_keep_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  received numeric;
  given numeric;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO received FROM "applications" WHERE "document_id" = OLD."id";
  SELECT COALESCE(SUM("amount"), 0) INTO given FROM "applications" WHERE "credit_note_id" = OLD."id";
  IF received = 0 AND given = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW."deleted_at" IS NOT NULL
     OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."review_status" NOT IN ('unreviewed', 'reviewed')
     OR NEW."total" IS NULL OR NEW."total" < received OR NEW."total" < given THEN
    RAISE EXCEPTION 'documents_keep_applied: document % has applications', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documents_keep_applied" BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "documents_keep_applied"();

-- The same for the payment side.
CREATE FUNCTION "payments_keep_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  given numeric;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO given FROM "applications" WHERE "payment_id" = OLD."id";
  IF given > 0 AND (NEW."deleted_at" IS NOT NULL
                    OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
                    OR NEW."amount" < given) THEN
    RAISE EXCEPTION 'payments_keep_applied: payment % has applications', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payments_keep_applied" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_keep_applied"();
```

### HTTP (prefix `/api`, JSON bodies, every route behind the global `SessionGuard`)

| Method and path | Success | Errors |
| --- | --- | --- |
| `POST /api/applications/preview`, body `SplitRequest` | 200 `Split` | 400 malformed or field errors |
| `POST /api/applications`, body `ApplyCreditInput` | 204 | 400, 409 |
| `POST /api/payments`, body `PaymentInput` | 201 `{ id }` | 400, 409 |
| `POST /api/payments/mark-paid`, body `MarkPaidInput` | 201 `{ id }` (the payment's id) | 400, 409 |
| `GET /api/payments?supplierId=` | 200 `PaymentList` | 400 for a non-UUID or repeated `supplierId` |
| `GET /api/payments/:id` | 200 `PaymentDetail` | 404, also for a non-UUID or deleted payment |
| `DELETE /api/documents/:id` (changed) | 204 | 404, and now 409 `document_has_applications` |
| `GET /api/suppliers` (changed) | 200 `SupplierList` with `today` | unchanged |
| `GET /api/suppliers/:id` (changed) | 200 `SupplierAccount`, new shape | unchanged |

`POST /api/applications/preview` uses `@HttpCode(200)`, and `POST /api/applications` uses `@HttpCode(204)`. Amounts are strings with exactly two decimals, and dates are `YYYY-MM-DD`, as in slice 2. An unknown `supplierId` in `GET /api/payments` gives an empty list.

```ts
type PaymentMethod = 'transfer' | 'echeq' | 'cash' | 'mercado_pago' | 'other';
type DebtStatus = 'pending' | 'overdue' | 'paid';
type CreditStatus = 'available' | 'applied';
type DocumentStatus = DebtStatus | CreditStatus;
type ReceivingType = 'invoice' | 'delivery_note' | 'opening_balance';

interface SplitRow {
  documentId: string;
  amount: string; // "20000.00"; "0" applies nothing
}

type SplitSource =
  | { kind: 'new_payment'; supplierId: string; amount: string }
  | { kind: 'payment'; id: string }
  | { kind: 'credit_note'; id: string };

interface SplitRequest {
  source: SplitSource;
  /** Null asks for the suggestion. Otherwise the amount typed on each row; documents left out apply nothing. */
  applications: SplitRow[] | null;
}

interface Split {
  /** The new payment's amount, or what the existing payment or credit note has left before this split. */
  available: string;
  applied: string; // Σ row amounts
  unapplied: string; // stays as credit; "0.00" when the rows add up to more than `available`
  excess: string; // how much the rows go over `available`; "0.00" otherwise
  rows: SplitRowResult[];
  /** Exactly what a save would refuse with, as its 409 field errors. Empty when the split can be saved. */
  errors: FieldError[];
}

interface SplitRowResult {
  documentId: string;
  type: ReceivingType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  daysToDue: number | null;
  status: DebtStatus; // now
  remaining: string; // now: "Falta $ …"
  amount: string; // in this split, "0.00" when it applies nothing
  /** As it would be after saving. The same as now when the row applies nothing or has an error. */
  after: { status: DebtStatus; remaining: string; partial: boolean };
}

interface PaymentInput {
  supplierId: string;
  amount: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  valueDate: string | null; // eCheq only
  notes: string | null;
  applications: SplitRow[];
}

interface ApplyCreditInput {
  source: { kind: 'payment' | 'credit_note'; id: string };
  applications: SplitRow[];
}

interface MarkPaidInput {
  documentId: string;
  amount: string; // what the person saw as left; refused if it's no longer exactly that
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  valueDate: string | null;
}

interface PaymentSummary {
  id: string;
  amount: string;
  paidOn: string;
  valueDate: string | null;
  method: PaymentMethod;
  reference: string | null;
  createdByName: string;
  unapplied: string;
  status: CreditStatus;
}

interface PaymentListRow extends PaymentSummary {
  supplierId: string;
  supplierName: string;
}

interface PaymentList {
  payments: PaymentListRow[]; // newest paid first: paid_on DESC, created_at DESC, id DESC
}

interface PaymentDetail extends PaymentListRow {
  notes: string | null;
  applied: string;
  /** In split order. The document's status and remaining are as of now. */
  applications: {
    documentId: string;
    type: ReceivingType;
    letter: string | null;
    number: string | null;
    amount: string; // what this payment applied to it
    status: DebtStatus;
    remaining: string;
    partial: boolean;
  }[];
}

// Changed from slice 2
interface SupplierList {
  suppliers: SupplierListRow[];
  totals: SupplierFigures;
  today: string; // Buenos Aires, the date the statuses were derived for
}

interface SupplierAccount extends SupplierFigures {
  // …slice 2 fields…
  today: string;
  /** Counted documents only, by COALESCE(due date, issue date), then issue date, then creation, then id. */
  documents: AccountDocument[];
  payments: PaymentSummary[]; // the supplier's, newest paid first
}

interface AccountDocument {
  id: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  total: string;
  reviewStatus: 'unreviewed' | 'reviewed';
  status: DocumentStatus; // DebtStatus for debts, CreditStatus for credit notes; never null now
  remaining: string; // left to pay on a debt, left to apply on a credit note
  partial: boolean; // something applied and something left
  daysToDue: number | null;
}
```

**Body rules.** Every documented key must be present with its JSON type. Anything else is a malformed 400.

| Body | Key | JSON type | Rule | Code |
| --- | --- | --- | --- | --- |
| `PaymentInput`, `MarkPaidInput` | `supplierId` | string | A UUID of an existing supplier (`PaymentInput` only) | Malformed |
| | `documentId` | string | A UUID (`MarkPaidInput` only) | Malformed |
| | `amount` | string | `Money.fromString`, above zero | `amount_invalid` |
| | `paidOn` | string | `isIsoDate` | `paid_on_invalid` |
| | `method` | string | One of the five | Malformed |
| | `reference` | string or null | Trimmed. Empty becomes null | |
| | `valueDate` | string or null | Null unless `method` is `echeq` (malformed otherwise). Then `isIsoDate` | `value_date_invalid` |
| | `notes` | string or null | Trimmed. Empty becomes null (`PaymentInput` only) | |
| `PaymentInput`, `ApplyCreditInput` | `applications` | array | Each element is a `SplitRow`. Document ids are distinct | Malformed |
| `SplitRequest` | `applications` | array or null | The same, or null | Malformed |
| `SplitRow` | `documentId` | string | A UUID | Malformed |
| | `amount` | string | `Money.fromString`, zero or more | `application_amount_invalid` on `applications.<documentId>` |
| `SplitRequest` | `source` | object | Exactly the keys of its `kind`. `supplierId` and `id` are UUIDs. A `new_payment`'s `supplierId` must exist | Malformed |
| | `source.amount` | string | `Money.fromString`, above zero | `amount_invalid` on `amount` |
| `ApplyCreditInput` | `source` | object | `kind` is `payment` or `credit_note`, plus `id`, a UUID | Malformed |

**Conflicts.** These are checked in the transaction, after the locks. A save gets 409 `{ errors }`, and a preview returns the same list in `Split.errors`.

| Field | Code | When |
| --- | --- | --- |
| `applications.<documentId>` | `not_applicable` | The document isn't a counted `invoice`, `delivery_note` or `opening_balance` of the source's supplier. That covers unknown, deleted, `processing`, `error`, a credit note, and another supplier's document (invariants 4 and 5). Only for rows with an amount above zero |
| `applications.<documentId>` | `exceeds_remaining` | The row is more than the document has left (invariant 2) |
| `applications` | `exceeds_source` | The rows add up to more than `available` (invariant 3) |
| `applications` | `nothing_to_apply` | Existing credit (`payment` or `credit_note` source) and every row is zero |
| `source` | `not_applicable` | The source is unknown, a deleted payment, or not a counted credit note |
| `documentId` | `not_applicable` | *Marcar como pagado* on something that isn't a counted, receiving document |
| `amount` | `remaining_changed` | *Marcar como pagado* when `amount` isn't exactly what the document has left |
| `document` | `document_has_applications` | Deleting a document that has applications, received or given |

**Which rows a split shows.** The source's supplier's counted, receiving documents that still have something left, plus any document named in `applications` that's one of them but has nothing left. They come in split order: `COALESCE(due_date, issue_date)`, then `issue_date`, then `created_at`, then `id`.

**The suggestion** (`applications: null`). Walk the rows in order. Each one takes the smaller of what it has left and what's still available, until nothing is available. Every later row gets 0.

**Order of work**

- `POST /api/applications/preview`: parse. In one transaction, with no locks and no writes, resolve the supplier and `available`, read the rows, evaluate, and return the result.
- `POST /api/payments`: parse. In one transaction:
  1. Read the supplier. If it's missing, return a malformed 400.
  2. Insert the payment, with `created_by` the session user.
  3. Write its `create` audit entry.
  4. Call `ApplicationsService.applyNewPayment`:
     - lock the named documents
     - read the rows
     - evaluate with `available` set to the amount
     - on any error, throw 409, which rolls back the payment too
     - insert each row above zero, with its audit entry
- `POST /api/applications`: parse. In one transaction:
  1. Lock the source.
  2. Lock the named documents.
  3. Read the source's `unapplied` and the rows.
  4. Evaluate. On any error, throw 409.
  5. Insert the rows above zero, with their audit entries.
- `POST /api/payments/mark-paid`: parse. In one transaction:
  1. Call `ApplicationsService.lockToSettle(documentId)`, which locks the document and reads its supplier and what it has left. Otherwise it throws 409 `not_applicable`.
  2. If `amount` differs from what's left, throw 409 `remaining_changed`.
  3. Insert the payment for that supplier and audit it.
  4. Call `applyNewPayment` with the single row. Locking the same row again in the same transaction is a no-op.
- `DELETE /api/documents/:id`: in one transaction:
  1. Snapshot, which locks the row. If it's missing or already deleted, return 404.
  2. Call `ApplicationsService.assertDocumentChange(tx, id, { delete: true })`. If the document has applications, received or given, it throws 409 `document_has_applications`.
  3. Set `deleted_at`.
  4. Audit.

  The trigger refuses the same update on its own if anything gets past the service check. That shows up as a 500.

### Backend modules

- `backend/src/common/money.ts`: add `subtract(other: Money): Money` and `isZero(): boolean`.
- `backend/src/common/field-errors.ts`: `FieldErrorCode` adds `amount_invalid`, `paid_on_invalid`, `value_date_invalid`, `application_amount_invalid`, `exceeds_remaining`, `exceeds_source`, `nothing_to_apply`, `not_applicable`, `remaining_changed` and `document_has_applications`.
- `backend/src/audit/audit.service.ts`: `AuditEntity` adds `payments` and `applications`, each with its fixed identifier in `TABLES`.
- `backend/src/balances/`
  - `balances.types.ts`: the changed account and list types, `PaymentSummary`, `PaymentList`, `PaymentDetail`, and the status types.
  - `BalancesService`
    - `listSuppliers` adds `today`.
    - `supplierAccount` adds `today`, `payments` and the new document fields and order. All three reads stay in one `RepeatableRead` transaction.
    - New: `listPayments({ supplierId: string | null }): Promise<PaymentList>` and `payment(id): Promise<PaymentDetail | null>`.
    - New, for `ApplicationsService`, always called with the caller's `tx` after its locks:
      - `splitDocuments(tx, supplierId: string, documentIds: string[]): Promise<SplitDocument[]>`: the rows defined above, with `remaining` and `applied` as `Money`.
      - `creditSource(tx, source: { kind: 'payment' | 'credit_note'; id: string }): Promise<{ supplierId: string; unapplied: Money } | null>`: null when it can't give.
      - `documentApplied(tx, id): Promise<{ supplierId: string | null; type: DocumentType | null; total: Money | null; reviewStatus: ReviewStatus; received: Money; given: Money } | null>`: for the invariant 6 check.
  - `project.ts`: `projectAfter(now: { status: DebtStatus; remaining: Money; applied: Money }, amount: Money): { status: DebtStatus; remaining: Money; partial: boolean }`. The status becomes `paid` when what's left reaches zero, and otherwise stays as it is. `partial` means something is applied and something is left.
- `backend/src/applications/` (`ApplicationsModule`: imports `AuditModule` and `BalancesModule`, exports `ApplicationsService`)
  - `split.ts`, pure functions on `Money`:
    - `suggest(available: Money, rows: { id: string; remaining: Money }[]): Map<string, Money>`
    - `evaluate(available: Money, rows: { id: string; remaining: Money }[], amounts: Map<string, Money>): { applied: Money; unapplied: Money; excess: Money; exceeding: Set<string> }`
  - `split-input.ts`: `parseSplitRequest(body)`, `parseApplyCreditInput(body)` and `parseSplitRows(value)`. The payments parsers reuse the last one.
  - `ApplicationsService`
    - `preview(request): Promise<Split>`
    - `applyCredit(input, user): Promise<void>`: its own transaction
    - `applyNewPayment(tx, payment: { id: string; supplierId: string; amount: Money }, rows, user): Promise<void>`
    - `lockToSettle(tx, documentId): Promise<{ supplierId: string; remaining: Money }>`
    - `assertDocumentChange(tx, documentId, change: { delete: true } | { supplierId?: string; type?: DocumentType; total?: Money; reviewStatus?: ReviewStatus }): Promise<void>`: invariant 6 on both sides. Slice 3 calls it only for deletes. Slice 6's edit will call it with the new header.
    - All three writes share one private evaluation, and the preview runs that same one.
  - `ApplicationsController`: `POST applications/preview` and `POST applications`.
- `backend/src/payments/` (`PaymentsModule`: imports `AuditModule`, `ApplicationsModule` and `BalancesModule`)
  - `payment-input.ts`: `parsePaymentInput(body)` and `parseMarkPaidInput(body)`.
  - `PaymentsService`: `create(input, user)` and `markPaid(input, user)`. It writes `payments` and calls `ApplicationsService` for every application.
  - `PaymentsController`: the four `payments` routes. The two `GET`s call `BalancesService`, as `SuppliersController` does.
- `DocumentsModule` imports `ApplicationsModule`, and `DocumentsService.delete` calls `assertDocumentChange`.
- `AppModule` imports `ApplicationsModule` and `PaymentsModule`.

### Balance SQL (verified on Postgres 17)

`counted(today)` replaces slice 2's fragment. Cast `applied` and `remaining` to `::text` wherever they're returned to JS, since `numeric` comes back as a Prisma `Decimal`.

```sql
-- counted(today): the only derivation for documents (D1).
SELECT d.id, d.supplier_id, d.type, d.review_status, d.letter, d.number,
       to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
       to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
       COALESCE(d.due_date, d.issue_date) AS sort_date, d.issue_date AS issue_date_value, d.created_at,
       d.total::text AS total,
       a.applied,
       d.total - a.applied AS remaining,
       CASE WHEN d.type = 'credit_note' THEN 0.00 ELSE d.total - a.applied END AS outstanding,
       CASE WHEN d.type = 'credit_note' THEN d.total - a.applied ELSE 0.00 END AS unapplied,
       a.applied > 0 AND a.applied < d.total AS partial,
       CASE WHEN d.type = 'credit_note' THEN CASE WHEN a.applied = d.total THEN 'applied' ELSE 'available' END
            WHEN a.applied = d.total THEN 'paid'
            WHEN d.due_date < ${today}::date THEN 'overdue'
            ELSE 'pending' END AS status,
       d.due_date - ${today}::date AS days_to_due
FROM documents d
CROSS JOIN LATERAL (
  SELECT CASE WHEN d.type = 'credit_note'
              THEN (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.credit_note_id = d.id)
              ELSE (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.document_id = d.id) END AS applied
) a
WHERE d.deleted_at IS NULL AND d.review_status IN ('unreviewed', 'reviewed')
```

```sql
-- credited(): every payment that isn't deleted (D3), with what it has left to apply.
SELECT p.id, p.supplier_id, p.amount, p.paid_on, p.value_date, p.method, p.reference, p.notes,
       p.created_by, p.created_at, g.applied,
       p.amount - g.applied AS unapplied,
       CASE WHEN g.applied = p.amount THEN 'applied' ELSE 'available' END AS status
FROM payments p
CROSS JOIN LATERAL (SELECT COALESCE(SUM(x.amount), 0.00) AS applied FROM applications x WHERE x.payment_id = p.id) g
WHERE p.deleted_at IS NULL
```

```sql
-- Supplier sums. The sums are aggregated before joining, so payments don't multiply documents.
WITH counted AS (…), credited AS (…),
doc_sums AS (
  SELECT supplier_id,
         SUM(outstanding) FILTER (WHERE status = 'pending') AS not_due,
         SUM(outstanding) FILTER (WHERE status = 'overdue') AS overdue,
         SUM(outstanding) AS outstanding, SUM(unapplied) AS unapplied
  FROM counted GROUP BY supplier_id
),
payment_sums AS (SELECT supplier_id, SUM(unapplied) AS unapplied FROM credited GROUP BY supplier_id)
SELECT s.id, s.name, s.legal_name, s.cuit, s.payment_term_days, s.notes,
  COALESCE(ds.not_due, 0.00)::text AS not_due,
  COALESCE(ds.overdue, 0.00)::text AS overdue,
  (COALESCE(ds.unapplied, 0.00) + COALESCE(ps.unapplied, 0.00))::text AS credit,
  (COALESCE(ds.outstanding, 0.00) - COALESCE(ds.unapplied, 0.00) - COALESCE(ps.unapplied, 0.00))::text AS balance
FROM suppliers s
LEFT JOIN doc_sums ds ON ds.supplier_id = s.id
LEFT JOIN payment_sums ps ON ps.supplier_id = s.id
${where}
```

- *Proveedor*'s documents: `counted` filtered by supplier, `ORDER BY sort_date, issue_date_value, created_at, id`.
- `splitDocuments`: `counted` with `supplier_id = ${supplierId}::uuid AND type <> 'credit_note' AND (remaining > 0 OR id = ANY(${ids}::uuid[]))`, in the same order.
- `creditSource`: `credited` by id, or `counted` by id with `type = 'credit_note'`.
- Payment lists and the detail join `users` for `createdByName`, and `suppliers` for `supplierName`. The detail's applications join `counted` for each document's state now.

### Lint ban (`backend/eslint.config.mjs`)

`no-restricted-syntax` already carries the clock selectors, and ESLint replaces a rule's options instead of merging them. So the backend config builds the rule from both groups:

```js
const APPLICATIONS_MESSAGE = 'Only src/applications/ writes applications (invariants 2–6).';
const WRITE_SQL = String.raw`/\b(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+"?applications\b/i`;
const applicationWriteSelectors = [
  { selector: "MemberExpression[property.name='application']", message: APPLICATIONS_MESSAGE },
  { selector: "MemberExpression[property.value='application']", message: APPLICATIONS_MESSAGE },
  { selector: 'Property[key.name=/^applications(Received|Given)$/]', message: APPLICATIONS_MESSAGE },
  { selector: `TemplateElement[value.raw=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
  { selector: `Literal[value=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
];
const clockSelectors = clockBans['no-restricted-syntax'].slice(1);
const restrictedSyntax = (...groups) => ['error', ...groups.flat()];
```

- Every file gets `restrictedSyntax(clockSelectors, applicationWriteSelectors)`.
- `src/common/clock.ts` gets `restrictedSyntax(applicationWriteSelectors)`, in place of `off(clockBanRules)`.
- `src/applications/**/*.ts` and `**/*.spec.ts` get `restrictedSyntax(clockSelectors)`.
- `eslint-bans.mjs` doesn't change, so the frontend is untouched.

### Frontend

**Routes** (added to `Shell`)

| Path | Screen | Wireframe |
| --- | --- | --- |
| `/pagos` | *Pagos*. `?proveedor=<id>` filters | 7a |
| `/pagos/nuevo` | *Registrar pago*. `?proveedor=<id>` preselects | 7b, 7c, 7d, 7e |
| `/pagos/:id` | *Pago registrado* | 7f |
| `/proveedores/:id/aplicar-credito` | *Aplicar crédito* | 7h |
| `/proveedores/:id/documentos/:documentId/marcar-pagado` | *Marcar como pagado* | 7g |

The header gets *Resumen* (`/`) and *Pagos* (`/pagos`) links, after *Facturas*.

**`frontend/src/accounts-api.ts`** adds the types above and:

```ts
previewSplit(request: SplitRequest): Promise<ApiResult<Split>>                      // POST /api/applications/preview
applyCredit(input: ApplyCreditInput): Promise<ApiResult<void>>                      // POST /api/applications
createPayment(input: PaymentInput): Promise<ApiResult<{ id: string }>>              // POST /api/payments
markPaid(input: MarkPaidInput): Promise<ApiResult<{ id: string }>>                  // POST /api/payments/mark-paid
listPayments(params: { supplierId: string | null }): Promise<ApiResult<PaymentList>> // GET /api/payments, ?supplierId= only when set
getPayment(id: string): Promise<ApiResult<PaymentDetail>>                           // GET /api/payments/:id
```

`FieldErrorCode`, `DocumentStatus` and `AccountDocument` mirror the backend. `status` is never null now.

**`frontend/src/format.ts`** adds `formatAmountInput(amount)`: `"86900.50"` → `"86.900,50"`, `"0.00"` → `"0,00"`. It throws on anything that isn't canonical, like `formatMoney`. It prefills the split's inputs.

**`frontend/src/payment-filter.ts`**
- `type PaymentFilter = 'with_balance' | 'overdue' | 'pending' | 'paid'`.
- `PAYMENT_FILTER_STATUSES: Record<PaymentFilter, readonly DocumentStatus[]>`:
  - `with_balance`: `pending`, `overdue`, `available`
  - `overdue`: `overdue`
  - `pending`: `pending`
  - `paid`: `paid`, `applied`
- `matchesFilter(filter, status): boolean`.

**`frontend/src/labels.ts`** (exhaustive)

| Record | Values |
| --- | --- |
| `DOCUMENT_STATUS_LABELS` | pending *Sin vencer*, overdue *Vencido*, paid *Pagado*, available *Disponible*, applied *Aplicada* |
| `PAYMENT_METHOD_LABELS` | transfer *Transferencia*, echeq *eCheq*, cash *Efectivo*, mercado_pago *Mercado Pago*, other *Otro* |
| `PAYMENT_FILTER_LABELS` | with_balance *Con saldo*, overdue *Vencido*, pending *Sin vencer*, paid *Pagado* |
| `FIELD_ERROR_MESSAGES` | Adds the codes below |

`PAYMENT_METHODS: readonly PaymentMethod[]` gives the chip order, with *Transferencia* first.

| Code | Spanish message |
| --- | --- |
| `amount_invalid` | Ingresá un monto mayor a cero, como 120.000,00. |
| `paid_on_invalid` | Ingresá una fecha de pago válida. |
| `value_date_invalid` | Ingresá una fecha de cobro válida. |
| `application_amount_invalid` | Ingresá un monto válido, como 20.000,00, o 0 para no aplicar nada. |
| `exceeds_remaining` | Es más de lo que falta pagar de este documento. |
| `exceeds_source` | Repartiste más de lo que hay para aplicar. |
| `nothing_to_apply` | Ingresá cuánto aplicar en al menos un documento. |
| `not_applicable` | Este documento o este crédito ya no se puede usar. Volvé a abrir el reparto. |
| `remaining_changed` | Lo que falta pagar cambió mientras tanto. Volvé a abrir el documento. |
| `document_has_applications` | No se puede descartar: tiene pagos o créditos aplicados. |

**Screens** (`frontend/src/screens/`; copy from the wireframes, with this file winning where they differ)

- **The split rows**, a component shared by *Registrar pago* and *Aplicar crédito* (7c, 7d, 7e, 7h)
  - One row per `Split.rows` entry, in the order received:
    - `documentTitle`
    - when: *vencido {formatDueIn}* when overdue, *{formatDueIn}* otherwise, and *Sin vencimiento* without a due date
    - *Falta {remaining}*
    - an amount input, prefilled with `formatAmountInput(amount)`
  - What saving would do, from `after`: *→ Pagado*, or *→ quedan {after.remaining}*. Nothing when the amount is `"0.00"`.
  - Under an `exceeds_remaining` row: *Es más de lo que falta pagar de este documento ({formatMoney(remaining)}).*
  - A row that `parseAmountInput` can't read shows `application_amount_invalid` and sends no request.
  - Every change sends `previewSplit` with every row's canonical amount, and only the latest response is applied, as in *Resumen*.
  - After any edit, *Cambiaste el reparto.* with *Volver al sugerido*, which sends `applications: null`.
- **`RegistrarPago.tsx`** (7b, then 7c, 7d, 7e)
  - Step 1:
    - *Cancelar*, *Registrar pago*, *1 de 2*.
    - *Proveedor*: a select from `listSuppliers({ q: '', sort: 'name' })`, preselected from `?proveedor=`. Under it, *Debe {balance} · vencido {overdue}* from that supplier's row.
    - *Monto*, with `inputmode="decimal"`.
    - *Medio*: chips in `PAYMENT_METHODS` order, *Transferencia* preselected.
    - *Fecha de pago*: a native date input, prefilled with `SupplierList.today`.
    - *Referencia*, with the placeholder *Opcional*.
    - *Fecha de cobro*: only for *eCheq*, optional.
    - *Notas*.
    - *Siguiente: repartir*: an amount `parseAmountInput` can't read shows `amount_invalid` without a request. Otherwise it sends `previewSplit` with `new_payment` and `applications: null`. Field errors from a 400 show on step 1.
  - Step 2:
    - *← Atrás* keeps step 1's values. The title is *Repartir {amount}*, with *2 de 2*.
    - The hint *Lo repartimos desde el vencimiento más viejo. Podés cambiar cada monto.*, then the split rows.
    - Footer: *Aplicado {applied}* and *Sin aplicar {unapplied}*.
      - When `unapplied` isn't `"0.00"`: *→ {unapplied} queda como crédito a favor*.
      - When `excess` isn't `"0.00"`: *Sin aplicar* shows *−*, with *Repartiste {excess} más que el pago.*
    - No rows: *Este proveedor no tiene documentos con saldo. Todo el pago queda como crédito a favor.*
    - *Guardar pago* is disabled while a preview is pending, when the latest preview has `errors`, or when a row doesn't parse.
      - It sends `createPayment` with step 1's fields and the rows' amounts.
      - A 201 goes to `/pagos/{id}`.
      - A 409 shows the field errors, at the row or above the button, and sends the preview again.
- **`PagoRegistrado.tsx`** (7f)
  - *← {supplierName}* goes to *Proveedor*.
  - *Pago registrado*.
  - *{method} · {reference} · {paidOn} · por {createdByName}*, plus *· cobro {valueDate}* for an eCheq. Then the amount and the notes.
  - One row per application:
    - the title, *aplicado {amount}*, and the status badge
    - *Pago parcial · quedan {remaining}* when `partial`
  - *Sin aplicar {unapplied}*, then *Volver al proveedor*.
  - 404: *No encontramos este pago.*
- **`Pagos.tsx`** (7a)
  - *Pagos*, and *+ Registrar pago*, which passes `?proveedor=` when the filter is set.
  - A supplier select: *Todos los proveedores*, then `listSuppliers` by name, kept in `?proveedor=`.
  - One row per payment:
    - the supplier name and the amount
    - *{paidOn} · {method}*, plus *· {reference}* and *· cobro {valueDate}* when set
    - `createdByName`
    - *Sin aplicar {unapplied}* when the status is `available`
    - opens `/pagos/{id}`
  - Empty: *Todavía no hay pagos.* With the filter set: *Este proveedor no tiene pagos.*
  - Loading and failure as in *Resumen*.
- **`AplicarCredito.tsx`** (7h)
  - *Cancelar* goes to *Proveedor*. The title is *Aplicar crédito*, with *{supplier} · crédito disponible*.
  - The sources, from `getSupplier`: credit notes with status `available`, then payments with status `available`.
    - A credit note shows `documentTitle` and *Emitida {issueDate}*. A payment shows *Pago {method} · {paidOn}*. Both show *Disponible {remaining or unapplied}*.
    - With more than one, they're a radio list with the first preselected.
  - *Aplicar a*, then the split rows for the chosen source.
  - Footer: *Aplicado {applied}* and *Queda crédito {unapplied}*. When `excess` isn't `"0.00"`: *Aplicaste {excess} más que el crédito disponible.*
  - *Aplicar* is disabled under the same conditions as *Guardar pago*. `nothing_to_apply` is among the preview's errors when every row is zero, so that case is covered too. On success it goes to *Proveedor*.
  - Empty states:
    - no credit: *No hay crédito a favor para aplicar.*
    - no rows: *No hay documentos con saldo para aplicar el crédito.*
- **`MarcarPagado.tsx`** (7g)
  - It loads `getSupplier(id)` and finds the document.
  - If the document isn't there, or its status isn't `pending` or `overdue`: *Este documento ya no tiene saldo.* with *← {supplier}*.
  - Shows *Marcar como pagado* and *{documentTitle} · {supplier name}*.
  - *Monto (lo que falta)*: `formatMoney(remaining)`, read-only.
  - The same *Medio*, *Fecha de pago* (prefilled with `SupplierAccount.today`), *Referencia* and *Fecha de cobro* as *Registrar pago*.
  - *Marcar como pagado* sends `markPaid` with `amount: remaining` and goes back to *Proveedor*. On 409, it shows the message and reloads.
  - *¿Pagaste otro monto? Registrar pago* goes to `/pagos/nuevo?proveedor={id}`.
- **`Proveedor.tsx`** (3a), changes:
  - Actions: *Registrar pago*, which goes to `/pagos/nuevo?proveedor={id}`, and *Cargar documento*.
  - The *Crédito a favor* figure gets an *Aplicar* link to `/proveedores/{id}/aplicar-credito` when `credit` isn't `"0.00"`.
  - *Documentos ({all})*, then filter chips (`PAYMENT_FILTER_LABELS`, *Con saldo* by default).
    - Under *Con saldo*, *Ver {n} pagados* appears when some are hidden, and switches to *Pagado*.
    - A filter with no matches: *No hay documentos en este filtro.*
  - Rows:
    - The badge comes from `DOCUMENT_STATUS_LABELS` for every type.
    - *Pago parcial · quedan {remaining}* on a partial debt, and *quedan {remaining}* on a partial credit note.
    - A paid document's second line is *Vence {fecha}*, without `formatDueIn`.
    - *Marcar como pagado* on `pending` and `overdue` rows.
    - *Descartar* shows `document_has_applications` from a 409.
  - *Pagos ({n})* follows the documents:
    - Each row shows *{paidOn} · {method}* and the amount, with the reference.
    - *Sin aplicar {unapplied}* shows when the status is `available`.
    - Each row opens `/pagos/{id}`.
- **`index.css`**: styles for the chips, the split rows and their footer, the radio list, and the header links, keeping the tokens and dark mode.

The frontend may check whether an amount string is exactly `"0.00"`, and may filter by status strings. It never adds, subtracts or compares amounts, and never compares dates (D1).

## Behaviors to test

Backend tests go through HTTP, using supertest against `createTestApp()` and a real Postgres, unless an item says it inserts rows directly. Suppliers are informal, with a unique token in the name. Dates are faked before signing in. Frontend tests are Node unit tests with `fetch` stubbed.

**Suggesting and previewing a split** (`backend/src/applications/split-preview.spec.ts`)
- Acceptance 1: invoice A for 100.00 is due 2026-11-05 and invoice B for 50.00 is due 2026-11-20. A 120.00 preview suggests 100.00 for A and 20.00 for B, with `unapplied` 0.00. Afterwards, A is `paid` and B is `pending`, partial, with 30.00 left.
- Order:
  - An opening balance without a due date, issued 2026-09-30, comes before an invoice due 2026-10-15, and after one due 2026-09-29.
  - Ties go by issue date, then creation.
  - *Proveedor*'s list comes in the same order.
- The suggestion stops when the money runs out: 50.00 over A and B gives A 50.00 and B 0.00.
- Money left over: 200.00 over A and B gives `unapplied` 50.00.
- The rows leave out paid documents, credit notes, deleted documents, ones in `processing` or `error` (inserted directly), and other suppliers' documents.
- With no open documents, there are no rows and `unapplied` equals the amount.
- Edited rows:
  - The rows come back as typed, with their `after`, `applied` and `unapplied`. A row of 0 gives `after` equal to now.
  - The 7d case: 100.00 for A and 15.00 for B, out of 120.00, leaves 5.00.
- Errors come back with status 200:
  - 60.00 for B gives `exceeds_remaining` on `applications.<B>`.
  - Rows adding up to 160.00 out of 120.00 give `exceeds_source`, with `excess` 40.00 and `unapplied` 0.00.
- Each of these comes back as `not_applicable` on its row: another supplier's invoice, a credit note, a deleted document, and a document in `error`.
- The preview writes nothing: no payment, no application, no audit entry.
- These are refused with 400 and no field errors:
  - an unknown `supplierId`
  - a source with an extra key
  - repeated document ids
  - a non-UUID document id
- An amount of `"0"` gives `amount_invalid`. A row of `"-1.00"` gives `application_amount_invalid`.

**Saving a payment** (`backend/src/payments/payments.spec.ts`)
- Preview equals save: for the same rows, the save writes exactly the preview's rows above zero, the payment's `unapplied` equals the preview's, and the account shows each document with the preview's `after`. Run it for the suggestion and for an edited split.
- Acceptance 2: a payment of 80.00 that applies nothing.
  - *Crédito* goes up by 80.00 and *Total* down by 80.00, in the account and in *Resumen*.
  - The payment is `available`.
  - Its audit entry has `after->>'amount'` = `'80.00'`, by Ana.
- Acceptance 3: after acceptance 1, a payment applying 40.00 to B is refused with 409 `exceeds_remaining`. No payment, no application and no audit entry exist for it.
- Invariants 4 and 5: a row for another supplier's invoice, or for a credit note, gets 409 `not_applicable`, and nothing is written.
- Concurrency: an invoice of 100.00 and two payments sent at once, each applying 60.00.
  - Exactly one gets 201 and the other gets 409 `exceeds_remaining`.
  - The invoice has 60.00 applied, and only one payment exists.
  - Repeat five times, on fresh invoices.
- Audit: a split over two documents writes three `create` entries (`payments` and twice `applications`), each by Ana. A row of 0 writes no application and no entry.
- Acceptance 7: an eCheq keeps its `reference` and `valueDate`, read back from `GET /api/payments/:id`.
- `valueDate` on a transfer is refused with 400 and no field errors.
- These are refused with their codes:
  - `paidOn` of `"2026-02-30"` gives `paid_on_invalid`
  - `valueDate` of `"2026-13-01"` gives `value_date_invalid`
  - amounts of `"0"`, `"-5.00"`, `"1,50"`, `""` and `"1000000000000.00"` give `amount_invalid`
- These are malformed: a missing key, an unknown method, and `applications: null` on a save.
- `GET /api/payments`:
  - Newest `paidOn` first. Filtering by `supplierId` returns only that supplier's payments, with `unapplied`, `status` and `createdByName`.
  - A non-UUID or repeated `supplierId` gives 400, and an unknown one gives an empty list.
- `GET /api/payments/:id` lists the applications, with each document's status now. An unknown or non-UUID id gives 404.

**Applying existing credit** (`backend/src/applications/apply-credit.spec.ts`)
- Acceptance 5: a credit note of 30.00 applied to B (30.00 left). B becomes `paid` and the note becomes `applied`, with `remaining` 0.00.
- Acceptance 8: applying 50.00 of the 80.00 payment from acceptance 2 to a new invoice. The payment stays `available` with 30.00 unapplied, and *Crédito* is 30.00 from that payment.
- A partly applied credit note: 50.00 with 20.00 applied is `available`, `partial`, with 30.00 left, and *Crédito* counts 30.00.
- The suggestion uses what the source has left: the 30.00 left of that note suggests 30.00, not 50.00.
- Applying more than the source has left gives 409 `exceeds_source`, and nothing is written.
- All rows at zero give 409 `nothing_to_apply`.
- Each of these sources gives 409 `not_applicable` on `source`:
  - a deleted payment, inserted directly without applications
  - a credit note in `error`
  - a deleted credit note
  - an invoice id sent as `credit_note`
  - an unknown id
- Concurrency: a credit note of 50.00 and two applies sent at once, each giving 40.00 to a different invoice. Exactly one succeeds, and the note has 40.00 applied. Repeat five times.

***Marcar como pagado*** (`backend/src/payments/mark-paid.spec.ts`)
- Acceptance 6: on a new invoice of 64,380.00, `amount` 64380.00 gives 201. The invoice is `paid`, with exactly one payment and one application, both audited.
- On B, with 30.00 left, `amount` 50.00 gives 409 `remaining_changed`, and nothing is written.
- Already paid gives 409 `remaining_changed`.
- `not_applicable` comes back for each of these:
  - a credit note
  - a deleted document
  - a document in `error`
  - an unknown id

**Invariant 6** (`documents.spec.ts` through HTTP, the rest in `backend/src/applications/`)
- Acceptance 4, delete half: deleting A gives 409 `document_has_applications`. A still counts, and no audit entry is written.
- Deleting a credit note that gave credit gives the same 409. Deleting a document without applications still works.
- `assertDocumentChange`, called through the Nest testing module inside a transaction (the edit half of acceptance 4):
  - These are refused with `document_has_applications`:
    - for a document that received applications: deleting it, changing its supplier or type, lowering its total from 100.00 to 90.00 when 100.00 is applied, and moving it to `error`
    - for a credit note that gave 20.00: deleting it, changing its supplier, and lowering its total below 20.00
  - These are accepted: a total equal to what's applied, and any change to a document without applications.

**Database** (`backend/src/applications/applications-table.spec.ts`; rows inserted directly)
- `CHECK`s refuse:
  - an application of 0
  - one with both sources
  - one with no source
  - a payment of 0
  - a value date on a transfer
- An eCheq with a value date is accepted.
- The documents trigger, with the error matched by `documents_keep_applied`:
  - For a document that received applications, it refuses: soft delete, a supplier change, a type change, a total below what's applied, and moving to `error` or `processing`.
  - For that document, it accepts: a total equal to what's applied, a notes change, and `reviewed` to `unreviewed` (with `reviewed_*` cleared).
  - For a credit note that gave credit, it refuses: soft delete, a supplier change, a total below what it gave, and moving to `error`.
  - A document without applications accepts all of these.
- The payments trigger, matched by `payments_keep_applied`: it refuses a soft delete, a supplier change and an amount below what it gave. It accepts an amount equal to what it gave, and a notes change.
- A hard `DELETE` of a document, a credit note or a payment that has applications fails on its foreign key.

**Balances** (`balances.spec.ts`; rows inserted directly, which the spec exemption allows)
- An invoice of 100.00 with 40.00 applied: `pending`, `remaining` 60.00, `partial`, and *Sin vencer* 60.00.
- A fully applied invoice due yesterday is `paid` and adds nothing to *Vencido*.
- An unapplied payment and a partly applied credit note both add to *Crédito*. *Total* is *Sin vencer* + *Vencido* − *Crédito*, and the totals row is still the sum of the rows.
- A deleted payment counts nowhere and isn't listed (D3).
- Documents come by `COALESCE(due_date, issue_date)`, then issue date, then creation. Credit notes sort by their issue date.
- `today` is the Buenos Aires date: at `2026-11-10T02:59:59Z` it's `2026-11-09`.
- The account's `payments` come newest first.

**Rollback** (`audit-rollback.spec.ts`, with the existing failing `AuditService`)
- Each of these returns 500 and leaves nothing behind:
  - saving a payment with a split: no payment and no application
  - applying credit: no application
  - *Marcar como pagado*: no payment and no application

**Units**
- `split.ts`:
  - `suggest` in order, stopping when the money runs out, with what's left over.
  - `evaluate` with exact sums, a row that exceeds, a total that exceeds, and all zeros.
- `projectAfter`: paid at zero, the status kept otherwise, `partial` both ways.
- `Money`: `subtract` stays exact at 12 digits, and `isZero` is true for `0.00` and false for `0.01` and `-0.01`.

**Lint** (`test/lint-bans.spec.ts`)
- These are errors in `src/main.ts`:
  - `tx.application.create(…)` and `tx['application']`
  - a nested `applicationsReceived` write
  - raw `INSERT INTO applications`, `insert into "applications"`, `UPDATE applications` and `DELETE FROM applications`
- These are allowed in `src/main.ts`: `SELECT … FROM applications`, and `{ applications: rows }`.
- `tx.application.create(…)` is allowed in `src/applications/applications.service.ts` and in a spec file. It's an error in `src/common/clock.ts`.
- `new Date()` is still an error in `src/applications/applications.service.ts`, and still allowed in `clock.ts`.

**Routes** (`test/routes.spec.ts`): the listing includes the six new routes, and they answer 401 without a session.

**Frontend**
- `accounts-api.spec.ts`:
  - each new function calls the right URL, method and body
  - `listPayments` leaves out a null `supplierId`
  - the same status mapping as slice 2
- `format.spec.ts`: `formatAmountInput` on the examples above, and a throw on `"1.5"`.
- `payment-filter.spec.ts`: each filter matches exactly its statuses. *Con saldo* includes `available` and *Pagado* includes `applied`.

## Steps

One commit per step. Backend steps need `docker compose up -d db`, and after a schema change, `npx prisma generate`. "Verify" lists what proves the step is done.

1. **Record the answers**
   - `system-design.md`:
     - Rewrite invariant 6: *While a document has applications, received or given, it can't be deleted, can't change supplier or type, can't leave `unreviewed` or `reviewed`, and its `total` can't drop below what was applied. A payment with applications can't be deleted or change supplier, and its `amount` can't drop below what it gave. A database trigger enforces both.*
     - In *Screens*, under *Pagos*: *A document without a due date, which only an opening balance can be, takes its issue date's place in that order.*
     - Under *Proveedor*: *Documents are listed in the same order as the suggestion.*
   - `plans/mvp-slices.md`:
     - Question 3: add *Answered: invariant 6 protects both sides of an application* with the rule above. Leave editing and deleting payments and removing applications open.
     - Question 13: answer the second bullet with the `COALESCE` rule and its reason.
     - Slice 3: the rule becomes *Deleting a document enforces invariant 6, and a trigger on `documents` and `payments` refuses any change that breaks it. Editing arrives in slice 6.* Acceptance 4 becomes *Deleting A is rejected. Changing its supplier or lowering its total to 90 is rejected by the database, and slice 6 tries it from the screen.*
     - Slice 6: add acceptance 7: *On a document with applications, changing the supplier or lowering the total below what's applied is rejected.*
   - Verify: backend `npm run lint` passes, since `check:cuits` scans the docs too.
2. **Common helpers**
   - Add `Money.subtract` and `isZero`, and the new `FieldErrorCode`s, with their tests.
   - Verify: backend `npm test`, `npm run lint` and `npm run typecheck` pass.
3. **Tables, migration and triggers**
   - Add the enum, the two models and the back-relations.
   - Run `npx prisma migrate dev --name payments_applications --create-only`, append the hand-written block, run `npx prisma migrate dev`, then `npx prisma generate`.
   - Add `AuditEntity` `payments` and `applications`.
   - Add `backend/src/applications/applications-table.spec.ts`.
   - Verify:
     - All three checks pass.
     - `\d payments` shows two `CHECK`s and the trigger. `\d applications` shows two `CHECK`s and three indexes. `\d documents` lists `documents_keep_applied`.
     - Run `npx prisma migrate dev --create-only --name probe`. It generates nothing, and in particular no `DROP`. Delete the probe migration.
4. **Split math and the lint ban**
   - Add `backend/src/applications/split.ts`, `backend/src/balances/project.ts` and their unit tests.
   - Add the ban to `backend/eslint.config.mjs`, and its cases to `test/lint-bans.spec.ts`.
   - Verify: all three checks pass, and the lint cases fail if the ban is removed.
5. **The balance derivation**
   - Change `counted` and `supplierSums`, and add `credited`.
   - Add `today`, the new document fields and order, and the account's `payments`.
   - Add `splitDocuments`, `creditSource` and `documentApplied`.
   - Update the existing balances tests for `status` and order, and add *Balances*.
   - Verify: all three checks pass. Resumen's numbers in the existing tests don't change for suppliers without payments.
6. **Previews and payments**
   - Add `ApplicationsModule` (`preview`, `applyNewPayment`) with `POST /api/applications/preview`.
   - Add `PaymentsModule` with `POST /api/payments`.
   - Add *Suggesting and previewing a split*, *Saving a payment* (without the two `GET`s), and the payment case of *Rollback*.
   - Verify:
     - All three checks pass.
     - The concurrency test passes five runs in a row (`npx vitest run src/payments` five times).
7. **Existing credit and *Marcar como pagado***
   - Add `applyCredit` with `POST /api/applications`, and `lockToSettle` with `POST /api/payments/mark-paid`.
   - Add *Applying existing credit*, *Marcar como pagado* and their *Rollback* cases.
   - Verify: all three checks pass.
8. **Payment reads, invariant 6 on delete, and routes**
   - Add `GET /api/payments` and `GET /api/payments/:id` with their tests.
   - Add `assertDocumentChange`, call it from `DocumentsService.delete`, and add *Invariant 6*.
   - Add the six routes to `routes.spec.ts`.
   - Verify:
     - All three checks pass.
     - With `start:dev`, sign in with `curl`, record a payment, and read `/api/payments`, `/api/payments/<id>` and `/api/suppliers/<id>`.
9. **Frontend foundations**
   - Add the new API functions and types, `formatAmountInput`, `payment-filter.ts`, the labels, and their tests.
   - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
10. **Screens**
    - Add the five screens, the shared split rows, the *Proveedor* changes, the header links, the routes and the CSS.
    - Verify:
      - The frontend checks pass.
      - With both apps in dev mode, go through the manual acceptance below at 390 px wide, in light and dark mode.
11. **Docs**
    - `agents.md`, under *Where things live*:
      - `backend/src/applications/` is the only writer of `applications` (invariants 2–6). It locks sources before documents, by id, and reads what's left through `BalancesService`.
      - `backend/src/payments/`.
    - `agents.md`, under *Rules that are easy to miss*:
      - Write paths never pass `isolationLevel`: under `REPEATABLE READ`, a sum read after a lock misses a concurrent application.
      - A trigger refuses changes to documents and payments that have applications. A 500 with `documents_keep_applied` means a service check is missing.
      - Specs may write `applications` directly. Production code outside `src/applications/` can't.
    - `codingStandards.md`: delete the *Writing `applications` outside its service* row, since a check exists now.
    - Verify: all checks pass in both apps.

**Manual acceptance at the end** (from the spec, with invented data; start from slice 2's data for a supplier with a 30-day term)
1. Enter invoice A for 100,00, due first, and invoice B for 50,00, due later.
   - *Registrar pago* of 120,00 by *Transferencia* suggests 100,00 for A and 20,00 for B.
   - Save it. *Pago registrado* shows A *Pagado* and B *Pago parcial · quedan $ 30,00*.
   - *Proveedor* agrees.
2. Record a payment of 80,00 and set both rows to 0. *Total* drops by 80,00, and *Crédito a favor* shows it.
3. Start a new payment and type 40,00 for B. The row shows the error, and *Guardar pago* stays disabled.
4. *Descartar* on A shows *No se puede descartar: tiene pagos o créditos aplicados.* In `psql`, as the trigger's backstop, both of these fail with `documents_keep_applied`:
   - `UPDATE documents SET total = 90 WHERE id = '<A>'`
   - `UPDATE documents SET supplier_id = '<other>' WHERE id = '<A>'`
5. Enter a credit note of 30,00. From *Crédito a favor*, choose it and apply 30,00 to B. B is *Pagado* and the note is *Aplicada*.
6. Enter a new invoice and use *Marcar como pagado* on it. It's *Pagado*, and in `psql` it has one payment and one application.
7. Record an eCheq with a reference and a *Fecha de cobro*. *Pagos* and *Pago registrado* show both.
8. From *Crédito a favor*, choose step 2's payment and apply 50,00 of it to a new invoice. 30,00 stays as credit.
9. *Pagos*, filtered by the supplier, lists the payments, newest first, with *Sin aplicar* where it applies. *Proveedor*'s *Pagado* filter shows A, B and the note.

## Doors

| Part | Door | Note |
| --- | --- | --- |
| Tables, enum and migration | Two-way | New tables on an empty database. No real data exists until slice 8, and `prisma migrate reset` undoes them in development. |
| `documents_keep_applied` and `payments_keep_applied` triggers | Two-way now | They only refuse writes and never change data. A later migration can drop or replace them. They'll also guard slice 5's worker and slice 6's edit, which is the point. |
| `CHECK`s on `payments` and `applications` | Two-way | Constraints on empty tables. |
| `ApplicationsService`: locks, invariants 2–5 and the split | Two-way now, **one-way in effect once slice 8 stores real money** | See below. |
| Balance SQL, statuses, *Proveedor*'s new order | Two-way | Derived, never stored, so a fix only changes what's shown. |
| `audit_log` entries for payments and applications | Two-way now | A missing entry can't be recreated later, but no real change exists yet. |
| Lint ban | Two-way | Tooling only. |
| The six new endpoints and the changed `DELETE` | Two-way | Behind the existing `SessionGuard`, with no new `@Public()`. `routes.spec.ts` lists them and checks the 401. |
| Frontend screens and copy | Two-way | The backend enforces every rule. |

Nothing in this slice is on the [one-way list](../one-way-doors.md): there are no hard deletes, no bulk changes to stored amounts or applications, and no changes to authentication. Payment status is derived, which the list calls a two-way door.

**Blast radius of the application write path**
- **Today**: none. Only test and developer data exist.
- **From slice 8**: an application can't be removed or changed through the app (question 3), and the trigger keeps its document and source in place. So a wrong application written to real data stays until someone fixes it by hand in SQL, with the audit log as the only record of what it was.
  - **Over-application** (a bug in invariants 2 or 3) understates the debt, and nothing flags it. This is the dangerous one.
  - **A false refusal** blocks a real payment. The person sees the message, and the payment can still be recorded as credit.

**How the plan shrinks it**
- One function evaluates the preview and the save, and a test proves they write the same rows and leave the same leftover.
- Locks come in a fixed order, and sums are read after the locks under `read committed`. The probe showed `REPEATABLE READ` would over-apply. The concurrency tests cover payments and credit notes.
- The lint ban means no code outside `src/applications/` writes `applications`.
- The database backs up the rules it can check row by row: `amount > 0`, exactly one source, the `RESTRICT` foreign keys, and invariant 6 on both sides.
- Every application is audited with its user, in the same transaction.

**Known limits**
- Invariants 2–5 aren't enforced by the database, as the spec chose. A raw `INSERT` from `psql` can break them.
- *Pagos* and *Proveedor*'s payments aren't paginated.
- A mistyped payment can't be corrected until question 3 is answered.

**Look closely at**
- No write transaction passes `isolationLevel`, and every sum is read after the `FOR UPDATE`, in a new statement.
- The lock order: the source first, then documents in one `ORDER BY id FOR UPDATE`.
- The trigger function: the `IS DISTINCT FROM` comparisons, the `review_status` list, and `NEW.total IS NULL`.
- That `counted` takes `applied` from `credit_note_id` for credit notes and from `document_id` for everything else, and that `credited` filters `deleted_at` (D3).
- That `projectAfter` agrees with the SQL's `paid` rule.
- That every write to `payments` and `applications` calls `AuditService.record` inside its transaction (D2).
