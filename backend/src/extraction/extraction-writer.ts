import { Injectable } from '@nestjs/common';
import { AuditService, type AuditSnapshot } from '../audit/audit.service.js';
import { ADVISORY_LOCKS } from '../common/advisory-locks.js';
import { toDbDate } from '../common/dates.js';
import { uniqueViolationIndex } from '../common/unique-violation.js';
import { resolveDueDate } from '../documents/due-date.js';
import { DuplicateNumberCheck } from '../documents/duplicate-number-check.js';
import { DuplicateSuspectedCheck } from '../documents/duplicate-suspected-check.js';
import type { IssueCode } from '../documents/issues.js';
import { Prisma, type ReviewStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CallOutcome } from './extraction-call.js';
import {
  checkExtraction,
  type ExtractionCheckInput,
} from './extraction-checks.js';
import { ExtractionConfig } from './extraction-config.js';
import { mapExtraction, type MappedExtraction } from './extraction-mapping.js';

/** Invariant 7. Only this index means a duplicate document number. */
const NUMBER_INDEX = 'documents_number_unique';

/** A job as one run claimed it. `attempt` is the fencing token. */
export interface ClaimedJob {
  id: string;
  documentId: string;
  attempt: number;
}

export type WriteResult =
  | { kind: 'written'; reviewStatus: ReviewStatus }
  | { kind: 'not_processing' }
  | { kind: 'lost' };

type Success = Extract<CallOutcome, { ok: true }>;
type Supplier =
  | { resolved: false }
  | { resolved: true; id: string; paymentTermDays: number | null };

interface DocumentRow {
  review_status: ReviewStatus;
  deleted_at: string | null;
}

function isWritable(snapshot: AuditSnapshot | null): boolean {
  if (snapshot === null) return false;
  const row = JSON.parse(snapshot) as DocumentRow;
  return row.deleted_at === null && row.review_status === 'processing';
}

/**
 * Writes a job's result: the only writer of `document_lines` and
 * `document_taxes`. Every write locks the job first and checks the fence,
 * then locks the document, then the supplier. It only ever writes to a
 * document that is still `processing` (E2).
 */
@Injectable()
export class ExtractionWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ExtractionConfig,
    private readonly duplicateCheck: DuplicateNumberCheck,
    private readonly duplicateSuspectedCheck: DuplicateSuspectedCheck,
  ) {}

  /**
   * Locks the job and checks it's still this run's: `running` at the
   * claimed attempt. False when the lease expired and another run took it.
   */
  async holdsFence(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ status: string; attempts: number }[]>`
      SELECT status::text AS status, attempts FROM extraction_jobs
      WHERE id = ${job.id}::uuid
      FOR UPDATE`;
    return (
      rows.length === 1 &&
      rows[0].status === 'running' &&
      rows[0].attempts === job.attempt
    );
  }

  /**
   * The final failure. The job fails, and a document still `processing`
   * goes to *Error* with `extraction_failed`. Call it after the job is
   * locked, in the caller's transaction.
   */
  async fail(
    tx: Prisma.TransactionClient,
    job: Pick<ClaimedJob, 'id' | 'documentId'>,
    lastError: string,
  ): Promise<void> {
    await tx.extractionJob.update({
      where: { id: job.id },
      data: { status: 'failed', lockedUntil: null, lastError },
    });
    const before = await this.audit.snapshot(tx, 'documents', job.documentId);
    if (!isWritable(before)) return;
    await tx.document.update({
      where: { id: job.documentId },
      data: { reviewStatus: 'error', issues: [{ code: 'extraction_failed' }] },
    });
    const after = await this.audit.snapshot(tx, 'documents', job.documentId);
    await this.audit.recordByWorker(tx, {
      entity: 'documents',
      entityId: job.documentId,
      action: 'update',
      before,
      after,
    });
  }

  /**
   * Writes a successful call's result in one transaction. A duplicate only
   * the unique index catches runs it once more, knowing the duplicate: the
   * document ends in *Error*, and the attempt didn't fail.
   */
  async write(job: ClaimedJob, outcome: Success): Promise<WriteResult> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.writeIn(tx, job, outcome, false),
      );
    } catch (error) {
      if (uniqueViolationIndex(error) !== NUMBER_INDEX) throw error;
      return this.prisma.$transaction((tx) =>
        this.writeIn(tx, job, outcome, true),
      );
    }
  }

  private async writeIn(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
    outcome: Success,
    knownDuplicate: boolean,
  ): Promise<WriteResult> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.documentDuplicates})`;
    if (!(await this.holdsFence(tx, job))) return { kind: 'lost' };
    const rawOutput = outcome.rawOutput as Prisma.InputJsonValue;

    const before = await this.audit.snapshot(tx, 'documents', job.documentId);
    if (!isWritable(before)) {
      await tx.extractionJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lockedUntil: null,
          rawOutput,
          lastError: 'document no longer processing',
        },
      });
      return { kind: 'not_processing' };
    }

    const mapped = mapExtraction(outcome.output);
    const supplier = await this.resolveSupplier(tx, mapped);
    const doc = mapped.kind === 'document' ? mapped : null;

    let dueDate: string | null = null;
    let dueDateSource: 'supplier_term' | 'manual' | null = null;
    if (doc !== null && supplier.resolved && doc.issueDate !== null) {
      const due = resolveDueDate({
        type: doc.type,
        issueDate: doc.issueDate,
        typedDueDate: null,
        paymentTermDays: supplier.paymentTermDays,
      });
      if (due !== 'due_date_required') {
        dueDate = due.dueDate;
        dueDateSource = due.source;
      }
    }

    const duplicateNumber =
      knownDuplicate ||
      (doc !== null &&
        supplier.resolved &&
        doc.numberNormalized !== null &&
        (await this.duplicateCheck.exists(tx, {
          documentId: job.documentId,
          supplierId: supplier.id,
          type: doc.type,
          letter: doc.letter,
          numberNormalized: doc.numberNormalized,
        })));

    const duplicateSuspected =
      doc !== null &&
      supplier.resolved &&
      doc.issueDate !== null &&
      doc.total !== null &&
      (await this.duplicateSuspectedCheck.findMatch(tx, {
        documentId: job.documentId,
        supplierId: supplier.id,
        issueDate: doc.issueDate,
        total: doc.total,
        hasNumber: doc.numberNormalized !== null,
      })) !== null;

    const checkSupplier: ExtractionCheckInput['supplier'] = supplier.resolved
      ? { resolved: true, paymentTermDays: supplier.paymentTermDays }
      : { resolved: false };
    const issues: IssueCode[] = checkExtraction({
      mapped,
      supplier: checkSupplier,
      duplicateNumber,
      duplicateSuspected,
      restaurantCuit: this.config.restaurantCuit,
    });

    // A run replaces everything an earlier run of this job left (E2).
    await tx.documentLine.deleteMany({ where: { documentId: job.documentId } });
    await tx.documentTax.deleteMany({ where: { documentId: job.documentId } });
    if (doc !== null) {
      await tx.documentLine.createMany({
        data: doc.lines.map((line) => ({
          documentId: job.documentId,
          ...line,
        })),
      });
      await tx.documentTax.createMany({
        data: doc.taxes.map((tax) => ({ documentId: job.documentId, ...tax })),
      });
    }

    const reviewStatus: ReviewStatus =
      issues.length === 0 ? 'unreviewed' : 'error';
    // The model API, so a duplicate surfaces as P2002 on the index.
    await tx.document.update({
      where: { id: job.documentId },
      data: {
        type: doc?.type ?? null,
        letter: doc?.letter ?? null,
        number: doc?.number ?? null,
        numberNormalized: doc?.numberNormalized ?? null,
        issueDate: doc?.issueDate ? toDbDate(doc.issueDate) : null,
        dueDate: dueDate === null ? null : toDbDate(dueDate),
        dueDateSource,
        subtotal: doc?.subtotal ?? null,
        total: doc?.total ?? null,
        cae: doc?.cae ?? null,
        supplierId: supplier.resolved ? supplier.id : null,
        issues: issues.map((code) => ({ code })),
        reviewStatus,
      },
    });
    const after = await this.audit.snapshot(tx, 'documents', job.documentId);
    await this.audit.recordByWorker(tx, {
      entity: 'documents',
      entityId: job.documentId,
      action: 'update',
      before,
      after,
    });

    await tx.extractionJob.update({
      where: { id: job.id },
      data: { status: 'succeeded', lockedUntil: null, rawOutput },
    });
    return { kind: 'written', reviewStatus };
  }

  /**
   * Decision 9. A CUIT that's missing, invalid or the restaurant's own never
   * resolves. A known one is read `FOR SHARE`, so a term change waits for
   * this write. A new one with a legible name creates the supplier, with no
   * term.
   */
  private async resolveSupplier(
    tx: Prisma.TransactionClient,
    mapped: MappedExtraction,
  ): Promise<Supplier> {
    if (mapped.kind !== 'document') return { resolved: false };
    const cuit = mapped.supplierCuit;
    if (cuit === null || cuit === this.config.restaurantCuit) {
      return { resolved: false };
    }
    const existing = await this.supplierByCuit(tx, cuit);
    if (existing !== null) return existing;
    if (mapped.supplierName === null) return { resolved: false };

    // ON CONFLICT DO NOTHING: a person saving the same CUIT at the same
    // moment can't make this write fail.
    const [created] = await tx.supplier.createManyAndReturn({
      data: [
        { name: mapped.supplierName, legalName: mapped.supplierName, cuit },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created === undefined) {
      return (await this.supplierByCuit(tx, cuit)) ?? { resolved: false };
    }
    const after = await this.audit.snapshot(tx, 'suppliers', created.id);
    await this.audit.recordByWorker(tx, {
      entity: 'suppliers',
      entityId: created.id,
      action: 'create',
      before: null,
      after,
    });
    return { resolved: true, id: created.id, paymentTermDays: null };
  }

  private async supplierByCuit(
    tx: Prisma.TransactionClient,
    cuit: string,
  ): Promise<Supplier | null> {
    const rows = await tx.$queryRaw<
      { id: string; payment_term_days: number | null }[]
    >`
      SELECT id, payment_term_days FROM suppliers
      WHERE cuit = ${cuit}
      FOR SHARE`;
    if (rows.length === 0) return null;
    return {
      resolved: true,
      id: rows[0].id,
      paymentTermDays: rows[0].payment_term_days,
    };
  }
}
