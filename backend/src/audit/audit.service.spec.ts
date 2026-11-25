import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  let userId: string;
  let supplierId: string;

  beforeAll(async () => {
    const [user] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, password_set_at, role)
      VALUES (${`ana-${randomUUID()}@example.com`}, 'Ana', 'not-a-real-hash', now(), 'staff')
      RETURNING id`;
    userId = user.id;
  });

  beforeEach(async () => {
    const [supplier] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO suppliers (name, payment_term_days)
      VALUES ('Panadería de prueba', 30) RETURNING id`;
    supplierId = supplier.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('writes the whole row, with amounts as Postgres prints them, and a SQL NULL before on create', async () => {
    const [doc] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO documents (source, review_status, type, supplier_id, issue_date, total, created_by, reviewed_by, reviewed_at)
      VALUES ('manual', 'reviewed', 'credit_note', ${supplierId}::uuid, '2026-10-09', 86900.50, ${userId}::uuid, ${userId}::uuid, now())
      RETURNING id`;

    await prisma.$transaction(async (tx) => {
      const after = await audit.snapshot(tx, 'documents', doc.id);
      await audit.record(tx, {
        userId,
        entity: 'documents',
        entityId: doc.id,
        action: 'create',
        before: null,
        after,
      });
    });

    const rows = await prisma.$queryRaw<
      {
        user_id: string;
        action: string;
        before_is_null: boolean;
        total: string;
        issue_date: string;
        id: string;
      }[]
    >`
      SELECT user_id::text, action, before IS NULL AS before_is_null,
             after->>'total' AS total, after->>'issue_date' AS issue_date, after->>'id' AS id
      FROM audit_log WHERE entity = 'documents' AND entity_id = ${doc.id}::uuid`;
    expect(rows).toEqual([
      {
        user_id: userId,
        action: 'create',
        before_is_null: true,
        total: '86900.50',
        issue_date: '2026-10-09',
        id: doc.id,
      },
    ]);
  });

  it('snapshots a supplier, and gives null for a missing row', async () => {
    await prisma.$transaction(async (tx) => {
      const row = await audit.snapshot(tx, 'suppliers', supplierId);
      expect(JSON.parse(row ?? 'null')).toMatchObject({
        id: supplierId,
        payment_term_days: 30,
      });
      expect(await audit.snapshot(tx, 'suppliers', randomUUID())).toBeNull();
    });
  });

  it('rolls back with the transaction that wrote it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(tx, {
          userId,
          entity: 'suppliers',
          entityId: supplierId,
          action: 'update',
          before: null,
          after: null,
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const count = await prisma.auditLog.count({
      where: { entityId: supplierId },
    });
    expect(count).toBe(0);
  });

  it('writes a worker entry with no user_id', async () => {
    await prisma.$transaction(async (tx) => {
      const after = await audit.snapshot(tx, 'suppliers', supplierId);
      await audit.recordByWorker(tx, {
        entity: 'suppliers',
        entityId: supplierId,
        action: 'create',
        before: null,
        after,
      });
    });
    const rows = await prisma.auditLog.findMany({
      where: { entityId: supplierId },
      select: { userId: true, action: true, entity: true },
    });
    expect(rows).toEqual([
      { userId: null, action: 'create', entity: 'suppliers' },
    ]);
  });

  it('rolls a worker entry back with the transaction that wrote it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.recordByWorker(tx, {
          entity: 'suppliers',
          entityId: supplierId,
          action: 'update',
          before: null,
          after: null,
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const count = await prisma.auditLog.count({
      where: { entityId: supplierId },
    });
    expect(count).toBe(0);
  });
});
