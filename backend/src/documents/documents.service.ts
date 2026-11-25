import { Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from '../applications/applications.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { BUSINESS_TIME_ZONE, now } from '../common/clock.js';
import { toDbDate } from '../common/dates.js';
import { conflict, invalidRequest } from '../common/field-errors.js';
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
import { normalizeNumber } from './document-number.js';
import type { ManualDocumentFields } from './document-input.js';
import { resolveDueDate } from './due-date.js';
import type { Issue, IssueCode } from './issues.js';

/** Invariant 7. Only this index means a duplicate document number. */
const NUMBER_INDEX = 'documents_number_unique';

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
  /** By position. Empty for a manual document. */
  images: { id: string; position: number }[];
  supplier: { id: string; name: string } | null;
  issueDate: string | null;
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  /** Amounts and quantities keep their column's scale. */
  subtotal: string | null;
  total: string | null;
  cae: string | null;
  notes: string | null;
  /** Codes, in stored order. */
  issues: IssueCode[];
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
  created_by_name: string;
  created_on: string;
  created_time: string;
  supplier_id: string | null;
  supplier_name: string | null;
  issue_date: string | null;
  due_date: string | null;
  due_date_source: DueDateSource | null;
  subtotal: string | null;
  total: string | null;
  cae: string | null;
  notes: string | null;
  issues: Issue[];
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
    const [[row], images, lines, taxes] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<DetailRow[]>`
          SELECT d.id, d.source, d.review_status, d.type, d.letter, d.number,
                 u.name AS created_by_name,
                 to_char(${localCreatedAt}, 'YYYY-MM-DD') AS created_on,
                 to_char(${localCreatedAt}, 'HH24:MI') AS created_time,
                 d.supplier_id, s.name AS supplier_name,
                 to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
                 to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
                 d.due_date_source, d.subtotal::text AS subtotal, d.total::text AS total,
                 d.cae, d.notes, d.issues
          FROM documents d
          JOIN users u ON u.id = d.created_by
          LEFT JOIN suppliers s ON s.id = d.supplier_id
          WHERE d.id = ${id}::uuid AND d.deleted_at IS NULL`,
        this.prisma.documentImage.findMany({
          where: { documentId: id },
          orderBy: { position: 'asc' },
          select: { id: true, position: true },
        }),
        this.prisma.$queryRaw<DocumentLineDetail[]>`
          SELECT position, product_code AS "productCode", description,
                 quantity::text AS quantity, unit, package_text AS "packageText",
                 unit_price::text AS "unitPrice", iva_rate::text AS "ivaRate",
                 discount_pct::text AS "discountPct", line_total::text AS "lineTotal"
          FROM document_lines WHERE document_id = ${id}::uuid
          ORDER BY position`,
        this.prisma.$queryRaw<DocumentTaxDetail[]>`
          SELECT kind, label, rate::text AS rate, base::text AS base, amount::text AS amount
          FROM document_taxes WHERE document_id = ${id}::uuid
          ORDER BY kind, label, amount, id`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (row === undefined) return null;
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
      images,
      supplier:
        row.supplier_id === null || row.supplier_name === null
          ? null
          : { id: row.supplier_id, name: row.supplier_name },
      issueDate: row.issue_date,
      dueDate: row.due_date,
      dueDateSource: row.due_date_source,
      subtotal: row.subtotal,
      total: row.total,
      cae: row.cae,
      notes: row.notes,
      issues: row.issues.map((issue) => issue.code),
      lines,
      taxes,
    };
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
