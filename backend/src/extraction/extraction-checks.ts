import { Money } from '../common/money.js';
import {
  checkLinesMismatch,
  checkTotalsMismatch,
  checkWrongRecipient,
} from '../documents/consistency-checks.js';
import { ISSUE_CODES, type IssueCode } from '../documents/issues.js';
import type { MappedExtraction } from './extraction-mapping.js';

export interface ExtractionCheckInput {
  mapped: MappedExtraction;
  supplier:
    | { resolved: false }
    | { resolved: true; paymentTermDays: number | null };
  duplicateNumber: boolean;
  duplicateSuspected: boolean;
  restaurantCuit: string;
}

/**
 * The issues of what was read, in the order of ISSUE_CODES. It only decides
 * (V1): the caller writes the result. No issues means the document meets
 * invariant 1. `extraction_failed` never comes from here.
 */
export function checkExtraction(input: ExtractionCheckInput): IssueCode[] {
  const {
    mapped,
    supplier,
    duplicateNumber,
    duplicateSuspected,
    restaurantCuit,
  } = input;
  if (mapped.kind === 'unsupported') return ['unsupported_document'];

  const found = new Set<IssueCode>();
  if (duplicateNumber) found.add('duplicate_number');
  if (
    supplier.resolved &&
    supplier.paymentTermDays === null &&
    mapped.type !== 'credit_note'
  ) {
    found.add('supplier_term_missing');
  }
  if (mapped.issueDate === null) found.add('missing_issue_date');
  if (mapped.total === null) found.add('missing_total');
  if (!supplier.resolved) found.add('supplier_unresolved');

  if (duplicateSuspected) found.add('duplicate_suspected');

  const subtotal =
    mapped.subtotal === null ? null : Money.fromString(mapped.subtotal);
  const total = mapped.total === null ? null : Money.fromString(mapped.total);
  const taxes = mapped.taxes.map((tax) => ({
    amount: Money.fromString(tax.amount),
  }));
  const lines = mapped.lines.map((line) => ({
    lineTotal:
      line.lineTotal === null ? null : Money.fromString(line.lineTotal),
  }));

  if (checkTotalsMismatch({ subtotal, total, taxes })) {
    found.add('totals_mismatch');
  }
  if (checkLinesMismatch({ subtotal, total, lines })) {
    found.add('lines_mismatch');
  }
  if (checkWrongRecipient(mapped.recipientCuit, restaurantCuit)) {
    found.add('wrong_recipient');
  }

  return ISSUE_CODES.filter((code) => found.has(code));
}
