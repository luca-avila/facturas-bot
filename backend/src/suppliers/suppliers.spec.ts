import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import { SUPPLIER_SPEC_CUITS } from '../../test/test-cuits.js';
import { DuplicateNumberCheck } from '../documents/duplicate-number-check.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `cuit` is unique and other spec files give their own suppliers CUITs, so
 * each test starts by freeing only this file's group, `SUPPLIER_SPEC_CUITS`.
 */
describe('suppliers', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let session: string;

  const [CEIBO_CUIT, OTHER_CUIT] = SUPPLIER_SPEC_CUITS;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ana = await createUser(app, { name: 'Ana' });
    session = await signIn(app, ana);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`
      UPDATE suppliers SET cuit = NULL WHERE cuit = ANY(${[...SUPPLIER_SPEC_CUITS]}::text[])`;
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (body: unknown) =>
    http()
      .post('/api/suppliers')
      .set('Cookie', `session=${session}`)
      .send(body as object);
  const put = (id: string, body: unknown) =>
    http()
      .put(`/api/suppliers/${id}`)
      .set('Cookie', `session=${session}`)
      .send(body as object);

  function input(overrides: Record<string, unknown> = {}) {
    return {
      name: `Panadería ${randomUUID()}`,
      legalName: null,
      cuit: null,
      paymentTermDays: 30,
      notes: null,
      ...overrides,
    };
  }

  async function create(overrides: Record<string, unknown> = {}) {
    const res = await post(input(overrides)).expect(201);
    return (res.body as { id: string }).id;
  }

  const suppliersNamed = (name: string) =>
    prisma.supplier.count({ where: { name } });

  const auditEntriesNamed = async (name: string) => {
    const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE entity = 'suppliers' AND after->>'name' = ${name}`;
    return count;
  };

  const auditFor = (id: string) =>
    prisma.$queryRaw<
      {
        action: string;
        user_id: string;
        before_is_null: boolean;
        before_term: string | null;
        after_term: string | null;
      }[]
    >`
      SELECT action, user_id::text, before IS NULL AS before_is_null,
             before->>'payment_term_days' AS before_term,
             after->>'payment_term_days' AS after_term
      FROM audit_log
      WHERE entity = 'suppliers' AND entity_id = ${id}::uuid
      ORDER BY created_at`;

  describe('create', () => {
    it('stores Panadería El Ceibo with the CUIT as 11 digits, and audits it by Ana', async () => {
      const name = `Panadería El Ceibo ${randomUUID()}`;
      const res = await post({
        name: `  ${name} `,
        legalName: ' El Ceibo S.R.L. ',
        cuit: '30-00000001-5',
        paymentTermDays: 30,
        notes: ' Entrega los martes ',
      }).expect(201);
      const { id } = res.body as { id: string };

      const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        name,
        legalName: 'El Ceibo S.R.L.',
        cuit: CEIBO_CUIT,
        paymentTermDays: 30,
        notes: 'Entrega los martes',
      });
      expect(await auditFor(id)).toEqual([
        {
          action: 'create',
          user_id: ana.id,
          before_is_null: true,
          before_term: null,
          after_term: '30',
        },
      ]);
    });

    it('turns an empty legal name and notes into null', async () => {
      const id = await create({ legalName: '   ', notes: '' });
      const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
      expect(row.legalName).toBeNull();
      expect(row.notes).toBeNull();
    });

    it('refuses a CUIT with a wrong check digit, and writes nothing', async () => {
      const body = input({ cuit: '30-00000001-6' });
      const res = await post(body).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'cuit', code: 'cuit_invalid' }],
      });
      expect(await suppliersNamed(body.name)).toBe(0);
      expect(await auditEntriesNamed(body.name)).toBe(0);
    });

    it.each([
      ['ten digits', '3000000001', 'cuit_invalid'],
      ['letters', '30-0000000A-5', 'cuit_invalid'],
      ['only hyphens and spaces', ' - -  ', 'cuit_required'],
      ['an empty string', '', 'cuit_required'],
    ])('refuses a CUIT of %s', async (_, cuit, code) => {
      const res = await post(input({ cuit })).expect(400);
      expect(res.body).toEqual({ errors: [{ field: 'cuit', code }] });
    });

    it('accepts two informal suppliers', async () => {
      await create({ cuit: null });
      await create({ cuit: null });
    });

    it("refuses a second supplier with Ana's CUIT with 409, and keeps one", async () => {
      await create({ cuit: CEIBO_CUIT });
      const res = await post(input({ cuit: '30-00000001-5' })).expect(409);
      expect(res.body).toEqual({
        errors: [{ field: 'cuit', code: 'cuit_taken' }],
      });
      expect(await prisma.supplier.count({ where: { cuit: CEIBO_CUIT } })).toBe(
        1,
      );
    });

    it('refuses a blank name with name_required', async () => {
      const res = await post(input({ name: '   ' })).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'name', code: 'name_required' }],
      });
    });

    it('gives every field error at once', async () => {
      const res = await post(
        input({ name: '', cuit: '30-00000001-6', paymentTermDays: -1 }),
      ).expect(400);
      expect(res.body).toEqual({
        errors: [
          { field: 'name', code: 'name_required' },
          { field: 'cuit', code: 'cuit_invalid' },
          { field: 'paymentTermDays', code: 'payment_term_invalid' },
        ],
      });
    });

    it.each([-1, 366, 1.5])('refuses a term of %s', async (paymentTermDays) => {
      const body = input({ paymentTermDays });
      const res = await post(body).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'paymentTermDays', code: 'payment_term_invalid' }],
      });
      expect(await suppliersNamed(body.name)).toBe(0);
    });

    it.each([0, 365, null])('accepts a term of %s', async (paymentTermDays) => {
      const id = await create({ paymentTermDays });
      const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
      expect(row.paymentTermDays).toBe(paymentTermDays);
    });

    it.each([
      ['an array', []],
      ['a number as the name', { ...input(), name: 42 }],
      [
        'a missing key',
        { name: 'Panadería', legalName: null, cuit: null, paymentTermDays: 30 },
      ],
      ['a string as the term', input({ paymentTermDays: '30' })],
      ['an unknown key', { ...input(), extra: true }],
    ])('refuses %s with 400 and no field errors', async (_, body) => {
      const res = await http()
        .post('/api/suppliers')
        .set('Cookie', `session=${session}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body))
        .expect(400);
      expect(res.body).toEqual({ errors: [] });
    });

    // Express's JSON parser refuses a top-level string or null before the
    // controller sees it, so the body is Nest's, not `{ errors: [] }`.
    it.each([
      ['a string', 'Panadería'],
      ['null', null],
      ['not JSON', undefined],
    ])('refuses %s as the body with 400', async (_, body) => {
      await http()
        .post('/api/suppliers')
        .set('Cookie', `session=${session}`)
        .set('Content-Type', 'application/json')
        .send(body === undefined ? '{name:' : JSON.stringify(body))
        .expect(400);
    });
  });

  describe('update', () => {
    it('changes the term from 30 to 45 and audits the before and after', async () => {
      const body = input({ paymentTermDays: 30 });
      const id = ((await post(body).expect(201)).body as { id: string }).id;

      await put(id, { ...body, paymentTermDays: 45 }).expect(204);

      const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
      expect(row.paymentTermDays).toBe(45);
      const entries = await auditFor(id);
      expect(entries).toHaveLength(2);
      expect(entries[1]).toEqual({
        action: 'update',
        user_id: ana.id,
        before_is_null: false,
        before_term: '30',
        after_term: '45',
      });
    });

    it("refuses another supplier's CUIT with 409", async () => {
      await create({ cuit: CEIBO_CUIT });
      const body = input({ cuit: OTHER_CUIT });
      const id = ((await post(body).expect(201)).body as { id: string }).id;

      const res = await put(id, { ...body, cuit: CEIBO_CUIT }).expect(409);
      expect(res.body).toEqual({
        errors: [{ field: 'cuit', code: 'cuit_taken' }],
      });
      const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
      expect(row.cuit).toBe(OTHER_CUIT);
      expect(await prisma.supplier.count({ where: { cuit: CEIBO_CUIT } })).toBe(
        1,
      );
    });

    it('frees the CUIT for another supplier once the first is informal', async () => {
      const body = input({ cuit: CEIBO_CUIT });
      const first = ((await post(body).expect(201)).body as { id: string }).id;
      await put(first, { ...body, cuit: null }).expect(204);

      const second = await create({ cuit: CEIBO_CUIT });
      const row = await prisma.supplier.findUniqueOrThrow({
        where: { cuit: CEIBO_CUIT },
      });
      expect(row.id).toBe(second);
    });

    it('validates the body like create', async () => {
      const id = await create();
      const res = await put(id, input({ name: '' })).expect(400);
      expect(res.body).toEqual({
        errors: [{ field: 'name', code: 'name_required' }],
      });
    });

    it.each([
      ['an unknown id', randomUUID()],
      ['a non-UUID id', 'not-a-uuid'],
    ])('returns 404 for %s', async (_, id) => {
      await put(id, input()).expect(404);
    });
  });

  describe('term preview and save (Definir plazo)', () => {
    const preview = (id: string, body: unknown) =>
      http()
        .post(`/api/suppliers/${id}/term/preview`)
        .set('Cookie', `session=${session}`)
        .send(body as object);

    const setTerm = (id: string, body: unknown) =>
      http()
        .post(`/api/suppliers/${id}/term`)
        .set('Cookie', `session=${session}`)
        .send(body as object);

    async function doc(data: Record<string, unknown>): Promise<string> {
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

    it('validates input and returns 404 for missing or invalid supplier ids', async () => {
      const supplierId = await create({ paymentTermDays: null });
      for (const bad of [-1, 366, 1.5]) {
        for (const call of [preview, setTerm]) {
          const res = await call(supplierId, { paymentTermDays: bad }).expect(
            400,
          );
          expect(res.body).toEqual({
            errors: [{ field: 'paymentTermDays', code: 'payment_term_invalid' }],
          });
        }
      }
      for (const malformed of [{}, { paymentTermDays: '30' }, { paymentTermDays: 30, extra: 1 }]) {
        await preview(supplierId, malformed).expect(400);
        await setTerm(supplierId, malformed).expect(400);
      }
      for (const badId of ['nope', randomUUID()]) {
        await preview(badId, { paymentTermDays: 30 }).expect(404);
        await setTerm(badId, { paymentTermDays: 30 }).expect(404);
      }
    });

    it('previews identically to save without mutating DB, then unblocks eligible error docs and updates others', async () => {
      const supplierId = await create({ paymentTermDays: null });
      const otherSupplierId = await create({ paymentTermDays: null });

      const cleanInvoice = await doc({
        type: 'invoice',
        letter: 'A',
        number: '0001-00000001',
        numberNormalized: '000100000001',
        supplierId,
        issueDate: new Date('2026-10-01'),
        total: '1000.00',
        issues: [{ code: 'supplier_term_missing' }],
        createdAt: new Date('2026-11-01T10:00:00Z'),
      });
      const missingTotal = await doc({
        type: 'delivery_note',
        letter: null,
        number: '0001-00000002',
        numberNormalized: '000100000002',
        supplierId,
        issueDate: new Date('2026-10-02'),
        total: null,
        issues: [{ code: 'missing_total' }, { code: 'supplier_term_missing' }],
        createdAt: new Date('2026-11-01T10:01:00Z'),
      });
      const missingIssueDate = await doc({
        type: 'invoice',
        letter: 'A',
        number: '0001-00000003',
        numberNormalized: '000100000003',
        supplierId,
        issueDate: null,
        total: '500.00',
        issues: [
          { code: 'missing_issue_date' },
          { code: 'supplier_term_missing' },
        ],
        createdAt: new Date('2026-11-01T10:02:00Z'),
      });
      // Error doc without supplier_term_missing -> untouched
      const onlyMissingTotal = await doc({
        type: 'invoice',
        supplierId,
        issueDate: new Date('2026-10-03'),
        dueDate: new Date('2026-10-20'),
        dueDateSource: 'manual',
        total: null,
        issues: [{ code: 'missing_total' }],
        createdAt: new Date('2026-11-01T10:03:00Z'),
      });
      // Non-error, deleted, and other supplier docs -> untouched
      const unreviewed = await doc({
        reviewStatus: 'unreviewed',
        type: 'invoice',
        supplierId,
        issueDate: new Date('2026-10-01'),
        dueDate: new Date('2026-10-15'),
        dueDateSource: 'manual',
        total: '200.00',
        issues: [],
      });
      const reviewed = await doc({
        reviewStatus: 'reviewed',
        type: 'invoice',
        supplierId,
        issueDate: new Date('2026-10-01'),
        dueDate: new Date('2026-10-15'),
        dueDateSource: 'manual',
        total: '300.00',
        issues: [],
        reviewedById: ana.id,
        reviewedAt: new Date('2026-11-01T10:00:00Z'),
      });
      const processing = await doc({
        reviewStatus: 'processing',
        supplierId,
        issues: [],
      });
      const deleted = await doc({
        type: 'invoice',
        supplierId,
        issueDate: new Date('2026-10-01'),
        total: '400.00',
        issues: [{ code: 'supplier_term_missing' }],
        deletedAt: new Date('2026-11-02T00:00:00Z'),
      });
      const otherSupplierDoc = await doc({
        type: 'invoice',
        supplierId: otherSupplierId,
        issueDate: new Date('2026-10-01'),
        total: '400.00',
        issues: [{ code: 'supplier_term_missing' }],
      });

      const previewRes = await preview(supplierId, {
        paymentTermDays: 30,
      }).expect(200);
      expect(previewRes.body).toEqual({
        paymentTermDays: 30,
        unblockedCount: 1,
        documents: [
          {
            id: cleanInvoice,
            type: 'invoice',
            letter: 'A',
            number: '0001-00000001',
            issueDate: '2026-10-01',
            dueDate: '2026-10-31',
            willUnblock: true,
            remainingIssues: [],
          },
          {
            id: missingTotal,
            type: 'delivery_note',
            letter: null,
            number: '0001-00000002',
            issueDate: '2026-10-02',
            dueDate: '2026-11-01',
            willUnblock: false,
            remainingIssues: ['missing_total'],
          },
          {
            id: missingIssueDate,
            type: 'invoice',
            letter: 'A',
            number: '0001-00000003',
            issueDate: null,
            dueDate: null,
            willUnblock: false,
            remainingIssues: ['missing_issue_date'],
          },
        ],
      });

      // Preview did not mutate DB
      expect(
        (await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }))
          .paymentTermDays,
      ).toBeNull();
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: cleanInvoice } }))
          .reviewStatus,
      ).toBe('error');

      const saveRes = await setTerm(supplierId, {
        paymentTermDays: 30,
      }).expect(200);
      expect(saveRes.body).toEqual(previewRes.body);

      const savedSupplier = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      expect(savedSupplier.paymentTermDays).toBe(30);

      const savedClean = await prisma.document.findUniqueOrThrow({
        where: { id: cleanInvoice },
      });
      expect(savedClean.reviewStatus).toBe('unreviewed');
      expect(savedClean.reviewedById).toBeNull();
      expect(savedClean.reviewedAt).toBeNull();
      expect(savedClean.dueDate?.toISOString().slice(0, 10)).toBe('2026-10-31');
      expect(savedClean.dueDateSource).toBe('supplier_term');
      expect(savedClean.issues).toEqual([]);

      const savedMissingTotal = await prisma.document.findUniqueOrThrow({
        where: { id: missingTotal },
      });
      expect(savedMissingTotal.reviewStatus).toBe('error');
      expect(savedMissingTotal.dueDate?.toISOString().slice(0, 10)).toBe(
        '2026-11-01',
      );
      expect(savedMissingTotal.dueDateSource).toBe('supplier_term');
      expect(savedMissingTotal.issues).toEqual([{ code: 'missing_total' }]);

      const savedMissingDate = await prisma.document.findUniqueOrThrow({
        where: { id: missingIssueDate },
      });
      expect(savedMissingDate.reviewStatus).toBe('error');
      expect(savedMissingDate.dueDate).toBeNull();
      expect(savedMissingDate.issues).toEqual([
        { code: 'missing_issue_date' },
      ]);

      // Untouched rows
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: onlyMissingTotal } }))
          .dueDate?.toISOString()
          .slice(0, 10),
      ).toBe('2026-10-20');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: unreviewed } }))
          .dueDate?.toISOString()
          .slice(0, 10),
      ).toBe('2026-10-15');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: reviewed } }))
          .reviewedById,
      ).toBe(ana.id);
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: processing } }))
          .reviewStatus,
      ).toBe('processing');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: deleted } }))
          .reviewStatus,
      ).toBe('error');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: otherSupplierDoc } }))
          .reviewStatus,
      ).toBe('error');

      // Audit logs written for supplier and changed error documents
      expect(
        await prisma.auditLog.count({
          where: { entity: 'suppliers', entityId: supplierId, action: 'update' },
        }),
      ).toBe(1);
      for (const changedId of [cleanInvoice, missingTotal, missingIssueDate]) {
        const logs = await prisma.auditLog.findMany({
          where: { entity: 'documents', entityId: changedId, action: 'update' },
        });
        expect(logs).toHaveLength(1);
        expect(logs[0].userId).toBe(ana.id);
      }
      expect(
        await prisma.auditLog.count({
          where: { entity: 'documents', entityId: onlyMissingTotal },
        }),
      ).toBe(0);
    });

    it('unblocks only the oldest of two duplicate error documents and keeps the second in error with duplicate_number', async () => {
      const supplierId = await create({ paymentTermDays: null });
      const older = await doc({
        type: 'invoice',
        letter: 'A',
        number: '0003-00000123',
        numberNormalized: '000300000123',
        supplierId,
        issueDate: new Date('2026-10-01'),
        total: '1000.00',
        issues: [{ code: 'supplier_term_missing' }],
        createdAt: new Date('2026-11-01T10:00:00Z'),
      });
      const newer = await doc({
        type: 'invoice',
        letter: 'A',
        number: '0003 00000123',
        numberNormalized: '000300000123',
        supplierId,
        issueDate: new Date('2026-10-02'),
        total: '1000.00',
        issues: [{ code: 'supplier_term_missing' }],
        createdAt: new Date('2026-11-01T10:05:00Z'),
      });

      const res = await setTerm(supplierId, { paymentTermDays: 30 }).expect(
        200,
      );
      expect(res.body).toEqual({
        paymentTermDays: 30,
        unblockedCount: 1,
        documents: [
          expect.objectContaining({
            id: older,
            willUnblock: true,
            remainingIssues: [],
          }),
          expect.objectContaining({
            id: newer,
            willUnblock: false,
            remainingIssues: ['duplicate_number'],
          }),
        ],
      });
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: older } }))
          .reviewStatus,
      ).toBe('unreviewed');
      expect(
        (await prisma.document.findUniqueOrThrow({ where: { id: newer } }))
          .reviewStatus,
      ).toBe('error');
    });

    it('retries once on P2002 from documents_number_unique and marks the colliding document with duplicate_number', async () => {
      let calls = 0;
      const customApp = await createTestApp((builder) =>
        builder.overrideProvider(DuplicateNumberCheck).useValue({
          exists: () => {
            calls += 1;
            // First check misses so P2002 triggers on DB unique index; retry sees false or forcedDuplicateIds
            return Promise.resolve(false);
          },
        }),
      );
      try {
        const customPrisma = customApp.get(PrismaService);
        const user = await createUser(customApp);
        const cookie = await signIn(customApp, user);
        const supplier = await customPrisma.supplier.create({
          data: { name: `Dup ${randomUUID()}`, paymentTermDays: null },
        });
        await customPrisma.document.create({
          data: {
            source: 'manual',
            reviewStatus: 'reviewed',
            type: 'invoice',
            letter: 'A',
            number: '0001-00009999',
            numberNormalized: '000100009999',
            supplierId: supplier.id,
            issueDate: new Date('2026-10-01'),
            dueDate: new Date('2026-10-31'),
            dueDateSource: 'manual',
            total: '500.00',
            createdById: user.id,
            reviewedById: user.id,
            reviewedAt: new Date('2026-11-01T10:00:00Z'),
          },
        });
        const errorDoc = await customPrisma.document.create({
          data: {
            source: 'upload',
            reviewStatus: 'error',
            type: 'invoice',
            letter: 'A',
            number: '0001-00009999',
            numberNormalized: '000100009999',
            supplierId: supplier.id,
            issueDate: new Date('2026-10-02'),
            total: '500.00',
            issues: [{ code: 'supplier_term_missing' }],
            createdById: user.id,
          },
        });

        const res = await request(customApp.getHttpServer())
          .post(`/api/suppliers/${supplier.id}/term`)
          .set('Cookie', `session=${cookie}`)
          .send({ paymentTermDays: 15 })
          .expect(200);
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(res.body).toEqual({
          paymentTermDays: 15,
          unblockedCount: 0,
          documents: [
            expect.objectContaining({
              id: errorDoc.id,
              dueDate: '2026-10-17',
              willUnblock: false,
              remainingIssues: ['duplicate_number'],
            }),
          ],
        });
        const after = await customPrisma.document.findUniqueOrThrow({
          where: { id: errorDoc.id },
        });
        expect(after.reviewStatus).toBe('error');
        expect(after.issues).toEqual([{ code: 'duplicate_number' }]);
      } finally {
        await customApp.close();
      }
    });

    it('handles concurrent setTerm calls without invariant violations', async () => {
      const supplierId = await create({ paymentTermDays: null });
      const docId = await doc({
        type: 'invoice',
        letter: 'A',
        number: '0004-00000001',
        numberNormalized: '000400000001',
        supplierId,
        issueDate: new Date('2026-10-01'),
        total: '1000.00',
        issues: [{ code: 'supplier_term_missing' }],
      });

      const [r1, r2] = await Promise.all([
        setTerm(supplierId, { paymentTermDays: 30 }),
        setTerm(supplierId, { paymentTermDays: 45 }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const finalSupplier = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      const finalDoc = await prisma.document.findUniqueOrThrow({
        where: { id: docId },
      });
      expect(finalDoc.reviewStatus).toBe('unreviewed');
      expect([30, 45]).toContain(finalSupplier.paymentTermDays);
    });
  });
});
