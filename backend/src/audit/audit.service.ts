import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

export type AuditEntity =
  'suppliers' | 'documents' | 'payments' | 'applications';
export type AuditAction = 'create' | 'update' | 'delete';

/**
 * A row as `to_jsonb` printed it, kept as JSON text. It never goes through a
 * JS object, where `86900.50` would become the float `86900.5`.
 */
export type AuditSnapshot = string & { readonly __brand: 'AuditSnapshot' };

export interface AuditEntry {
  userId: string;
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  /** Null on create. */
  before: AuditSnapshot | null;
  /** Null when the row is gone. */
  after: AuditSnapshot | null;
}

/** Fixed table identifiers. A table name never comes from input. */
const TABLES: Record<AuditEntity, Prisma.Sql> = {
  suppliers: Prisma.sql`suppliers`,
  documents: Prisma.sql`documents`,
  payments: Prisma.sql`payments`,
  applications: Prisma.sql`applications`,
};

/**
 * Writes `audit_log` inside the caller's transaction (D2), so the entry and
 * the change it records commit or roll back together.
 */
@Injectable()
export class AuditService {
  /**
   * The whole row as `to_jsonb`, locked until the transaction ends. Call it
   * first in a transaction that changes the row. Null when there's no row.
   */
  async snapshot(
    tx: Prisma.TransactionClient,
    entity: AuditEntity,
    id: string,
  ): Promise<AuditSnapshot | null> {
    const rows = await tx.$queryRaw<{ row: string }[]>`
      SELECT to_jsonb(t)::text AS row FROM ${TABLES[entity]} t
      WHERE t.id = ${id}::uuid
      FOR UPDATE`;
    return rows.length === 0 ? null : (rows[0].row as AuditSnapshot);
  }

  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO audit_log (user_id, entity, entity_id, action, before, after)
      VALUES (${entry.userId}::uuid, ${entry.entity}, ${entry.entityId}::uuid,
              ${entry.action}, ${entry.before}::jsonb, ${entry.after}::jsonb)`;
  }
}
