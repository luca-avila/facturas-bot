import { addDays } from '../common/dates.js';
import type {
  DocumentType,
  DueDateSource,
} from '../generated/prisma/client.js';

export interface ResolvedDueDate {
  dueDate: string | null;
  source: DueDateSource | null;
}

/**
 * The only due-date rule (D4). A typed date wins. Otherwise invoices and
 * delivery notes take the issue date plus the supplier's term, and need a
 * typed date when there's no term. Opening balances never use the term, and
 * credit notes never have a due date.
 */
export function resolveDueDate(input: {
  type: DocumentType;
  issueDate: string;
  typedDueDate: string | null;
  paymentTermDays: number | null;
}): ResolvedDueDate | 'due_date_required' {
  const { type, issueDate, typedDueDate, paymentTermDays } = input;
  switch (type) {
    case 'invoice':
    case 'delivery_note':
      if (typedDueDate !== null)
        return { dueDate: typedDueDate, source: 'manual' };
      if (paymentTermDays === null) return 'due_date_required';
      return {
        dueDate: addDays(issueDate, paymentTermDays),
        source: 'supplier_term',
      };
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
