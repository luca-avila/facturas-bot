import { Money } from '../common/money.js';
import {
  EXTRACTION_RESULT_CUITS,
  RESTAURANT_TEST_CUIT,
} from '../../test/test-cuits.js';
import {
  checkLinesMismatch,
  checkTotalsMismatch,
  checkWrongRecipient,
  summarizeConsistency,
} from './consistency-checks.js';

const m = (value: string) => Money.fromString(value);

describe('checkTotalsMismatch', () => {
  it('passes when subtotal plus taxes equals total exactly', () => {
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(false);
  });

  it('passes at exactly +$1.00 and -$1.00 difference', () => {
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1211.00'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(false);
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1209.00'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(false);
  });

  it('fails at +$1.01 and -$1.01 difference', () => {
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1211.01'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(true);
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1208.99'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(true);
  });

  it('sums multiple tax rows', () => {
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1250.00'),
        taxes: [{ amount: m('210.00') }, { amount: m('40.00') }],
      }),
    ).toBe(false);
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('1255.00'),
        taxes: [{ amount: m('210.00') }, { amount: m('40.00') }],
      }),
    ).toBe(true);
  });

  it('skips when there are no taxes, subtotal is null, or total is null', () => {
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: m('5000.00'),
        taxes: [],
      }),
    ).toBe(false);
    expect(
      checkTotalsMismatch({
        subtotal: null,
        total: m('1210.00'),
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(false);
    expect(
      checkTotalsMismatch({
        subtotal: m('1000.00'),
        total: null,
        taxes: [{ amount: m('210.00') }],
      }),
    ).toBe(false);
  });
});

describe('checkLinesMismatch', () => {
  it('passes when line sum matches subtotal within $1.00 even if differing from total', () => {
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('600.00') }, { lineTotal: m('401.00') }],
      }),
    ).toBe(false);
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('600.00') }, { lineTotal: m('399.00') }],
      }),
    ).toBe(false);
  });

  it('passes when line sum matches total within $1.00 (tax-inclusive lines) even if differing from subtotal', () => {
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('700.00') }, { lineTotal: m('511.00') }],
      }),
    ).toBe(false);
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('700.00') }, { lineTotal: m('509.00') }],
      }),
    ).toBe(false);
  });

  it('fails when line sum differs by $1.01 or more from both subtotal and total', () => {
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('600.00') }, { lineTotal: m('401.01') }],
      }),
    ).toBe(true);
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('700.00') }, { lineTotal: m('511.01') }],
      }),
    ).toBe(true);
    expect(
      checkLinesMismatch({
        subtotal: null,
        total: m('1000.00'),
        lines: [{ lineTotal: m('998.99') }],
      }),
    ).toBe(true);
  });

  it('skips when there are no lines, any line has null lineTotal, or both subtotal and total are null', () => {
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [],
      }),
    ).toBe(false);
    expect(
      checkLinesMismatch({
        subtotal: m('1000.00'),
        total: m('1210.00'),
        lines: [{ lineTotal: m('100.00') }, { lineTotal: null }],
      }),
    ).toBe(false);
    expect(
      checkLinesMismatch({
        subtotal: null,
        total: null,
        lines: [{ lineTotal: m('500.00') }],
      }),
    ).toBe(false);
  });
});

describe('checkWrongRecipient', () => {
  it('passes when recipientCuit matches restaurantCuit or is null or invalid', () => {
    expect(
      checkWrongRecipient(RESTAURANT_TEST_CUIT, RESTAURANT_TEST_CUIT),
    ).toBe(false);
    expect(checkWrongRecipient(null, RESTAURANT_TEST_CUIT)).toBe(false);
    expect(checkWrongRecipient('30000000119', RESTAURANT_TEST_CUIT)).toBe(
      false,
    );
  });

  it('fails when recipientCuit is a valid CUIT different from restaurantCuit', () => {
    expect(
      checkWrongRecipient(EXTRACTION_RESULT_CUITS[0], RESTAURANT_TEST_CUIT),
    ).toBe(true);
  });
});

describe('summarizeConsistency', () => {
  it('computes exact sums and returns null when inputs are absent or incomplete', () => {
    expect(
      summarizeConsistency({
        subtotal: m('1000.00'),
        taxes: [{ amount: m('210.00') }, { amount: m('30.50') }],
        lines: [{ lineTotal: m('600.00') }, { lineTotal: m('400.00') }],
      }),
    ).toEqual({
      taxSum: '240.50',
      subtotalPlusTaxes: '1240.50',
      lineTotalSum: '1000.00',
    });

    expect(
      summarizeConsistency({
        subtotal: null,
        taxes: [{ amount: m('210.00') }],
        lines: [{ lineTotal: m('600.00') }, { lineTotal: null }],
      }),
    ).toEqual({
      taxSum: '210.00',
      subtotalPlusTaxes: null,
      lineTotalSum: null,
    });

    expect(
      summarizeConsistency({
        subtotal: m('1000.00'),
        taxes: [],
        lines: [],
      }),
    ).toEqual({
      taxSum: null,
      subtotalPlusTaxes: null,
      lineTotalSum: null,
    });
  });
});
