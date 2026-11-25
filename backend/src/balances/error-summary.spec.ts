import { summarizeErrors, type ErrorSummaryRow } from './error-summary.js';

const bebidas = { id: 'a', name: 'Bebidas Norte' };
const lacteos = { id: 'b', name: 'Lácteos Sur' };

const row = (overrides: Partial<ErrorSummaryRow> = {}): ErrorSummaryRow => ({
  type: 'invoice',
  total: '100.00',
  supplier: bebidas,
  ...overrides,
});

describe('summarizeErrors', () => {
  it('names the supplier and adds the totals of two documents of one supplier', () => {
    expect(
      summarizeErrors([row({ total: '98700.00' }), row({ total: '53600.50' })]),
    ).toEqual({ count: 2, amount: '152300.50', supplierName: 'Bebidas Norte' });
  });

  it('names no supplier for two suppliers', () => {
    expect(
      summarizeErrors([row(), row({ supplier: lacteos })]).supplierName,
    ).toBeNull();
  });

  it('names no supplier when one is unknown', () => {
    expect(
      summarizeErrors([row(), row({ supplier: null })]).supplierName,
    ).toBeNull();
    expect(summarizeErrors([row({ supplier: null })]).supplierName).toBeNull();
  });

  it('counts a credit note, and adds nothing for it', () => {
    expect(
      summarizeErrors([row(), row({ type: 'credit_note', total: '40.00' })]),
    ).toMatchObject({ count: 2, amount: '100.00' });
  });

  it('counts a document with no total, and adds nothing for it', () => {
    expect(
      summarizeErrors([row(), row({ total: null, type: null })]),
    ).toMatchObject({ count: 2, amount: '100.00' });
  });

  it('gives 0, 0.00 and no name for none', () => {
    expect(summarizeErrors([])).toEqual({
      count: 0,
      amount: '0.00',
      supplierName: null,
    });
  });
});
