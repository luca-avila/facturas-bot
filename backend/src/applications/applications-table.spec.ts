import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = Record<string, string | null>;

/**
 * The database's own rules on payments and applications, with rows written
 * directly: the `CHECK`s, the invariant 6 triggers and the foreign keys.
 */
describe('payments and applications tables', () => {
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
      INSERT INTO suppliers (name) VALUES (${`Panadería ${randomUUID()}`}) RETURNING id`;
    return supplier.id;
  }

  async function insert(table: string, row: Row): Promise<string> {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const [inserted] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...columns.map((c) => row[c]),
    );
    return inserted.id;
  }

  /** A reviewed invoice of 100.00, changed by `overrides`. */
  const invoice = (supplierId: string, overrides: Row = {}) =>
    insert('documents', {
      source: 'manual',
      review_status: 'reviewed',
      type: 'invoice',
      supplier_id: supplierId,
      issue_date: '2026-10-09',
      due_date: '2026-11-08',
      due_date_source: 'manual',
      total: '100.00',
      created_by: userId,
      reviewed_by: userId,
      reviewed_at: '2026-11-09T12:00:00Z',
      ...overrides,
    });

  const creditNote = (supplierId: string, total: string) =>
    invoice(supplierId, {
      type: 'credit_note',
      due_date: null,
      due_date_source: null,
      total,
    });

  /** A transfer of 100.00, changed by `overrides`. */
  const payment = (supplierId: string, overrides: Row = {}) =>
    insert('payments', {
      supplier_id: supplierId,
      amount: '100.00',
      paid_on: '2026-11-09',
      method: 'transfer',
      created_by: userId,
      ...overrides,
    });

  const application = (row: Row) => insert('applications', row);

  /** Runs `sql` with `$1` bound to `id`. */
  const update = (sql: string, id: string, ...params: unknown[]) =>
    prisma.$executeRawUnsafe(sql, id, ...params);

  describe('CHECKs', () => {
    let supplierId: string;
    let documentId: string;
    let paymentId: string;
    let creditNoteId: string;

    beforeAll(async () => {
      supplierId = await newSupplier();
      documentId = await invoice(supplierId);
      paymentId = await payment(supplierId);
      creditNoteId = await creditNote(supplierId, '30.00');
    });

    it('refuses an application of 0', async () => {
      await expect(
        application({
          document_id: documentId,
          payment_id: paymentId,
          amount: '0.00',
        }),
      ).rejects.toThrow(/applications_amount_positive/);
    });

    it('refuses an application with both sources', async () => {
      await expect(
        application({
          document_id: documentId,
          payment_id: paymentId,
          credit_note_id: creditNoteId,
          amount: '1.00',
        }),
      ).rejects.toThrow(/applications_one_source/);
    });

    it('refuses an application with no source', async () => {
      await expect(
        application({ document_id: documentId, amount: '1.00' }),
      ).rejects.toThrow(/applications_one_source/);
    });

    it('refuses a payment of 0', async () => {
      await expect(payment(supplierId, { amount: '0.00' })).rejects.toThrow(
        /payments_amount_positive/,
      );
    });

    it('refuses a value date on a transfer', async () => {
      await expect(
        payment(supplierId, { value_date: '2026-11-20' }),
      ).rejects.toThrow(/payments_value_date_echeq_only/);
    });

    it('accepts an eCheq with a value date', async () => {
      await expect(
        payment(supplierId, {
          method: 'echeq',
          reference: '00012345',
          value_date: '2026-11-20',
        }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  /** Each change, as SQL on `$1`, with the column values it needs. */
  const documentChanges: Record<
    string,
    (other: string) => [string, ...unknown[]]
  > = {
    'a soft delete': () => [
      `UPDATE documents SET deleted_at = now() WHERE id = $1`,
    ],
    'a supplier change': (other) => [
      `UPDATE documents SET supplier_id = $2::uuid WHERE id = $1`,
      other,
    ],
    'a type change': () => [
      `UPDATE documents SET type = 'delivery_note' WHERE id = $1`,
    ],
    'a total below what is applied': () => [
      `UPDATE documents SET total = 90.00 WHERE id = $1`,
    ],
    'moving to error': () => [
      `UPDATE documents SET review_status = 'error', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
    ],
    'moving to processing': () => [
      `UPDATE documents SET review_status = 'processing', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
    ],
  };

  describe('documents_keep_applied, on a document that received applications', () => {
    async function applied(): Promise<{ id: string; other: string }> {
      const supplierId = await newSupplier();
      const id = await invoice(supplierId);
      const paymentId = await payment(supplierId);
      await application({
        document_id: id,
        payment_id: paymentId,
        amount: '100.00',
      });
      return { id, other: await newSupplier() };
    }

    it.each(Object.entries(documentChanges))(
      'refuses %s',
      async (_, change) => {
        const { id, other } = await applied();
        const [sql, ...params] = change(other);
        await expect(update(sql, id, ...params)).rejects.toThrow(
          /documents_keep_applied/,
        );
      },
    );

    it('accepts a total equal to what is applied', async () => {
      const { id } = await applied();
      await expect(
        update(`UPDATE documents SET total = 100.00 WHERE id = $1`, id),
      ).resolves.toBe(1);
    });

    it('accepts a notes change', async () => {
      const { id } = await applied();
      await expect(
        update(`UPDATE documents SET notes = 'Pagada' WHERE id = $1`, id),
      ).resolves.toBe(1);
    });

    it('accepts reviewed to unreviewed, with reviewed_* cleared', async () => {
      const { id } = await applied();
      await expect(
        update(
          `UPDATE documents SET review_status = 'unreviewed', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
          id,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('documents_keep_applied, on a credit note that gave credit', () => {
    async function given(): Promise<{ id: string; other: string }> {
      const supplierId = await newSupplier();
      const id = await creditNote(supplierId, '50.00');
      await application({
        document_id: await invoice(supplierId),
        credit_note_id: id,
        amount: '20.00',
      });
      return { id, other: await newSupplier() };
    }

    it.each([
      [
        'a soft delete',
        `UPDATE documents SET deleted_at = now() WHERE id = $1`,
      ],
      [
        'a total below what it gave',
        `UPDATE documents SET total = 19.99 WHERE id = $1`,
      ],
      [
        'moving to error',
        `UPDATE documents SET review_status = 'error', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`,
      ],
    ])('refuses %s', async (_, sql) => {
      const { id } = await given();
      await expect(update(sql, id)).rejects.toThrow(/documents_keep_applied/);
    });

    it('refuses a supplier change', async () => {
      const { id, other } = await given();
      await expect(
        update(
          `UPDATE documents SET supplier_id = $2::uuid WHERE id = $1`,
          id,
          other,
        ),
      ).rejects.toThrow(/documents_keep_applied/);
    });

    it('accepts a total equal to what it gave', async () => {
      const { id } = await given();
      await expect(
        update(`UPDATE documents SET total = 20.00 WHERE id = $1`, id),
      ).resolves.toBe(1);
    });
  });

  describe('documents_keep_applied, on a document without applications', () => {
    it.each(Object.entries(documentChanges))(
      'accepts %s',
      async (_, change) => {
        const supplierId = await newSupplier();
        const id = await invoice(supplierId);
        const [sql, ...params] = change(await newSupplier());
        await expect(update(sql, id, ...params)).resolves.toBe(1);
      },
    );

    it('accepts any change to a credit note that gave nothing', async () => {
      const id = await creditNote(await newSupplier(), '50.00');
      await expect(
        update(
          `UPDATE documents SET total = 1.00, deleted_at = now() WHERE id = $1`,
          id,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('payments_keep_applied', () => {
    async function given(): Promise<{ id: string; other: string }> {
      const supplierId = await newSupplier();
      const id = await payment(supplierId);
      await application({
        document_id: await invoice(supplierId),
        payment_id: id,
        amount: '60.00',
      });
      return { id, other: await newSupplier() };
    }

    it.each([
      ['a soft delete', `UPDATE payments SET deleted_at = now() WHERE id = $1`],
      [
        'an amount below what it gave',
        `UPDATE payments SET amount = 59.99 WHERE id = $1`,
      ],
    ])('refuses %s', async (_, sql) => {
      const { id } = await given();
      await expect(update(sql, id)).rejects.toThrow(/payments_keep_applied/);
    });

    it('refuses a supplier change', async () => {
      const { id, other } = await given();
      await expect(
        update(
          `UPDATE payments SET supplier_id = $2::uuid WHERE id = $1`,
          id,
          other,
        ),
      ).rejects.toThrow(/payments_keep_applied/);
    });

    it('accepts an amount equal to what it gave', async () => {
      const { id } = await given();
      await expect(
        update(`UPDATE payments SET amount = 60.00 WHERE id = $1`, id),
      ).resolves.toBe(1);
    });

    it('accepts a notes change', async () => {
      const { id } = await given();
      await expect(
        update(`UPDATE payments SET notes = 'Transferencia' WHERE id = $1`, id),
      ).resolves.toBe(1);
    });

    it('accepts any change to a payment that gave nothing', async () => {
      const id = await payment(await newSupplier());
      await expect(
        update(
          `UPDATE payments SET amount = 1.00, deleted_at = now() WHERE id = $1`,
          id,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('hard deletes', () => {
    let documentId: string;
    let creditNoteId: string;
    let paymentId: string;

    beforeAll(async () => {
      const supplierId = await newSupplier();
      documentId = await invoice(supplierId);
      creditNoteId = await creditNote(supplierId, '30.00');
      paymentId = await payment(supplierId);
      await application({
        document_id: documentId,
        payment_id: paymentId,
        amount: '10.00',
      });
      await application({
        document_id: documentId,
        credit_note_id: creditNoteId,
        amount: '10.00',
      });
    });

    it.each([
      [
        'a document',
        'documents',
        () => documentId,
        /applications_document_id_fkey/,
      ],
      [
        'a credit note',
        'documents',
        () => creditNoteId,
        /applications_credit_note_id_fkey/,
      ],
      [
        'a payment',
        'payments',
        () => paymentId,
        /applications_payment_id_fkey/,
      ],
    ])(
      'refuses to delete %s that has applications',
      async (_, table, id, key) => {
        await expect(
          prisma.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE id = $1::uuid`,
            id(),
          ),
        ).rejects.toThrow(key);
      },
    );
  });
});
