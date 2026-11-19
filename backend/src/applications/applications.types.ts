import type { FieldError } from '../common/field-errors.js';
import type { Money } from '../common/money.js';
import type {
  CreditSourceRef,
  DebtStatus,
  ReceivingType,
} from '../balances/balances.types.js';

/** One row of a split as typed. Documents left out apply nothing. */
export interface SplitRowInput {
  documentId: string;
  amount: Money;
}

export type SplitSource =
  { kind: 'new_payment'; supplierId: string; amount: Money } | CreditSourceRef;

export interface SplitRequest {
  source: SplitSource;
  /** Null asks for the suggestion. */
  applications: SplitRowInput[] | null;
}

export interface ApplyCreditInput {
  source: CreditSourceRef;
  applications: SplitRowInput[];
}

export interface SplitRowResult {
  documentId: string;
  type: ReceivingType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  daysToDue: number | null;
  /** Now. */
  status: DebtStatus;
  /** Now: "Falta $ …". */
  remaining: string;
  /** In this split, "0.00" when it applies nothing. */
  amount: string;
  /** As it would be after saving. The same as now when the row applies nothing or has an error. */
  after: { status: DebtStatus; remaining: string; partial: boolean };
}

export interface Split {
  /** The new payment's amount, or what the existing payment or credit note has left before this split. */
  available: string;
  /** Σ row amounts. */
  applied: string;
  /** Stays as credit; "0.00" when the rows add up to more than `available`. */
  unapplied: string;
  /** How much the rows go over `available`; "0.00" otherwise. */
  excess: string;
  rows: SplitRowResult[];
  /** Exactly what a save would refuse with, as its 409 field errors. Empty when the split can be saved. */
  errors: FieldError[];
}
