import { Injectable } from '@nestjs/common';
import { today } from '../common/clock.js';
import { Money } from '../common/money.js';
import { isUuid } from '../common/uuid.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AccountDocument,
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
  status: AccountDocument['status'];
  days_to_due: number | null;
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

/**
 * The only place that derives document status and supplier balances (D1).
 * Both screens read it. Slice 3 changes `outstanding` and `unapplied` in
 * `counted` and nowhere else.
 */
@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async listSuppliers(params: {
    q: string;
    sort: SupplierSort;
  }): Promise<SupplierList> {
    const rows = await this.prisma.$queryRaw<SupplierSumsRow[]>(
      this.supplierSums(today(), Prisma.empty),
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
    };
  }

  /**
   * Null for an unknown id, or one that isn't a UUID. Both reads share one
   * snapshot, so a write landing between them can't leave the four figures
   * disagreeing with the list.
   */
  async supplierAccount(id: string): Promise<SupplierAccount | null> {
    if (!isUuid(id)) return null;
    const date = today();
    const [[row], documents] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<SupplierSumsRow[]>(
          this.supplierSums(date, Prisma.sql`WHERE s.id = ${id}::uuid`),
        ),
        this.prisma.$queryRaw<CountedRow[]>`
          WITH counted AS (${this.counted(date)})
          SELECT id, type, review_status, letter, number, issue_date, due_date, total, status, days_to_due
          FROM counted
          WHERE supplier_id = ${id}::uuid
          ORDER BY due_date_value ASC NULLS LAST, issue_date_value, created_at, id`,
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
        daysToDue: doc.days_to_due,
      })),
    };
  }

  /**
   * counted(today): the only derivation. Counted documents are those not
   * deleted and in `unreviewed` or `reviewed` (D3). `today` is a parameter,
   * never `CURRENT_DATE`, which depends on the session time zone.
   */
  private counted(date: string): Prisma.Sql {
    return Prisma.sql`
      SELECT d.id, d.supplier_id, d.type, d.review_status, d.letter, d.number,
             to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
             to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
             d.due_date AS due_date_value, d.issue_date AS issue_date_value, d.created_at,
             d.total::text AS total,
             CASE WHEN d.type = 'credit_note' THEN 0.00 ELSE d.total END AS outstanding,
             CASE WHEN d.type = 'credit_note' THEN d.total ELSE 0.00 END AS unapplied,
             CASE WHEN d.type = 'credit_note' THEN NULL
                  WHEN d.due_date < ${date}::date THEN 'overdue'
                  ELSE 'pending' END AS status,
             d.due_date - ${date}::date AS days_to_due
      FROM documents d
      WHERE d.deleted_at IS NULL AND d.review_status IN ('unreviewed', 'reviewed')`;
  }

  /** The four sums of every supplier, or of those `where` keeps. */
  private supplierSums(date: string, where: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      WITH counted AS (${this.counted(date)})
      SELECT s.id, s.name, s.legal_name, s.cuit, s.payment_term_days, s.notes,
        COALESCE(SUM(c.outstanding) FILTER (WHERE c.status = 'pending'), 0.00)::text AS not_due,
        COALESCE(SUM(c.outstanding) FILTER (WHERE c.status = 'overdue'), 0.00)::text AS overdue,
        COALESCE(SUM(c.unapplied), 0.00)::text AS credit,
        (COALESCE(SUM(c.outstanding), 0.00) - COALESCE(SUM(c.unapplied), 0.00))::text AS balance
      FROM suppliers s LEFT JOIN counted c ON c.supplier_id = s.id
      ${where}
      GROUP BY s.id`;
  }
}
