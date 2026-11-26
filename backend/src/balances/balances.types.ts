import type { Money } from '../common/money.js';
import type { IssueCode } from '../documents/issues.js';
import type {
  DocumentType,
  PaymentMethod,
  ReviewStatus,
} from '../generated/prisma/client.js';

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
  /** Buenos Aires, the date the statuses were derived for. */
  today: string;
  /** Every *Error* document, from the same snapshot. */
  errors: ErrorSummary;
}

export type DebtStatus = 'pending' | 'overdue' | 'paid';
export type CreditStatus = 'available' | 'applied';
export type DocumentStatus = DebtStatus | CreditStatus;

/** The types that receive applications (invariant 5). */
export type ReceivingType = Exclude<DocumentType, 'credit_note'>;

export interface AccountDocument {
  id: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  total: string;
  reviewStatus: 'unreviewed' | 'reviewed';
  /** A `DebtStatus` for debts, a `CreditStatus` for credit notes. */
  status: DocumentStatus;
  /** Left to pay on a debt, left to apply on a credit note. */
  remaining: string;
  /** Something applied and something left. */
  partial: boolean;
  /** dueDate − today, null without a due date. */
  daysToDue: number | null;
}

export interface PaymentSummary {
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

export interface PaymentListRow extends PaymentSummary {
  supplierId: string;
  supplierName: string;
}

export interface PaymentList {
  /** Newest paid first: paid on, then creation, then id, all descending. */
  payments: PaymentListRow[];
}

export interface PaymentApplication {
  documentId: string;
  type: ReceivingType;
  letter: string | null;
  number: string | null;
  /** What this payment applied to it, across all its applications to it. */
  amount: string;
  /** As of now. */
  status: DebtStatus;
  remaining: string;
  partial: boolean;
}

export interface PaymentDetail extends PaymentListRow {
  notes: string | null;
  applied: string;
  /** One per document, in split order. */
  applications: PaymentApplication[];
}

export interface SupplierAccount extends SupplierFigures {
  id: string;
  name: string;
  legalName: string | null;
  cuit: string | null;
  paymentTermDays: number | null;
  notes: string | null;
  /** Buenos Aires, the date the statuses were derived for. */
  today: string;
  /** Counted documents only, by COALESCE(due date, issue date), then issue date, then creation, then id. */
  documents: AccountDocument[];
  /** Newest paid first. */
  payments: PaymentSummary[];
}

/** A row a split can apply to, as `ApplicationsService` reads it after its locks. */
export interface SplitDocument {
  id: string;
  type: ReceivingType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  daysToDue: number | null;
  status: DebtStatus;
  remaining: Money;
  applied: Money;
}

/** A source of existing credit. */
export interface CreditSourceRef {
  kind: 'payment' | 'credit_note';
  id: string;
}

/** What invariant 6 needs to know about a document. */
export interface DocumentApplied {
  supplierId: string | null;
  type: DocumentType | null;
  total: Money | null;
  reviewStatus: ReviewStatus;
  /** Applied to it. */
  received: Money;
  /** Applied from it, when it's a credit note. */
  given: Money;
}

/** The *Error* warning: how many documents don't count, and what they add up to. */
export interface ErrorSummary {
  count: number;
  /** Totals of the ones that aren't credit notes. */
  amount: string;
  /** Only when every one has the same known supplier. */
  supplierName: string | null;
}

export interface ErrorDocumentRow {
  id: string;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  supplier: { id: string; name: string } | null;
  issueDate: string | null;
  total: string | null;
  createdByName: string;
  /** The upload date in Buenos Aires. */
  createdOn: string;
  /** Codes, in stored order. */
  issues: IssueCode[];
  suggestedTermDays: number | null;
}

export interface ErrorDocumentList {
  summary: ErrorSummary;
  /** Oldest upload first. */
  documents: ErrorDocumentRow[];
}
