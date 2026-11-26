/**
 * The only place that reads the system clock. ESLint bans `new Date()`,
 * `Date()` and `Date.now()` everywhere else.
 */

/** Pass it to SQL as `${BUSINESS_TIME_ZONE}::text`, never as a literal. */
export const BUSINESS_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timestampFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The current instant. Everything that stores or compares a timestamp reads it here. */
export function now(): Date {
  return new Date();
}

/** Today's date in Buenos Aires as `YYYY-MM-DD`, whatever the machine's time zone. */
export function today(): string {
  const parts = dateFormat.formatToParts(now());
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} in formatted date`);
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Formats an ISO timestamp as Buenos Aires `YYYY-MM-DD` and `HH:MM`. */
export function formatBuenosAiresTimestamp(iso: string): {
  date: string;
  time: string;
} {
  const parts = timestampFormat.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} in formatted timestamp`);
    return value;
  };
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}
