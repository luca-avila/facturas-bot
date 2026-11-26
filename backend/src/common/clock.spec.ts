import { formatBuenosAiresTimestamp, now, today } from './clock.js';

describe('today', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function at(isoInstant: string): string {
    vi.useFakeTimers();
    vi.setSystemTime(isoInstant);
    return today();
  }

  it('is still the previous day in Buenos Aires just after midnight UTC', () => {
    expect(at('2026-11-10T00:30:00Z')).toBe('2026-11-09');
  });

  it('changes day at 03:00 UTC, which is midnight in Buenos Aires', () => {
    expect(at('2026-11-10T02:59:59Z')).toBe('2026-11-09');
    expect(at('2026-11-10T03:00:00Z')).toBe('2026-11-10');
  });

  it('zero-pads month and day', () => {
    expect(at('2026-01-05T12:00:00Z')).toBe('2026-01-05');
  });
});

describe('now', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the instant set with vi.setSystemTime', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-11-10T12:34:56.789Z');
    expect(now().toISOString()).toBe('2026-11-10T12:34:56.789Z');
  });
});

describe('formatBuenosAiresTimestamp', () => {
  it('formats dates and 24-hour times in Buenos Aires across midnight', () => {
    expect(formatBuenosAiresTimestamp('2026-11-10T02:30:00.000Z')).toEqual({
      date: '2026-11-09',
      time: '23:30',
    });
    expect(formatBuenosAiresTimestamp('2026-11-10T03:05:00.000Z')).toEqual({
      date: '2026-11-10',
      time: '00:05',
    });
  });
});
