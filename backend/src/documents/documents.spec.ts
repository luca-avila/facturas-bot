import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Test } from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import { invoiceOutput } from '../../test/extraction-outputs.js';
import { FakeLlm } from '../../test/fake-llm.js';
import { jpeg } from '../../test/photos.js';
import { createTestWorker } from '../../test/worker.js';
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
        reviewedByName: 'Ana',
        reviewedOn: '2026-11-09',
        reviewedTime: '12:00',
        images: [],
        supplier: { id: supplierId, name, paymentTermDays: 30 },
        issueDate: '2026-10-09',
        dueDate: '2026-11-08',
        dueDateSource: 'supplier_term',
        subtotal: null,
        total: '86900.50',
        appliedAmount: '0.00',
        suggestedTermDays: null,
        cae: null,
        notes: 'Pedido de octubre',
        issues: [],
        acceptedIssues: [],
        suspectedDuplicate: null,
        consistencySummary: {
          taxSum: null,
          subtotalPlusTaxes: null,
          lineTotalSum: null,
        },
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
        reviewedByName: null,
        reviewedOn: null,
        reviewedTime: null,
        supplier: { id: supplierId, name, paymentTermDays: 30 },
        issueDate: '2026-10-21',
        dueDate: null,
        dueDateSource: null,
        subtotal: '41322.31',
        total: '50000.00',
        appliedAmount: '0.00',
        suggestedTermDays: null,
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
      expect(body.consistencySummary).toEqual({
        taxSum: '8688.19',
        subtotalPlusTaxes: '50010.50',
        lineTotalSum: '24818.40',
      });
    });

    it('separates open issues from acceptedIssues with user name and Buenos Aires time, and resolves suspectedDuplicate', async () => {
      const supplierId = await newSupplier(30);
      const existingId = await enter(
        invoice(supplierId, {
          type: 'delivery_note',
          letter: 'X',
          number: null,
          issueDate: '2026-10-15',
          total: '12345.67',
        }),
      );
      const { id } = await prisma.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'error',
          type: 'delivery_note',
          supplierId,
          letter: 'X',
          number: null,
          numberNormalized: null,
          issueDate: new Date('2026-10-15T00:00:00Z'),
          total: '12345.67',
          issues: [
            { code: 'duplicate_suspected' },
            {
              code: 'wrong_recipient',
              acceptedBy: ana.id,
              acceptedAt: '2026-11-10T02:15:00.000Z',
            },
          ],
          createdById: ana.id,
        },
      });

      const res = await read(id).expect(200);
      expect(res.body).toMatchObject({
        issues: ['duplicate_suspected'],
        acceptedIssues: [
          {
            code: 'wrong_recipient',
            acceptedByName: 'Ana',
            acceptedOn: '2026-11-09',
            acceptedTime: '23:15',
          },
        ],
        suspectedDuplicate: {
          id: existingId,
          type: 'delivery_note',
          letter: 'X',
          number: null,
          issueDate: '2026-10-15',
          total: '12345.67',
        },
      });
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

    it('includes appliedAmount for invoices and credit notes, and suggestedTermDays from the latest succeeded job', async () => {
      const supplierId = await newSupplier(null);
      const invId = await enter(
        invoice(supplierId, {
          dueDate: '2026-11-08',
          total: '1000.00',
        }),
      );
      const cnId = await enter({
        supplierId,
        type: 'credit_note',
        letter: 'A',
        number: '0003-00000099',
        issueDate: '2026-10-10',
        dueDate: null,
        total: '400.00',
        notes: null,
      });
      await prisma.application.create({
        data: {
          creditNoteId: cnId,
          documentId: invId,
          amount: '250.00',
        },
      });
      await prisma.extractionJob.create({
        data: {
          documentId: invId,
          status: 'succeeded',
          attempts: 1,
          runAfter: new Date(NOW),
          model: 'claude-haiku-5-5',
          promptVersion: '1',
          rawOutput: { printedTermDays: 45 },
        },
      });

      const invBody = (await read(invId).expect(200)).body as Record<
        string,
        unknown
      >;
      expect(invBody).toMatchObject({
        appliedAmount: '250.00',
        suggestedTermDays: 45,
        reviewedByName: 'Ana',
      });
      const cnBody = (await read(cnId).expect(200)).body as Record<
        string,
        unknown
      >;
      expect(cnBody).toMatchObject({
        appliedAmount: '250.00',
        suggestedTermDays: null,
      });
    });
  });

  describe('PUT /api/documents/:id, POST /review, and POST /retry', () => {
    const put = (id: string, body: unknown) =>
      withSession(http().put(`/api/documents/${id}`)).send(body as object);
    const review = (id: string) =>
      withSession(http().post(`/api/documents/${id}/review`)).send({});
    const retry = (id: string) =>
      withSession(http().post(`/api/documents/${id}/retry`)).send({});

    function editPayload(
      supplierId: string | null,
      overrides: Record<string, unknown> = {},
    ) {
      return {
        supplierId,
        type: 'invoice',
        letter: 'A',
        number: '0001-00004521',
        issueDate: '2026-10-09',
        dueDate: null,
        dueDateSource: 'supplier_term',
        subtotal: null,
        total: '86900.50',
        notes: null,
        ...overrides,
      };
    }

    async function createDoc(data: Record<string, unknown>): Promise<string> {
      const { id } = await prisma.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'error',
          createdById: ana.id,
          ...(data as object),
        } as never,
      });
      return id;
    }

    describe('status transitions (table-driven)', () => {
      it.each([
        [
          'error (missing_total) -> reviewed via PUT',
          'error',
          [{ code: 'missing_total' }],
          (supplierId: string) => editPayload(supplierId, { total: '5000.00' }),
        ],
        [
          'error (supplier_unresolved) -> reviewed via PUT',
          'error',
          [{ code: 'supplier_unresolved' }],
          (supplierId: string) => editPayload(supplierId),
        ],
        [
          'error (supplier_term_missing) -> reviewed via PUT with manual dueDate',
          'error',
          [{ code: 'supplier_term_missing' }],
          (supplierId: string) =>
            editPayload(supplierId, {
              dueDate: '2026-11-15',
              dueDateSource: 'manual',
            }),
        ],
        [
          'unreviewed -> reviewed via PUT',
          'unreviewed',
          [],
          (supplierId: string) => editPayload(supplierId, { total: '9999.00' }),
        ],
        [
          'reviewed -> reviewed via PUT',
          'reviewed',
          [],
          (supplierId: string) => editPayload(supplierId, { notes: 'actualizado' }),
        ],
      ] as const)(
        'allows %s',
        async (_, initialStatus, initialIssues, buildBody) => {
          const supplierId = await newSupplier(30);
          const secondUser = await createUser(app, { name: 'Beto' });
          const secondSession = await signIn(app, secondUser);
          const id = await createDoc({
            reviewStatus: initialStatus,
            type: 'invoice',
            supplierId: initialIssues.some((i) => i.code === 'supplier_unresolved')
              ? null
              : supplierId,
            issueDate: new Date('2026-10-09'),
            dueDate:
              initialStatus === 'error' ? null : new Date('2026-11-08'),
            dueDateSource: initialStatus === 'error' ? null : 'supplier_term',
            total:
              initialIssues.some((i) => i.code === 'missing_total')
                ? null
                : '86900.50',
            issues: initialIssues,
            reviewedById: initialStatus === 'reviewed' ? ana.id : null,
            reviewedAt: initialStatus === 'reviewed' ? new Date(NOW) : null,
          });

          await http()
            .put(`/api/documents/${id}`)
            .set('Cookie', `session=${secondSession}`)
            .send(buildBody(supplierId))
            .expect(204);

          const after = await stored(id);
          expect(after.reviewStatus).toBe('reviewed');
          expect(after.reviewedById).toBe(secondUser.id);
          expect(after.reviewedAt).toEqual(new Date(NOW));
          expect(after.issues).toEqual([]);
        },
      );

      it.each([
        [
          'error -> partial PUT missing supplier',
          'error',
          null,
          () => editPayload(null),
          'supplier_required',
        ],
        [
          'error -> partial PUT empty supplier string',
          'error',
          null,
          () => editPayload(''),
          'supplier_required',
        ],
        [
          'error -> partial PUT supplier without term and no manual dueDate',
          'error',
          null,
          (supplierId: string) => editPayload(supplierId),
          'due_date_required',
        ],
        [
          'error -> partial PUT missing total',
          'error',
          30,
          (supplierId: string) => editPayload(supplierId, { total: '' }),
          'total_invalid',
        ],
        [
          'error -> partial PUT invalid issueDate',
          'error',
          30,
          (supplierId: string) => editPayload(supplierId, { issueDate: '' }),
          'issue_date_invalid',
        ],
        [
          'unreviewed -> invalid PUT cleared total stays unreviewed',
          'unreviewed',
          30,
          (supplierId: string) => editPayload(supplierId, { total: '0' }),
          'total_invalid',
        ],
        [
          'unreviewed -> invalid PUT cleared issueDate stays unreviewed',
          'unreviewed',
          30,
          (supplierId: string) => editPayload(supplierId, { issueDate: '' }),
          'issue_date_invalid',
        ],
        [
          'unreviewed -> invalid PUT supplier without term and no manual dueDate stays unreviewed',
          'unreviewed',
          null,
          (supplierId: string) => editPayload(supplierId),
          'due_date_required',
        ],
        [
          'reviewed -> invalid PUT cleared total stays reviewed',
          'reviewed',
          30,
          (supplierId: string) => editPayload(supplierId, { total: '' }),
          'total_invalid',
        ],
      ] as const)(
        'rejects %s and keeps previous status and data',
        async (_, initialStatus, termDays, buildBody, expectedCode) => {
          const supplierId = await newSupplier(termDays);
          const id = await createDoc({
            reviewStatus: initialStatus,
            type: 'invoice',
            supplierId,
            issueDate: new Date('2026-10-09'),
            dueDate:
              initialStatus === 'error' ? null : new Date('2026-11-08'),
            dueDateSource:
              initialStatus === 'error'
                ? null
                : termDays === null
                  ? 'manual'
                  : 'supplier_term',
            total: '500.00',
            issues:
              initialStatus === 'error'
                ? [{ code: 'supplier_term_missing' }]
                : [],
            reviewedById: initialStatus === 'reviewed' ? ana.id : null,
            reviewedAt: initialStatus === 'reviewed' ? new Date(NOW) : null,
          });

          const res = await put(id, buildBody(supplierId)).expect(400);
          expect((res.body as { errors: { code: string }[] }).errors).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: expectedCode }),
            ]),
          );

          const after = await stored(id);
          expect(after.reviewStatus).toBe(initialStatus);
          expect(after.total?.toString()).toBe('500');
          expect(after.issueDate).toBe('2026-10-09');
        },
      );

      it('confirms unreviewed (and idempotently reviewed) via POST /review without changing fields', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          reviewStatus: 'unreviewed',
          type: 'invoice',
          supplierId,
          letter: 'B',
          number: '0002-00000111',
          numberNormalized: '000200000111',
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          total: '1234.50',
          notes: 'original',
          issues: [],
        });

        await review(id).expect(204);
        const after = await stored(id);
        expect(after).toMatchObject({
          reviewStatus: 'reviewed',
          reviewedById: ana.id,
          reviewedAt: new Date(NOW),
          notes: 'original',
          number: '0002-00000111',
        });

        // Idempotent for a second user
        const beto = await createUser(app, { name: 'Beto' });
        const betoSession = await signIn(app, beto);
        await http()
          .post(`/api/documents/${id}/review`)
          .set('Cookie', `session=${betoSession}`)
          .send({})
          .expect(204);
        expect((await stored(id)).reviewedById).toBe(beto.id);
      });

      it('rejects PUT, POST /review, and POST /retry on processing with 409 not_editable', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({ reviewStatus: 'processing', issues: [] });

        for (const req of [
          put(id, editPayload(supplierId)),
          review(id),
          retry(id),
        ]) {
          const res = await req.expect(409);
          expect(res.body).toEqual({
            errors: [{ field: 'document', code: 'not_editable' }],
          });
        }
      });

      it('rejects POST /review on error with 409 not_editable', async () => {
        const id = await createDoc({
          reviewStatus: 'error',
          issues: [{ code: 'extraction_failed' }],
        });
        const res = await review(id).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'document', code: 'not_editable' }],
        });
      });

      it.each([
        ['bad UUID', 'nope'],
        ['unknown UUID', randomUUID()],
      ])('returns 404 on PUT, /review, and /retry for %s', async (_, id) => {
        const supplierId = await newSupplier(30);
        await put(id, editPayload(supplierId)).expect(404);
        await review(id).expect(404);
        await retry(id).expect(404);
      });

      it('returns 404 on PUT, /review, and /retry for a deleted document', async () => {
        const supplierId = await newSupplier(30);
        const id = await enter(invoice(supplierId));
        await remove(id).expect(204);
        await put(id, editPayload(supplierId)).expect(404);
        await review(id).expect(404);
        await retry(id).expect(404);
      });

      it('rejects opening_balance on upload documents, and allows it on manual documents', async () => {
        const supplierId = await newSupplier(30);
        const uploadId = await createDoc({
          source: 'upload',
          reviewStatus: 'error',
          issues: [{ code: 'missing_total' }],
        });
        await put(
          uploadId,
          editPayload(supplierId, {
            type: 'opening_balance',
            letter: null,
            number: null,
            dueDate: null,
            dueDateSource: null,
          }),
        ).expect(400);

        const manualId = await enter(invoice(supplierId));
        await put(
          manualId,
          editPayload(supplierId, {
            type: 'opening_balance',
            letter: null,
            number: null,
            dueDate: '2026-09-01',
            dueDateSource: 'manual',
          }),
        ).expect(204);
        expect((await stored(manualId)).type).toBe('opening_balance');
      });
    });

    describe('due-date preservation and validation rules', () => {
      it('preserves the original term when editing issueDate even after supplier paymentTermDays changed', async () => {
        const supplierId = await newSupplier(30);
        const id = await enter(
          invoice(supplierId, { issueDate: '2026-10-01', dueDate: null }),
        );
        expect((await stored(id)).dueDate).toBe('2026-10-31');

        await changeTerm(supplierId, 60);
        await put(
          id,
          editPayload(supplierId, {
            issueDate: '2026-10-10',
            dueDate: null,
            dueDateSource: 'supplier_term',
          }),
        ).expect(204);

        const after = await stored(id);
        expect(after.dueDate).toBe('2026-11-09');
        expect(after.dueDateSource).toBe('supplier_term');
      });

      it('switches between supplier_term and manual, and uses new supplier term on supplier change', async () => {
        const s1 = await newSupplier(15);
        const s2 = await newSupplier(45);
        const id = await enter(
          invoice(s1, { issueDate: '2026-10-01', dueDate: null }),
        );
        expect((await stored(id)).dueDate).toBe('2026-10-16');

        // Switch to manual
        await put(
          id,
          editPayload(s1, {
            issueDate: '2026-10-01',
            dueDate: '2026-12-20',
            dueDateSource: 'manual',
          }),
        ).expect(204);
        expect(await stored(id)).toMatchObject({
          dueDate: '2026-12-20',
          dueDateSource: 'manual',
        });

        // Switch back to supplier_term
        await put(
          id,
          editPayload(s1, {
            issueDate: '2026-10-01',
            dueDate: null,
            dueDateSource: 'supplier_term',
          }),
        ).expect(204);
        expect(await stored(id)).toMatchObject({
          dueDate: '2026-10-16',
          dueDateSource: 'supplier_term',
        });

        // Change supplierId -> uses target supplier's current term
        await put(
          id,
          editPayload(s2, {
            issueDate: '2026-10-01',
            dueDate: null,
            dueDateSource: 'supplier_term',
          }),
        ).expect(204);
        expect(await stored(id)).toMatchObject({
          dueDate: '2026-11-15',
          dueDateSource: 'supplier_term',
        });
      });

      it('keeps manual dueDate on issueDate edit and rejects issueDate > manual dueDate with due_date_before_issue', async () => {
        const supplierId = await newSupplier(30);
        const id = await enter(
          invoice(supplierId, {
            issueDate: '2026-10-01',
            dueDate: '2026-10-15',
          }),
        );

        await put(
          id,
          editPayload(supplierId, {
            issueDate: '2026-10-10',
            dueDate: '2026-10-15',
            dueDateSource: 'manual',
          }),
        ).expect(204);
        expect((await stored(id)).dueDate).toBe('2026-10-15');

        const res = await put(
          id,
          editPayload(supplierId, {
            issueDate: '2026-10-16',
            dueDate: '2026-10-15',
            dueDateSource: 'manual',
          }),
        ).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'dueDate', code: 'due_date_before_issue' }],
        });
        expect((await stored(id)).issueDate).toBe('2026-10-10');
      });

      it('enforces opening_balance and credit_note due-date rules and subtotal validation', async () => {
        const supplierId = await newSupplier(30);
        const obId = await enter({
          supplierId,
          type: 'opening_balance',
          letter: null,
          number: null,
          issueDate: '2026-10-10',
          dueDate: '2026-10-01',
          total: '500.00',
          notes: null,
        });
        await put(
          obId,
          editPayload(supplierId, {
            type: 'opening_balance',
            letter: null,
            number: null,
            issueDate: '2026-10-10',
            dueDate: '2026-09-15',
            dueDateSource: 'manual',
          }),
        ).expect(204);
        await put(
          obId,
          editPayload(supplierId, {
            type: 'opening_balance',
            letter: null,
            number: null,
            issueDate: '2026-10-10',
            dueDate: null,
            dueDateSource: null,
          }),
        ).expect(204);
        await put(
          obId,
          editPayload(supplierId, {
            type: 'opening_balance',
            letter: null,
            number: null,
            issueDate: '2026-10-10',
            dueDate: null,
            dueDateSource: 'supplier_term',
          }),
        ).expect(400);

        const cnId = await enter(
          invoice(supplierId, {
            type: 'credit_note',
            number: '0001-00000088',
          }),
        );
        await put(
          cnId,
          editPayload(supplierId, {
            type: 'credit_note',
            number: '0001-00000088',
            dueDate: '2026-11-01',
            dueDateSource: 'manual',
          }),
        ).expect(400);
        await put(
          cnId,
          editPayload(supplierId, {
            type: 'credit_note',
            number: '0001-00000088',
            dueDate: null,
            dueDateSource: 'supplier_term',
          }),
        ).expect(400);

        const badSubtotal = await put(
          cnId,
          editPayload(supplierId, {
            type: 'credit_note',
            number: '0001-00000088',
            dueDate: null,
            dueDateSource: null,
            subtotal: '-1.00',
          }),
        ).expect(400);
        expect(badSubtotal.body).toEqual({
          errors: [{ field: 'subtotal', code: 'subtotal_invalid' }],
        });

        await put(
          cnId,
          editPayload(supplierId, {
            type: 'credit_note',
            number: '0001-00000088',
            dueDate: null,
            dueDateSource: null,
            subtotal: '0.00',
          }),
        ).expect(204);
      });
    });

    describe('invariant 6, invariant 7, and read-only preservation on edit', () => {
      it('protects documents with received or given applications on PUT', async () => {
        const s1 = await newSupplier(30);
        const s2 = await newSupplier(30);
        const invId = await enter(
          invoice(s1, { number: '0001-00000010', total: '1000.00' }),
        );
        const cnId = await enter({
          supplierId: s1,
          type: 'credit_note',
          letter: 'A',
          number: '0001-00000011',
          issueDate: '2026-10-10',
          dueDate: null,
          total: '400.00',
          notes: null,
        });
        await prisma.application.create({
          data: { creditNoteId: cnId, documentId: invId, amount: '300.00' },
        });

        for (const body of [
          editPayload(s2, { number: '0001-00000010', total: '1000.00' }),
          editPayload(s1, {
            type: 'delivery_note',
            number: '0001-00000010',
            total: '1000.00',
          }),
          editPayload(s1, { number: '0001-00000010', total: '299.99' }),
        ]) {
          const res = await put(invId, body).expect(409);
          expect(res.body).toEqual({
            errors: [{ field: 'document', code: 'document_has_applications' }],
          });
        }

        // Credit note that gave 300 cannot drop below 300 or change supplier/type
        for (const body of [
          editPayload(s2, {
            type: 'credit_note',
            number: '0001-00000011',
            dueDate: null,
            dueDateSource: null,
            total: '400.00',
          }),
          editPayload(s1, {
            type: 'invoice',
            number: '0001-00000011',
            total: '400.00',
          }),
          editPayload(s1, {
            type: 'credit_note',
            number: '0001-00000011',
            dueDate: null,
            dueDateSource: null,
            total: '299.99',
          }),
        ]) {
          const res = await put(cnId, body).expect(409);
          expect(res.body).toEqual({
            errors: [{ field: 'document', code: 'document_has_applications' }],
          });
        }

        // Lowering to exact applied amount and editing number/issueDate/notes succeeds
        await put(
          invId,
          editPayload(s1, {
            number: '0001-00000099',
            issueDate: '2026-10-12',
            total: '300.00',
            notes: 'ok',
          }),
        ).expect(204);
        await put(
          cnId,
          editPayload(s1, {
            type: 'credit_note',
            number: '0001-00000098',
            dueDate: null,
            dueDateSource: null,
            total: '300.00',
            notes: 'cn ok',
          }),
        ).expect(204);
      });

      it('rejects duplicate numbers on PUT (including null letter) while allowing keeping own number', async () => {
        const supplierId = await newSupplier(30);
        const existing = await enter(
          invoice(supplierId, { letter: null, number: '0001-00005555' }),
        );
        const other = await enter(
          invoice(supplierId, { letter: null, number: '0001-00006666' }),
        );

        // Colliding with existing counted doc
        const dup = await put(
          other,
          editPayload(supplierId, { letter: null, number: '0001 00005555' }),
        ).expect(409);
        expect(dup.body).toEqual({
          errors: [{ field: 'number', code: 'duplicate_number' }],
        });

        // Keeping own number succeeds (tests id <> documentId)
        await put(
          existing,
          editPayload(supplierId, {
            letter: null,
            number: '0001-00005555',
            notes: 'mismo número',
          }),
        ).expect(204);
      });

      it('preserves cae, lines, taxes, and raw_output on PUT and writes an audit entry', async () => {
        const supplierId = await newSupplier(30);
        const docId = await createDoc({
          reviewStatus: 'unreviewed',
          type: 'invoice',
          supplierId,
          letter: 'A',
          number: '0001-00007777',
          numberNormalized: '000100007777',
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          subtotal: '100.00',
          total: '121.00',
          cae: '76543210987654',
          issues: [],
          lines: { create: [{ position: 1, description: 'Harina', lineTotal: '100.00' }] },
          taxes: { create: [{ kind: 'iva', label: 'IVA 21%', amount: '21.00' }] },
          extractionJobs: {
            create: {
              status: 'succeeded',
              attempts: 1,
              runAfter: new Date(NOW),
              model: 'claude-haiku-5-5',
              promptVersion: '1',
              rawOutput: { total: '121.00', printedTermDays: 30 },
            },
          },
        });

        await put(
          docId,
          editPayload(supplierId, {
            number: '0001-00007778',
            subtotal: '200.00',
            total: '221.00',
            notes: 'editado',
            acceptIssues: ['lines_mismatch'],
          }),
        ).expect(204);

        const after = await stored(docId);
        expect(after.cae).toBe('76543210987654');
        expect(await prisma.documentLine.findMany({ where: { documentId: docId } })).toHaveLength(1);
        expect(await prisma.documentTax.findMany({ where: { documentId: docId } })).toHaveLength(1);
        const job = await prisma.extractionJob.findFirstOrThrow({
          where: { documentId: docId },
        });
        expect(job.rawOutput).toEqual({ total: '121.00', printedTermDays: 30 });

        const logs = await prisma.auditLog.findMany({
          where: { entityId: docId, action: 'update' },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].userId).toBe(ana.id);
      });
    });

    describe('POST /api/documents/:id/retry', () => {
      it('moves extraction_failed upload to processing, adds a queued job keeping the failed one, and can be claimed by the worker', async () => {
        const up = await withSession(http().post('/api/uploads'))
          .set('X-Requested-With', 'XMLHttpRequest')
          .attach('photos', jpeg(), 'pagina-1.jpg')
          .expect(201);
        const id = (up.body as { id: string }).id;

        await prisma.extractionJob.updateMany({
          where: { documentId: id },
          data: { status: 'failed', attempts: 4, lastError: 'api error' },
        });
        await prisma.document.update({
          where: { id },
          data: {
            reviewStatus: 'error',
            issues: [{ code: 'extraction_failed' }],
          },
        });

        vi.setSystemTime(new Date(new Date(NOW).getTime() + 1000));
        await retry(id).expect(204);

        const after = await stored(id);
        expect(after.reviewStatus).toBe('processing');
        expect(after.issues).toEqual([]);

        const jobs = await prisma.extractionJob.findMany({
          where: { documentId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        expect(jobs).toHaveLength(2);
        expect(jobs[0].status).toBe('failed');
        expect(jobs[1].status).toBe('queued');
        expect(jobs[1].attempts).toBe(0);

        const auditLogs = await prisma.auditLog.findMany({
          where: { entityId: id, action: 'update' },
        });
        expect(auditLogs).toHaveLength(1);
        expect(auditLogs[0].userId).toBe(ana.id);

        const fake = new FakeLlm();
        const { worker, close } = await createTestWorker(fake);
        try {
          fake.reply(invoiceOutput({ supplierCuit: null, supplierName: null }));
          expect(await worker.runOnce({ documentIds: [id] })).toBe(true);
          const jobsAfter = await prisma.extractionJob.findMany({
            where: { documentId: id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          expect(jobsAfter[0].status).toBe('failed');
          expect(jobsAfter[1].status).toBe('succeeded');
        } finally {
          await close();
        }
      });

      it('rejects retry with 409 not_editable when not error', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          source: 'upload',
          reviewStatus: 'unreviewed',
          type: 'credit_note',
          supplierId,
          issueDate: new Date('2026-10-09'),
          total: '100.00',
          issues: [],
        });
        const res = await retry(id).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'document', code: 'not_editable' }],
        });
      });

      it.each([
        [
          'missing extraction_failed issue',
          {
            source: 'upload',
            reviewStatus: 'error',
            issues: [{ code: 'unsupported_document' }],
          },
        ],
        [
          'manual source',
          {
            source: 'manual',
            reviewStatus: 'error',
            issues: [{ code: 'extraction_failed' }],
          },
        ],
        [
          'has type',
          {
            source: 'upload',
            reviewStatus: 'error',
            type: 'invoice',
            issues: [{ code: 'extraction_failed' }],
          },
        ],
        [
          'has total',
          {
            source: 'upload',
            reviewStatus: 'error',
            total: '100.00',
            issues: [{ code: 'extraction_failed' }],
          },
        ],
        [
          'has lines',
          {
            source: 'upload',
            reviewStatus: 'error',
            issues: [{ code: 'extraction_failed' }],
            lines: { create: [{ position: 1, description: 'item' }] },
          },
        ],
        [
          'has taxes',
          {
            source: 'upload',
            reviewStatus: 'error',
            issues: [{ code: 'extraction_failed' }],
            taxes: {
              create: [{ kind: 'iva', label: 'IVA', amount: '10.00' }],
            },
          },
        ],
      ])('rejects retry with 409 not_editable when %s', async (_, data) => {
        const id = await createDoc(data);
        const res = await retry(id).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'document', code: 'not_editable' }],
        });
      });
    });

    describe('POST /api/documents/:id/issues/:code/accept', () => {
      const accept = (id: string, code: string) =>
        withSession(http().post(`/api/documents/${id}/issues/${code}/accept`))
          .send({});

      it.each([
        'extraction_failed',
        'unsupported_document',
        'supplier_unresolved',
        'missing_total',
        'missing_issue_date',
        'supplier_term_missing',
        'duplicate_number',
      ])(
        'refuses blocking code %s with 400 issue_not_acceptable and leaves document untouched',
        async (blockingCode) => {
          const supplierId = await newSupplier(30);
          const id = await createDoc({
            reviewStatus: 'error',
            type: 'invoice',
            supplierId,
            issueDate: new Date('2026-10-09'),
            dueDate: new Date('2026-11-08'),
            dueDateSource: 'supplier_term',
            total: '1000.00',
            issues: [{ code: blockingCode }],
          });
          const res = await accept(id, blockingCode).expect(400);
          expect(res.body).toEqual({
            errors: [{ field: 'code', code: 'issue_not_acceptable' }],
          });
          const stored = await prisma.document.findUniqueOrThrow({
            where: { id },
          });
          expect(stored.reviewStatus).toBe('error');
          expect(stored.issues).toEqual([{ code: blockingCode }]);
          expect(
            await prisma.auditLog.count({ where: { entityId: id } }),
          ).toBe(0);
        },
      );

      it('refuses unknown code with 400, non-UUID/unknown/deleted doc with 404, and non-error or missing issue with 409', async () => {
        const supplierId = await newSupplier(30);
        const errorId = await createDoc({
          reviewStatus: 'error',
          type: 'invoice',
          supplierId,
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          total: '1000.00',
          issues: [{ code: 'totals_mismatch' }],
        });
        await accept(errorId, 'not_a_real_code').expect(400);
        await accept('not-a-uuid', 'totals_mismatch').expect(404);
        await accept(randomUUID(), 'totals_mismatch').expect(404);

        const missingRes = await accept(errorId, 'wrong_recipient').expect(409);
        expect(missingRes.body).toEqual({
          errors: [{ field: 'document', code: 'not_editable' }],
        });

        const unreviewedId = await createDoc({
          reviewStatus: 'unreviewed',
          type: 'invoice',
          supplierId,
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          total: '1000.00',
          issues: [],
        });
        const stateRes = await accept(unreviewedId, 'totals_mismatch').expect(
          409,
        );
        expect(stateRes.body).toEqual({
          errors: [{ field: 'document', code: 'not_editable' }],
        });

        await remove(errorId).expect(204);
        await accept(errorId, 'totals_mismatch').expect(404);
      });

      it('accepts one of two issues keeping error, hides it from open issues, is idempotent, and promotes on the last issue', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          reviewStatus: 'error',
          type: 'invoice',
          supplierId,
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          subtotal: '800.00',
          total: '1000.00',
          issues: [{ code: 'totals_mismatch' }, { code: 'wrong_recipient' }],
        });

        // Accept first of two
        await accept(id, 'totals_mismatch').expect(204);
        const afterFirst = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(afterFirst.reviewStatus).toBe('error');
        expect(afterFirst.reviewedById).toBeNull();
        expect(afterFirst.issues).toEqual([
          {
            code: 'totals_mismatch',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
          { code: 'wrong_recipient' },
        ]);

        // Detail exposes open issues only + acceptedIssues with user name & Buenos Aires timestamp
        const detail1 = (
          await withSession(http().get(`/api/documents/${id}`)).expect(200)
        ).body as Record<string, unknown>;
        expect(detail1).toMatchObject({
          reviewStatus: 'error',
          issues: ['wrong_recipient'],
          acceptedIssues: [
            {
              code: 'totals_mismatch',
              acceptedByName: 'Ana',
              acceptedOn: '2026-11-09',
              acceptedTime: '12:00',
            },
          ],
        });

        // Error list hides accepted code
        const errList = await withSession(http().get('/api/error-documents'))
          .expect(200);
        const errRow = (
          errList.body as {
            documents: { id: string; issues: string[] }[];
          }
        ).documents.find((d) => d.id === id);
        expect(errRow?.issues).toEqual(['wrong_recipient']);

        // Idempotent second accept on already-accepted issue writes no second audit entry
        await accept(id, 'totals_mismatch').expect(204);
        expect(
          await prisma.auditLog.count({
            where: { entity: 'documents', entityId: id, action: 'update' },
          }),
        ).toBe(1);

        // Supplier account doesn't count it yet
        const accountBefore = (
          await withSession(http().get(`/api/suppliers/${supplierId}`)).expect(
            200,
          )
        ).body as { balance: string };
        expect(accountBefore.balance).toBe('0.00');

        // Accept last open issue -> promotes to reviewed and counts in supplier balance
        await accept(id, 'wrong_recipient').expect(204);
        const afterLast = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(afterLast.reviewStatus).toBe('reviewed');
        expect(afterLast.reviewedById).toBe(ana.id);
        expect(afterLast.reviewedAt?.toISOString()).toBe(NOW);

        const accountAfter = (
          await withSession(http().get(`/api/suppliers/${supplierId}`)).expect(
            200,
          )
        ).body as { balance: string };
        expect(accountAfter.balance).toBe('1000.00');
        expect(
          await prisma.auditLog.count({
            where: { entity: 'documents', entityId: id, action: 'update' },
          }),
        ).toBe(2);
      });

      it('adds duplicate_number and stays in error if a concurrent duplicate number arrived before accepting the last issue', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          reviewStatus: 'error',
          type: 'invoice',
          supplierId,
          letter: 'A',
          number: '0009-00000101',
          numberNormalized: '000900000101',
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          total: '1000.00',
          issues: [{ code: 'wrong_recipient' }],
        });
        // Another document with the same number lands in reviewed first
        await enter(
          invoice(supplierId, {
            letter: 'A',
            number: '0009-00000101',
            issueDate: '2026-10-09',
            total: '2000.00',
          }),
        );

        await accept(id, 'wrong_recipient').expect(204);
        const stored = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(stored.reviewStatus).toBe('error');
        expect(stored.reviewedById).toBeNull();
        expect(stored.issues).toEqual([
          { code: 'duplicate_number' },
          {
            code: 'wrong_recipient',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
        ]);
      });

      it('adds duplicate_suspected and stays in error if a concurrent unnumbered duplicate arrived before accepting the last issue', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          reviewStatus: 'error',
          type: 'delivery_note',
          supplierId,
          letter: 'X',
          number: null,
          numberNormalized: null,
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          total: '1000.00',
          issues: [{ code: 'wrong_recipient' }],
        });
        // Concurrent matching unnumbered document arrives
        await enter(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-09',
            total: '1000.00',
          }),
        );

        await accept(id, 'wrong_recipient').expect(204);
        const stored = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(stored.reviewStatus).toBe('error');
        expect(stored.issues).toEqual([
          { code: 'duplicate_suspected' },
          {
            code: 'wrong_recipient',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
        ]);
      });
    });

    describe('manual entry duplicate_suspected and concurrency', () => {
      it('rejects a suspected duplicate with 409 including documentId, and saves as reviewed with accepted issue when allowSuspectedDuplicate is true', async () => {
        const supplierId = await newSupplier(30);
        const firstId = await enter(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
        );

        const dupPayload = invoice(supplierId, {
          type: 'delivery_note',
          letter: 'X',
          number: null,
          issueDate: '2026-10-15',
          total: '15000.00',
        });
        const conflictRes = await post(dupPayload).expect(409);
        expect(conflictRes.body).toEqual({
          errors: [
            {
              field: 'document',
              code: 'duplicate_suspected',
              documentId: firstId,
            },
          ],
        });
        expect(
          await prisma.document.count({ where: { supplierId } }),
        ).toBe(1);

        // Resend with allowSuspectedDuplicate: true
        const createdRes = await post({
          ...dupPayload,
          allowSuspectedDuplicate: true,
        }).expect(201);
        const secondId = (createdRes.body as { id: string }).id;
        const stored = await prisma.document.findUniqueOrThrow({
          where: { id: secondId },
        });
        expect(stored.reviewStatus).toBe('reviewed');
        expect(stored.issues).toEqual([
          {
            code: 'duplicate_suspected',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
        ]);
        expect(
          await prisma.auditLog.count({
            where: {
              entity: 'documents',
              entityId: secondId,
              action: 'create',
              userId: ana.id,
            },
          }),
        ).toBe(1);
      });

      it('checks duplicate_number before duplicate_suspected on manual entry', async () => {
        const supplierId = await newSupplier(30);
        await enter(
          invoice(supplierId, {
            number: '0003-00005555',
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
        );
        const res = await post({
          ...invoice(supplierId, {
            number: '0003-00005555',
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
          allowSuspectedDuplicate: true,
        }).expect(409);
        expect(res.body).toEqual({
          errors: [{ field: 'number', code: 'duplicate_number' }],
        });
      });

      it('allows two numbered documents with different numbers, different day, and opening_balance without warning', async () => {
        const supplierId = await newSupplier(30);
        await enter(
          invoice(supplierId, {
            number: '0003-00006001',
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
        );
        // Different number, same date & total
        await post(
          invoice(supplierId, {
            number: '0003-00006002',
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
        ).expect(201);
        // Unnumbered on different day
        await post(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-16',
            total: '15000.00',
          }),
        ).expect(201);
        // Opening balance on same date & total
        await post({
          supplierId,
          type: 'opening_balance',
          letter: null,
          number: null,
          issueDate: '2026-10-15',
          dueDate: null,
          total: '15000.00',
          notes: null,
        }).expect(201);
        // Same date & total for a different supplier
        const otherSupplierId = await newSupplier(30);
        await post(
          invoice(otherSupplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-15',
            total: '15000.00',
          }),
        ).expect(201);
        // Different total on same supplier & date
        await post(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-15',
            total: '15001.00',
          }),
        ).expect(201);
      });

      it('prevents concurrent unnumbered manual duplicates via advisory lock (exactly one 201 and one 409)', async () => {
        const supplierId = await newSupplier(30);
        const payload = invoice(supplierId, {
          type: 'delivery_note',
          letter: 'X',
          number: null,
          issueDate: '2026-10-18',
          total: '22222.00',
        });

        const [r1, r2] = await Promise.all([post(payload), post(payload)]);
        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);

        const winner = r1.status === 201 ? r1 : r2;
        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body).toEqual({
          errors: [
            {
              field: 'document',
              code: 'duplicate_suspected',
              documentId: (winner.body as { id: string }).id,
            },
          ],
        });
        expect(
          await prisma.document.count({ where: { supplierId } }),
        ).toBe(1);
      });
    });

    describe('PUT /api/documents/:id acceptable re-checks and acceptance', () => {
      it('rejects editing an unreviewed document subtotal by $5 with 409 totals_mismatch (never returns to error), passes at $0.50, and accepts with acceptIssues', async () => {
        const supplierId = await newSupplier(30);
        const id = await createDoc({
          reviewStatus: 'unreviewed',
          type: 'invoice',
          supplierId,
          letter: 'A',
          number: '0003-00007001',
          numberNormalized: '000300007001',
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          subtotal: '1000.00',
          total: '1210.00',
          issues: [],
          taxes: {
            create: [{ kind: 'iva', label: 'IVA 21%', amount: '210.00' }],
          },
        });

        // Change subtotal by $5.00 -> 409 totals_mismatch, document unchanged
        const rejectRes = await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007001',
            subtotal: '1005.00',
            total: '1210.00',
          }),
        ).expect(409);
        expect(rejectRes.body).toEqual({
          errors: [{ field: 'document', code: 'totals_mismatch' }],
        });
        const unchanged = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(unchanged.reviewStatus).toBe('unreviewed');
        expect(unchanged.subtotal?.toString()).toBe('1000');

        // Change subtotal by $0.50 -> passes immediately within $1.00 tolerance
        await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007001',
            subtotal: '1000.50',
            total: '1210.00',
          }),
        ).expect(204);
        const within = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(within.reviewStatus).toBe('reviewed');
        expect(within.issues).toEqual([]);

        // Change subtotal by $5.00 with acceptIssues -> 204 reviewed with acceptance recorded
        await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007001',
            subtotal: '1005.00',
            total: '1210.00',
            acceptIssues: ['totals_mismatch'],
          }),
        ).expect(204);
        const accepted = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(accepted.reviewStatus).toBe('reviewed');
        expect(accepted.issues).toEqual([
          {
            code: 'totals_mismatch',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
        ]);
      });

      it('requires re-acceptance when editing a reviewed document that previously accepted wrong_recipient or totals_mismatch', async () => {
        const supplierId = await newSupplier(30);
        const earlier = '2026-11-01T10:00:00.000Z';
        const id = await createDoc({
          reviewStatus: 'reviewed',
          type: 'invoice',
          supplierId,
          letter: 'A',
          number: '0003-00007002',
          numberNormalized: '000300007002',
          issueDate: new Date('2026-10-09'),
          dueDate: new Date('2026-11-08'),
          dueDateSource: 'supplier_term',
          subtotal: '1005.00',
          total: '1210.00',
          reviewedById: ana.id,
          reviewedAt: new Date(earlier),
          issues: [
            {
              code: 'totals_mismatch',
              acceptedBy: ana.id,
              acceptedAt: earlier,
            },
            {
              code: 'wrong_recipient',
              acceptedBy: ana.id,
              acceptedAt: earlier,
            },
          ],
          taxes: {
            create: [{ kind: 'iva', label: 'IVA 21%', amount: '210.00' }],
          },
        });

        // Editing notes without acceptIssues -> 409 naming BOTH still-triggering codes
        const res = await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007002',
            subtotal: '1005.00',
            total: '1210.00',
            notes: 'Editada',
          }),
        ).expect(409);
        expect(res.body).toEqual({
          errors: [
            { field: 'document', code: 'totals_mismatch' },
            { field: 'document', code: 'wrong_recipient' },
          ],
        });

        // Re-sending with both accepted updates acceptedAt
        await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007002',
            subtotal: '1005.00',
            total: '1210.00',
            notes: 'Editada',
            acceptIssues: ['totals_mismatch', 'wrong_recipient'],
          }),
        ).expect(204);
        const updated = await prisma.document.findUniqueOrThrow({
          where: { id },
        });
        expect(updated.notes).toBe('Editada');
        expect(updated.issues).toEqual([
          { code: 'totals_mismatch', acceptedBy: ana.id, acceptedAt: NOW },
          { code: 'wrong_recipient', acceptedBy: ana.id, acceptedAt: NOW },
        ]);
      });

      it('saves header edits on an error document and keeps it in error when acceptable issues trigger without acceptIssues, and resets previously accepted wrong_recipient to open', async () => {
        const supplierId = await newSupplier(30);
        const earlier = '2026-11-01T10:00:00.000Z';
        const id = await createDoc({
          reviewStatus: 'error',
          type: 'invoice',
          supplierId: null,
          letter: 'A',
          number: '0003-00007003',
          numberNormalized: '000300007003',
          issueDate: new Date('2026-10-09'),
          subtotal: '1005.00',
          total: '1210.00',
          issues: [
            { code: 'supplier_unresolved' },
            {
              code: 'wrong_recipient',
              acceptedBy: ana.id,
              acceptedAt: earlier,
            },
          ],
          taxes: {
            create: [{ kind: 'iva', label: 'IVA 21%', amount: '210.00' }],
          },
        });

        await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007003',
            subtotal: '1005.00',
            total: '1210.00',
            notes: 'Proveedor asignado',
          }),
        ).expect(204);

        const saved = await prisma.document.findUniqueOrThrow({ where: { id } });
        expect(saved.supplierId).toBe(supplierId);
        expect(saved.notes).toBe('Proveedor asignado');
        expect(saved.reviewStatus).toBe('error');
        expect(saved.reviewedById).toBeNull();
        expect(saved.reviewedAt).toBeNull();
        expect(saved.issues).toEqual([
          { code: 'totals_mismatch' },
          { code: 'wrong_recipient' },
        ]);
        expect(
          await prisma.auditLog.count({
            where: {
              entity: 'documents',
              entityId: id,
              action: 'update',
              userId: ana.id,
            },
          }),
        ).toBe(1);
      });

      it('rejects blocking or unknown codes in acceptIssues with 400', async () => {
        const supplierId = await newSupplier(30);
        const id = await enter(
          invoice(supplierId, { number: '0003-00007004' }),
        );
        const blockingRes = await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007004',
            acceptIssues: ['duplicate_number'],
          }),
        ).expect(400);
        expect(blockingRes.body).toEqual({
          errors: [{ field: 'acceptIssues', code: 'issue_not_acceptable' }],
        });

        await put(
          id,
          editPayload(supplierId, {
            number: '0003-00007004',
            acceptIssues: ['unknown_code'],
          }),
        ).expect(400);
      });

      it('rejects editing a reviewed document to match an unnumbered duplicate with 409 duplicate_suspected including documentId, and succeeds with acceptIssues', async () => {
        const supplierId = await newSupplier(30);
        const existingId = await enter(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-20',
            total: '3300.00',
          }),
        );
        const editedId = await enter(
          invoice(supplierId, {
            number: '0003-00007005',
            issueDate: '2026-10-20',
            total: '9999.00',
          }),
        );

        const conflictRes = await put(
          editedId,
          editPayload(supplierId, {
            number: '0003-00007005',
            issueDate: '2026-10-20',
            total: '3300.00',
          }),
        ).expect(409);
        expect(conflictRes.body).toEqual({
          errors: [
            {
              field: 'document',
              code: 'duplicate_suspected',
              documentId: existingId,
            },
          ],
        });

        await put(
          editedId,
          editPayload(supplierId, {
            number: '0003-00007005',
            issueDate: '2026-10-20',
            total: '3300.00',
            acceptIssues: ['duplicate_suspected'],
          }),
        ).expect(204);
        const saved = await prisma.document.findUniqueOrThrow({
          where: { id: editedId },
        });
        expect(saved.reviewStatus).toBe('reviewed');
        expect(saved.issues).toEqual([
          {
            code: 'duplicate_suspected',
            acceptedBy: ana.id,
            acceptedAt: NOW,
          },
        ]);

        // Editing an unnumbered document itself (e.g. its notes) does not self-match duplicate_suspected
        const soloId = await enter(
          invoice(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-25',
            total: '4400.00',
          }),
        );
        await put(
          soloId,
          editPayload(supplierId, {
            type: 'delivery_note',
            letter: 'X',
            number: null,
            issueDate: '2026-10-25',
            total: '4400.00',
            notes: 'Solo notas',
          }),
        ).expect(204);
      });
    });
  });
});
