import { addDays, diffDays, isIsoDate } from '../common/dates.js';
import type {
  DocumentType,
  DueDateSource,
} from '../generated/prisma/client.js';

const MAX_SUGGESTED_TERM_DAYS = 365;

export interface ResolvedDueDate {
  dueDate: string | null;
  source: DueDateSource | null;
}

/** A document's due date as stored, when an edit resolves it again. */
export interface StoredDueDate {
  type: DocumentType | null;
  supplierId: string | null;
  issueDate: string | null;
  dueDate: string | null;
  source: DueDateSource | null;
}

/**
 * The only due-date rule (D4). A typed date wins. Otherwise invoices and
 * delivery notes take the issue date plus the supplier's term, and need a
 * typed date when there's no term. An edit that keeps the supplier of an
 * invoice or delivery note due by its term keeps the term its stored date was
 * computed with, even if the supplier's term changed since. Opening balances
 * never use the term, and credit notes never have a due date.
 */
export function resolveDueDate(input: {
  type: DocumentType;
  issueDate: string;
  typedDueDate: string | null;
  paymentTermDays: number | null;
  /** For an edit: the supplier the document will have, and what's stored. */
  edit?: { supplierId: string; stored: StoredDueDate };
}): ResolvedDueDate | 'due_date_required' {
  const { type, issueDate, typedDueDate, paymentTermDays } = input;
  switch (type) {
    case 'invoice':
    case 'delivery_note': {
      if (typedDueDate !== null)
        return { dueDate: typedDueDate, source: 'manual' };
      const termDays = keptTermDays(input.edit) ?? paymentTermDays;
      if (termDays === null) return 'due_date_required';
      return {
        dueDate: addDays(issueDate, termDays),
        source: 'supplier_term',
      };
    }
    case 'opening_balance':
      return typedDueDate === null
        ? { dueDate: null, source: null }
        : { dueDate: typedDueDate, source: 'manual' };
    case 'credit_note':
      if (typedDueDate !== null) {
        throw new Error('A credit note never has a due date.');
      }
      return { dueDate: null, source: null };
  }
}

/**
 * The days between the stored issue and due dates, when the stored document
 * is an invoice or delivery note due by the term of the supplier it keeps.
 */
function keptTermDays(edit: {
  supplierId: string;
  stored: StoredDueDate;
} | undefined): number | null {
  if (edit === undefined) return null;
  const { stored } = edit;
  if (stored.type !== 'invoice' && stored.type !== 'delivery_note') return null;
  if (stored.source !== 'supplier_term') return null;
  if (stored.supplierId !== edit.supplierId) return null;
  if (stored.issueDate === null || stored.dueDate === null) return null;
  return diffDays(stored.issueDate, stored.dueDate);
}

function isValidTermDays(days: unknown): days is number {
  return (
    typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 0 &&
    days <= MAX_SUGGESTED_TERM_DAYS
  );
}

/**
 * Suggests a supplier term in `0..365` from an extraction job's `raw_output`,
 * preferring `printedTermDays` and falling back to `printedDueDate - issueDate`.
 */
export function suggestTermDays(
  rawOutput: unknown,
  documentIssueDate: string | null,
): number | null {
  if (rawOutput === null || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
    return null;
  }
  const record = rawOutput as Record<string, unknown>;
  if (isValidTermDays(record.printedTermDays)) {
    return record.printedTermDays;
  }
  const printedDueDate = record.printedDueDate;
  if (typeof printedDueDate !== 'string' || !isIsoDate(printedDueDate)) {
    return null;
  }
  const issueDate =
    documentIssueDate !== null && isIsoDate(documentIssueDate)
      ? documentIssueDate
      : typeof record.issueDate === 'string' && isIsoDate(record.issueDate)
        ? record.issueDate
        : null;
  if (issueDate === null) return null;
  const days = diffDays(issueDate, printedDueDate);
  return isValidTermDays(days) ? days : null;
}
