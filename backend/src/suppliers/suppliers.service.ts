import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { conflict } from '../common/field-errors.js';
import { uniqueViolationIndex } from '../common/unique-violation.js';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupplierFields } from './supplier-input.js';

const CUIT_INDEX = 'suppliers_cuit_key';

/** Writes suppliers. Every write leaves an `audit_log` entry in its transaction (D2). */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: SupplierFields,
    user: SessionUser,
  ): Promise<{ id: string }> {
    return this.mapCuitTaken(() =>
      this.prisma.$transaction(async (tx) => {
        const { id } = await tx.supplier.create({
          data: input,
          select: { id: true },
        });
        const after = await this.audit.snapshot(tx, 'suppliers', id);
        await this.audit.record(tx, {
          userId: user.id,
          entity: 'suppliers',
          entityId: id,
          action: 'create',
          before: null,
          after,
        });
        return { id };
      }),
    );
  }

  /** Replaces every field. Changing the term never touches documents. */
  async update(
    id: string,
    input: SupplierFields,
    user: SessionUser,
  ): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException();
    await this.mapCuitTaken(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await this.audit.snapshot(tx, 'suppliers', id);
        if (before === null) throw new NotFoundException();
        await tx.supplier.update({ where: { id }, data: input });
        const after = await this.audit.snapshot(tx, 'suppliers', id);
        await this.audit.record(tx, {
          userId: user.id,
          entity: 'suppliers',
          entityId: id,
          action: 'update',
          before,
          after,
        });
      }),
    );
  }

  private async mapCuitTaken<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (uniqueViolationIndex(error) === CUIT_INDEX) {
        throw conflict([{ field: 'cuit', code: 'cuit_taken' }]);
      }
      throw error;
    }
  }
}
