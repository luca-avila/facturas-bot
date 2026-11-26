/** Every issue code, in the order they're stored (`system-design.md` Validation). */
export const ISSUE_CODES = [
  'extraction_failed',
  'unsupported_document',
  'supplier_unresolved',
  'missing_total',
  'missing_issue_date',
  'supplier_term_missing',
  'duplicate_number',
  'duplicate_suspected',
  'totals_mismatch',
  'lines_mismatch',
  'wrong_recipient',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** Issue codes a person can explicitly accept as printed. */
export const ACCEPTABLE_ISSUE_CODES = [
  'duplicate_suspected',
  'totals_mismatch',
  'lines_mismatch',
  'wrong_recipient',
] as const;

export type AcceptableIssueCode = (typeof ACCEPTABLE_ISSUE_CODES)[number];

/** Shape stored in `documents.issues` JSONB. */
export interface StoredIssue {
  code: IssueCode;
  acceptedBy?: string;
  acceptedAt?: string;
}

/** Backward-compatible alias for `StoredIssue`. */
export type Issue = StoredIssue;

const ISSUE_CODE_SET = new Set<string>(ISSUE_CODES);
const ACCEPTABLE_SET = new Set<string>(ACCEPTABLE_ISSUE_CODES);
const ISSUE_ORDER = new Map<IssueCode, number>(
  ISSUE_CODES.map((code, index) => [code, index]),
);

export function isIssueCode(value: unknown): value is IssueCode {
  return typeof value === 'string' && ISSUE_CODE_SET.has(value);
}

export function isAcceptableIssueCode(
  value: unknown,
): value is AcceptableIssueCode {
  return typeof value === 'string' && ACCEPTABLE_SET.has(value);
}

export function isAcceptedIssue(
  issue: StoredIssue,
): issue is StoredIssue & {
  code: AcceptableIssueCode;
  acceptedBy: string;
  acceptedAt: string;
} {
  return (
    isAcceptableIssueCode(issue.code) &&
    typeof issue.acceptedBy === 'string' &&
    issue.acceptedBy.length > 0 &&
    typeof issue.acceptedAt === 'string' &&
    issue.acceptedAt.length > 0
  );
}

/** Sorts issues in canonical `ISSUE_CODES` order, deduplicating by code. */
export function sortStoredIssues(
  issues: readonly StoredIssue[],
): StoredIssue[] {
  const byCode = new Map<IssueCode, StoredIssue>();
  for (const issue of issues) {
    const existing = byCode.get(issue.code);
    if (existing === undefined || isAcceptedIssue(issue)) {
      byCode.set(issue.code, issue);
    }
  }
  return [...byCode.values()].sort(
    (a, b) => (ISSUE_ORDER.get(a.code) ?? 0) - (ISSUE_ORDER.get(b.code) ?? 0),
  );
}

/** Reads `documents.issues` JSONB safely into canonical `StoredIssue[]`. */
export function normalizeStoredIssues(raw: unknown): StoredIssue[] {
  if (!Array.isArray(raw)) return [];
  const parsed: StoredIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (!isIssueCode(record.code)) continue;
    const code = record.code;
    if (
      isAcceptableIssueCode(code) &&
      typeof record.acceptedBy === 'string' &&
      record.acceptedBy.length > 0 &&
      typeof record.acceptedAt === 'string' &&
      record.acceptedAt.length > 0
    ) {
      parsed.push({
        code,
        acceptedBy: record.acceptedBy,
        acceptedAt: record.acceptedAt,
      });
    } else {
      parsed.push({ code });
    }
  }
  return sortStoredIssues(parsed);
}

/** Open (unaccepted) issue codes, in `ISSUE_CODES` order. */
export function openIssueCodes(issues: readonly StoredIssue[]): IssueCode[] {
  return sortStoredIssues(issues)
    .filter((issue) => !isAcceptedIssue(issue))
    .map((issue) => issue.code);
}
