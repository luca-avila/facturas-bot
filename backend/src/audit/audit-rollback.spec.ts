import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, createUser, signIn } from '../../test/app.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type AuditEntry, AuditService } from './audit.service.js';

/** Writes the entry, then fails, so the caller's transaction must roll back both. */
@Injectable()
class FailingAuditService extends AuditService {
  override async record(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    await super.record(tx, entry);
    throw new Error('The audit write failed.');
  }
}

describe('a failing audit write rolls back the change', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let session: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(AuditService).useClass(FailingAuditService),
    );
    prisma = app.get(PrismaService);
    const user = await createUser(app);
    userId = user.id;
    session = await signIn(app, user);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  function supplierInput(name: string, paymentTermDays: number | null) {
    return { name, legalName: null, cuit: null, paymentTermDays, notes: null };
  }

  it('creating a supplier returns 500 and leaves no supplier', async () => {
    const name = `Panadería ${randomUUID()}`;
    await http()
      .post('/api/suppliers')
      .set('Cookie', `session=${session}`)
      .send(supplierInput(name, 30))
      .expect(500);
    expect(await prisma.supplier.count({ where: { name } })).toBe(0);
  });

  it('updating a term returns 500 and keeps the old term', async () => {
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
  });

  it('entering a document returns 500 and leaves no document', async () => {
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
  });

  it('deleting a document returns 500 and leaves it counted', async () => {
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
  });

  it('applying credit returns 500 and leaves no application', async () => {
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
  });

  it('marking as paid returns 500 and leaves no payment and no application', async () => {
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
  });
});
