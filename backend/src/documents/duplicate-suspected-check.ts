import { Injectable } from '@nestjs/common';
import { Money } from '../common/money.js';
import { Prisma } from '../generated/prisma/client.js';

export interface SuspectedDuplicateQuery {
  /** Exclude this document id when checking an existing document; null on manual create. */
  documentId: string | null;
  supplierId: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  /** Canonical decimal string, e.g. "50000.00". */
  total: string;
  /** Whether the subject document has a non-null `number_normalized`. */
  hasNumber: boolean;
}

export interface SuspectedDuplicateRef {
  id: string;
  type: 'invoice' | 'delivery_note' | 'credit_note';
  letter: string | null;
  number: string | null;
  issueDate: string;
  total: string;
}

interface SuspectedDuplicateRow {
  id: string;
  type: 'invoice' | 'delivery_note' | 'credit_note';
  letter: string | null;
  number: string | null;
  issue_date: string;
  total: string;
}

/**
 * Rule 3 of `system-design.md` Duplicates: another non-deleted counted document
 * (`review_status IN ('unreviewed', 'reviewed')`, `type <> 'opening_balance'`)
 * with the same supplier, `issue_date`, and `total`, where at least one of the
 * two documents has `number_normalized IS NULL`.
 *
 * Shared by both `DuplicateSuspectedCheck` and `BalancesService.errorDocuments`
 * so the matching predicate exists in one place.
 */
export async function findSuspectedDuplicate(
  tx: Prisma.TransactionClient,
  query: SuspectedDuplicateQuery,
): Promise<SuspectedDuplicateRef | null> {
  const idFilter =
    query.documentId === null
      ? Prisma.empty
      : Prisma.sql`AND id <> ${query.documentId}::uuid`;
  const numberFilter = query.hasNumber
    ? Prisma.sql`AND number_normalized IS NULL`
    : Prisma.empty;

  const [row] = await tx.$queryRaw<SuspectedDuplicateRow[]>`
    SELECT id, type, letter, number,
           to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
           total::text AS total
    FROM documents
    WHERE deleted_at IS NULL
      AND review_status IN ('unreviewed', 'reviewed')
      AND type <> 'opening_balance'
      AND supplier_id = ${query.supplierId}::uuid
      AND issue_date = ${query.issueDate}::date
      AND total = ${query.total}::numeric(14,2)
      ${idFilter}
      ${numberFilter}
    ORDER BY created_at ASC, id ASC
    LIMIT 1`;

  if (row === undefined) return null;
  return {
    id: row.id,
    type: row.type,
    letter: row.letter,
    number: row.number,
    issueDate: row.issue_date,
    total: Money.fromString(row.total).toString(),
  };
}

/**
 * Injectable wrapper around `findSuspectedDuplicate`, exported by
 * `DocumentsModule` for `ExtractionModule`, `SuppliersModule`, and `DocumentsService`.
 */
@Injectable()
export class DuplicateSuspectedCheck {
  findMatch(
    tx: Prisma.TransactionClient,
    query: SuspectedDuplicateQuery,
  ): Promise<SuspectedDuplicateRef | null> {
    return findSuspectedDuplicate(tx, query);
  }
}
