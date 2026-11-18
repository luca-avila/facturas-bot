import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../test/app.js';
import { Ledger, type SplitRowBody } from '../../test/ledger.js';
import type { Split } from './applications.types.js';

describe('suggesting and previewing a split', () => {
  let app: NestExpressApplication;
  let ledger: Ledger;

  beforeAll(async () => {
    app = await createTestApp();
    ledger = new Ledger(app);
    await ledger.createAna();
  });

  beforeEach(async () => {
    await ledger.signInAtNow();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  const newPayment = (supplierId: string, amount: string) => ({
    kind: 'new_payment',
    supplierId,
    amount,
  });

  async function preview(
    supplierId: string,
    amount: string,
    applications: SplitRowBody[] | null = null,
  ): Promise<Split> {
    const res = await ledger
      .post('/api/applications/preview', {
        source: newPayment(supplierId, amount),
        applications,
      })
      .expect(200);
    return res.body as Split;
  }

  const amounts = (split: Split) =>
    split.rows.map((row) => [row.documentId, row.amount]);

  /** Invoice A for 100.00 due 2026-11-05, and invoice B for 50.00 due 2026-11-20. */
  async function aAndB(): Promise<{ supplier: string; a: string; b: string }> {
    const supplier = await ledger.supplier();
    const a = await ledger.invoice(supplier, '100.00', '2026-11-05');
    const b = await ledger.invoice(supplier, '50.00', '2026-11-20');
    return { supplier, a, b };
  }

  it('acceptance 1: suggests 100.00 for A and 20.00 for B out of 120.00, and what each becomes', async () => {
    const { supplier, a, b } = await aAndB();
    const split = await preview(supplier, '120.00');

    expect(split).toEqual({
      available: '120.00',
      applied: '120.00',
      unapplied: '0.00',
      excess: '0.00',
      errors: [],
      rows: [
        {
          documentId: a,
          type: 'invoice',
          letter: null,
          number: null,
          issueDate: '2026-10-01',
          dueDate: '2026-11-05',
          daysToDue: -4,
          status: 'overdue',
          remaining: '100.00',
          amount: '100.00',
          after: { status: 'paid', remaining: '0.00', partial: false },
        },
        {
          documentId: b,
          type: 'invoice',
          letter: null,
          number: null,
          issueDate: '2026-10-01',
          dueDate: '2026-11-20',
          daysToDue: 11,
          status: 'pending',
          remaining: '50.00',
          amount: '20.00',
          after: { status: 'pending', remaining: '30.00', partial: true },
        },
      ],
    });
  });

  describe('order', () => {
    it('puts an undated opening balance at its issue date, between the invoices due either side', async () => {
      const supplier = await ledger.supplier();
      const later = await ledger.invoice(supplier, '10.00', '2026-10-15');
      const opening = await ledger.openingBalance(
        supplier,
        '40.00',
        '2026-09-30',
        null,
      );
      const earlier = await ledger.invoice(
        supplier,
        '10.00',
        '2026-09-29',
        '2026-09-01',
      );

      const split = await preview(supplier, '1.00');
      expect(split.rows.map((r) => r.documentId)).toEqual([
        earlier,
        opening,
        later,
      ]);
      expect(amounts(split)).toEqual([
        [earlier, '1.00'],
        [opening, '0.00'],
        [later, '0.00'],
      ]);
    });

    it('breaks ties by issue date, then creation, and Proveedor lists them the same way', async () => {
      const supplier = await ledger.supplier();
      const laterIssue = await ledger.invoice(
        supplier,
        '10.00',
        '2026-11-20',
        '2026-10-10',
      );
      ledger.tick();
      const firstCreated = await ledger.invoice(
        supplier,
        '10.00',
        '2026-11-20',
        '2026-10-05',
      );
      ledger.tick();
      const createdNext = await ledger.invoice(
        supplier,
        '10.00',
        '2026-11-20',
        '2026-10-05',
      );

      const order = [firstCreated, createdNext, laterIssue];
      const split = await preview(supplier, '1.00');
      expect(split.rows.map((r) => r.documentId)).toEqual(order);
      const account = await ledger.account(supplier);
      expect(account.documents.map((d) => d.id)).toEqual(order);
    });
  });

  it('stops when the money runs out: 50.00 gives A 50.00 and B 0.00', async () => {
    const { supplier, a, b } = await aAndB();
    const split = await preview(supplier, '50.00');
    expect(amounts(split)).toEqual([
      [a, '50.00'],
      [b, '0.00'],
    ]);
    expect(split.rows[1].after).toEqual({
      status: 'pending',
      remaining: '50.00',
      partial: false,
    });
  });

  it('leaves what is over as credit: 200.00 leaves 50.00', async () => {
    const { supplier } = await aAndB();
    const split = await preview(supplier, '200.00');
    expect(split).toMatchObject({ applied: '150.00', unapplied: '50.00' });
  });

  it('leaves out paid documents, credit notes, deleted, processing and error ones, and other suppliers', async () => {
    const supplier = await ledger.supplier();
    const open = await ledger.invoice(supplier, '30.00', '2026-11-20');
    const paid = await ledger.invoice(supplier, '20.00', '2026-11-01');
    await ledger.pay(supplier, '20.00', [
      { documentId: paid, amount: '20.00' },
    ]);
    await ledger.creditNote(supplier, '10.00');
    const deleted = await ledger.invoice(supplier, '10.00', '2026-11-02');
    await ledger.delete(`/api/documents/${deleted}`).expect(204);
    await ledger.errorDocument(supplier);
    await ledger.insertDocument(supplier, {
      review_status: 'processing',
      source: 'upload',
      reviewed_by: null,
      reviewed_at: null,
    });
    await ledger.invoice(await ledger.supplier(), '10.00', '2026-11-02');

    const split = await preview(supplier, '100.00');
    expect(split.rows.map((r) => r.documentId)).toEqual([open]);
  });

  it('gives no rows and leaves the whole amount without open documents', async () => {
    const split = await preview(await ledger.supplier(), '80.00');
    expect(split).toEqual({
      available: '80.00',
      applied: '0.00',
      unapplied: '80.00',
      excess: '0.00',
      rows: [],
      errors: [],
    });
  });

  describe('edited rows', () => {
    it('returns the rows as typed, with their after, and a row of 0 stays as it is now', async () => {
      const { supplier, a, b } = await aAndB();
      const split = await preview(supplier, '120.00', [
        { documentId: a, amount: '0' },
        { documentId: b, amount: '50' },
      ]);
      expect(split).toMatchObject({
        applied: '50.00',
        unapplied: '70.00',
        errors: [],
      });
      expect(split.rows).toMatchObject([
        {
          documentId: a,
          amount: '0.00',
          status: 'overdue',
          remaining: '100.00',
          after: { status: 'overdue', remaining: '100.00', partial: false },
        },
        {
          documentId: b,
          amount: '50.00',
          after: { status: 'paid', remaining: '0.00', partial: false },
        },
      ]);
    });

    it('leaves 5.00 from 100.00 for A and 15.00 for B out of 120.00 (7d)', async () => {
      const { supplier, a, b } = await aAndB();
      const split = await preview(supplier, '120.00', [
        { documentId: a, amount: '100.00' },
        { documentId: b, amount: '15.00' },
      ]);
      expect(split).toMatchObject({
        applied: '115.00',
        unapplied: '5.00',
        excess: '0.00',
        errors: [],
      });
      expect(split.rows[1].after).toEqual({
        status: 'pending',
        remaining: '35.00',
        partial: true,
      });
    });

    it('treats a document left out as 0', async () => {
      const { supplier, a, b } = await aAndB();
      const split = await preview(supplier, '120.00', [
        { documentId: b, amount: '10.00' },
      ]);
      expect(amounts(split)).toEqual([
        [a, '0.00'],
        [b, '10.00'],
      ]);
    });
  });

  describe('errors, with status 200', () => {
    it('gives exceeds_remaining for 60.00 on B, and keeps B as it is', async () => {
      const { supplier, a, b } = await aAndB();
      const split = await preview(supplier, '120.00', [
        { documentId: a, amount: '0' },
        { documentId: b, amount: '60.00' },
      ]);
      expect(split.errors).toEqual([
        { field: `applications.${b}`, code: 'exceeds_remaining' },
      ]);
      expect(split.rows[1]).toMatchObject({
        amount: '60.00',
        after: { status: 'pending', remaining: '50.00', partial: false },
      });
    });

    it('gives exceeds_source when the rows add up to 160.00 out of 120.00', async () => {
      const { supplier, a, b } = await aAndB();
      const extra = await ledger.invoice(supplier, '10.00', '2026-11-25');
      const split = await preview(supplier, '120.00', [
        { documentId: a, amount: '100.00' },
        { documentId: b, amount: '50.00' },
        { documentId: extra, amount: '10.00' },
      ]);
      expect(split).toMatchObject({
        applied: '160.00',
        unapplied: '0.00',
        excess: '40.00',
        errors: [{ field: 'applications', code: 'exceeds_source' }],
      });
    });

    it.each([
      ['another supplier’s invoice', 'other'],
      ['a credit note', 'credit'],
      ['a deleted document', 'deleted'],
      ['a document in error', 'error'],
    ])('gives not_applicable on the row for %s', async (_, kind) => {
      const supplier = await ledger.supplier();
      let documentId: string;
      if (kind === 'other') {
        documentId = await ledger.invoice(
          await ledger.supplier(),
          '10.00',
          '2026-11-20',
        );
      } else if (kind === 'credit') {
        documentId = await ledger.creditNote(supplier, '10.00');
      } else if (kind === 'deleted') {
        documentId = await ledger.invoice(supplier, '10.00', '2026-11-20');
        await ledger.delete(`/api/documents/${documentId}`).expect(204);
      } else {
        documentId = await ledger.errorDocument(supplier);
      }
      const split = await preview(supplier, '10.00', [
        { documentId, amount: '5.00' },
      ]);
      expect(split.errors).toEqual([
        { field: `applications.${documentId}`, code: 'not_applicable' },
      ]);
      expect(split.rows).toEqual([]);
    });
  });

  it('writes nothing: no payment, no application, no audit entry', async () => {
    const { supplier, a } = await aAndB();
    const before = await ledger.writes(supplier);
    await preview(supplier, '120.00');
    await preview(supplier, '120.00', [{ documentId: a, amount: '100.00' }]);
    expect(await ledger.writes(supplier)).toEqual(before);
    expect(before.payments).toBe(0);
  });

  describe('malformed requests', () => {
    it.each([
      [
        'an unknown supplierId',
        () =>
          Promise.resolve({
            source: newPayment('00000000-0000-4000-8000-000000000000', '1.00'),
            applications: null,
          }),
      ],
      [
        'a source with an extra key',
        async () => ({
          source: { ...newPayment(await ledger.supplier(), '1.00'), id: null },
          applications: null,
        }),
      ],
      [
        'repeated document ids',
        async () => {
          const { supplier, a } = await aAndB();
          return {
            source: newPayment(supplier, '1.00'),
            applications: [
              { documentId: a, amount: '1.00' },
              { documentId: a.toUpperCase(), amount: '0' },
            ],
          };
        },
      ],
      [
        'a non-UUID document id',
        async () => ({
          source: newPayment(await ledger.supplier(), '1.00'),
          applications: [{ documentId: 'not-a-uuid', amount: '1.00' }],
        }),
      ],
      [
        'a row amount that is a number',
        async () => {
          const { supplier, a } = await aAndB();
          return {
            source: newPayment(supplier, '1.00'),
            applications: [{ documentId: a, amount: 1 }],
          };
        },
      ],
      [
        'an unknown source kind',
        () =>
          Promise.resolve({
            source: {
              kind: 'refund',
              id: '00000000-0000-4000-8000-000000000000',
            },
            applications: null,
          }),
      ],
    ])('refuses %s with 400 and no field errors', async (_, body) => {
      const res = await ledger
        .post('/api/applications/preview', await body())
        .expect(400);
      expect(res.body).toEqual({ errors: [] });
    });
  });

  it('gives amount_invalid for an amount of "0", and application_amount_invalid for a row of "-1.00"', async () => {
    const { supplier, a } = await aAndB();
    const res = await ledger
      .post('/api/applications/preview', {
        source: newPayment(supplier, '0'),
        applications: [{ documentId: a, amount: '-1.00' }],
      })
      .expect(400);
    expect(res.body).toEqual({
      errors: [
        { field: 'amount', code: 'amount_invalid' },
        { field: `applications.${a}`, code: 'application_amount_invalid' },
      ],
    });
  });
});
