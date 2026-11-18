import { bodyWithKeys } from '../common/body.js';
import { type FieldError, invalidRequest } from '../common/field-errors.js';
import { Money } from '../common/money.js';
import { isUuid } from '../common/uuid.js';
import type {
  ApplyCreditInput,
  SplitRequest,
  SplitRowInput,
  SplitSource,
} from './applications.types.js';

/** `Money.fromString`, or null for anything it refuses. */
export function readMoney(value: string): Money | null {
  try {
    return Money.fromString(value);
  } catch {
    return null;
  }
}

/** A UUID, lower-cased so it matches the ids Postgres returns. */
function readUuid(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw invalidRequest();
  return value.toLowerCase();
}

/**
 * The `applications` array of a split. A wrong shape, a non-UUID or a
 * repeated document id is malformed. An amount that isn't zero or more is
 * a field error on `applications.<documentId>`, and its row is left out.
 */
export function parseSplitRows(value: unknown): {
  rows: SplitRowInput[];
  errors: FieldError[];
} {
  if (!Array.isArray(value)) throw invalidRequest();
  const rows: SplitRowInput[] = [];
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const element of value) {
    const raw = bodyWithKeys(element, ['documentId', 'amount'] as const);
    const documentId = readUuid(raw.documentId);
    if (typeof raw.amount !== 'string' || seen.has(documentId)) {
      throw invalidRequest();
    }
    seen.add(documentId);
    const amount = readMoney(raw.amount);
    if (amount === null || !(amount.isPositive() || amount.isZero())) {
      errors.push({
        field: `applications.${documentId}`,
        code: 'application_amount_invalid',
      });
    } else {
      rows.push({ documentId, amount });
    }
  }
  return { rows, errors };
}

/** Above zero, or the `amount_invalid` field error. */
export function readPositiveAmount(
  value: string,
  errors: FieldError[],
): Money | null {
  const amount = readMoney(value);
  if (amount === null || !amount.isPositive()) {
    errors.push({ field: 'amount', code: 'amount_invalid' });
    return null;
  }
  return amount;
}

function readExistingSource(raw: unknown): ApplyCreditInput['source'] {
  const source = bodyWithKeys(raw, ['kind', 'id'] as const);
  if (source.kind !== 'payment' && source.kind !== 'credit_note') {
    throw invalidRequest();
  }
  return { kind: source.kind, id: readUuid(source.id) };
}

function readSource(raw: unknown, errors: FieldError[]): SplitSource | null {
  const kind =
    typeof raw === 'object' && raw !== null && 'kind' in raw
      ? raw.kind
      : undefined;
  if (kind !== 'new_payment') return readExistingSource(raw);
  const source = bodyWithKeys(raw, ['kind', 'supplierId', 'amount'] as const);
  const supplierId = readUuid(source.supplierId);
  if (typeof source.amount !== 'string') throw invalidRequest();
  const amount = readPositiveAmount(source.amount, errors);
  return amount === null ? null : { kind, supplierId, amount };
}

/** `POST /api/applications/preview`. Field errors come back together as a 400. */
export function parseSplitRequest(body: unknown): SplitRequest {
  const raw = bodyWithKeys(body, ['source', 'applications'] as const);
  const errors: FieldError[] = [];
  const source = readSource(raw.source, errors);
  let applications: SplitRowInput[] | null = null;
  if (raw.applications !== null) {
    const parsed = parseSplitRows(raw.applications);
    errors.push(...parsed.errors);
    applications = parsed.rows;
  }
  if (errors.length > 0 || source === null) throw invalidRequest(errors);
  return { source, applications };
}

/** `POST /api/applications`. */
export function parseApplyCreditInput(body: unknown): ApplyCreditInput {
  const raw = bodyWithKeys(body, ['source', 'applications'] as const);
  const source = readExistingSource(raw.source);
  const { rows, errors } = parseSplitRows(raw.applications);
  if (errors.length > 0) throw invalidRequest(errors);
  return { source, applications: rows };
}
