/**
 * Every `pg_advisory_xact_lock` key in the app, so two locks can never share
 * a key by accident.
 */
export const ADVISORY_LOCKS = {
  /** Taken before the same-image check, by every upload. */
  uploads: 1,
} as const;
