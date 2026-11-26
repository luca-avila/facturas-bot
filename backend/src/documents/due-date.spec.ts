import {
  resolveDueDate,
  type StoredDueDate,
  suggestTermDays,
} from './due-date.js';

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

describe('resolveDueDate for an edit', () => {
  // Stored 30 days apart. The supplier's term is now 45.
  const stored: StoredDueDate = {
    type: 'invoice',
    supplierId: 'supplier-a',
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    source: 'supplier_term',
  };
  const edit = (changes: Partial<StoredDueDate> = {}) => ({
    supplierId: 'supplier-a',
    stored: { ...stored, ...changes },
  });
  const issueDate = '2026-10-09';
  const kept = { dueDate: '2026-11-08', source: 'supplier_term' };
  const current = { dueDate: '2026-11-23', source: 'supplier_term' };

  it("keeps the stored term, not the supplier's current one, when the supplier stays", () => {
    for (const type of ['invoice', 'delivery_note'] as const) {
      for (const storedType of ['invoice', 'delivery_note'] as const) {
        expect(
          resolveDueDate({
            type,
            issueDate,
            typedDueDate: null,
            paymentTermDays: 45,
            edit: edit({ type: storedType }),
          }),
        ).toEqual(kept);
      }
    }
  });

  it('keeps the stored term when the supplier no longer has one', () => {
    expect(
      resolveDueDate({
        type: 'invoice',
        issueDate,
        typedDueDate: null,
        paymentTermDays: null,
        edit: edit(),
      }),
    ).toEqual(kept);
  });

  it('keeps a stored term of 0', () => {
    expect(
      resolveDueDate({
        type: 'invoice',
        issueDate,
        typedDueDate: null,
        paymentTermDays: 45,
        edit: edit({ dueDate: '2026-10-01' }),
      }),
    ).toEqual({ dueDate: issueDate, source: 'supplier_term' });
  });

  it.each([
    ['the supplier changes', { supplierId: 'supplier-b' }],
    ['the stored date was typed', { source: 'manual' }],
    ['the stored date has no source', { source: null }],
    ['the stored type is an opening balance', { type: 'opening_balance' }],
    ['the stored type is a credit note', { type: 'credit_note' }],
    ['there was no stored type', { type: null }],
    ['there was no stored issue date', { issueDate: null }],
    ['there was no stored due date', { dueDate: null }],
  ] as const)("uses the supplier's current term when %s", (_, changes) => {
    expect(
      resolveDueDate({
        type: 'invoice',
        issueDate,
        typedDueDate: null,
        paymentTermDays: 45,
        edit: edit(changes),
      }),
    ).toEqual(current);
  });

  it('lets a typed date win over the stored term', () => {
    expect(
      resolveDueDate({
        type: 'invoice',
        issueDate,
        typedDueDate: '2026-12-01',
        paymentTermDays: 45,
        edit: edit(),
      }),
    ).toEqual({ dueDate: '2026-12-01', source: 'manual' });
  });

  it('never gives an opening balance or a credit note the stored term', () => {
    for (const type of ['opening_balance', 'credit_note'] as const) {
      expect(
        resolveDueDate({
          type,
          issueDate,
          typedDueDate: null,
          paymentTermDays: 45,
          edit: edit(),
        }),
      ).toEqual({ dueDate: null, source: null });
    }
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
