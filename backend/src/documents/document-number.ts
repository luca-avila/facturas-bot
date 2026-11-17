/**
 * The digits of a printed document number, which invariant 7 compares, so
 * `0001-00004521` and `0001 00004521` are the same number. Null when there
 * are no digits. Leading zeros stay. The `documents_number_normalized` check
 * holds every writer to this same rule.
 */
export function normalizeNumber(number: string): string | null {
  const digits = number.replace(/[^0-9]/g, '');
  return digits === '' ? null : digits;
}
