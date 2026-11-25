import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Test } from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import type {
  SupplierAccount,
  SupplierList,
} from '../balances/balances.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** 12:00 in Buenos Aires on 2026-11-09. */
const NOW = '2026-11-09T15:00:00.000Z';

describe('documents', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let session: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ana = await createUser(app, { name: 'Ana' });
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    session = await signIn(app, ana);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const withSession = (req: Test) => req.set('Cookie', `session=${session}`);

  async function newSupplier(
    paymentTermDays: number | null,
    name = `Panadería ${randomUUID()}`,
  ): Promise<string> {
    const res = await withSession(http().post('/api/suppliers'))
      .send({ name, legalName: null, cuit: null, paymentTermDays, notes: null })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function changeTerm(
    id: string,
    paymentTermDays: number,
  ): Promise<void> {
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    await withSession(http().put(`/api/suppliers/${id}`))
      .send({
        name: row.name,
        legalName: row.legalName,
        cuit: row.cuit,
        paymentTermDays,
        notes: row.notes,
      })
      .expect(204);
  }

  function invoice(
    supplierId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      supplierId,
      type: 'invoice',
      letter: 'A',
      number: '0001-00004521',
      issueDate: '2026-10-09',
      dueDate: null,
      total: '86900.50',
      notes: null,
      ...overrides,
    };
  }

  const post = (body: unknown) =>
    withSession(http().post('/api/documents')).send(body as object);

  async function enter(body: unknown): Promise<string> {
    const res = await post(body).expect(201);
    return (res.body as { id: string }).id;
  }

  const remove = (id: string) =>
    withSession(http().delete(`/api/documents/${id}`));

  async function account(id: string): Promise<SupplierAccount> {
    const res = await withSession(http().get(`/api/suppliers/${id}`)).expect(
      200,
    );
    return res.body as SupplierAccount;
  }

  async function stored(id: string) {
    const row = await prisma.document.findUniqueOrThrow({ where: { id } });
    return {
      ...row,
      dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
      issueDate: row.issueDate?.toISOString().slice(0, 10) ?? null,
    };
  }

  const documentsOf = (supplierId: string) =>
    prisma.document.count({ where: { supplierId } });

  describe('manual entry', () => {
    it('computes the due date from a 30-day term and stores the document as reviewed by Ana', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { total: '86900.5' }));

      const row = await stored(id);
      expect(row).toMatchObject({
        dueDate: '2026-11-08',
        dueDateSource: 'supplier_term',
        source: 'manual',
        reviewStatus: 'reviewed',
        createdById: ana.id,
        reviewedById: ana.id,
        numberNormalized: '000100004521',
        deletedAt: null,
      });
      expect(row.reviewedAt?.toISOString()).toBe(NOW);

      const doc = (await account(supplier)).documents.find((d) => d.id === id);
      expect(doc).toMatchObject({
        status: 'overdue',
        daysToDue: -1,
        total: '86900.50',
      });

      const audit = await prisma.$queryRaw<
        {
          action: string;
          user_id: string;
          before_is_null: boolean;
          total: string;
        }[]
      >`
        SELECT action, user_id::text, before IS NULL AS before_is_null, after->>'total' AS total
        FROM audit_log WHERE entity = 'documents' AND entity_id = ${id}::uuid`;
      expect(audit).toEqual([
        {
          action: 'create',
          user_id: ana.id,
          before_is_null: true,
          total: '86900.50',
        },
      ]);
    });

    it('shows one issued 30 days ago as Sin vencer, due today', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { issueDate: '2026-10-10' }));
      const doc = (await account(supplier)).documents.find((d) => d.id === id);
      expect(doc).toMatchObject({
        dueDate: '2026-11-09',
        status: 'pending',
        daysToDue: 0,
      });
    });

    it.each(['invoice', 'delivery_note'])(
      'keeps a typed due date on a %s over the term, as manual',
      async (type) => {
        const supplier = await newSupplier(30);
        const id = await enter(
          invoice(supplier, { type, dueDate: '2026-12-01' }),
        );
        expect(await stored(id)).toMatchObject({
          type,
          dueDate: '2026-12-01',
          dueDateSource: 'manual',
        });
      },
    );

    it('computes a delivery note due date from the term too', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { type: 'delivery_note' }));
      expect(await stored(id)).toMatchObject({
        dueDate: '2026-11-08',
        dueDateSource: 'supplier_term',
      });
    });

    it('refuses an invoice without a due date from a supplier with no term, and writes nothing', async () => {
      const supplier = await newSupplier(null);
      const res = await post(invoice(supplier)).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'dueDate', code: 'due_date_required' }],
      });
      expect(await documentsOf(supplier)).toBe(0);
    });

    it('saves an invoice with a typed due date from a supplier with no term, as manual', async () => {
      const supplier = await newSupplier(null);
      const id = await enter(invoice(supplier, { dueDate: '2026-11-30' }));
      expect(await stored(id)).toMatchObject({
        dueDate: '2026-11-30',
        dueDateSource: 'manual',
      });
    });

    describe('opening balances never use the term', () => {
      const opening = (supplierId: string, dueDate: string | null) =>
        invoice(supplierId, {
          type: 'opening_balance',
          letter: null,
          number: null,
          issueDate: '2026-11-01',
          dueDate,
        });

      it('saves one without a due date with none, even when the supplier has a term', async () => {
        const supplier = await newSupplier(30);
        const id = await enter(opening(supplier, null));
        expect(await stored(id)).toMatchObject({
          dueDate: null,
          dueDateSource: null,
        });
      });

      it('keeps a typed date as manual', async () => {
        const supplier = await newSupplier(30);
        const id = await enter(opening(supplier, '2026-10-15'));
        expect(await stored(id)).toMatchObject({
          dueDate: '2026-10-15',
          dueDateSource: 'manual',
        });
      });
    });

    it('saves a credit note without a due date', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { type: 'credit_note' }));
      expect(await stored(id)).toMatchObject({
        dueDate: null,
        dueDateSource: null,
      });
    });

    it.each([
      [
        'a credit note with a due date',
        { type: 'credit_note', dueDate: '2026-12-01' },
      ],
      [
        'an opening balance with a letter',
        { type: 'opening_balance', letter: 'A', number: null },
      ],
      [
        'an opening balance with a number',
        { type: 'opening_balance', letter: null },
      ],
      ['an unknown type', { type: 'receipt' }],
      ['an unknown letter', { letter: 'Z' }],
      ['a number as the total', { total: 100 }],
      ['a missing key', { notes: undefined }],
    ])('refuses %s with 400 and no field errors', async (_, overrides) => {
      const supplier = await newSupplier(30);
      const res = await post(invoice(supplier, overrides)).expect(400);
      expect(res.body).toEqual({ errors: [] });
      expect(await documentsOf(supplier)).toBe(0);
    });

    it('refuses an unknown supplier id with 400 and no field errors', async () => {
      const res = await post(invoice(randomUUID())).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });

    it('refuses a supplier id that is not a UUID with 400 and no field errors', async () => {
      const res = await post(invoice('not-a-uuid')).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });

    it("doesn't move existing due dates when the term changes, and uses the new term next", async () => {
      const supplier = await newSupplier(30);
      const first = await enter(invoice(supplier));
      await changeTerm(supplier, 45);
      const second = await enter(
        invoice(supplier, { number: '0001-00004522' }),
      );

      expect((await stored(first)).dueDate).toBe('2026-11-08');
      expect((await stored(second)).dueDate).toBe('2026-11-23');
    });

    describe('duplicate numbers', () => {
      it.each([
        ['the same number', '0001-00004521', 'A'],
        ['the number with other separators', '0001 00004521', 'A'],
        ['no letter on either', '0001-00004521', null],
      ])(
        'refuses %s with 409, and writes nothing',
        async (_, number, letter) => {
          const supplier = await newSupplier(30);
          await enter(invoice(supplier, { letter }));
          const res = await post(invoice(supplier, { number, letter })).expect(
            409,
          );
          expect(res.body).toEqual({
            errors: [{ field: 'number', code: 'duplicate_number' }],
          });
          expect(await documentsOf(supplier)).toBe(1);
        },
      );

      it('accepts the same number with another type, another letter or another supplier', async () => {
        const supplier = await newSupplier(30);
        await enter(invoice(supplier));
        await enter(invoice(supplier, { type: 'delivery_note' }));
        await enter(invoice(supplier, { letter: 'B' }));
        await enter(invoice(await newSupplier(30)));
        expect(await documentsOf(supplier)).toBe(3);
      });

      it('accepts the number again once the first is deleted', async () => {
        const supplier = await newSupplier(30);
        const first = await enter(invoice(supplier));
        await remove(first).expect(204);
        await enter(invoice(supplier));
      });
    });

    it('refuses s/n as the number with number_invalid', async () => {
      const supplier = await newSupplier(30);
      const res = await post(invoice(supplier, { number: 's/n' })).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'number', code: 'number_invalid' }],
      });
    });

    it('saves an empty number as none', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { number: '  ' }));
      expect(await stored(id)).toMatchObject({
        number: null,
        numberNormalized: null,
      });
    });

    it.each(['0', '-5.00', '1.005', '1,50', '', '1000000000000.00'])(
      'refuses a total of %j with total_invalid',
      async (total) => {
        const supplier = await newSupplier(30);
        const res = await post(invoice(supplier, { total })).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'total', code: 'total_invalid' }],
        });
        expect(await documentsOf(supplier)).toBe(0);
      },
    );

    it('stores 999999999999.99 and reads it back exactly', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier, { total: '999999999999.99' }));
      const [row] = await prisma.$queryRaw<{ total: string }[]>`
        SELECT total::text AS total FROM documents WHERE id = ${id}::uuid`;
      expect(row.total).toBe('999999999999.99');
      const doc = (await account(supplier)).documents.find((d) => d.id === id);
      expect(doc?.total).toBe('999999999999.99');
    });

    it.each(['2026-02-30', '1899-12-31', '3000-01-01', ''])(
      'refuses an issue date of %j with issue_date_invalid',
      async (issueDate) => {
        const supplier = await newSupplier(30);
        const res = await post(invoice(supplier, { issueDate })).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'issueDate', code: 'issue_date_invalid' }],
        });
      },
    );

    it('refuses an invalid due date with due_date_invalid', async () => {
      const supplier = await newSupplier(30);
      const res = await post(
        invoice(supplier, { dueDate: '2026-11-31' }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'dueDate', code: 'due_date_invalid' }],
      });
    });

    describe('a due date before the issue date', () => {
      it.each(['invoice', 'delivery_note'])(
        'refuses it on a %s with due_date_before_issue, and writes nothing',
        async (type) => {
          const supplier = await newSupplier(30);
          const res = await post(
            invoice(supplier, {
              type,
              issueDate: '2026-11-10',
              dueDate: '2025-12-10',
            }),
          ).expect(400);
          expect(res.body).toEqual({
            errors: [{ field: 'dueDate', code: 'due_date_before_issue' }],
          });
          expect(await documentsOf(supplier)).toBe(0);
        },
      );

      it('accepts a due date on the issue date', async () => {
        const supplier = await newSupplier(30);
        const id = await enter(
          invoice(supplier, { issueDate: '2026-11-10', dueDate: '2026-11-10' }),
        );
        expect(await stored(id)).toMatchObject({
          dueDate: '2026-11-10',
          dueDateSource: 'manual',
        });
      });

      it('accepts it on an opening balance, which counts as Vencido', async () => {
        const supplier = await newSupplier(30);
        const id = await enter(
          invoice(supplier, {
            type: 'opening_balance',
            letter: null,
            number: null,
            issueDate: '2026-11-09',
            dueDate: '2026-10-31',
          }),
        );
        const doc = (await account(supplier)).documents.find(
          (d) => d.id === id,
        );
        expect(doc?.status).toBe('overdue');
      });

      it('reports only due_date_invalid when the due date is not a date', async () => {
        const supplier = await newSupplier(30);
        const res = await post(
          invoice(supplier, { issueDate: '2026-11-10', dueDate: '2026-02-30' }),
        ).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'dueDate', code: 'due_date_invalid' }],
        });
      });

      it('reports only issue_date_invalid when the issue date is not a date', async () => {
        const supplier = await newSupplier(30);
        const res = await post(
          invoice(supplier, { issueDate: '2026-13-01', dueDate: '2026-01-01' }),
        ).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'issueDate', code: 'issue_date_invalid' }],
        });
      });
    });

    it('gives every field error at once', async () => {
      const supplier = await newSupplier(30);
      const res = await post(
        invoice(supplier, {
          number: 's/n',
          issueDate: '',
          dueDate: 'mañana',
          total: '0',
        }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [
          { field: 'number', code: 'number_invalid' },
          { field: 'issueDate', code: 'issue_date_invalid' },
          { field: 'dueDate', code: 'due_date_invalid' },
          { field: 'total', code: 'total_invalid' },
        ],
      });
    });
  });

  describe('deleting', () => {
    it('soft-deletes the document, drops it from the balances, and audits it', async () => {
      const token = randomUUID();
      const supplier = await newSupplier(30, `Panadería ${token}`);
      const kept = await enter(invoice(supplier, { total: '100.00' }));
      const deleted = await enter(
        invoice(supplier, { number: '0001-00004522', total: '50.00' }),
      );

      vi.setSystemTime('2026-11-09T16:30:00.000Z');
      await remove(deleted).expect(204);

      const row = await stored(deleted);
      expect(row.deletedAt?.toISOString()).toBe('2026-11-09T16:30:00.000Z');

      const result = await account(supplier);
      expect(result.documents.map((d) => d.id)).toEqual([kept]);
      expect(result.balance).toBe('100.00');

      const listRes = await withSession(
        http().get(`/api/suppliers?q=${token}`),
      ).expect(200);
      const list = listRes.body as SupplierList;
      expect(list.suppliers.map((s) => s.balance)).toEqual(['100.00']);

      // `before->>'deleted_at'` alone is also null when `before` is missing,
      // so read its JSON type: 'null' only for a snapshot that has the key.
      const audit = await prisma.$queryRaw<
        {
          user_id: string;
          before_deleted_at: string | null;
          after_deleted_at: string | null;
        }[]
      >`
        SELECT user_id::text, jsonb_typeof(before->'deleted_at') AS before_deleted_at,
               after->>'deleted_at' AS after_deleted_at
        FROM audit_log
        WHERE entity = 'documents' AND entity_id = ${deleted}::uuid AND action = 'delete'`;
      expect(audit).toEqual([
        {
          user_id: ana.id,
          before_deleted_at: 'null',
          after_deleted_at: expect.stringMatching(
            /^2026-11-09T16:30:00/,
          ) as string,
        },
      ]);
    });

    it('returns 404 for a document deleted already, and writes no second entry', async () => {
      const supplier = await newSupplier(30);
      const id = await enter(invoice(supplier));
      await remove(id).expect(204);
      await remove(id).expect(404);
      expect(
        await prisma.auditLog.count({
          where: { entityId: id, action: 'delete' },
        }),
      ).toBe(1);
    });

    it.each([
      ['an unknown id', randomUUID()],
      ['a non-UUID id', 'not-a-uuid'],
    ])('returns 404 for %s', async (_, id) => {
      await remove(id).expect(404);
    });

    describe('invariant 6', () => {
      async function pay(
        supplierId: string,
        amount: string,
        documentId: string,
      ): Promise<void> {
        await withSession(http().post('/api/payments'))
          .send({
            supplierId,
            amount,
            paidOn: '2026-11-09',
            method: 'transfer',
            reference: null,
            valueDate: null,
            notes: null,
            applications: [{ documentId, amount }],
          })
          .expect(201);
      }

      const deletes = (id: string) =>
        prisma.auditLog.count({ where: { entityId: id, action: 'delete' } });

      it('acceptance 4: refuses to delete A once it has a payment, and A still counts', async () => {
        const supplier = await newSupplier(30);
        const a = await enter(invoice(supplier, { total: '100.00' }));
        await pay(supplier, '40.00', a);

        const res = await remove(a).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'document', code: 'document_has_applications' }],
        });
        expect((await stored(a)).deletedAt).toBeNull();
        expect(
          (await account(supplier)).documents.find((d) => d.id === a),
        ).toMatchObject({ remaining: '60.00' });
        expect(await deletes(a)).toBe(0);
      });

      it('refuses to delete a credit note that gave credit', async () => {
        const supplier = await newSupplier(30);
        const target = await enter(invoice(supplier, { total: '100.00' }));
        const note = await enter(
          invoice(supplier, {
            type: 'credit_note',
            number: '0001-00000042',
            total: '30.00',
          }),
        );
        await withSession(http().post('/api/applications'))
          .send({
            source: { kind: 'credit_note', id: note },
            applications: [{ documentId: target, amount: '10.00' }],
          })
          .expect(204);

        const res = await remove(note).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'document', code: 'document_has_applications' }],
        });
        expect(await deletes(note)).toBe(0);
      });

      it('still deletes a document of the same supplier without applications', async () => {
        const supplier = await newSupplier(30);
        const paid = await enter(invoice(supplier, { total: '100.00' }));
        await pay(supplier, '100.00', paid);
        const other = await enter(
          invoice(supplier, { number: '0001-00004522' }),
        );
        await remove(other).expect(204);
      });
    });

    it('leaves one audit entry per step, in order, each by Ana', async () => {
      const supplier = await newSupplier(30);
      const first = await enter(invoice(supplier));
      const second = await enter(
        invoice(supplier, { number: '0001-00004522' }),
      );
      await changeTerm(supplier, 45);
      await remove(first).expect(204);

      const entries = await prisma.$queryRaw<
        { entity: string; entity_id: string; action: string; user_id: string }[]
      >`
        SELECT entity, entity_id::text, action, user_id::text FROM audit_log
        WHERE entity_id = ANY(${[supplier, first, second]}::uuid[])
        ORDER BY created_at, id`;
      expect(entries).toEqual([
        {
          entity: 'suppliers',
          entity_id: supplier,
          action: 'create',
          user_id: ana.id,
        },
        {
          entity: 'documents',
          entity_id: first,
          action: 'create',
          user_id: ana.id,
        },
        {
          entity: 'documents',
          entity_id: second,
          action: 'create',
          user_id: ana.id,
        },
        {
          entity: 'suppliers',
          entity_id: supplier,
          action: 'update',
          user_id: ana.id,
        },
        {
          entity: 'documents',
          entity_id: first,
          action: 'delete',
          user_id: ana.id,
        },
      ]);
    });
  });

  describe('reading one for Documento', () => {
    const read = (id: string) =>
      withSession(http().get(`/api/documents/${id}`));

    it('returns a manual document with its supplier, dates, total, due date and notes, and no images or lines', async () => {
      const name = `Panadería ${randomUUID()}`;
      const supplierId = await newSupplier(30, name);
      const id = await enter(
        invoice(supplierId, {
          number: '0003-00000077',
          notes: 'Pedido de octubre',
        }),
      );
      const res = await read(id).expect(200);
      expect(res.body).toEqual({
        id,
        source: 'manual',
        reviewStatus: 'reviewed',
        type: 'invoice',
        letter: 'A',
        number: '0003-00000077',
        createdByName: 'Ana',
        // NOW is 12:00 in Buenos Aires.
        createdOn: '2026-11-09',
        createdTime: '12:00',
        images: [],
        supplier: { id: supplierId, name },
        issueDate: '2026-10-09',
        dueDate: '2026-11-08',
        dueDateSource: 'supplier_term',
        subtotal: null,
        total: '86900.50',
        cae: null,
        notes: 'Pedido de octubre',
        issues: [],
        lines: [],
        taxes: [],
      });
    });

    it('returns an extracted invoice with its lines by position, at their column scale, and its taxes in order', async () => {
      const name = `Panadería ${randomUUID()}`;
      const supplierId = await newSupplier(30, name);
      const { id } = await prisma.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'error',
          type: 'invoice',
          supplierId,
          letter: 'A',
          number: '0003-00012345',
          numberNormalized: '000300012345',
          issueDate: new Date('2026-10-21T00:00:00Z'),
          subtotal: '41322.31',
          total: '50000',
          cae: '76543210987654',
          issues: [
            { code: 'missing_issue_date' },
            { code: 'duplicate_number' },
          ],
          createdById: ana.id,
          lines: {
            create: [
              {
                position: 2,
                description: 'Aceite',
                quantity: '2.5',
                unitPrice: '10',
                lineTotal: '25',
              },
              {
                position: 1,
                productCode: 'H-000',
                description: 'Harina 000',
                quantity: '4',
                unit: 'un',
                packageText: 'x 25 kg',
                unitPrice: '6198.35',
                ivaRate: '21',
                lineTotal: '24793.4',
              },
            ],
          },
          taxes: {
            create: [
              { kind: 'iibb_perception', label: 'Perc. IIBB', amount: '0' },
              {
                kind: 'iva',
                label: 'IVA 21%',
                rate: '21',
                base: '41322.31',
                amount: '8677.69',
              },
              {
                kind: 'iva',
                label: 'IVA 10,5%',
                rate: '10.5',
                base: '100',
                amount: '10.5',
              },
            ],
          },
        },
      });
      const body = (await read(id).expect(200)).body as Record<string, unknown>;
      expect(body).toMatchObject({
        reviewStatus: 'error',
        supplier: { id: supplierId, name },
        issueDate: '2026-10-21',
        dueDate: null,
        dueDateSource: null,
        subtotal: '41322.31',
        total: '50000.00',
        cae: '76543210987654',
        issues: ['missing_issue_date', 'duplicate_number'],
      });
      expect(body.lines).toEqual([
        {
          position: 1,
          productCode: 'H-000',
          description: 'Harina 000',
          quantity: '4.000',
          unit: 'un',
          packageText: 'x 25 kg',
          unitPrice: '6198.3500',
          ivaRate: '21.00',
          discountPct: null,
          lineTotal: '24793.40',
        },
        {
          position: 2,
          productCode: null,
          description: 'Aceite',
          quantity: '2.500',
          unit: null,
          packageText: null,
          unitPrice: '10.0000',
          ivaRate: null,
          discountPct: null,
          lineTotal: '25.00',
        },
      ]);
      expect(body.taxes).toEqual([
        {
          kind: 'iva',
          label: 'IVA 10,5%',
          rate: '10.50',
          base: '100.00',
          amount: '10.50',
        },
        {
          kind: 'iva',
          label: 'IVA 21%',
          rate: '21.00',
          base: '41322.31',
          amount: '8677.69',
        },
        {
          kind: 'iibb_perception',
          label: 'Perc. IIBB',
          rate: null,
          base: null,
          amount: '0.00',
        },
      ]);
    });

    it.each([
      ['a non-UUID id', 'nope'],
      ['an unknown id', randomUUID()],
    ])('answers 404 for %s', async (_, id) => {
      await read(id).expect(404);
    });

    it('lists an upload’s images by position, whatever order they were stored in', async () => {
      const { id } = await prisma.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'processing',
          createdById: ana.id,
        },
      });
      const imageIds: Record<number, string> = {};
      for (const position of [2, 1]) {
        const image = await prisma.documentImage.create({
          data: {
            documentId: id,
            position,
            storageKey: `${randomUUID()}.jpg`,
            mimeType: 'image/jpeg',
            width: 1650,
            height: 2200,
            sizeBytes: 100,
            sha256: createHash('sha256').update(randomUUID()).digest('hex'),
          },
        });
        imageIds[position] = image.id;
      }
      const res = await read(id).expect(200);
      expect((res.body as { images: unknown }).images).toEqual([
        { id: imageIds[1], position: 1 },
        { id: imageIds[2], position: 2 },
      ]);
    });

    it('answers 404 for a deleted document', async () => {
      const id = await enter(invoice(await newSupplier(30)));
      await remove(id).expect(204);
      await read(id).expect(404);
    });
  });
});
