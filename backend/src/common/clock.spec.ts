import { today } from './clock.js';

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
