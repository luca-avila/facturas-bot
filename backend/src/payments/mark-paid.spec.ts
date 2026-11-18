import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../test/app.js';
import { Ledger } from '../../test/ledger.js';

describe('Marcar como pagado', () => {
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

  const markPaid = (
    documentId: string,
    amount: string,
    overrides: Record<string, unknown> = {},
  ) =>
    ledger.post('/api/payments/mark-paid', {
      documentId,
      amount,
      paidOn: '2026-11-09',
      method: 'transfer',
      reference: null,
      valueDate: null,
      ...overrides,
    });

  it('acceptance 6: settles a new invoice of 64,380.00 with one payment and one application, both audited', async () => {
    const supplier = await ledger.supplier();
    const invoice = await ledger.invoice(supplier, '64380.00', '2026-11-30');

    const res = await markPaid(invoice, '64380.00', {
      method: 'echeq',
      reference: '00045',
      valueDate: '2026-11-15',
    }).expect(201);
    const { id } = res.body as { id: string };

    expect(await ledger.doc(supplier, invoice)).toMatchObject({
      status: 'paid',
      remaining: '0.00',
    });
    const payments = await ledger.prisma.payment.findMany({
      where: { supplierId: supplier },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id,
      method: 'echeq',
      reference: '00045',
      notes: null,
      createdById: ledger.ana.id,
    });
    expect(payments[0].valueDate?.toISOString().slice(0, 10)).toBe(
      '2026-11-15',
    );
    expect(await ledger.applicationsTo([invoice])).toEqual([
      [invoice, '64380.00'],
    ]);

    const entries = await ledger.prisma.$queryRaw<
      { entity: string; user_id: string }[]
    >`
      SELECT entity, user_id FROM audit_log
      WHERE entity_id = ${id}::uuid
         OR entity_id IN (SELECT x.id FROM applications x WHERE x.payment_id = ${id}::uuid)
      ORDER BY entity`;
    expect(entries).toEqual([
      { entity: 'applications', user_id: ledger.ana.id },
      { entity: 'payments', user_id: ledger.ana.id },
    ]);
  });

  it('refuses an amount that is not what is left with remaining_changed, and writes nothing', async () => {
    const supplier = await ledger.supplier();
    const b = await ledger.invoice(supplier, '50.00', '2026-11-20');
    await ledger.pay(supplier, '20.00', [{ documentId: b, amount: '20.00' }]);
    const before = await ledger.writes(supplier);

    const res = await markPaid(b, '50.00').expect(409);
    expect(res.body).toEqual({
      errors: [{ field: 'amount', code: 'remaining_changed' }],
    });
    expect(await ledger.writes(supplier)).toEqual(before);
    await markPaid(b, '30.00').expect(201);
  });

  it('refuses a document that is already paid with remaining_changed', async () => {
    const supplier = await ledger.supplier();
    const invoice = await ledger.invoice(supplier, '50.00', '2026-11-20');
    await markPaid(invoice, '50.00').expect(201);
    const res = await markPaid(invoice, '50.00').expect(409);
    expect(res.body).toEqual({
      errors: [{ field: 'amount', code: 'remaining_changed' }],
    });
    expect((await ledger.writes(supplier)).payments).toBe(1);
  });

  it.each([
    ['a credit note', (s: string) => ledger.creditNote(s, '50.00')],
    [
      'a deleted document',
      async (s: string) => {
        const id = await ledger.invoice(s, '50.00', '2026-11-20');
        await ledger.delete(`/api/documents/${id}`).expect(204);
        return id;
      },
    ],
    ['a document in error', (s: string) => ledger.errorDocument(s)],
    ['an unknown id', () => Promise.resolve(randomUUID())],
  ])('refuses %s with not_applicable on documentId', async (_, make) => {
    const supplier = await ledger.supplier();
    const documentId = await make(supplier);
    const res = await markPaid(documentId, '50.00').expect(409);
    expect(res.body).toEqual({
      errors: [{ field: 'documentId', code: 'not_applicable' }],
    });
    expect((await ledger.writes(supplier)).payments).toBe(0);
  });

  it.each([
    ['a notes key, which it has none of', { notes: null }],
    ['a value date on a transfer', { valueDate: '2026-11-15' }],
    ['a non-UUID document id', { documentId: 'nope' }],
  ])('refuses %s with 400 and no field errors', async (_, overrides) => {
    const res = await markPaid(randomUUID(), '50.00', overrides).expect(400);
    expect(res.body).toEqual({ errors: [] });
  });

  it('gives field errors for a bad amount and date', async () => {
    const res = await markPaid(randomUUID(), '0', {
      paidOn: '2026-02-30',
    }).expect(400);
    expect(res.body).toEqual({
      errors: [
        { field: 'amount', code: 'amount_invalid' },
        { field: 'paidOn', code: 'paid_on_invalid' },
      ],
    });
  });
});
