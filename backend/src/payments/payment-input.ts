import { bodyWithKeys, isStringOrNull, optionalText } from '../common/body.js';
import { isIsoDate } from '../common/dates.js';
import { type FieldError, invalidRequest } from '../common/field-errors.js';
import type { Money } from '../common/money.js';
import { isUuid } from '../common/uuid.js';
import type { SplitRowInput } from '../applications/applications.types.js';
import {
  parseSplitRows,
  readPositiveAmount,
} from '../applications/split-input.js';
import { PaymentMethod } from '../generated/prisma/client.js';

/** The fields of a payment, checked and trimmed. */
export interface PaymentFields {
  amount: Money;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  /** eCheq only. */
  valueDate: string | null;
}

export interface PaymentInput extends PaymentFields {
  supplierId: string;
  notes: string | null;
  applications: SplitRowInput[];
}

export interface MarkPaidInput extends PaymentFields {
  documentId: string;
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return Object.values<unknown>(PaymentMethod).includes(value);
}

function readUuid(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw invalidRequest();
  return value.toLowerCase();
}

/**
 * The fields both bodies share. A wrong JSON type, an unknown method, or a
 * value date on anything but an eCheq is malformed. User mistakes are added
 * to `errors`.
 */
function readPaymentFields(
  raw: Record<
    'amount' | 'paidOn' | 'method' | 'reference' | 'valueDate',
    unknown
  >,
  errors: FieldError[],
): PaymentFields | null {
  const { amount, paidOn, method, reference, valueDate } = raw;
  if (
    typeof amount !== 'string' ||
    typeof paidOn !== 'string' ||
    !isPaymentMethod(method) ||
    !isStringOrNull(reference) ||
    !isStringOrNull(valueDate) ||
    (valueDate !== null && method !== 'echeq')
  ) {
    throw invalidRequest();
  }
  const money = readPositiveAmount(amount, errors);
  if (!isIsoDate(paidOn)) {
    errors.push({ field: 'paidOn', code: 'paid_on_invalid' });
  }
  if (valueDate !== null && !isIsoDate(valueDate)) {
    errors.push({ field: 'valueDate', code: 'value_date_invalid' });
  }
  if (money === null) return null;
  return {
    amount: money,
    paidOn,
    method,
    reference: optionalText(reference),
    valueDate,
  };
}

const PAYMENT_KEYS = [
  'supplierId',
  'amount',
  'paidOn',
  'method',
  'reference',
  'valueDate',
  'notes',
  'applications',
] as const;

/** `POST /api/payments`. Whether the supplier exists is checked in the transaction. */
export function parsePaymentInput(body: unknown): PaymentInput {
  const raw = bodyWithKeys(body, PAYMENT_KEYS);
  const supplierId = readUuid(raw.supplierId);
  if (!isStringOrNull(raw.notes)) throw invalidRequest();
  const errors: FieldError[] = [];
  const fields = readPaymentFields(raw, errors);
  const split = parseSplitRows(raw.applications);
  errors.push(...split.errors);
  if (errors.length > 0 || fields === null) throw invalidRequest(errors);
  return {
    ...fields,
    supplierId,
    notes: optionalText(raw.notes),
    applications: split.rows,
  };
}

const MARK_PAID_KEYS = [
  'documentId',
  'amount',
  'paidOn',
  'method',
  'reference',
  'valueDate',
] as const;

/** `POST /api/payments/mark-paid`. */
export function parseMarkPaidInput(body: unknown): MarkPaidInput {
  const raw = bodyWithKeys(body, MARK_PAID_KEYS);
  const documentId = readUuid(raw.documentId);
  const errors: FieldError[] = [];
  const fields = readPaymentFields(raw, errors);
  if (errors.length > 0 || fields === null) throw invalidRequest(errors);
  return { ...fields, documentId };
}
