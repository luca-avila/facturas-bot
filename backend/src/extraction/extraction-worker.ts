import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { now } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageStore } from '../uploads/image-store.js';
import {
  type CallOutcome,
  describeError,
  ExtractionCall,
} from './extraction-call.js';
import { ExtractionConfig } from './extraction-config.js';
import type { PageImage } from './extraction-request.js';
import { type ClaimedJob, ExtractionWriter } from './extraction-writer.js';
import { PROMPT_VERSION } from './prompt.js';

/** The first attempt plus three retries. */
export const MAX_ATTEMPTS = 4;
/** Longer than a call (`CALL_TIMEOUT_MS`), so a live worker keeps its job. */
export const LEASE_MS = 300_000;
/** How often an idle worker looks for work. */
export const POLL_MS = 5_000;
/** About 29.3 MB in base64, under the API's 32 MB request limit. */
export const MAX_IMAGE_BYTES_PER_CALL = 22_000_000;

/** The wait after failed attempt n: 30 s, 2 min, 8 min. */
export function backoffMs(attempt: number): number {
  return 30_000 * 4 ** (attempt - 1);
}

const MIME_TYPES: readonly PageImage['mimeType'][] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

function isPageMimeType(value: string): value is PageImage['mimeType'] {
  return (MIME_TYPES as readonly string[]).includes(value);
}

interface StoredPage {
  storageKey: string;
  mimeType: string;
}

/** A claim that ended the job with no call, or one that leads to a call. */
type Claim =
  { kind: 'ended' } | { kind: 'claimed'; job: ClaimedJob; pages: StoredPage[] };

interface JobRow {
  id: string;
  document_id: string;
  status: 'queued' | 'running';
  attempts: number;
}

/** `<class> <status>` of a described error, with no message. */
function errorKind(error: string): string {
  return error.split(':')[0];
}

/**
 * Claims extraction jobs one at a time, calls the model outside any
 * transaction (E1), and hands the result to `ExtractionWriter`.
 */
@Injectable()
export class ExtractionWorker {
  private readonly logger = new Logger(ExtractionWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ExtractionConfig,
    private readonly store: ImageStore,
    private readonly call: ExtractionCall,
    private readonly writer: ExtractionWriter,
  ) {}

  /**
   * Claims and handles at most one job. True when it claimed one. `only`
   * limits the claim to those documents' jobs, for specs: the shared test
   * database holds every spec file's queued uploads.
   */
  async runOnce(only?: { documentIds: readonly string[] }): Promise<boolean> {
    const claim = await this.claim(only);
    if (claim === null) return false;
    if (claim.kind === 'ended') return true;
    const { job, pages } = claim;
    this.logger.log(`Claimed job ${job.id}, attempt ${job.attempt}`);

    const start = performance.now();
    let outcome: CallOutcome;
    try {
      const images = await Promise.all(pages.map((page) => this.read(page)));
      outcome = await this.call.run(images);
    } catch (error) {
      outcome = { ok: false, error: describeError(error) };
    }

    if (!outcome.ok) {
      await this.failAttempt(job, outcome.error);
      return true;
    }
    const result = await this.writer.write(job, outcome);
    if (result.kind === 'lost') {
      this.logger.warn(`Job ${job.id} attempt ${job.attempt} lost its lease`);
    } else {
      const seconds = Math.round((performance.now() - start) / 1000);
      const status =
        result.kind === 'written' ? result.reviewStatus : 'not processing';
      this.logger.log(
        `Finished job ${job.id}: document ${status}, ` +
          `${outcome.usage.inputTokens} tokens in, ${outcome.usage.outputTokens} out, ${seconds} s`,
      );
    }
    return true;
  }

  /** Calls runOnce until the signal aborts, sleeping POLL_MS when idle or after an error. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed = false;
      try {
        claimed = await this.runOnce();
      } catch (error) {
        // Never the message: it can quote what was read.
        this.logger.error(
          `Worker step failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
        );
      }
      if (!claimed) {
        await sleep(POLL_MS, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  /**
   * Decision 7, in one short transaction committed before the call. `$now`
   * comes from `now()`, never SQL `now()`.
   */
  private claim(only?: {
    documentIds: readonly string[];
  }): Promise<Claim | null> {
    const at = now();
    const onlyThese =
      only === undefined
        ? Prisma.empty
        : Prisma.sql`AND j.document_id = ANY(${[...only.documentIds]}::uuid[])`;
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<JobRow[]>`
        SELECT j.id, j.document_id, j.status::text AS status, j.attempts
        FROM extraction_jobs j
        WHERE ((j.status = 'queued' AND j.run_after <= ${at})
            OR (j.status = 'running' AND j.locked_until < ${at}))
          ${onlyThese}
        ORDER BY j.run_after, j.created_at, j.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      if (row === undefined) return null;
      const job = { id: row.id, documentId: row.document_id };

      // Nothing from a deleted document is ever sent.
      const [doc] = await tx.$queryRaw<{ writable: boolean }[]>`
        SELECT deleted_at IS NULL AND review_status = 'processing' AS writable
        FROM documents WHERE id = ${row.document_id}::uuid`;
      if (doc === undefined || !doc.writable) {
        await tx.extractionJob.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            lockedUntil: null,
            lastError: 'document deleted or no longer processing',
          },
        });
        this.logger.log(`Ended job ${row.id}: document not processing`);
        return { kind: 'ended' };
      }

      const pages = await tx.$queryRaw<
        { storage_key: string; mime_type: string; size_bytes: number }[]
      >`
        SELECT storage_key, mime_type, size_bytes FROM document_images
        WHERE document_id = ${row.document_id}::uuid
        ORDER BY position`;
      const bytes = pages.reduce((sum, page) => sum + page.size_bytes, 0);
      if (bytes > MAX_IMAGE_BYTES_PER_CALL) {
        await this.writer.fail(
          tx,
          job,
          `pages add up to ${bytes} bytes, over ${MAX_IMAGE_BYTES_PER_CALL}`,
        );
        this.logger.log(`Ended job ${row.id}: pages too big to send`);
        return { kind: 'ended' };
      }

      if (row.status === 'running' && row.attempts >= MAX_ATTEMPTS) {
        await this.writer.fail(
          tx,
          job,
          `lease expired after attempt ${row.attempts}`,
        );
        this.logger.log(
          `Ended job ${row.id}: lease expired at the last attempt`,
        );
        return { kind: 'ended' };
      }

      const attempt = row.attempts + 1;
      await tx.extractionJob.update({
        where: { id: row.id },
        data: {
          status: 'running',
          attempts: attempt,
          lockedUntil: new Date(at.getTime() + LEASE_MS),
          model: this.config.model,
          promptVersion: PROMPT_VERSION,
        },
      });
      return {
        kind: 'claimed',
        job: { ...job, attempt },
        pages: pages.map((page) => ({
          storageKey: page.storage_key,
          mimeType: page.mime_type,
        })),
      };
    });
  }

  private async read(page: StoredPage): Promise<PageImage> {
    if (!isPageMimeType(page.mimeType)) {
      throw new Error(`Stored page has an unknown type ${page.mimeType}`);
    }
    return {
      mimeType: page.mimeType,
      bytes: await this.store.read(page.storageKey),
    };
  }

  /** Back in the queue with a backoff, or the final failure after the last attempt. */
  private async failAttempt(job: ClaimedJob, error: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.writer.holdsFence(tx, job))) {
        this.logger.warn(`Job ${job.id} attempt ${job.attempt} lost its lease`);
        return;
      }
      if (job.attempt >= MAX_ATTEMPTS) {
        await this.writer.fail(tx, job, error);
        this.logger.warn(
          `Job ${job.id} attempt ${job.attempt} failed (${errorKind(error)}): no attempts left`,
        );
        return;
      }
      const runAfter = new Date(now().getTime() + backoffMs(job.attempt));
      await tx.extractionJob.update({
        where: { id: job.id },
        data: {
          status: 'queued',
          runAfter,
          lockedUntil: null,
          lastError: error,
        },
      });
      this.logger.warn(
        `Job ${job.id} attempt ${job.attempt} failed (${errorKind(error)}), next at ${runAfter.toISOString()}`,
      );
    });
  }
}
