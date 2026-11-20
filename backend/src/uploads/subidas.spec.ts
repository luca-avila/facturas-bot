import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import { jpeg, png } from '../../test/photos.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UploadList, UploadRow } from './uploads.types.js';

/** 10:00 on 2026-11-12 in Buenos Aires. */
const A_AT = '2026-11-12T13:00:00.000Z';
const B_AT = '2026-11-12T13:05:00.000Z';
const C_AT = '2026-11-12T14:00:00.000Z';

describe('Subidas', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let beto: CreatedTestUser;
  const sessions = new Map<string, string>();
  let a: string;
  let b: string;
  let c: string;

  const http = () => request(app.getHttpServer());

  /** Moves the clock and signs both in again, since sessions last 30 days. */
  async function at(instant: string): Promise<void> {
    vi.setSystemTime(instant);
    for (const user of [ana, beto]) {
      sessions.set(user.id, await signIn(app, user));
    }
  }

  async function upload(user: CreatedTestUser, pages = 1): Promise<string> {
    const req = http()
      .post('/api/uploads')
      .set('Cookie', `session=${sessions.get(user.id)}`)
      .set('X-Requested-With', 'XMLHttpRequest');
    for (let i = 0; i < pages; i++) {
      req.attach('photos', i % 2 === 0 ? jpeg() : png(), `pagina-${i + 1}`);
    }
    const res = await req.expect(201);
    return (res.body as { id: string }).id;
  }

  async function list(
    user: CreatedTestUser,
    scope: 'mine' | 'all',
  ): Promise<UploadRow[]> {
    const res = await http()
      .get(`/api/uploads?scope=${scope}`)
      .set('Cookie', `session=${sessions.get(user.id)}`)
      .expect(200);
    return (res.body as UploadList).uploads;
  }

  const ids = (rows: UploadRow[]) => rows.map((row) => row.id);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(A_AT);
    ana = await createUser(app, { name: 'Ana' });
    beto = await createUser(app, { name: 'Beto' });

    await at(A_AT);
    a = await upload(ana, 2);
    await at(B_AT);
    b = await upload(ana);
    const supplier = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}` },
    });
    await prisma.document.update({
      where: { id: b },
      data: {
        reviewStatus: 'unreviewed',
        supplierId: supplier.id,
        type: 'invoice',
        letter: 'A',
        number: '0001-00004521',
        numberNormalized: '000100004521',
        issueDate: new Date('2026-11-10'),
        dueDate: new Date('2026-12-10'),
        dueDateSource: 'manual',
        total: '53600.00',
      },
    });
    await at(C_AT);
    c = await upload(beto);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
  });

  describe('on the sixth day after', () => {
    beforeAll(async () => {
      await at('2026-11-18T13:00:00.000Z');
    });

    it('lists Ana’s uploads under Mías, newest first', async () => {
      const rows = await list(ana, 'mine');
      expect(rows).toEqual([
        {
          id: b,
          reviewStatus: 'unreviewed',
          pageCount: 1,
          uploadedOn: '2026-11-12',
          uploadedTime: '10:05',
          daysAgo: 6,
          createdByName: 'Ana',
          type: 'invoice',
          letter: 'A',
          number: '0001-00004521',
          supplierName: expect.stringMatching(/^Panadería /) as unknown,
          total: '53600.00',
        },
        {
          id: a,
          reviewStatus: 'processing',
          pageCount: 2,
          uploadedOn: '2026-11-12',
          uploadedTime: '10:00',
          daysAgo: 6,
          createdByName: 'Ana',
          type: null,
          letter: null,
          number: null,
          supplierName: null,
          total: null,
        },
      ]);
    });

    it('lists everyone’s under Todas', async () => {
      const rows = await list(ana, 'all');
      expect(ids(rows)).toEqual(expect.arrayContaining([a, b, c]));
      expect(rows.find((row) => row.id === c)).toMatchObject({
        createdByName: 'Beto',
        uploadedTime: '11:00',
      });
    });

    it('lists only Beto’s under his Mías', async () => {
      expect(ids(await list(beto, 'mine'))).toEqual([c]);
    });
  });

  it('still lists B at 23:59 on the 18th in Buenos Aires', async () => {
    await at('2026-11-19T02:59:00.000Z');
    expect(ids(await list(ana, 'mine'))).toEqual([b, a]);
  });

  it('drops B at 00:00 on the 19th, and keeps A while it is processing', async () => {
    await at('2026-11-19T03:00:00.000Z');
    expect(ids(await list(ana, 'mine'))).toEqual([a]);
  });

  it('keeps listing a processing upload weeks later', async () => {
    await at('2026-12-30T15:00:00.000Z');
    const rows = await list(ana, 'mine');
    expect(rows).toMatchObject([{ id: a, daysAgo: 48 }]);
  });

  describe('never lists', () => {
    beforeAll(async () => {
      await at('2026-11-18T13:00:00.000Z');
    });

    it('a deleted upload', async () => {
      const id = await upload(ana);
      await http()
        .delete(`/api/documents/${id}`)
        .set('Cookie', `session=${sessions.get(ana.id)}`)
        .expect(204);
      expect(ids(await list(ana, 'all'))).not.toContain(id);
    });

    it('a manual document', async () => {
      const supplier = await prisma.supplier.create({
        data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
      });
      const res = await http()
        .post('/api/documents')
        .set('Cookie', `session=${sessions.get(ana.id)}`)
        .send({
          supplierId: supplier.id,
          type: 'invoice',
          letter: 'A',
          number: '0001-00000001',
          issueDate: '2026-11-17',
          dueDate: null,
          total: '100.00',
          notes: null,
        })
        .expect(201);
      const { id } = res.body as { id: string };
      expect(ids(await list(ana, 'all'))).not.toContain(id);
    });
  });

  it('breaks a tie in created_at by id, highest first', async () => {
    const caro = await createUser(app, { name: 'Caro' });
    await at('2026-11-18T13:00:00.000Z');
    const session = await signIn(app, caro);
    // The lower id goes in first, so table order is the opposite of the answer.
    const [low, high] = [randomUUID(), randomUUID()].sort();
    for (const id of [low, high]) {
      await prisma.document.create({
        data: {
          id,
          source: 'upload',
          reviewStatus: 'processing',
          createdById: caro.id,
          createdAt: new Date('2026-11-18T12:00:00.000Z'),
        },
      });
    }
    const res = await http()
      .get('/api/uploads?scope=mine')
      .set('Cookie', `session=${session}`)
      .expect(200);
    expect(ids((res.body as UploadList).uploads)).toEqual([high, low]);
  });

  it.each([
    ['without scope', ''],
    ['with scope=x', '?scope=x'],
    ['with scope repeated', '?scope=mine&scope=all'],
  ])('answers 400 %s', async (_, query) => {
    await at('2026-11-18T13:00:00.000Z');
    await http()
      .get(`/api/uploads${query}`)
      .set('Cookie', `session=${sessions.get(ana.id)}`)
      .expect(400);
  });
});
