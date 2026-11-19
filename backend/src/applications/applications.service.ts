import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { BalancesService } from '../balances/balances.service.js';
import { projectAfter } from '../balances/project.js';
import {
  conflict,
  type FieldError,
  invalidRequest,
} from '../common/field-errors.js';
import { Money } from '../common/money.js';
import type {
  DocumentType,
  Prisma,
  ReviewStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ApplyCreditInput,
  Split,
  SplitRequest,
  SplitRowInput,
} from './applications.types.js';
import { evaluate, suggest } from './split.js';

const ZERO = Money.fromString('0');

/** A delete, or the new values of the header fields invariant 6 protects. */
export type DocumentChange =
  | { delete: true }
  | {
      supplierId?: string;
      type?: DocumentType;
      total?: Money;
      reviewStatus?: ReviewStatus;
    };

const COUNTED: readonly ReviewStatus[] = ['unreviewed', 'reviewed'];

/** Who receives the split and how much it can give. */
interface SplitContext {
  supplierId: string;
  available: Money;
  /** True for a payment or credit note that exists already, which must apply something. */
  existingCredit: boolean;
}

/** The split as the preview shows it, and the rows a save writes. */
interface Evaluated {
  split: Split;
  /** The rows above zero. */
  toWrite: SplitRowInput[];
}

/**
 * The only writer of `applications` (invariants 2–6, enforced by ESLint).
 *
 * Every write locks in one fixed order. An existing payment source comes
 * first. Then every document the write names, a credit-note source among
 * them, is locked in one `ORDER BY id FOR UPDATE`, whatever its type.
 * Payments are never locked after documents, so no two writers can wait on
 * each other in a cycle, whatever a request names. The lock doesn't filter on
 * type on purpose: a filtered lock skips, without waiting, a row whose type
 * another transaction is changing. Then a new statement reads what's left
 * through `BalancesService`. Write transactions never pass `isolationLevel`: under
 * `REPEATABLE READ`, the sum read after a lock misses a concurrent
 * application, which would over-apply.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly balances: BalancesService,
  ) {}

  /** What saving this split would do, and every error it would refuse with. Writes nothing. */
  preview(request: SplitRequest): Promise<Split> {
    return this.prisma.$transaction(async (tx) => {
      const { source } = request;
      let context: SplitContext;
      if (source.kind === 'new_payment') {
        const supplier = await tx.supplier.findUnique({
          where: { id: source.supplierId },
          select: { id: true },
        });
        if (supplier === null) throw invalidRequest();
        context = {
          supplierId: supplier.id,
          available: source.amount,
          existingCredit: false,
        };
      } else {
        const credit = await this.balances.creditSource(tx, source);
        if (credit === null) {
          return emptySplit([{ field: 'source', code: 'not_applicable' }]);
        }
        context = {
          supplierId: credit.supplierId,
          available: credit.unapplied,
          existingCredit: true,
        };
      }
      return (await this.evaluate(tx, context, request.applications)).split;
    });
  }

  /**
   * Applies a payment the caller has just inserted in `tx`, which no other
   * transaction can see yet, so only the documents are locked. Refuses with
   * 409 and the preview's errors, which rolls the payment back too.
   */
  async applyNewPayment(
    tx: Prisma.TransactionClient,
    payment: { id: string; supplierId: string; amount: Money },
    rows: SplitRowInput[],
    user: SessionUser,
  ): Promise<void> {
    await this.lockDocuments(
      tx,
      rows.map((row) => row.documentId),
    );
    const { split, toWrite } = await this.evaluate(
      tx,
      {
        supplierId: payment.supplierId,
        available: payment.amount,
        existingCredit: false,
      },
      rows,
    );
    if (split.errors.length > 0) throw conflict(split.errors);
    await this.write(tx, { paymentId: payment.id }, toWrite, user);
  }

  /**
   * Applies existing credit, from a payment's leftover or a credit note, in
   * its own transaction. Locks a payment source first, then the documents. A
   * credit-note source is locked with the documents, in id order.
   */
  applyCredit(input: ApplyCreditInput, user: SessionUser): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const { source } = input;
      const rowIds = input.applications.map((row) => row.documentId);
      if (source.kind === 'payment') {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${source.id}::uuid FOR UPDATE`;
        await this.lockDocuments(tx, rowIds);
      } else {
        await this.lockDocuments(tx, [source.id, ...rowIds]);
      }
      const credit = await this.balances.creditSource(tx, source);
      if (credit === null) {
        throw conflict([{ field: 'source', code: 'not_applicable' }]);
      }
      const { split, toWrite } = await this.evaluate(
        tx,
        {
          supplierId: credit.supplierId,
          available: credit.unapplied,
          existingCredit: true,
        },
        input.applications,
      );
      if (split.errors.length > 0) throw conflict(split.errors);
      await this.write(
        tx,
        source.kind === 'payment'
          ? { paymentId: source.id }
          : { creditNoteId: source.id },
        toWrite,
        user,
      );
    });
  }

  /**
   * For *Marcar como pagado*: locks the document and reads whose it is and
   * what it has left. Refuses with 409 `not_applicable` on `documentId`
   * unless it's a counted invoice, delivery note or opening balance.
   */
  async lockToSettle(
    tx: Prisma.TransactionClient,
    documentId: string,
  ): Promise<{ supplierId: string; remaining: Money }> {
    await this.lockDocuments(tx, [documentId]);
    const refused = conflict([{ field: 'documentId', code: 'not_applicable' }]);
    const document = await this.balances.documentApplied(tx, documentId);
    if (document?.supplierId == null) throw refused;
    const [row] = (
      await this.balances.splitDocuments(tx, document.supplierId, [documentId])
    ).filter((doc) => doc.id === documentId);
    if (row === undefined) throw refused;
    return { supplierId: document.supplierId, remaining: row.remaining };
  }

  /**
   * Invariant 6, on both sides: while a document has applications, received
   * or given, it isn't deleted, keeps its supplier and type, stays counted,
   * and its total covers what it received and what it gave. Refuses with 409
   * `document_has_applications`. Call it after locking the document. The
   * `documents_keep_applied` trigger backs it up.
   */
  async assertDocumentChange(
    tx: Prisma.TransactionClient,
    documentId: string,
    change: DocumentChange,
  ): Promise<void> {
    const doc = await this.balances.documentApplied(tx, documentId);
    if (doc === null || (doc.received.isZero() && doc.given.isZero())) return;
    const breaks =
      'delete' in change ||
      (change.supplierId !== undefined &&
        change.supplierId !== doc.supplierId) ||
      (change.type !== undefined && change.type !== doc.type) ||
      (change.reviewStatus !== undefined &&
        !COUNTED.includes(change.reviewStatus)) ||
      (change.total !== undefined &&
        (change.total.compare(doc.received) < 0 ||
          change.total.compare(doc.given) < 0));
    if (breaks) {
      throw conflict([
        { field: 'document', code: 'document_has_applications' },
      ]);
    }
  }

  /** Locks these documents in `id` order, in one statement, whatever their type. */
  private async lockDocuments(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM documents WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  }

  /**
   * The one evaluation behind the preview and every save. `requested` null
   * asks for the suggestion. Call it after the locks.
   */
  private async evaluate(
    tx: Prisma.TransactionClient,
    context: SplitContext,
    requested: SplitRowInput[] | null,
  ): Promise<Evaluated> {
    const documents = await this.balances.splitDocuments(
      tx,
      context.supplierId,
      (requested ?? []).map((row) => row.documentId),
    );
    const amounts =
      requested === null
        ? suggest(context.available, documents)
        : new Map(requested.map((row) => [row.documentId, row.amount]));
    const result = evaluate(context.available, documents, amounts);

    const errors: FieldError[] = [];
    const known = new Set(documents.map((doc) => doc.id));
    for (const [documentId, amount] of amounts) {
      if (amount.isPositive() && !known.has(documentId)) {
        errors.push({
          field: `applications.${documentId}`,
          code: 'not_applicable',
        });
      }
    }
    for (const doc of documents) {
      if (result.exceeding.has(doc.id)) {
        errors.push({
          field: `applications.${doc.id}`,
          code: 'exceeds_remaining',
        });
      }
    }
    if (result.excess.isPositive()) {
      errors.push({ field: 'applications', code: 'exceeds_source' });
    }
    if (context.existingCredit && result.applied.isZero()) {
      errors.push({ field: 'applications', code: 'nothing_to_apply' });
    }

    const rows = documents.map((doc) => {
      const amount = amounts.get(doc.id) ?? ZERO;
      const after = projectAfter(
        doc,
        result.exceeding.has(doc.id) ? ZERO : amount,
      );
      return {
        documentId: doc.id,
        type: doc.type,
        letter: doc.letter,
        number: doc.number,
        issueDate: doc.issueDate,
        dueDate: doc.dueDate,
        daysToDue: doc.daysToDue,
        status: doc.status,
        remaining: doc.remaining.toString(),
        amount: amount.toString(),
        after: {
          status: after.status,
          remaining: after.remaining.toString(),
          partial: after.partial,
        },
      };
    });

    return {
      split: {
        available: context.available.toString(),
        applied: result.applied.toString(),
        unapplied: result.unapplied.toString(),
        excess: result.excess.toString(),
        rows,
        errors,
      },
      toWrite: [...amounts]
        .filter(([, amount]) => amount.isPositive())
        .map(([documentId, amount]) => ({ documentId, amount })),
    };
  }

  /** Inserts each row, with its `create` audit entry (D2). Rows of zero never reach here. */
  private async write(
    tx: Prisma.TransactionClient,
    source: { paymentId: string } | { creditNoteId: string },
    rows: SplitRowInput[],
    user: SessionUser,
  ): Promise<void> {
    for (const row of rows) {
      const { id } = await tx.application.create({
        data: {
          documentId: row.documentId,
          ...source,
          amount: row.amount.toString(),
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        userId: user.id,
        entity: 'applications',
        entityId: id,
        action: 'create',
        before: null,
        after: await this.audit.snapshot(tx, 'applications', id),
      });
    }
  }
}

/** A split with nothing to show, for a source that can't give. */
function emptySplit(errors: FieldError[]): Split {
  return {
    available: '0.00',
    applied: '0.00',
    unapplied: '0.00',
    excess: '0.00',
    rows: [],
    errors,
  };
}
