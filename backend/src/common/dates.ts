const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True for `YYYY-MM-DD` naming a real calendar day from 1900 to 2999. The
 * range keeps clear of Postgres's missing year 0 and catches a mistyped year.
 */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = toDbDate(value);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** UTC midnight of the date, which is how `@db.Date` fields are written and read. */
export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` of a `@db.Date` value, which Prisma returns as UTC midnight. */
export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Plain calendar days in UTC, so month ends and leap days work. */
export function addDays(date: string, days: number): string {
  return fromDbDate(new Date(toDbDate(date).getTime() + days * DAY_MS));
}
