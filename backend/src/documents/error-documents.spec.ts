import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import type { ErrorDocumentList } from '../balances/balances.types.js';
import { summarizeErrors } from '../balances/error-summary.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('GET /api/error-documents', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let session: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ana = await createUser(app, { name: 'Martín' });
    session = await signIn(app, ana);
  });

  afterAll(async () => {
    await app.close();
  });

  async function list(): Promise<ErrorDocumentList> {
    const res = await request(app.getHttpServer())
      .get('/api/error-documents')
      .set('Cookie', `session=${session}`)
      .expect(200);
    return res.body as ErrorDocumentList;
  }

  /** An upload of Ana's, at `createdAt`, changed by `data`. */
  async function upload(
    createdAt: string,
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const { id } = await prisma.document.create({
      data: {
        source: 'upload',
        reviewStatus: 'error',
        createdById: ana.id,
        createdAt: new Date(createdAt),
        issues: [{ code: 'extraction_failed' }],
        ...data,
      },
    });
    return id;
  }

  it("lists this file's Error documents oldest first, with their issues, and leaves out other states", async () => {
    const name = `Bebidas ${randomUUID()}`;
    const supplier = await prisma.supplier.create({
      data: { name, paymentTermDays: null },
    });
    const newer = await upload('2026-11-08T13:00:00Z', {
      type: 'invoice',
      letter: 'A',
      number: '0001-00004521',
      numberNormalized: '000100004521',
      supplierId: supplier.id,
      issueDate: new Date('2026-11-08T00:00:00Z'),
      total: '98700',
      issues: [{ code: 'supplier_term_missing' }],
    });
    const older = await upload('2026-11-08T02:00:00Z');
    const deleted = await upload('2026-11-08T03:00:00Z', {
      deletedAt: new Date('2026-11-09T00:00:00Z'),
    });
    const processing = await upload('2026-11-08T04:00:00Z', {
      reviewStatus: 'processing',
      issues: [],
    });
    const unreviewed = await upload('2026-11-08T05:00:00Z', {
      reviewStatus: 'unreviewed',
      type: 'credit_note',
      supplierId: supplier.id,
      issueDate: new Date('2026-11-08T00:00:00Z'),
      total: '10',
      issues: [],
    });

    const { documents } = await list();
    const ids = documents.map((doc) => doc.id);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(processing);
    expect(ids).not.toContain(unreviewed);
    const mine = documents.filter(
      (doc) => doc.id === older || doc.id === newer,
    );
    expect(mine).toEqual([
      {
        id: older,
        type: null,
        letter: null,
        number: null,
        supplier: null,
        issueDate: null,
        total: null,
        createdByName: 'Martín',
        // 02:00 UTC is still the 7th in Buenos Aires.
        createdOn: '2026-11-07',
        issues: ['extraction_failed'],
      },
      {
        id: newer,
        type: 'invoice',
        letter: 'A',
        number: '0001-00004521',
        supplier: { id: supplier.id, name },
        issueDate: '2026-11-08',
        total: '98700.00',
        createdByName: 'Martín',
        createdOn: '2026-11-08',
        issues: ['supplier_term_missing'],
      },
    ]);
  });

  it('always sends the summary of the documents in the same response', async () => {
    await upload('2026-11-10T12:00:00Z', { type: 'invoice', total: '55.55' });
    const result = await list();
    expect(result.summary).toEqual(summarizeErrors(result.documents));
    expect(result.summary.count).toBeGreaterThan(0);
  });
});
