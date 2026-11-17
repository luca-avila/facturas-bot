import type { DocumentType } from '../generated/prisma/client.js';

export type SupplierSort = 'overdue' | 'name' | 'total';

export const SUPPLIER_SORTS: readonly SupplierSort[] = [
  'overdue',
  'name',
  'total',
];

/** The four figures of a supplier, or their totals. Amounts have exactly two decimals. */
export interface SupplierFigures {
  notDue: string;
  overdue: string;
  /** Positive: it's subtracted. */
  credit: string;
  /** notDue + overdue − credit, negative when the supplier owes the restaurant. */
  balance: string;
}

export interface SupplierListRow extends SupplierFigures {
  id: string;
  name: string;
  legalName: string | null;
  paymentTermDays: number | null;
}

export interface SupplierList {
  suppliers: SupplierListRow[];
  totals: SupplierFigures;
}

export type DocumentStatus = 'pending' | 'overdue';

export interface AccountDocument {
  id: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  total: string;
  reviewStatus: 'unreviewed' | 'reviewed';
  /** Null for credit notes. */
  status: DocumentStatus | null;
  /** dueDate − today, null without a due date. */
  daysToDue: number | null;
}

export interface SupplierAccount extends SupplierFigures {
  id: string;
  name: string;
  legalName: string | null;
  cuit: string | null;
  paymentTermDays: number | null;
  notes: string | null;
  /** Counted documents only, by due date, then issue date, then creation. No due date goes last. */
  documents: AccountDocument[];
}
