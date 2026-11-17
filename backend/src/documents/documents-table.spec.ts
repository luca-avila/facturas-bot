import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = Record<string, string | null>;

describe('documents table', () => {
  const prisma = new PrismaService();
  let userId: string;

  beforeAll(async () => {
    const [user] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, password_set_at, role)
      VALUES (${`ana-${randomUUID()}@example.com`}, 'Ana', 'not-a-real-hash', now(), 'staff')
      RETURNING id`;
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newSupplier(): Promise<string> {
    const [supplier] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO suppliers (name) VALUES ('Panadería de prueba') RETURNING id`;
    return supplier.id;
  }

  /** A reviewed invoice with every field set, changed by `overrides`. */
  function reviewedInvoice(supplierId: string, overrides: Row = {}): Row {
    return {
      source: 'manual',
      review_status: 'reviewed',
      type: 'invoice',
      supplier_id: supplierId,
      letter: 'A',
      number: '0001-00004521',
      number_normalized: '000100004521',
      issue_date: '2026-10-09',
      due_date: '2026-11-08',
      due_date_source: 'supplier_term',
      total: '100.00',
      created_by: userId,
      reviewed_by: userId,
      reviewed_at: '2026-11-09T12:00:00Z',
      ...overrides,
    };
  }

  const openingBalance = {
    type: 'opening_balance',
    letter: null,
    number: null,
    number_normalized: null,
  };

  async function insert(row: Row): Promise<string> {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    const sql = `INSERT INTO documents (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const [inserted] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...values,
    );
    return inserted.id;
  }

  it('accepts a complete reviewed invoice', async () => {
    await expect(insert(reviewedInvoice(await newSupplier()))).resolves.toEqual(
      expect.any(String),
    );
  });

  describe('invariant 1: counted documents are complete', () => {
    it('refuses a reviewed invoice without a due date', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        due_date: null,
        due_date_source: null,
      });
      await expect(insert(row)).rejects.toThrow(/documents_counted_complete/);
    });

    it('refuses an unreviewed document without a total', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        review_status: 'unreviewed',
        reviewed_by: null,
        reviewed_at: null,
        total: null,
      });
      await expect(insert(row)).rejects.toThrow(/documents_counted_complete/);
    });

    it('accepts a reviewed opening balance without a due date', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        ...openingBalance,
        due_date: null,
        due_date_source: null,
      });
      await expect(insert(row)).resolves.toEqual(expect.any(String));
    });

    it('accepts an error document with nothing but its source', async () => {
      await expect(
        insert({
          source: 'upload',
          review_status: 'error',
          created_by: userId,
        }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('invariant 7: one counted document per number', () => {
    it('refuses two reviewed documents with the same supplier, type, letter and number', async () => {
      const supplierId = await newSupplier();
      await insert(reviewedInvoice(supplierId));
      await expect(insert(reviewedInvoice(supplierId))).rejects.toThrow(
        /documents_number_unique/,
      );
    });

    it('refuses the same with no letter on either', async () => {
      const supplierId = await newSupplier();
      await insert(reviewedInvoice(supplierId, { letter: null }));
      await expect(
        insert(reviewedInvoice(supplierId, { letter: null })),
      ).rejects.toThrow(/documents_number_unique/);
    });

    it('refuses an unreviewed one against a reviewed one', async () => {
      const supplierId = await newSupplier();
      await insert(reviewedInvoice(supplierId));
      const unreviewed = reviewedInvoice(supplierId, {
        review_status: 'unreviewed',
        reviewed_by: null,
        reviewed_at: null,
      });
      await expect(insert(unreviewed)).rejects.toThrow(
        /documents_number_unique/,
      );
    });

    it('lets a deleted one through', async () => {
      const supplierId = await newSupplier();
      await insert(
        reviewedInvoice(supplierId, { deleted_at: '2026-11-10T12:00:00Z' }),
      );
      await expect(insert(reviewedInvoice(supplierId))).resolves.toEqual(
        expect.any(String),
      );
    });

    // NULLS NOT DISTINCT would make these collide without the index's
    // `number_normalized IS NOT NULL`.
    it.each([
      [
        'two opening balances',
        { ...openingBalance, due_date_source: 'manual' },
      ],
      [
        'two delivery notes without a number',
        {
          type: 'delivery_note',
          letter: null,
          number: null,
          number_normalized: null,
        },
      ],
    ])('lets %s from one supplier through', async (_, overrides) => {
      const supplierId = await newSupplier();
      await insert(reviewedInvoice(supplierId, overrides));
      await expect(
        insert(reviewedInvoice(supplierId, overrides)),
      ).resolves.toEqual(expect.any(String));
    });

    it('lets one in error through', async () => {
      const supplierId = await newSupplier();
      await insert(reviewedInvoice(supplierId));
      const inError = reviewedInvoice(supplierId, {
        review_status: 'error',
        reviewed_by: null,
        reviewed_at: null,
      });
      await expect(insert(inError)).resolves.toEqual(expect.any(String));
    });
  });

  describe('invariant 8: reviewed_at and reviewed_by iff reviewed', () => {
    it('refuses a reviewed document without reviewed_by', async () => {
      const row = reviewedInvoice(await newSupplier(), { reviewed_by: null });
      await expect(insert(row)).rejects.toThrow(
        /documents_reviewed_by_iff_reviewed/,
      );
    });

    it('refuses an unreviewed document with reviewed_at and reviewed_by', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        review_status: 'unreviewed',
      });
      await expect(insert(row)).rejects.toThrow(
        /documents_reviewed_by_iff_reviewed/,
      );
    });
  });

  it('refuses a total of 0', async () => {
    const row = reviewedInvoice(await newSupplier(), { total: '0.00' });
    await expect(insert(row)).rejects.toThrow(/documents_total_positive/);
  });

  it('refuses a number_normalized that disagrees with number', async () => {
    const row = reviewedInvoice(await newSupplier(), {
      number_normalized: '100004521',
    });
    await expect(insert(row)).rejects.toThrow(/documents_number_normalized/);
  });

  describe('due-date rules', () => {
    it('refuses a credit note with a due date', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        type: 'credit_note',
        due_date_source: 'manual',
      });
      await expect(insert(row)).rejects.toThrow(
        /documents_credit_note_no_due_date/,
      );
    });

    it('refuses an opening balance with a supplier_term due date', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        ...openingBalance,
        due_date_source: 'supplier_term',
      });
      await expect(insert(row)).rejects.toThrow(
        /documents_opening_balance_no_term/,
      );
    });

    it('refuses a due date without a source', async () => {
      const row = reviewedInvoice(await newSupplier(), {
        due_date_source: null,
      });
      await expect(insert(row)).rejects.toThrow(/documents_due_date_source/);
    });
  });
});
