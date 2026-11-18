import { Injectable } from '@nestjs/common';
import { ApplicationsService } from '../applications/applications.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { toDbDate } from '../common/dates.js';
import { invalidRequest } from '../common/field-errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PaymentFields, PaymentInput } from './payment-input.js';

/**
 * Writes payments, each with its `create` audit entry (D2). Every
 * application goes through `ApplicationsService`, in the same transaction,
 * so a refused split leaves no payment behind.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
  ) {}

  /** Records a payment and applies it as split. An unknown supplier is a malformed request. */
  create(input: PaymentInput, user: SessionUser): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true },
      });
      if (supplier === null) throw invalidRequest();
      const id = await this.insert(tx, supplier.id, input, input.notes, user);
      await this.applications.applyNewPayment(
        tx,
        { id, supplierId: supplier.id, amount: input.amount },
        input.applications,
        user,
      );
      return { id };
    });
  }

  private async insert(
    tx: Prisma.TransactionClient,
    supplierId: string,
    fields: PaymentFields,
    notes: string | null,
    user: SessionUser,
  ): Promise<string> {
    const { id } = await tx.payment.create({
      data: {
        supplierId,
        amount: fields.amount.toString(),
        paidOn: toDbDate(fields.paidOn),
        valueDate:
          fields.valueDate === null ? null : toDbDate(fields.valueDate),
        method: fields.method,
        reference: fields.reference,
        notes,
        createdById: user.id,
      },
      select: { id: true },
    });
    await this.audit.record(tx, {
      userId: user.id,
      entity: 'payments',
      entityId: id,
      action: 'create',
      before: null,
      after: await this.audit.snapshot(tx, 'payments', id),
    });
    return id;
  }
}
