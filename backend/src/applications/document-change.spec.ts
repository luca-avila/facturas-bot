import { ConflictException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../test/app.js';
import { Ledger } from '../../test/ledger.js';
import { Money } from '../common/money.js';
import {
  ApplicationsService,
  type DocumentChange,
} from './applications.service.js';

/**
 * Invariant 6 as slice 6's edit will call it: `assertDocumentChange` inside
 * a transaction, through the real Nest module. Slice 3 only deletes.
 */
describe('assertDocumentChange', () => {
  let app: NestExpressApplication;
  let ledger: Ledger;
  let applications: ApplicationsService;

  beforeAll(async () => {
    app = await createTestApp();
    ledger = new Ledger(app);
    applications = app.get(ApplicationsService);
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

  /** The 409 body, or null when the change is accepted. */
  async function check(
    documentId: string,
    change: DocumentChange,
  ): Promise<unknown> {
    try {
      await ledger.prisma.$transaction((tx) =>
        applications.assertDocumentChange(tx, documentId, change),
      );
      return null;
    } catch (error) {
      if (error instanceof ConflictException) return error.getResponse();
      throw error;
    }
  }

  const refused = {
    errors: [{ field: 'document', code: 'document_has_applications' }],
  };
  const m = (amount: string) => Money.fromString(amount);

  describe('a document that received 100.00', () => {
    let supplier: string;
    let other: string;
    let a: string;

    beforeAll(async () => {
      await ledger.signInAtNow();
      supplier = await ledger.supplier();
      other = await ledger.supplier();
      a = await ledger.invoice(supplier, '100.00', '2026-11-20');
      await ledger.pay(supplier, '100.00', [
        { documentId: a, amount: '100.00' },
      ]);
    });

    it.each<[string, () => DocumentChange]>([
      ['deleting it', () => ({ delete: true })],
      ['changing its supplier', () => ({ supplierId: other })],
      ['changing its type', () => ({ type: 'delivery_note' })],
      [
        'lowering its total from 100.00 to 90.00',
        () => ({ total: m('90.00') }),
      ],
      ['moving it to error', () => ({ reviewStatus: 'error' })],
      ['moving it to processing', () => ({ reviewStatus: 'processing' })],
    ])('refuses %s', async (_, change) => {
      expect(await check(a, change())).toEqual(refused);
    });

    it.each<[string, () => DocumentChange]>([
      ['a total equal to what is applied', () => ({ total: m('100.00') })],
      [
        'the same supplier and type',
        () => ({ supplierId: supplier, type: 'invoice' }),
      ],
      ['going back to unreviewed', () => ({ reviewStatus: 'unreviewed' })],
    ])('accepts %s', async (_, change) => {
      expect(await check(a, change())).toBeNull();
    });
  });

  describe('a credit note that gave 20.00', () => {
    let other: string;
    let note: string;

    beforeAll(async () => {
      await ledger.signInAtNow();
      const supplier = await ledger.supplier();
      other = await ledger.supplier();
      note = await ledger.creditNote(supplier, '50.00');
      const invoice = await ledger.invoice(supplier, '100.00', '2026-11-20');
      await ledger
        .post('/api/applications', {
          source: { kind: 'credit_note', id: note },
          applications: [{ documentId: invoice, amount: '20.00' }],
        })
        .expect(204);
    });

    it.each<[string, () => DocumentChange]>([
      ['deleting it', () => ({ delete: true })],
      ['changing its supplier', () => ({ supplierId: other })],
      ['lowering its total below 20.00', () => ({ total: m('19.99') })],
    ])('refuses %s', async (_, change) => {
      expect(await check(note, change())).toEqual(refused);
    });

    it('accepts a total equal to what it gave', async () => {
      expect(await check(note, { total: m('20.00') })).toBeNull();
    });
  });

  it.each<[string, DocumentChange]>([
    ['deleting it', { delete: true }],
    [
      'changing its type and total',
      { type: 'delivery_note', total: m('1.00') },
    ],
    ['moving it to error', { reviewStatus: 'error' }],
  ])(
    'accepts any change to a document without applications: %s',
    async (_, change) => {
      const supplier = await ledger.supplier();
      const id = await ledger.invoice(supplier, '100.00', '2026-11-20');
      expect(await check(id, change)).toBeNull();
    },
  );
});
