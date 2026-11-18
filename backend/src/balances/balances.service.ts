import { Injectable } from '@nestjs/common';
import { today } from '../common/clock.js';
import { Money } from '../common/money.js';
import { isUuid } from '../common/uuid.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AccountDocument,
  CreditSourceRef,
  CreditStatus,
  DebtStatus,
  DocumentApplied,
  PaymentSummary,
  ReceivingType,
  SplitDocument,
  SupplierAccount,
  SupplierFigures,
  SupplierList,
  SupplierListRow,
  SupplierSort,
} from './balances.types.js';

interface SupplierSumsRow {
  id: string;
  name: string;
  legal_name: string | null;
  cuit: string | null;
  payment_term_days: number | null;
  notes: string | null;
  not_due: string;
  overdue: string;
  credit: string;
  balance: string;
}

interface CountedRow {
  id: string;
  type: AccountDocument['type'];
  review_status: AccountDocument['reviewStatus'];
  letter: string | null;
  number: string | null;
  issue_date: string;
  due_date: string | null;
  total: string;
  applied: string;
  remaining: string;
  partial: boolean;
  status: AccountDocument['status'];
  days_to_due: number | null;
}

interface PaymentRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  amount: string;
  paid_on: string;
  value_date: string | null;
  method: PaymentSummary['method'];
  reference: string | null;
  notes: string | null;
  created_by_name: string;
  applied: string;
  unapplied: string;
  status: CreditStatus;
}

const collator = new Intl.Collator('es', { sensitivity: 'base' });

/** Lower case without accents, so `panaderia ñandu` finds `Panadería ÑANDÚ`. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Re-reads a figure through `Money`, which also refuses one above `numeric(14,2)`. */
const money = (amount: string) => Money.fromString(amount);

function figures(row: SupplierSumsRow): SupplierFigures {
  return {
    notDue: money(row.not_due).toString(),
    overdue: money(row.overdue).toString(),
    credit: money(row.credit).toString(),
    balance: money(row.balance).toString(),
  };
}

function byName(a: SupplierListRow, b: SupplierListRow): number {
  return (
    collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const SORTS: Record<
  SupplierSort,
  (a: SupplierListRow, b: SupplierListRow) => number
> = {
  overdue: (a, b) => money(b.overdue).compare(money(a.overdue)) || byName(a, b),
  total: (a, b) => money(b.balance).compare(money(a.balance)) || byName(a, b),
  name: byName,
};

/** Split order, also *Proveedor*'s: an undated document takes its issue date's place. */
const SPLIT_ORDER = Prisma.sql`sort_date, issue_date_value, created_at, id`;

/** Newest paid first. */
const PAYMENT_ORDER = Prisma.sql`paid_on_value DESC, created_at DESC, id DESC`;

function toPaymentSummary(row: PaymentRow): PaymentSummary {
  return {
    id: row.id,
    amount: money(row.amount).toString(),
    paidOn: row.paid_on,
    valueDate: row.value_date,
    method: row.method,
    reference: row.reference,
    createdByName: row.created_by_name,
    unapplied: money(row.unapplied).toString(),
    status: row.status,
  };
}

/**
 * The only place that derives document status, what documents and payments
 * have applied and left, and supplier balances (D1). *Resumen*, *Proveedor*,
 * *Pagos* and `ApplicationsService` all read it.
 */
@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async listSuppliers(params: {
    q: string;
    sort: SupplierSort;
  }): Promise<SupplierList> {
    const date = today();
    const rows = await this.prisma.$queryRaw<SupplierSumsRow[]>(
      this.supplierSums(date, Prisma.empty),
    );
    const query = fold(params.q.trim());
    const suppliers = rows
      .filter(
        (row) =>
          query === '' ||
          fold(row.name).includes(query) ||
          (row.legal_name !== null && fold(row.legal_name).includes(query)),
      )
      .map((row): SupplierListRow => ({
        id: row.id,
        name: row.name,
        legalName: row.legal_name,
        paymentTermDays: row.payment_term_days,
        ...figures(row),
      }))
      .sort(SORTS[params.sort]);

    const zero = money('0.00');
    const sum = (key: keyof SupplierFigures) =>
      suppliers
        .reduce((total, row) => total.add(money(row[key])), zero)
        .toString();
    return {
      suppliers,
      totals: {
        notDue: sum('notDue'),
        overdue: sum('overdue'),
        credit: sum('credit'),
        balance: sum('balance'),
      },
      today: date,
    };
  }

  /**
   * Null for an unknown id, or one that isn't a UUID. The three reads share
   * one snapshot, so a write landing between them can't leave the four
   * figures disagreeing with the lists. It only reads, so `RepeatableRead`
   * is safe here, unlike on a write path.
   */
  async supplierAccount(id: string): Promise<SupplierAccount | null> {
    if (!isUuid(id)) return null;
    const date = today();
    const [[row], documents, payments] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<SupplierSumsRow[]>(
          this.supplierSums(date, Prisma.sql`WHERE s.id = ${id}::uuid`),
        ),
        this.prisma.$queryRaw<CountedRow[]>(
          this.countedRows(
            date,
            Prisma.sql`supplier_id = ${id}::uuid`,
            SPLIT_ORDER,
          ),
        ),
        this.prisma.$queryRaw<PaymentRow[]>(
          this.paymentRows(Prisma.sql`c.supplier_id = ${id}::uuid`),
        ),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      legalName: row.legal_name,
      cuit: row.cuit,
      paymentTermDays: row.payment_term_days,
      notes: row.notes,
      ...figures(row),
      today: date,
      documents: documents.map((doc) => ({
        id: doc.id,
        type: doc.type,
        letter: doc.letter,
        number: doc.number,
        issueDate: doc.issue_date,
        dueDate: doc.due_date,
        total: money(doc.total).toString(),
        reviewStatus: doc.review_status,
        status: doc.status,
        remaining: money(doc.remaining).toString(),
        partial: doc.partial,
        daysToDue: doc.days_to_due,
      })),
      payments: payments.map(toPaymentSummary),
    };
  }

  /**
   * The rows a split over `supplierId`'s documents shows: its counted debts
   * with something left, plus any of `documentIds` that are counted debts of
   * that supplier with nothing left. In split order. Call it with the
   * caller's transaction, after its locks.
   */
  async splitDocuments(
    tx: Prisma.TransactionClient,
    supplierId: string,
    documentIds: string[],
  ): Promise<SplitDocument[]> {
    const rows = await tx.$queryRaw<CountedRow[]>(
      this.countedRows(
        today(),
        Prisma.sql`supplier_id = ${supplierId}::uuid AND type <> 'credit_note'
          AND (remaining > 0 OR id = ANY(${documentIds}::uuid[]))`,
        SPLIT_ORDER,
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type as ReceivingType,
      letter: row.letter,
      number: row.number,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      daysToDue: row.days_to_due,
      status: row.status as DebtStatus,
      remaining: money(row.remaining),
      applied: money(row.applied),
    }));
  }

  /**
   * What a payment or credit note has left to give, and whose it is. Null
   * when it can't give: unknown, a deleted payment, or not a counted credit
   * note. Call it with the caller's transaction, after its locks.
   */
  async creditSource(
    tx: Prisma.TransactionClient,
    source: CreditSourceRef,
  ): Promise<{ supplierId: string; unapplied: Money } | null> {
    if (!isUuid(source.id)) return null;
    const rows =
      source.kind === 'payment'
        ? await tx.$queryRaw<{ supplier_id: string; unapplied: string }[]>`
            WITH credited AS (${this.credited()})
            SELECT supplier_id, unapplied::text AS unapplied
            FROM credited WHERE id = ${source.id}::uuid`
        : await tx.$queryRaw<{ supplier_id: string; unapplied: string }[]>`
            WITH counted AS (${this.counted(today())})
            SELECT supplier_id, unapplied::text AS unapplied
            FROM counted WHERE id = ${source.id}::uuid AND type = 'credit_note'`;
    if (rows.length === 0) return null;
    return {
      supplierId: rows[0].supplier_id,
      unapplied: money(rows[0].unapplied),
    };
  }

  /**
   * A document that isn't deleted, with what it received and what it gave,
   * for invariant 6. Null when there's no such document.
   */
  async documentApplied(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<DocumentApplied | null> {
    const rows = await tx.$queryRaw<
      {
        supplier_id: string | null;
        type: DocumentApplied['type'];
        total: string | null;
        review_status: DocumentApplied['reviewStatus'];
        received: string;
        given: string;
      }[]
    >`
      SELECT d.supplier_id, d.type, d.total::text AS total, d.review_status,
        (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.document_id = d.id)::text AS received,
        (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.credit_note_id = d.id)::text AS given
      FROM documents d
      WHERE d.id = ${id}::uuid AND d.deleted_at IS NULL`;
    if (rows.length === 0) return null;
    const [row] = rows;
    return {
      supplierId: row.supplier_id,
      type: row.type,
      total: row.total === null ? null : money(row.total),
      reviewStatus: row.review_status,
      received: money(row.received),
      given: money(row.given),
    };
  }

  /**
   * counted(today): the only derivation for documents (D1). Counted
   * documents are those not deleted and in `unreviewed` or `reviewed` (D3).
   * A credit note's `applied` is what it gave, anything else's is what it
   * received. `today` is a parameter, never `CURRENT_DATE`, which depends on
   * the session time zone. `projectAfter` in `project.ts` repeats the `paid`
   * rule of the status `CASE`.
   */
  private counted(date: string): Prisma.Sql {
    return Prisma.sql`
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
                  WHEN d.due_date < ${date}::date THEN 'overdue'
                  ELSE 'pending' END AS status,
             d.due_date - ${date}::date AS days_to_due
      FROM documents d
      CROSS JOIN LATERAL (
        SELECT CASE WHEN d.type = 'credit_note'
                    THEN (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.credit_note_id = d.id)
                    ELSE (SELECT COALESCE(SUM(x.amount), 0.00) FROM applications x WHERE x.document_id = d.id) END AS applied
      ) a
      WHERE d.deleted_at IS NULL AND d.review_status IN ('unreviewed', 'reviewed')`;
  }

  /** credited(): every payment that isn't deleted (D3), with what it has left to apply. */
  private credited(): Prisma.Sql {
    return Prisma.sql`
      SELECT p.id, p.supplier_id, p.amount, p.paid_on, p.value_date, p.method, p.reference, p.notes,
             p.created_by, p.created_at, g.applied,
             p.amount - g.applied AS unapplied,
             CASE WHEN g.applied = p.amount THEN 'applied' ELSE 'available' END AS status
      FROM payments p
      CROSS JOIN LATERAL (SELECT COALESCE(SUM(x.amount), 0.00) AS applied FROM applications x WHERE x.payment_id = p.id) g
      WHERE p.deleted_at IS NULL`;
  }

  /** `counted` rows kept by `where`, in `order`, with amounts as text. */
  private countedRows(
    date: string,
    where: Prisma.Sql,
    order: Prisma.Sql,
  ): Prisma.Sql {
    return Prisma.sql`
      WITH counted AS (${this.counted(date)})
      SELECT id, type, review_status, letter, number, issue_date, due_date, total,
             applied::text AS applied, remaining::text AS remaining, partial, status, days_to_due
      FROM counted
      WHERE ${where}
      ORDER BY ${order}`;
  }

  /** Payments kept by `where` (on `credited c`), newest paid first, with their supplier and author. */
  private paymentRows(where: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      WITH credited AS (${this.credited()})
      SELECT c.id, c.supplier_id, s.name AS supplier_name, c.amount::text AS amount,
             to_char(c.paid_on, 'YYYY-MM-DD') AS paid_on, c.paid_on AS paid_on_value,
             to_char(c.value_date, 'YYYY-MM-DD') AS value_date,
             c.method, c.reference, c.notes, u.name AS created_by_name, c.created_at,
             c.applied::text AS applied, c.unapplied::text AS unapplied, c.status
      FROM credited c
      JOIN users u ON u.id = c.created_by
      JOIN suppliers s ON s.id = c.supplier_id
      WHERE ${where}
      ORDER BY ${PAYMENT_ORDER}`;
  }

  /**
   * The four sums of every supplier, or of those `where` keeps. The sums are
   * aggregated before joining, so payments don't multiply documents.
   */
  private supplierSums(date: string, where: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      WITH counted AS (${this.counted(date)}), credited AS (${this.credited()}),
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
      ${where}`;
  }
}
