/**
 * The only place that reads the system clock. ESLint bans `new Date()`,
 * `Date()` and `Date.now()` everywhere else.
 */

const BUSINESS_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in Buenos Aires as `YYYY-MM-DD`, whatever the machine's time zone. */
export function today(): string {
  const parts = dateFormat.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} in formatted date`);
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}
