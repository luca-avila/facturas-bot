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
        suggestedTermDays: null,
        suspectedDuplicateId: null,
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
        suggestedTermDays: null,
        suspectedDuplicateId: null,
      },
    ]);
  });

  it('always sends the summary of the documents in the same response', async () => {
    await upload('2026-11-10T12:00:00Z', { type: 'invoice', total: '55.55' });
    const result = await list();
    expect(result.summary).toEqual(summarizeErrors(result.documents));
    expect(result.summary.count).toBeGreaterThan(0);
  });

  it('includes suggestedTermDays from the latest succeeded extraction job', async () => {
    const supplier = await prisma.supplier.create({
      data: { name: `Term ${randomUUID()}`, paymentTermDays: null },
    });
    const id = await upload('2026-11-10T13:00:00Z', {
      type: 'invoice',
      supplierId: supplier.id,
      issueDate: new Date('2026-11-01T00:00:00Z'),
      total: '1200',
      issues: [{ code: 'supplier_term_missing' }],
    });
    await prisma.extractionJob.createMany({
      data: [
        {
          documentId: id,
          status: 'succeeded',
          attempts: 1,
          runAfter: new Date('2026-11-10T13:00:00Z'),
          model: 'claude-haiku-5-5',
          promptVersion: '1',
          rawOutput: { printedTermDays: 15 },
          createdAt: new Date('2026-11-10T13:00:01Z'),
        },
        {
          documentId: id,
          status: 'succeeded',
          attempts: 1,
          runAfter: new Date('2026-11-10T13:01:00Z'),
          model: 'claude-haiku-5-5',
          promptVersion: '1',
          rawOutput: { printedDueDate: '2026-12-01' },
          createdAt: new Date('2026-11-10T13:01:01Z'),
        },
        {
          documentId: id,
          status: 'failed',
          attempts: 1,
          runAfter: new Date('2026-11-10T13:02:00Z'),
          rawOutput: { printedTermDays: 90 },
          createdAt: new Date('2026-11-10T13:02:01Z'),
        },
      ],
    });

    const { documents } = await list();
    expect(documents.find((doc) => doc.id === id)?.suggestedTermDays).toBe(30);
  });

  it('drops an Error document from the list after DELETE and audits the delete', async () => {
    const id = await upload('2026-11-10T14:00:00Z', {
      type: 'invoice',
      total: '750.00',
      issues: [{ code: 'unsupported_document' }],
    });
    expect((await list()).documents.map((d) => d.id)).toContain(id);

    await request(app.getHttpServer())
      .delete(`/api/documents/${id}`)
      .set('Cookie', `session=${session}`)
      .expect(204);

    expect((await list()).documents.map((d) => d.id)).not.toContain(id);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect(stored.deletedAt).not.toBeNull();
    const auditLogs = await prisma.auditLog.findMany({
      where: { entity: 'documents', entityId: id, action: 'delete' },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].userId).toBe(ana.id);
  });

  it('exposes only open issues and resolves suspectedDuplicateId when duplicate_suspected is open', async () => {
    const supplier = await prisma.supplier.create({
      data: { name: `Dup ${randomUUID()}`, paymentTermDays: 30 },
    });
    const existing = await prisma.document.create({
      data: {
        source: 'manual',
        reviewStatus: 'reviewed',
        type: 'delivery_note',
        supplierId: supplier.id,
        letter: 'X',
        number: null,
        numberNormalized: null,
        issueDate: new Date('2026-11-05T00:00:00Z'),
        dueDate: new Date('2026-12-05T00:00:00Z'),
        dueDateSource: 'supplier_term',
        total: '4500.00',
        createdById: ana.id,
        reviewedById: ana.id,
        reviewedAt: new Date('2026-11-05T15:00:00Z'),
      },
    });
    const dupId = await upload('2026-11-10T15:00:00Z', {
      type: 'delivery_note',
      supplierId: supplier.id,
      letter: 'X',
      number: null,
      numberNormalized: null,
      issueDate: new Date('2026-11-05T00:00:00Z'),
      total: '4500.00',
      issues: [
        { code: 'duplicate_suspected' },
        {
          code: 'wrong_recipient',
          acceptedBy: ana.id,
          acceptedAt: '2026-11-10T15:05:00.000Z',
        },
      ],
    });

    const { documents } = await list();
    const row = documents.find((d) => d.id === dupId);
    expect(row).toMatchObject({
      issues: ['duplicate_suspected'],
      suspectedDuplicateId: existing.id,
    });
  });
});
