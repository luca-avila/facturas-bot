/**
 * Every `pg_advisory_xact_lock` key in the app, so two locks can never share
 * a key by accident.
 */
export const ADVISORY_LOCKS = {
  /** Taken before the same-image check, by every upload. */
  uploads: 1,
  /**
   * Taken as the very first statement of any transaction that can introduce
   * or promote a counted document's `(supplier_id, issue_date, total, number_normalized)`
   * (C1), preventing concurrent duplicate races and deadlocks.
   */
  documentDuplicates: 2,
} as const;
