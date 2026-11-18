import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../test/app.js';
import { Ledger, type SplitRowBody } from '../../test/ledger.js';
import type { Split } from '../applications/applications.types.js';
import type { SupplierList } from '../balances/balances.types.js';

describe('saving a payment', () => {
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

  const save = (body: Record<string, unknown>) =>
    ledger.post('/api/payments', body);

  async function preview(
    supplierId: string,
    amount: string,
    applications: SplitRowBody[] | null,
  ): Promise<Split> {
    const res = await ledger
      .post('/api/applications/preview', {
        source: { kind: 'new_payment', supplierId, amount },
        applications,
      })
      .expect(200);
    return res.body as Split;
  }

  /** Invoice A for 100.00 due 2026-11-05, and invoice B for 50.00 due 2026-11-20. */
  async function aAndB(token?: string) {
    const supplier = await ledger.supplier(token);
    const a = await ledger.invoice(supplier, '100.00', '2026-11-05');
    const b = await ledger.invoice(supplier, '50.00', '2026-11-20');
    return { supplier, a, b };
  }

  async function auditOf(entityIds: string[]) {
    return ledger.prisma.$queryRaw<
      {
        entity: string;
        entity_id: string;
        action: string;
        user_id: string;
        before: unknown;
        amount: string;
      }[]
    >`
      SELECT entity, entity_id, action, user_id, before, after->>'amount' AS amount
      FROM audit_log WHERE entity_id = ANY(${entityIds}::uuid[])
      ORDER BY created_at, entity`;
  }

  describe('the save does what the preview showed', () => {
    it.each(['the suggestion', 'an edited split'])('for %s', async (kind) => {
      const { supplier, a, b } = await aAndB();
      const c = await ledger.invoice(supplier, '30.00', '2026-11-25');
      const rows =
        kind === 'the suggestion'
          ? null
          : [
              { documentId: a, amount: '40.00' },
              { documentId: b, amount: '50.00' },
              { documentId: c, amount: '0' },
            ];
      const shown = await preview(supplier, '120.00', rows);
      expect(shown.errors).toEqual([]);

      const sent = shown.rows.map((r) => ({
        documentId: r.documentId,
        amount: r.amount,
      }));
      const id = await ledger.pay(supplier, '120.00', sent);

      expect(await ledger.applicationsTo([a, b, c])).toEqual(
        shown.rows
          .filter((r) => r.amount !== '0.00')
          .map((r) => [r.documentId, r.amount])
          .sort(),
      );
      const account = await ledger.account(supplier);
      expect(account.payments.find((p) => p.id === id)?.unapplied).toBe(
        shown.unapplied,
      );
      for (const row of shown.rows) {
        const doc = account.documents.find((d) => d.id === row.documentId);
        expect({
          status: doc?.status,
          remaining: doc?.remaining,
          partial: doc?.partial,
        }).toEqual(row.after);
      }
    });
  });

  it('acceptance 1: a transfer of 120.00 leaves A paid and B partial with 30.00 left', async () => {
    const { supplier, a, b } = await aAndB();
    await ledger.pay(supplier, '120.00', [
      { documentId: a, amount: '100.00' },
      { documentId: b, amount: '20.00' },
    ]);
    expect(await ledger.doc(supplier, a)).toMatchObject({
      status: 'paid',
      remaining: '0.00',
    });
    expect(await ledger.doc(supplier, b)).toMatchObject({
      status: 'pending',
      remaining: '30.00',
      partial: true,
    });
  });

  it('acceptance 2: 80.00 that applies nothing stays as credit, in the account and in Resumen', async () => {
    const token = randomUUID();
    const { supplier, a, b } = await aAndB(token);
    const resumen = async () => {
      const res = await ledger.get(`/api/suppliers?q=${token}`).expect(200);
      return (res.body as SupplierList).suppliers[0];
    };
    const before = await ledger.account(supplier);
    expect(before).toMatchObject({ credit: '0.00', balance: '150.00' });

    const id = await ledger.pay(supplier, '80.00', [
      { documentId: a, amount: '0' },
      { documentId: b, amount: '0.00' },
    ]);

    const after = await ledger.account(supplier);
    expect(after).toMatchObject({ credit: '80.00', balance: '70.00' });
    expect(await resumen()).toMatchObject({
      credit: '80.00',
      balance: '70.00',
    });
    expect(after.payments).toEqual([
      expect.objectContaining({ id, status: 'available', unapplied: '80.00' }),
    ]);
    expect(await auditOf([id])).toEqual([
      {
        entity: 'payments',
        entity_id: id,
        action: 'create',
        user_id: ledger.ana.id,
        before: null,
        amount: '80.00',
      },
    ]);
  });

  it('acceptance 3: after acceptance 1, applying 40.00 to B is refused and writes nothing', async () => {
    const { supplier, a, b } = await aAndB();
    await ledger.pay(supplier, '120.00', [
      { documentId: a, amount: '100.00' },
      { documentId: b, amount: '20.00' },
    ]);
    const before = await ledger.writes(supplier);

    const res = await save(
      ledger.paymentBody(supplier, '40.00', [
        { documentId: b, amount: '40.00' },
      ]),
    ).expect(409);
    expect(res.body).toEqual({
      errors: [{ field: `applications.${b}`, code: 'exceeds_remaining' }],
    });
    expect(await ledger.writes(supplier)).toEqual(before);
  });

  it('refuses rows that go over the payment with exceeds_source', async () => {
    const { supplier, a, b } = await aAndB();
    const res = await save(
      ledger.paymentBody(supplier, '120.00', [
        { documentId: a, amount: '100.00' },
        { documentId: b, amount: '50.00' },
      ]),
    ).expect(409);
    expect(res.body).toEqual({
      errors: [{ field: 'applications', code: 'exceeds_source' }],
    });
    expect((await ledger.writes(supplier)).payments).toBe(0);
  });

  it.each([
    ['another supplier’s invoice', 'other'],
    ['a credit note', 'credit'],
  ])(
    'invariants 4 and 5: refuses a row for %s with not_applicable',
    async (_, kind) => {
      const supplier = await ledger.supplier();
      const documentId =
        kind === 'other'
          ? await ledger.invoice(await ledger.supplier(), '50.00', '2026-11-20')
          : await ledger.creditNote(supplier, '50.00');
      const before = await ledger.writes(supplier);

      const res = await save(
        ledger.paymentBody(supplier, '10.00', [
          { documentId, amount: '10.00' },
        ]),
      ).expect(409);
      expect(res.body).toEqual({
        errors: [
          { field: `applications.${documentId}`, code: 'not_applicable' },
        ],
      });
      expect(await ledger.writes(supplier)).toEqual(before);
      expect(await ledger.applicationsTo([documentId])).toEqual([]);
    },
  );

  describe('concurrency', () => {
    it.each([1, 2, 3, 4, 5])(
      'two payments of 60.00 at once on an invoice of 100.00: exactly one wins (run %i)',
      async () => {
        const supplier = await ledger.supplier();
        const invoice = await ledger.invoice(supplier, '100.00', '2026-11-20');
        const body = ledger.paymentBody(supplier, '60.00', [
          { documentId: invoice, amount: '60.00' },
        ]);

        const results = await Promise.all([save(body), save(body)]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const refused = results.find((r) => r.status === 409);
        expect(refused?.body).toEqual({
          errors: [
            { field: `applications.${invoice}`, code: 'exceeds_remaining' },
          ],
        });
        expect(await ledger.applicationsTo([invoice])).toEqual([
          [invoice, '60.00'],
        ]);
        expect((await ledger.writes(supplier)).payments).toBe(1);
      },
    );
  });

  describe('audit', () => {
    it('writes a create entry for the payment and one per application, each by Ana, and none for a row of 0', async () => {
      const { supplier, a, b } = await aAndB();
      const c = await ledger.invoice(supplier, '30.00', '2026-11-25');
      const id = await ledger.pay(supplier, '120.00', [
        { documentId: a, amount: '100.00' },
        { documentId: b, amount: '20.00' },
        { documentId: c, amount: '0' },
      ]);
      const applications = await ledger.prisma.$queryRaw<
        { id: string; document_id: string }[]
      >`
        SELECT id, document_id FROM applications WHERE payment_id = ${id}::uuid`;
      expect(applications.map((x) => x.document_id).sort()).toEqual(
        [a, b].sort(),
      );

      const entries = await auditOf([id, ...applications.map((x) => x.id)]);
      expect(
        entries.map((e) => [e.entity, e.action, e.user_id, e.before]).sort(),
      ).toEqual([
        ['applications', 'create', ledger.ana.id, null],
        ['applications', 'create', ledger.ana.id, null],
        ['payments', 'create', ledger.ana.id, null],
      ]);
      expect(entries.map((e) => e.amount).sort()).toEqual([
        '100.00',
        '120.00',
        '20.00',
      ]);
    });
  });

  describe('field errors', () => {
    let supplier: string;

    beforeAll(async () => {
      supplier = await ledger.supplier();
    });

    it('refuses a paidOn of 2026-02-30 with paid_on_invalid', async () => {
      const res = await save(
        ledger.paymentBody(supplier, '10.00', [], { paidOn: '2026-02-30' }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'paidOn', code: 'paid_on_invalid' }],
      });
    });

    it('refuses an eCheq valueDate of 2026-13-01 with value_date_invalid', async () => {
      const res = await save(
        ledger.paymentBody(supplier, '10.00', [], {
          method: 'echeq',
          valueDate: '2026-13-01',
        }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'valueDate', code: 'value_date_invalid' }],
      });
    });

    it.each(['0', '-5.00', '1,50', '', '1000000000000.00'])(
      'refuses an amount of %j with amount_invalid',
      async (amount) => {
        const res = await save(ledger.paymentBody(supplier, amount, [])).expect(
          400,
        );
        expect(res.body).toEqual({
          errors: [{ field: 'amount', code: 'amount_invalid' }],
        });
      },
    );

    it('gives every field error at once, and writes nothing', async () => {
      const res = await save(
        ledger.paymentBody(supplier, '0', [], { paidOn: 'ayer' }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [
          { field: 'amount', code: 'amount_invalid' },
          { field: 'paidOn', code: 'paid_on_invalid' },
        ],
      });
      expect((await ledger.writes(supplier)).payments).toBe(0);
    });
  });

  describe('malformed requests', () => {
    it.each([
      ['a valueDate on a transfer', { valueDate: '2026-11-20' }],
      ['an unknown method', { method: 'bitcoin' }],
      ['applications: null', { applications: null }],
      ['an unknown key', { extra: true }],
      ['a reference that is a number', { reference: 12 }],
    ])('refuses %s with 400 and no field errors', async (_, overrides) => {
      const supplier = await ledger.supplier();
      const res = await save(
        ledger.paymentBody(supplier, '10.00', [], overrides),
      ).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });

    it('refuses a missing key', async () => {
      const body = ledger.paymentBody(await ledger.supplier(), '10.00', []);
      delete body.notes;
      const res = await save(body).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });

    it('refuses an unknown supplierId', async () => {
      const res = await save(
        ledger.paymentBody(randomUUID(), '10.00', []),
      ).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });
  });

  it('trims the reference and the notes, and keeps an empty one as null', async () => {
    const supplier = await ledger.supplier();
    const res = await save(
      ledger.paymentBody(supplier, '10.00', [], {
        reference: '  0001-23  ',
        notes: '   ',
      }),
    ).expect(201);
    const row = await ledger.prisma.payment.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
    });
    expect(row).toMatchObject({
      reference: '0001-23',
      notes: null,
      createdById: ledger.ana.id,
    });
  });
});
