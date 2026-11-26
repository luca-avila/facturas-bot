import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from '../applications/applications.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { BalancesService } from '../balances/balances.service.js';
import {
  BUSINESS_TIME_ZONE,
  formatBuenosAiresTimestamp,
  now,
} from '../common/clock.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { conflict, invalidRequest } from '../common/field-errors.js';
import { Money } from '../common/money.js';
import { uniqueViolationIndex } from '../common/unique-violation.js';
import { isUuid } from '../common/uuid.js';
import {
  type DocumentSource,
  type DocumentType,
  type DueDateSource,
  Prisma,
  type ReviewStatus,
  type TaxKind,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  summarizeConsistency,
  type ConsistencySummary,
} from './consistency-checks.js';
import { normalizeNumber } from './document-number.js';
import type {
  ManualDocumentFields,
  UpdateDocumentFields,
} from './document-input.js';
import { resolveDueDate, suggestTermDays } from './due-date.js';
import { DuplicateNumberCheck } from './duplicate-number-check.js';
import {
  DuplicateSuspectedCheck,
  type SuspectedDuplicateRef,
} from './duplicate-suspected-check.js';
import {
  isAcceptedIssue,
  normalizeStoredIssues,
  openIssueCodes,
  type AcceptableIssueCode,
  type Issue,
  type IssueCode,
} from './issues.js';

/** Invariant 7. Only this index means a duplicate document number. */
const NUMBER_INDEX = 'documents_number_unique';

export interface AcceptedIssueDetail {
  code: AcceptableIssueCode;
  acceptedByName: string;
  /** YYYY-MM-DD in Buenos Aires. */
  acceptedOn: string;
  /** HH:MM in Buenos Aires. */
  acceptedTime: string;
}

/** One document for *Documento*. */
export interface DocumentDetail {
  id: string;
  source: DocumentSource;
  reviewStatus: ReviewStatus;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  createdByName: string;
  /** YYYY-MM-DD and HH:MM of created_at in Buenos Aires. */
  createdOn: string;
  createdTime: string;
  reviewedByName: string | null;
  reviewedOn: string | null;
  reviewedTime: string | null;
  /** By position. Empty for a manual document. */
  images: { id: string; position: number }[];
  supplier: { id: string; name: string; paymentTermDays: number | null } | null;
  issueDate: string | null;
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  /** Amounts and quantities keep their column's scale. */
  subtotal: string | null;
  total: string | null;
  appliedAmount: string;
  suggestedTermDays: number | null;
  cae: string | null;
  notes: string | null;
  /** Open codes only, in stored order. */
  issues: IssueCode[];
  /** Accepted issues, in stored order, with Buenos Aires timestamps. */
  acceptedIssues: AcceptedIssueDetail[];
  /** Matching counted document when `duplicate_suspected` is open. */
  suspectedDuplicate: SuspectedDuplicateRef | null;
  /** Backend-computed consistency sums for display (D1). */
  consistencySummary: ConsistencySummary;
  /** By position. */
  lines: DocumentLineDetail[];
  /** By kind, label, amount and id. */
  taxes: DocumentTaxDetail[];
}

export interface DocumentLineDetail {
  position: number;
  productCode: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  packageText: string | null;
  unitPrice: string | null;
  ivaRate: string | null;
  discountPct: string | null;
  lineTotal: string | null;
}

export interface DocumentTaxDetail {
  kind: TaxKind;
  label: string;
  rate: string | null;
  base: string | null;
  amount: string;
}

interface DetailRow {
  id: string;
  source: DocumentSource;
  review_status: ReviewStatus;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  number_normalized: string | null;
  created_by_name: string;
  created_on: string;
  created_time: string;
  reviewed_by_name: string | null;
  reviewed_on: string | null;
  reviewed_time: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_payment_term_days: number | null;
  issue_date: string | null;
  due_date: string | null;
  due_date_source: DueDateSource | null;
  subtotal: string | null;
  total: string | null;
  cae: string | null;
  notes: string | null;
  issues: unknown;
}

/**
 * Writes documents, and reads one for *Documento*. Every write leaves an
 * `audit_log` entry in its transaction (D2).
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly applications: ApplicationsService,
    private readonly balances: BalancesService,
    private readonly duplicateCheck: DuplicateNumberCheck,
    private readonly duplicateSuspectedCheck: DuplicateSuspectedCheck,
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

  /** Null for a bad id, an unknown one, or a deleted document (D3). */
  async detail(id: string): Promise<DocumentDetail | null> {
    if (!isUuid(id)) return null;
    const localCreatedAt = Prisma.sql`(d.created_at AT TIME ZONE ${BUSINESS_TIME_ZONE}::text)`;
    const localReviewedAt = Prisma.sql`(d.reviewed_at AT TIME ZONE ${BUSINESS_TIME_ZONE}::text)`;
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<DetailRow[]>`
          SELECT d.id, d.source, d.review_status, d.type, d.letter, d.number,
                 d.number_normalized,
                 cu.name AS created_by_name,
                 to_char(${localCreatedAt}, 'YYYY-MM-DD') AS created_on,
                 to_char(${localCreatedAt}, 'HH24:MI') AS created_time,
                 ru.name AS reviewed_by_name,
                 to_char(${localReviewedAt}, 'YYYY-MM-DD') AS reviewed_on,
                 to_char(${localReviewedAt}, 'HH24:MI') AS reviewed_time,
                 d.supplier_id, s.name AS supplier_name,
                 s.payment_term_days AS supplier_payment_term_days,
                 to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
                 to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
                 d.due_date_source, d.subtotal::text AS subtotal, d.total::text AS total,
                 d.cae, d.notes, d.issues
          FROM documents d
          JOIN users cu ON cu.id = d.created_by
          LEFT JOIN users ru ON ru.id = d.reviewed_by
          LEFT JOIN suppliers s ON s.id = d.supplier_id
          WHERE d.id = ${id}::uuid AND d.deleted_at IS NULL`;
        if (row === undefined) return null;

        const images = await tx.documentImage.findMany({
          where: { documentId: id },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        });
        const lines = await tx.$queryRaw<DocumentLineDetail[]>`
          SELECT position, product_code AS "productCode", description,
                 quantity::text AS quantity, unit, package_text AS "packageText",
                 unit_price::text AS "unitPrice", iva_rate::text AS "ivaRate",
                 discount_pct::text AS "discountPct", line_total::text AS "lineTotal"
          FROM document_lines WHERE document_id = ${id}::uuid
          ORDER BY position`;
        const taxes = await tx.$queryRaw<DocumentTaxDetail[]>`
          SELECT kind, label, rate::text AS rate, base::text AS base, amount::text AS amount
          FROM document_taxes WHERE document_id = ${id}::uuid
          ORDER BY kind, label, amount, id`;
        const applied = await this.balances.documentApplied(tx, id);
        const latestSucceeded = await tx.extractionJob.findFirst({
          where: { documentId: id, status: 'succeeded' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { rawOutput: true },
        });

        const appliedAmount =
          applied === null
            ? '0.00'
            : (row.type === 'credit_note'
                ? applied.given
                : applied.received
              ).toString();

        const storedIssues = normalizeStoredIssues(row.issues);
        const openIssues = openIssueCodes(storedIssues);
        const acceptedStored = storedIssues.filter(isAcceptedIssue);
        let acceptedIssues: AcceptedIssueDetail[] = [];
        if (acceptedStored.length > 0) {
          const userIds = [
            ...new Set(acceptedStored.map((issue) => issue.acceptedBy)),
          ];
          const users = await tx.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
          });
          const namesById = new Map(users.map((u) => [u.id, u.name]));
          acceptedIssues = acceptedStored.map((issue) => {
            const { date, time } = formatBuenosAiresTimestamp(issue.acceptedAt);
            return {
              code: issue.code,
              acceptedByName: namesById.get(issue.acceptedBy) ?? 'Usuario',
              acceptedOn: date,
              acceptedTime: time,
            };
          });
        }

        let suspectedDuplicate: SuspectedDuplicateRef | null = null;
        if (
          openIssues.includes('duplicate_suspected') &&
          row.type !== 'opening_balance' &&
          row.supplier_id !== null &&
          row.issue_date !== null &&
          row.total !== null
        ) {
          suspectedDuplicate = await this.duplicateSuspectedCheck.findMatch(
            tx,
            {
              documentId: row.id,
              supplierId: row.supplier_id,
              issueDate: row.issue_date,
              total: Money.fromString(row.total).toString(),
              hasNumber: row.number_normalized !== null,
            },
          );
        }

        const consistencySummary = summarizeConsistency({
          subtotal: row.subtotal === null ? null : Money.fromString(row.subtotal),
          taxes: taxes.map((tax) => ({ amount: Money.fromString(tax.amount) })),
          lines: lines.map((line) => ({
            lineTotal:
              line.lineTotal === null ? null : Money.fromString(line.lineTotal),
          })),
        });

        return {
          id: row.id,
          source: row.source,
          reviewStatus: row.review_status,
          type: row.type,
          letter: row.letter,
          number: row.number,
          createdByName: row.created_by_name,
          createdOn: row.created_on,
          createdTime: row.created_time,
          reviewedByName: row.reviewed_by_name,
          reviewedOn: row.reviewed_on,
          reviewedTime: row.reviewed_time,
          images,
          supplier:
            row.supplier_id === null || row.supplier_name === null
              ? null
              : {
                  id: row.supplier_id,
                  name: row.supplier_name,
                  paymentTermDays: row.supplier_payment_term_days,
                },
          issueDate: row.issue_date,
          dueDate: row.due_date,
          dueDateSource: row.due_date_source,
          subtotal: row.subtotal,
          total: row.total,
          appliedAmount,
          suggestedTermDays: suggestTermDays(
            latestSucceeded?.rawOutput ?? null,
            row.issue_date,
          ),
          cae: row.cae,
          notes: row.notes,
          issues: openIssues,
          acceptedIssues,
          suspectedDuplicate,
          consistencySummary,
          lines,
          taxes,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
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

  /**
   * Edits a document's header fields and marks it `reviewed` in `user`'s name.
   * Refuses `processing` documents (`409 not_editable`), invariant 6 changes
   * (`409 document_has_applications`), and duplicate numbers (`409 duplicate_number`).
   */
  async update(
    id: string,
    input: UpdateDocumentFields,
    user: SessionUser,
  ): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException();
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await this.audit.snapshot(tx, 'documents', id);
        if (before === null) throw new NotFoundException();

        const doc = await tx.document.findUnique({
          where: { id },
          select: {
            deletedAt: true,
            source: true,
            reviewStatus: true,
            type: true,
            supplierId: true,
            issueDate: true,
            dueDate: true,
            dueDateSource: true,
          },
        });
        if (doc === null || doc.deletedAt !== null) {
          throw new NotFoundException();
        }
        if (doc.reviewStatus === 'processing') {
          throw conflict([{ field: 'document', code: 'not_editable' }]);
        }
        if (doc.source === 'upload' && input.type === 'opening_balance') {
          throw invalidRequest();
        }

        const supplier = await tx.supplier.findUnique({
          where: { id: input.supplierId },
          select: { id: true, paymentTermDays: true },
        });
        if (supplier === null) throw invalidRequest();

        await this.applications.assertDocumentChange(tx, id, {
          supplierId: input.supplierId,
          type: input.type,
          total: input.total,
          reviewStatus: 'reviewed',
        });

        const due = resolveDueDate({
          type: input.type,
          issueDate: input.issueDate,
          typedDueDate:
            input.dueDateSource === 'manual' ? input.dueDate : null,
          paymentTermDays: supplier.paymentTermDays,
          edit: {
            supplierId: input.supplierId,
            stored: {
              type: doc.type,
              supplierId: doc.supplierId,
              issueDate:
                doc.issueDate === null ? null : fromDbDate(doc.issueDate),
              dueDate: doc.dueDate === null ? null : fromDbDate(doc.dueDate),
              source: doc.dueDateSource,
            },
          },
        });
        if (due === 'due_date_required') {
          throw invalidRequest([
            { field: 'dueDate', code: 'due_date_required' },
          ]);
        }

        const numberNormalized =
          input.number === null ? null : normalizeNumber(input.number);
        if (
          input.type !== 'opening_balance' &&
          numberNormalized !== null &&
          (await this.duplicateCheck.exists(tx, {
            documentId: id,
            supplierId: input.supplierId,
            type: input.type,
            letter: input.letter,
            numberNormalized,
          }))
        ) {
          throw conflict([{ field: 'number', code: 'duplicate_number' }]);
        }

        await tx.document.update({
          where: { id },
          data: {
            supplierId: input.supplierId,
            type: input.type,
            letter: input.letter,
            number: input.number,
            numberNormalized,
            issueDate: toDbDate(input.issueDate),
            dueDate: due.dueDate === null ? null : toDbDate(due.dueDate),
            dueDateSource: due.source,
            subtotal: input.subtotal === null ? null : input.subtotal.toString(),
            total: input.total.toString(),
            notes: input.notes,
            issues: [],
            reviewStatus: 'reviewed',
            reviewedById: user.id,
            reviewedAt: now(),
          },
        });

        const after = await this.audit.snapshot(tx, 'documents', id);
        await this.audit.record(tx, {
          userId: user.id,
          entity: 'documents',
          entityId: id,
          action: 'update',
          before,
          after,
        });
      });
    } catch (error) {
      if (uniqueViolationIndex(error) === NUMBER_INDEX) {
        throw conflict([{ field: 'number', code: 'duplicate_number' }]);
      }
      throw error;
    }
  }

  /** Confirms an `unreviewed` (or idempotently `reviewed`) document as-is. */
  async review(id: string, user: SessionUser): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.audit.snapshot(tx, 'documents', id);
      if (before === null) throw new NotFoundException();

      const doc = await tx.document.findUnique({
        where: { id },
        select: { deletedAt: true, reviewStatus: true },
      });
      if (doc === null || doc.deletedAt !== null) {
        throw new NotFoundException();
      }
      if (doc.reviewStatus === 'processing' || doc.reviewStatus === 'error') {
        throw conflict([{ field: 'document', code: 'not_editable' }]);
      }

      await tx.document.update({
        where: { id },
        data: {
          reviewStatus: 'reviewed',
          reviewedById: user.id,
          reviewedAt: now(),
        },
      });
      const after = await this.audit.snapshot(tx, 'documents', id);
      await this.audit.record(tx, {
        userId: user.id,
        entity: 'documents',
        entityId: id,
        action: 'update',
        before,
        after,
      });
    });
  }

  /**
   * Queues a fresh extraction job for an `upload` document in `error` with
   * `extraction_failed` and no extracted data. Keeps earlier job rows.
   */
  async retry(id: string, user: SessionUser): Promise<void> {
    if (!isUuid(id)) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.audit.snapshot(tx, 'documents', id);
      if (before === null) throw new NotFoundException();

      const doc = await tx.document.findUnique({
        where: { id },
        select: {
          deletedAt: true,
          source: true,
          reviewStatus: true,
          type: true,
          supplierId: true,
          issueDate: true,
          total: true,
          issues: true,
          _count: { select: { lines: true, taxes: true } },
        },
      });
      if (doc === null || doc.deletedAt !== null) {
        throw new NotFoundException();
      }
      const issues = Array.isArray(doc.issues)
        ? (doc.issues as unknown as Issue[])
        : [];
      const hasExtractionFailed = issues.some(
        (issue) => issue.code === 'extraction_failed',
      );
      const hasNoData =
        doc.type === null &&
        doc.supplierId === null &&
        doc.issueDate === null &&
        doc.total === null &&
        doc._count.lines === 0 &&
        doc._count.taxes === 0;
      if (
        doc.source !== 'upload' ||
        doc.reviewStatus !== 'error' ||
        !hasExtractionFailed ||
        !hasNoData
      ) {
        throw conflict([{ field: 'document', code: 'not_editable' }]);
      }

      await tx.document.update({
        where: { id },
        data: { reviewStatus: 'processing', issues: [] },
      });
      await tx.extractionJob.create({
        data: {
          documentId: id,
          status: 'queued',
          attempts: 0,
          runAfter: now(),
        },
      });
      const after = await this.audit.snapshot(tx, 'documents', id);
      await this.audit.record(tx, {
        userId: user.id,
        entity: 'documents',
        entityId: id,
        action: 'update',
        before,
        after,
      });
    });
  }
}
