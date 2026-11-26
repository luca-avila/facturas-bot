import { resolveDueDate, suggestTermDays } from './due-date.js';

describe('resolveDueDate', () => {
  const issueDate = '2026-10-09';

  describe.each(['invoice', 'delivery_note'] as const)('%s', (type) => {
    it('uses the typed date, as manual, whatever the term', () => {
      for (const paymentTermDays of [30, null]) {
        expect(
          resolveDueDate({
            type,
            issueDate,
            typedDueDate: '2026-12-01',
            paymentTermDays,
          }),
        ).toEqual({ dueDate: '2026-12-01', source: 'manual' });
      }
    });

    it('adds the term to the issue date without a typed date', () => {
      expect(
        resolveDueDate({
          type,
          issueDate,
          typedDueDate: null,
          paymentTermDays: 30,
        }),
      ).toEqual({ dueDate: '2026-11-08', source: 'supplier_term' });
    });

    it('needs a typed date when the supplier has no term', () => {
      expect(
        resolveDueDate({
          type,
          issueDate,
          typedDueDate: null,
          paymentTermDays: null,
        }),
      ).toBe('due_date_required');
    });
  });

  it('makes the due date the issue date with a term of 0', () => {
    expect(
      resolveDueDate({
        type: 'invoice',
        issueDate,
        typedDueDate: null,
        paymentTermDays: 0,
      }),
    ).toEqual({ dueDate: issueDate, source: 'supplier_term' });
  });

  it('keeps an opening balance typed date as manual, ignoring the term', () => {
    expect(
      resolveDueDate({
        type: 'opening_balance',
        issueDate,
        typedDueDate: '2026-10-01',
        paymentTermDays: 30,
      }),
    ).toEqual({ dueDate: '2026-10-01', source: 'manual' });
  });

  it('gives an opening balance without a typed date no due date, even with a term', () => {
    for (const paymentTermDays of [30, null]) {
      expect(
        resolveDueDate({
          type: 'opening_balance',
          issueDate,
          typedDueDate: null,
          paymentTermDays,
        }),
      ).toEqual({ dueDate: null, source: null });
    }
  });

  it('gives a credit note no due date, even with a term', () => {
    expect(
      resolveDueDate({
        type: 'credit_note',
        issueDate,
        typedDueDate: null,
        paymentTermDays: 30,
      }),
    ).toEqual({ dueDate: null, source: null });
  });

  it('throws for a credit note with a typed date, which the parser already rejects', () => {
    expect(() =>
      resolveDueDate({
        type: 'credit_note',
        issueDate,
        typedDueDate: '2026-12-01',
        paymentTermDays: 30,
      }),
    ).toThrow();
  });
});

describe('suggestTermDays', () => {
  it('uses printedTermDays when it is an integer in 0..365', () => {
    expect(suggestTermDays({ printedTermDays: 0 }, null)).toBe(0);
    expect(suggestTermDays({ printedTermDays: 30 }, null)).toBe(30);
    expect(suggestTermDays({ printedTermDays: 365 }, null)).toBe(365);
  });

  it('ignores printedTermDays that is out of range, float, or non-numeric', () => {
    expect(suggestTermDays({ printedTermDays: -1 }, null)).toBeNull();
    expect(suggestTermDays({ printedTermDays: 366 }, null)).toBeNull();
    expect(suggestTermDays({ printedTermDays: 15.5 }, null)).toBeNull();
    expect(suggestTermDays({ printedTermDays: '30' }, null)).toBeNull();
  });

  it('falls back to printedDueDate - documentIssueDate when printedTermDays is unusable', () => {
    expect(
      suggestTermDays(
        {
          printedTermDays: -5,
          printedDueDate: '2026-11-15',
          issueDate: '2026-10-01',
        },
        '2026-10-16',
      ),
    ).toBe(30);
  });

  it('falls back to raw_output.issueDate when documentIssueDate is null', () => {
    expect(
      suggestTermDays(
        { printedDueDate: '2026-11-15', issueDate: '2026-10-16' },
        null,
      ),
    ).toBe(30);
  });

  it('rejects negative or over-365 differences and invalid dates', () => {
    expect(
      suggestTermDays({ printedDueDate: '2026-10-15' }, '2026-10-16'),
    ).toBeNull();
    expect(
      suggestTermDays({ printedDueDate: '2027-10-17' }, '2026-10-16'),
    ).toBeNull();
    expect(
      suggestTermDays({ printedDueDate: '2026-02-30' }, '2026-02-01'),
    ).toBeNull();
    expect(suggestTermDays({ printedDueDate: '2026-11-15' }, null)).toBeNull();
  });

  it('returns null for null, primitive, or array rawOutput', () => {
    expect(suggestTermDays(null, '2026-10-16')).toBeNull();
    expect(suggestTermDays(undefined, '2026-10-16')).toBeNull();
    expect(suggestTermDays('30', '2026-10-16')).toBeNull();
    expect(suggestTermDays([], '2026-10-16')).toBeNull();
  });
});
