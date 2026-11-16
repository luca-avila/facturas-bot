import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/** Counted in code points, so an accented letter or an emoji counts once. */
export const MIN_PASSWORD_LENGTH = 12;

export function isLongEnough(password: string): boolean {
  return [...password].length >= MIN_PASSWORD_LENGTH;
}

/** An argon2id PHC string, which carries its own parameters. Passwords are never trimmed. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies `password` against `hash`. With no hash (an unknown email) it
 * still verifies against a dummy hash and returns false, so the response time
 * doesn't reveal which emails exist. The dummy is computed once, at run time,
 * from a random value.
 */
export async function verifyPassword(
  hash: string | null,
  password: string,
): Promise<boolean> {
  if (hash === null) {
    dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
    await argon2.verify(await dummyHash, password);
    return false;
  }
  return argon2.verify(hash, password);
}
