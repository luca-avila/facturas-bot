import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { toDbDate } from '../common/dates.js';
import { conflict } from '../common/field-errors.js';
import { uniqueViolationIndex } from '../common/unique-violation.js';
import { isUuid } from '../common/uuid.js';
import { normalizeNumber } from '../documents/document-number.js';
import { resolveDueDate } from '../documents/due-date.js';
import { DuplicateNumberCheck } from '../documents/duplicate-number-check.js';
import {
  ISSUE_CODES,
  type Issue,
  type IssueCode,
} from '../documents/issues.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupplierFields } from './supplier-input.js';

const CUIT_INDEX = 'suppliers_cuit_key';
const NUMBER_INDEX = 'documents_number_unique';

export interface TermPreviewDocument {
  id: string;
  type: 'invoice' | 'delivery_note';
  letter: string | null;
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  willUnblock: boolean;
  remainingIssues: IssueCode[];
}

export interface TermPreview {
  paymentTermDays: number;
  documents: TermPreviewDocument[];
  unblockedCount: number;
}

interface TermCandidateRow {
  id: string;
  type: 'invoice' | 'delivery_note';
  letter: string | null;
  number: string | null;
  number_normalized: string | null;
  issue_date: string | null;
  issues: Issue[];
}

/** Writes suppliers. Every write leaves an `audit_log` entry in its transaction (D2). */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly duplicateCheck: DuplicateNumberCheck,
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

  /** Previews *Definir plazo*: same evaluation as `setTerm`, writing nothing (D1). */
  async previewTerm(
    id: string,
    paymentTermDays: number,
  ): Promise<TermPreview> {
    if (!isUuid(id)) throw new NotFoundException();
    return this.prisma.$transaction(
      async (tx) => {
        const supplier = await tx.supplier.findUnique({
          where: { id },
          select: { id: true },
        });
        if (supplier === null) throw new NotFoundException();
        return this.evaluateTerm(tx, id, paymentTermDays, new Set());
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Sets `payment_term_days` and re-checks only this supplier's non-deleted
   * `error` documents that have `supplier_term_missing`. Locks supplier first,
   * then only `error` rows in `id` order so the worker never deadlocks (C1).
   */
  async setTerm(
    id: string,
    paymentTermDays: number,
    user: SessionUser,
  ): Promise<TermPreview> {
    if (!isUuid(id)) throw new NotFoundException();
    const forcedDuplicateIds = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let currentDocumentId: string | null = null;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const supplierBefore = await this.audit.snapshot(tx, 'suppliers', id);
          if (supplierBefore === null) throw new NotFoundException();

          await tx.supplier.update({
            where: { id },
            data: { paymentTermDays },
          });
          const supplierAfter = await this.audit.snapshot(tx, 'suppliers', id);
          await this.audit.record(tx, {
            userId: user.id,
            entity: 'suppliers',
            entityId: id,
            action: 'update',
            before: supplierBefore,
            after: supplierAfter,
          });

          // Lock only `error` rows of this supplier, never `processing`.
          await tx.$queryRaw`
            SELECT id FROM documents
            WHERE supplier_id = ${id}::uuid
              AND deleted_at IS NULL
              AND review_status = 'error'
            ORDER BY id
            FOR UPDATE`;

          const preview = await this.evaluateTerm(
            tx,
            id,
            paymentTermDays,
            forcedDuplicateIds,
          );

          for (const doc of preview.documents) {
            currentDocumentId = doc.id;
            const before = await this.audit.snapshot(tx, 'documents', doc.id);
            if (before === null) continue;
            await tx.document.update({
              where: { id: doc.id },
              data: {
                dueDate: doc.dueDate === null ? null : toDbDate(doc.dueDate),
                dueDateSource: doc.dueDate === null ? null : 'supplier_term',
                issues: doc.remainingIssues.map((code) => ({ code })),
                reviewStatus: doc.willUnblock ? 'unreviewed' : 'error',
                reviewedById: null,
                reviewedAt: null,
              },
            });
            const after = await this.audit.snapshot(tx, 'documents', doc.id);
            await this.audit.record(tx, {
              userId: user.id,
              entity: 'documents',
              entityId: doc.id,
              action: 'update',
              before,
              after,
            });
          }

          return preview;
        });
      } catch (error) {
        if (
          attempt === 0 &&
          currentDocumentId !== null &&
          uniqueViolationIndex(error) === NUMBER_INDEX
        ) {
          forcedDuplicateIds.add(currentDocumentId);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable');
  }

  private async evaluateTerm(
    tx: Prisma.TransactionClient,
    supplierId: string,
    paymentTermDays: number,
    forcedDuplicateIds: ReadonlySet<string>,
  ): Promise<TermPreview> {
    const rows = await tx.$queryRaw<TermCandidateRow[]>`
      SELECT d.id, d.type, d.letter, d.number, d.number_normalized,
             to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
             d.issues
      FROM documents d
      WHERE d.supplier_id = ${supplierId}::uuid
        AND d.deleted_at IS NULL
        AND d.review_status = 'error'
        AND d.type IN ('invoice', 'delivery_note')
        AND d.issues @> '[{"code":"supplier_term_missing"}]'::jsonb
      ORDER BY d.created_at ASC, d.id ASC`;

    const unblockedKeys = new Set<string>();
    const documents: TermPreviewDocument[] = [];
    let unblockedCount = 0;

    for (const row of rows) {
      let dueDate: string | null = null;
      if (row.issue_date !== null) {
        const resolved = resolveDueDate({
          type: row.type,
          issueDate: row.issue_date,
          typedDueDate: null,
          paymentTermDays,
        });
        if (resolved !== 'due_date_required') {
          dueDate = resolved.dueDate;
        }
      }

      const issueSet = new Set<IssueCode>(
        row.issues
          .map((issue) => issue.code)
          .filter(
            (code) =>
              code !== 'supplier_term_missing' && code !== 'duplicate_number',
          ),
      );

      const normalized =
        row.number_normalized ??
        (row.number === null ? null : normalizeNumber(row.number));
      const numberKey =
        normalized === null
          ? null
          : `${row.type}\0${row.letter ?? ''}\0${normalized}`;
      const isDuplicate =
        forcedDuplicateIds.has(row.id) ||
        (numberKey !== null && unblockedKeys.has(numberKey)) ||
        (normalized !== null &&
          (await this.duplicateCheck.exists(tx, {
            documentId: row.id,
            supplierId,
            type: row.type,
            letter: row.letter,
            numberNormalized: normalized,
          })));
      if (isDuplicate) {
        issueSet.add('duplicate_number');
      }

      const remainingIssues = ISSUE_CODES.filter((code) => issueSet.has(code));
      const willUnblock = remainingIssues.length === 0;
      if (willUnblock) {
        unblockedCount += 1;
        if (numberKey !== null) {
          unblockedKeys.add(numberKey);
        }
      }

      documents.push({
        id: row.id,
        type: row.type,
        letter: row.letter,
        number: row.number,
        issueDate: row.issue_date,
        dueDate,
        willUnblock,
        remainingIssues,
      });
    }

    return { paymentTermDays, documents, unblockedCount };
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
