import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from '../applications/applications.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { now } from '../common/clock.js';
import { toDbDate } from '../common/dates.js';
import { conflict, invalidRequest } from '../common/field-errors.js';
import { uniqueViolationIndex } from '../common/unique-violation.js';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeNumber } from './document-number.js';
import type { ManualDocumentFields } from './document-input.js';
import { resolveDueDate } from './due-date.js';

/** Invariant 7. Only this index means a duplicate document number. */
const NUMBER_INDEX = 'documents_number_unique';

/** Writes documents. Every write leaves an `audit_log` entry in its transaction (D2). */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
  ) {}

  /** Saves a document a person typed in. It counts at once, as reviewed by them. */
  async createManual(
    input: ManualDocumentFields,
    user: SessionUser,
  ): Promise<{ id: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({
          where: { id: input.supplierId },
          select: { paymentTermDays: true },
        });
        if (supplier === null) throw invalidRequest();

        const due = resolveDueDate({
          type: input.type,
          issueDate: input.issueDate,
          typedDueDate: input.dueDate,
          paymentTermDays: supplier.paymentTermDays,
        });
        if (due === 'due_date_required') {
          throw invalidRequest([
            { field: 'dueDate', code: 'due_date_required' },
          ]);
        }

        const { id } = await tx.document.create({
          data: {
            type: input.type,
            source: 'manual',
            reviewStatus: 'reviewed',
            supplierId: input.supplierId,
            letter: input.letter,
            number: input.number,
            numberNormalized:
              input.number === null ? null : normalizeNumber(input.number),
            issueDate: toDbDate(input.issueDate),
            dueDate: due.dueDate === null ? null : toDbDate(due.dueDate),
            dueDateSource: due.source,
            total: input.total.toString(),
            notes: input.notes,
            createdById: user.id,
            reviewedById: user.id,
            reviewedAt: now(),
          },
          select: { id: true },
        });
        const after = await this.audit.snapshot(tx, 'documents', id);
        await this.audit.record(tx, {
          userId: user.id,
          entity: 'documents',
          entityId: id,
          action: 'create',
          before: null,
          after,
        });
        return { id };
      });
    } catch (error) {
      if (uniqueViolationIndex(error) === NUMBER_INDEX) {
        throw conflict([{ field: 'number', code: 'duplicate_number' }]);
      }
      throw error;
    }
  }

  /**
   * Soft delete: the row stays, and stops counting. A deleted document is not
   * found, and one with applications is refused (invariant 6).
   */
  async delete(id: string, user: SessionUser): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.audit.snapshot(tx, 'documents', id);
      if (before === null) throw new NotFoundException();
      await this.applications.assertDocumentChange(tx, id, { delete: true });
      const { count } = await tx.document.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: now() },
      });
      if (count === 0) throw new NotFoundException();
      const after = await this.audit.snapshot(tx, 'documents', id);
      await this.audit.record(tx, {
        userId: user.id,
        entity: 'documents',
        entityId: id,
        action: 'delete',
        before,
        after,
      });
    });
  }
}
