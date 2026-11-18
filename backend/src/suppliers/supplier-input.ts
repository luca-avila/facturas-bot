import { bodyWithKeys, isStringOrNull, optionalText } from '../common/body.js';
import { isValidCuit } from '../common/cuit.js';
import { type FieldError, invalidRequest } from '../common/field-errors.js';

/** A supplier as the API stores it: trimmed, with the CUIT as 11 digits. */
export interface SupplierFields {
  name: string;
  legalName: string | null;
  cuit: string | null;
  paymentTermDays: number | null;
  notes: string | null;
}

const KEYS = ['name', 'legalName', 'cuit', 'paymentTermDays', 'notes'] as const;

export const MAX_PAYMENT_TERM_DAYS = 365;

/**
 * Reads a `SupplierInput` body. A missing key or a wrong JSON type is a
 * malformed request; user mistakes come back together as field errors.
 */
export function parseSupplierInput(body: unknown): SupplierFields {
  const raw = bodyWithKeys(body, KEYS);
  const { name, legalName, cuit, paymentTermDays, notes } = raw;
  if (
    typeof name !== 'string' ||
    !isStringOrNull(legalName) ||
    !isStringOrNull(cuit) ||
    !(paymentTermDays === null || typeof paymentTermDays === 'number') ||
    !isStringOrNull(notes)
  ) {
    throw invalidRequest();
  }

  const errors: FieldError[] = [];
  const trimmedName = name.trim();
  if (trimmedName === '') errors.push({ field: 'name', code: 'name_required' });

  const digits = cuit === null ? null : cuit.replace(/[\s-]/g, '');
  if (digits === '') errors.push({ field: 'cuit', code: 'cuit_required' });
  else if (digits !== null && !isValidCuit(digits)) {
    errors.push({ field: 'cuit', code: 'cuit_invalid' });
  }

  if (
    paymentTermDays !== null &&
    !(
      Number.isInteger(paymentTermDays) &&
      paymentTermDays >= 0 &&
      paymentTermDays <= MAX_PAYMENT_TERM_DAYS
    )
  ) {
    errors.push({ field: 'paymentTermDays', code: 'payment_term_invalid' });
  }

  if (errors.length > 0) throw invalidRequest(errors);
  return {
    name: trimmedName,
    legalName: optionalText(legalName),
    cuit: digits,
    paymentTermDays,
    notes: optionalText(notes),
  };
}
