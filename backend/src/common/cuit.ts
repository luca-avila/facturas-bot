const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/**
 * True only for exactly 11 ASCII digits with the right check digit. Dashes
 * aren't accepted: callers normalize first. The only implementation of the
 * CUIT check digit; slice 2 reuses it for suppliers.
 */
export function isValidCuit(value: string): boolean {
  if (!/^[0-9]{11}$/.test(value)) return false;
  const digits = Array.from(value, Number);
  const sum = WEIGHTS.reduce((total, weight, i) => total + weight * digits[i], 0);
  const remainder = sum % 11;
  const checkDigit = remainder === 0 ? 0 : 11 - remainder;
  // 10 means no valid CUIT exists for this body.
  return checkDigit !== 10 && checkDigit === digits[10];
}
