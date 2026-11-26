import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, createUser, signIn } from '../../test/app.js';
import { jpeg, png, sha256 } from '../../test/photos.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type AuditEntity,
  type AuditEntry,
  AuditService,
} from './audit.service.js';

/**
 * Writes each entry and records its entity. Then it fails on the first entry
 * for `failOn`, so the caller's transaction must roll back everything it wrote.
 */
@Injectable()
class FailingAuditService extends AuditService {
  /** The entity whose entry throws. With null nothing throws, so a test that forgets it fails. */
  failOn: AuditEntity | null = null;
  /** The entity of each entry asked for, in order. The last one is the entry that threw. */
  entities: AuditEntity[] = [];

  override async record(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    this.entities.push(entry.entity);
    await super.record(tx, entry);
    if (entry.entity === this.failOn) {
      throw new Error('The audit write failed.');
    }
  }
}

describe('a failing audit write rolls back the change', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let session: string;
  let userId: string;
  let audit: FailingAuditService;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(AuditService).useClass(FailingAuditService),
    );
    prisma = app.get(PrismaService);
    const provided = app.get(AuditService);
    if (!(provided instanceof FailingAuditService)) {
      throw new Error('AuditService is not the failing one.');
    }
    audit = provided;
    const user = await createUser(app);
    userId = user.id;
    session = await signIn(app, user);
  });

  beforeEach(() => {
    audit.failOn = null;
    audit.entities = [];
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  function supplierInput(name: string, paymentTermDays: number | null) {
    return { name, legalName: null, cuit: null, paymentTermDays, notes: null };
  }

  it('creating a supplier returns 500 and leaves no supplier', async () => {
    audit.failOn = 'suppliers';
    const name = `Panadería ${randomUUID()}`;
    await http()
      .post('/api/suppliers')
      .set('Cookie', `session=${session}`)
      .send(supplierInput(name, 30))
      .expect(500);
    expect(await prisma.supplier.count({ where: { name } })).toBe(0);
    expect(audit.entities).toEqual(['suppliers']);
  });

  it('updating a term returns 500 and keeps the old term', async () => {
    audit.failOn = 'suppliers';
    const name = `Panadería ${randomUUID()}`;
    const { id } = await prisma.supplier.create({
      data: { name, paymentTermDays: 30 },
    });
    await http()
      .put(`/api/suppliers/${id}`)
      .set('Cookie', `session=${session}`)
      .send(supplierInput(name, 45))
      .expect(500);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    expect(row.paymentTermDays).toBe(30);
    expect(await prisma.auditLog.count({ where: { entityId: id } })).toBe(0);
    expect(audit.entities).toEqual(['suppliers']);
  });

  it('entering a document returns 500 and leaves no document', async () => {
    audit.failOn = 'documents';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    await http()
      .post('/api/documents')
      .set('Cookie', `session=${session}`)
      .send({
        supplierId,
        type: 'invoice',
        letter: 'A',
        number: '0001-00004521',
        issueDate: '2026-10-09',
        dueDate: null,
        total: '100.00',
        notes: null,
      })
      .expect(500);
    expect(
      await prisma.document.count({
        where: { supplierId, number: '0001-00004521' },
      }),
    ).toBe(0);
    expect(audit.entities).toEqual(['documents']);
  });

  it('deleting a document returns 500 and leaves it counted', async () => {
    audit.failOn = 'documents';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const { id } = await prisma.document.create({
      data: {
        type: 'invoice',
        source: 'manual',
        reviewStatus: 'reviewed',
        supplierId,
        issueDate: new Date('2026-10-09'),
        dueDate: new Date('2026-11-08'),
        dueDateSource: 'supplier_term',
        total: '100.00',
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date('2026-11-09T12:00:00Z'),
      },
    });
    await http()
      .delete(`/api/documents/${id}`)
      .set('Cookie', `session=${session}`)
      .expect(500);
    const row = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: id } })).toBe(0);
    expect(audit.entities).toEqual(['documents']);
  });

  it('uploading returns 500 and leaves no document, image or job, so the same photos are new after', async () => {
    audit.failOn = 'documents';
    const photos = [jpeg(), png()];
    const upload = () => {
      const req = http()
        .post('/api/uploads')
        .set('Cookie', `session=${session}`)
        .set('X-Requested-With', 'XMLHttpRequest');
      photos.forEach((bytes, i) => {
        req.attach('photos', bytes, `pagina-${i + 1}`);
      });
      return req;
    };
    await upload().expect(500);
    expect(
      await prisma.document.count({
        where: { createdById: userId, source: 'upload' },
      }),
    ).toBe(0);
    expect(
      await prisma.documentImage.count({
        where: { sha256: { in: photos.map(sha256) } },
      }),
    ).toBe(0);
    expect(
      await prisma.extractionJob.count({
        where: { document: { createdById: userId } },
      }),
    ).toBe(0);
    expect(audit.entities).toEqual(['documents']);

    audit.failOn = null;
    const res = await upload().expect(201);
    expect(res.body).toEqual({
      id: expect.any(String) as unknown,
      alreadyUploaded: false,
    });
  });

  /** A reviewed invoice of 100.00, written directly. */
  async function newInvoice(supplierId: string): Promise<string> {
    const { id } = await prisma.document.create({
      data: {
        type: 'invoice',
        source: 'manual',
        reviewStatus: 'reviewed',
        supplierId,
        issueDate: new Date('2026-10-09'),
        dueDate: new Date('2026-11-08'),
        dueDateSource: 'manual',
        total: '100.00',
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date('2026-11-09T12:00:00Z'),
      },
    });
    return id;
  }

  it('saving a payment with a split returns 500 and leaves no payment and no application', async () => {
    audit.failOn = 'applications';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const documentId = await newInvoice(supplierId);
    await http()
      .post('/api/payments')
      .set('Cookie', `session=${session}`)
      .send({
        supplierId,
        amount: '100.00',
        paidOn: '2026-11-09',
        method: 'transfer',
        reference: null,
        valueDate: null,
        notes: null,
        applications: [{ documentId, amount: '100.00' }],
      })
      .expect(500);
    expect(await prisma.payment.count({ where: { supplierId } })).toBe(0);
    expect(await prisma.application.count({ where: { documentId } })).toBe(0);
    expect(audit.entities).toEqual(['payments', 'applications']);
  });

  it('applying credit returns 500 and leaves no application', async () => {
    audit.failOn = 'applications';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const documentId = await newInvoice(supplierId);
    const { id: creditNoteId } = await prisma.document.create({
      data: {
        type: 'credit_note',
        source: 'manual',
        reviewStatus: 'reviewed',
        supplierId,
        issueDate: new Date('2026-10-09'),
        total: '30.00',
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date('2026-11-09T12:00:00Z'),
      },
    });
    await http()
      .post('/api/applications')
      .set('Cookie', `session=${session}`)
      .send({
        source: { kind: 'credit_note', id: creditNoteId },
        applications: [{ documentId, amount: '30.00' }],
      })
      .expect(500);
    expect(await prisma.application.count({ where: { documentId } })).toBe(0);
    expect(audit.entities).toEqual(['applications']);
  });

  it('marking as paid returns 500 and leaves no payment and no application', async () => {
    audit.failOn = 'applications';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const documentId = await newInvoice(supplierId);
    await http()
      .post('/api/payments/mark-paid')
      .set('Cookie', `session=${session}`)
      .send({
        documentId,
        amount: '100.00',
        paidOn: '2026-11-09',
        method: 'cash',
        reference: null,
        valueDate: null,
      })
      .expect(500);
    expect(await prisma.payment.count({ where: { supplierId } })).toBe(0);
    expect(await prisma.application.count({ where: { documentId } })).toBe(0);
    expect(audit.entities).toEqual(['payments', 'applications']);
  });

  it('updating a document returns 500 and keeps the old fields', async () => {
    audit.failOn = 'documents';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const documentId = await newInvoice(supplierId);
    await http()
      .put(`/api/documents/${documentId}`)
      .set('Cookie', `session=${session}`)
      .send({
        supplierId,
        type: 'invoice',
        letter: 'A',
        number: '0001-00000001',
        issueDate: '2026-10-09',
        dueDate: null,
        dueDateSource: 'supplier_term',
        subtotal: null,
        total: '250.00',
        notes: 'cambiado',
      })
      .expect(500);
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    expect(row.total?.toString()).toBe('100');
    expect(row.notes).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: documentId } })).toBe(0);
  });

  it('reviewing a document returns 500 and leaves it unreviewed', async () => {
    audit.failOn = 'documents';
    const { id: supplierId } = await prisma.supplier.create({
      data: { name: `Panadería ${randomUUID()}`, paymentTermDays: 30 },
    });
    const { id: documentId } = await prisma.document.create({
      data: {
        source: 'upload',
        reviewStatus: 'unreviewed',
        type: 'credit_note',
        supplierId,
        issueDate: new Date('2026-10-09'),
        total: '100.00',
        createdById: userId,
      },
    });
    await http()
      .post(`/api/documents/${documentId}/review`)
      .set('Cookie', `session=${session}`)
      .send({})
      .expect(500);
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    expect(row.reviewStatus).toBe('unreviewed');
    expect(row.reviewedById).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: documentId } })).toBe(0);
  });

  it('retrying a document returns 500 and keeps it in error with no new job', async () => {
    audit.failOn = 'documents';
    const { id: documentId } = await prisma.document.create({
      data: {
        source: 'upload',
        reviewStatus: 'error',
        issues: [{ code: 'extraction_failed' }],
        createdById: userId,
      },
    });
    await http()
      .post(`/api/documents/${documentId}/retry`)
      .set('Cookie', `session=${session}`)
      .send({})
      .expect(500);
    const row = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });
    expect(row.reviewStatus).toBe('error');
    expect(await prisma.extractionJob.count({ where: { documentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: documentId } })).toBe(0);
  });
});
