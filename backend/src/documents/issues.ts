/** Every issue code, in the order they're stored (decision 12). */
export const ISSUE_CODES = [
  'extraction_failed',
  'unsupported_document',
  'supplier_unresolved',
  'missing_total',
  'missing_issue_date',
  'supplier_term_missing',
  'duplicate_number',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
export interface Issue {
  code: IssueCode;
}
