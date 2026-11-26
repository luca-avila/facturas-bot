import { isValidCuit } from '../common/cuit.js';
import { Money } from '../common/money.js';

const ZERO = Money.fromString('0.00');

/** Maximum tolerated rounding difference on document amount checks ($1.00). */
export const AMOUNT_TOLERANCE = Money.fromString('1.00');

export interface ConsistencySummary {
  /** Sum of tax amounts, or null when there are no taxes. */
  taxSum: string | null;
  /** `subtotal + taxSum`, or null when subtotal is missing or there are no taxes. */
  subtotalPlusTaxes: string | null;
  /** Sum of line totals, or null when there are no lines or any line has no `lineTotal`. */
  lineTotalSum: string | null;
}

function withinTolerance(a: Money, b: Money): boolean {
  const diff = a.subtract(b);
  const abs = diff.compare(ZERO) < 0 ? ZERO.subtract(diff) : diff;
  return abs.compare(AMOUNT_TOLERANCE) <= 0;
}

/**
 * Pure check for `totals_mismatch` (V1).
 * Skipped when there are no taxes, `subtotal` is null, or `total` is null.
 * Passes when `|subtotal + Σ(tax.amount) - total| <= $1.00`.
 */
export function checkTotalsMismatch(input: {
  subtotal: Money | null;
  total: Money | null;
  taxes: readonly { amount: Money }[];
}): boolean {
  if (
    input.taxes.length === 0 ||
    input.subtotal === null ||
    input.total === null
  ) {
    return false;
  }
  const sum = input.taxes.reduce(
    (acc, tax) => acc.add(tax.amount),
    input.subtotal,
  );
  return !withinTolerance(sum, input.total);
}

/**
 * Pure check for `lines_mismatch` (V1).
 * Skipped when there are no lines, when any line has `lineTotal === null`,
 * or when both `subtotal` and `total` are null.
 * Passes when `Σ(line.lineTotal)` matches `subtotal` OR `total` within `$1.00`.
 */
export function checkLinesMismatch(input: {
  subtotal: Money | null;
  total: Money | null;
  lines: readonly { lineTotal: Money | null }[];
}): boolean {
  if (
    input.lines.length === 0 ||
    (input.subtotal === null && input.total === null)
  ) {
    return false;
  }
  let lineSum = ZERO;
  for (const line of input.lines) {
    if (line.lineTotal === null) return false;
    lineSum = lineSum.add(line.lineTotal);
  }
  const matchesSubtotal =
    input.subtotal !== null && withinTolerance(lineSum, input.subtotal);
  const matchesTotal =
    input.total !== null && withinTolerance(lineSum, input.total);
  return !(matchesSubtotal || matchesTotal);
}

/**
 * Pure check for `wrong_recipient` (V1).
 * Missing or invalid `recipientCuit` defaults to `restaurantCuit` (skipped).
 * Triggers only when a valid 11-digit recipient CUIT differs from `restaurantCuit`.
 */
export function checkWrongRecipient(
  recipientCuit: string | null,
  restaurantCuit: string,
): boolean {
  if (recipientCuit === null || !isValidCuit(recipientCuit)) {
    return false;
  }
  return recipientCuit !== restaurantCuit;
}

/** Backend-computed consistency sums for display in *Documento* (D1). */
export function summarizeConsistency(input: {
  subtotal: Money | null;
  taxes: readonly { amount: Money }[];
  lines: readonly { lineTotal: Money | null }[];
}): ConsistencySummary {
  const taxTotal =
    input.taxes.length === 0
      ? null
      : input.taxes.reduce((acc, tax) => acc.add(tax.amount), ZERO);
  const subtotalPlusTaxes =
    input.subtotal === null || taxTotal === null
      ? null
      : input.subtotal.add(taxTotal).toString();

  let lineTotalSum: string | null = null;
  if (input.lines.length > 0) {
    let sum = ZERO;
    let allPresent = true;
    for (const line of input.lines) {
      if (line.lineTotal === null) {
        allPresent = false;
        break;
      }
      sum = sum.add(line.lineTotal);
    }
    if (allPresent) lineTotalSum = sum.toString();
  }

  return {
    taxSum: taxTotal === null ? null : taxTotal.toString(),
    subtotalPlusTaxes,
    lineTotalSum,
  };
}
