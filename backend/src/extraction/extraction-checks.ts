import { ISSUE_CODES, type IssueCode } from '../documents/issues.js';
import type { MappedExtraction } from './extraction-mapping.js';

export interface ExtractionCheckInput {
  mapped: MappedExtraction;
  supplier:
    { resolved: false } | { resolved: true; paymentTermDays: number | null };
  duplicateNumber: boolean;
}

/**
 * The issues of what was read, in the order of ISSUE_CODES. It only decides
 * (V1): the caller writes the result. No issues means the document meets
 * invariant 1. `extraction_failed` never comes from here.
 */
export function checkExtraction(input: ExtractionCheckInput): IssueCode[] {
  const { mapped, supplier, duplicateNumber } = input;
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
  return ISSUE_CODES.filter((code) => found.has(code));
}
