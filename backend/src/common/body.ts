import { invalidRequest } from './field-errors.js';

/**
 * The body as an object with exactly `keys`, or a malformed-request 400.
 * Each key's JSON type is checked by the caller.
 */
export function bodyWithKeys<K extends string>(
  body: unknown,
  keys: readonly K[],
): Record<K, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest();
  }
  const actual = Object.keys(body);
  const expected = new Set<string>(keys);
  if (
    actual.length !== expected.size ||
    !actual.every((key) => expected.has(key))
  ) {
    throw invalidRequest();
  }
  return body as Record<K, unknown>;
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Trimmed, with an empty string as null. */
export function optionalText(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
