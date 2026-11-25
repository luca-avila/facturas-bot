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
});
