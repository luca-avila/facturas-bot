import { addDays, isIsoDate, toDbDate } from './dates.js';

describe('isIsoDate', () => {
  it.each([
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '1899-12-31',
    '3000-01-01',
    '26-11-09',
    '2026-11-9',
    '',
    '2026-11-09T00:00:00Z',
  ])('rejects %j', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it.each(['2028-02-29', '1900-01-01', '2999-12-31', '2026-11-09'])(
    'accepts %s',
    (value) => {
      expect(isIsoDate(value)).toBe(true);
    },
  );
});

describe('addDays', () => {
  it.each([
    ['2026-01-31', 30, '2026-03-02'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-12-15', 30, '2027-01-14'],
    ['2026-11-09', 0, '2026-11-09'],
  ])('%s + %i = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('toDbDate', () => {
  it('is UTC midnight of that day', () => {
    expect(toDbDate('2026-11-09').toISOString()).toBe(
      '2026-11-09T00:00:00.000Z',
    );
  });
});
