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

/**
 * The body as an object with all `requiredKeys` and any subset of
 * `optionalKeys`, or a malformed-request 400 on missing required keys or
 * unknown keys. Each key's JSON type is checked by the caller.
 */
export function bodyWithOptionalKeys<R extends string, O extends string>(
  body: unknown,
  requiredKeys: readonly R[],
  optionalKeys: readonly O[],
): Record<R, unknown> & Partial<Record<O, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest();
  }
  const actual = Object.keys(body);
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);
  if (!actual.every((key) => allowed.has(key))) {
    throw invalidRequest();
  }
  const actualSet = new Set(actual);
  if (!requiredKeys.every((key) => actualSet.has(key))) {
    throw invalidRequest();
  }
  return body as Record<R, unknown> & Partial<Record<O, unknown>>;
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Trimmed, with an empty string as null. */
export function optionalText(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
