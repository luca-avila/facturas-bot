import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, createUser, signIn } from '../../test/app.js';
import { type AuditEntry, AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { uniqueViolationIndex } from './unique-violation.js';

/** A real unique violation on an index that isn't a document number or a CUIT. */
async function createTwoUsersWithOneEmail(
  db: Prisma.TransactionClient,
): Promise<void> {
  const user = {
    email: `ana-${randomUUID()}@example.com`,
    name: 'Ana',
    passwordHash: 'not-a-real-hash',
    passwordSetAt: new Date('2026-11-09T12:00:00Z'),
    role: 'staff' as const,
  };
  await db.user.create({ data: user });
  await db.user.create({ data: user });
}

/** Writes the entry, then breaks `users_email_key` in the caller's transaction. */
@Injectable()
class CollidingAuditService extends AuditService {
  override async record(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    await super.record(tx, entry);
    await createTwoUsersWithOneEmail(tx);
  }
}

describe('unique violations', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let session: string;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(AuditService).useClass(CollidingAuditService),
    );
    prisma = app.get(PrismaService);
    session = await signIn(app, await createUser(app));
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('reads the name of the index a write broke', async () => {
    const error = await createTwoUsersWithOneEmail(prisma).catch(
      (caught: unknown) => caught,
    );
    expect(uniqueViolationIndex(error)).toBe('users_email_key');
  });

  it('gives null for an error that is not a unique violation', () => {
    expect(uniqueViolationIndex(new Error('The write failed.'))).toBeNull();
  });

  // The services check the index name, so another unique violation is a bug
  // and a 500, never a duplicate the person is asked to fix.
  it('entering a document returns 500, not duplicate_number', async () => {
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
    expect(await prisma.document.count({ where: { supplierId } })).toBe(0);
  });

  it('creating a supplier returns 500, not cuit_taken', async () => {
    const name = `Panadería ${randomUUID()}`;
    await http()
      .post('/api/suppliers')
      .set('Cookie', `session=${session}`)
      .send({
        name,
        legalName: null,
        cuit: null,
        paymentTermDays: 30,
        notes: null,
      })
      .expect(500);
    expect(await prisma.supplier.count({ where: { name } })).toBe(0);
  });
});
