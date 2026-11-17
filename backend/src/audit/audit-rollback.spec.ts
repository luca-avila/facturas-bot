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

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(AuditService).useClass(FailingAuditService),
    );
    prisma = app.get(PrismaService);
    session = await signIn(app, await createUser(app));
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
});
