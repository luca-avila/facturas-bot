/**
 * The one normalization for emails. Creating users, signing in and the
 * sign-in rate limit all go through it, and the `users_email_normalized`
 * constraint enforces the same rule in the database.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Exactly one `@` with something on each side, and no whitespace. Expects a normalized email. */
export function isValidEmail(normalizedEmail: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(normalizedEmail);
}
