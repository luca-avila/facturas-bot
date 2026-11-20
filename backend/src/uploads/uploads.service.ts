import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { ADVISORY_LOCKS } from '../common/advisory-locks.js';
import { BUSINESS_TIME_ZONE, now, today } from '../common/clock.js';
import { addDays } from '../common/dates.js';
import {
  conflict,
  type FieldError,
  invalidRequest,
} from '../common/field-errors.js';
import { Prisma } from '../generated/prisma/client.js';
import type { DocumentType, ReviewStatus } from '../generated/prisma/client.js';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageStore } from './image-store.js';
import { inspectPhoto, type Photo } from './photo.js';
import type { UploadList, UploadScope } from './uploads.types.js';

/** Today and the six days before, in Buenos Aires. */
const LISTED_DAYS = 7;

/** A file as multer keeps it in memory. Only these fields are read. */
export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

export interface UploadResult {
  id: string;
  /** True when every photo was already in this one document. Nothing was written. */
  alreadyUploaded: boolean;
}

interface PagePhoto {
  photo: Photo;
  /** `file.buffer` itself: the bytes hashed are the bytes written (E5). */
  bytes: Buffer;
}

interface UploadListRow {
  id: string;
  review_status: ReviewStatus;
  page_count: number;
  uploaded_on: string;
  uploaded_time: string;
  days_ago: number;
  created_by_name: string;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  supplier_name: string | null;
  total: string | null;
}

/** A photo already in another document. */
interface OtherDocumentError extends FieldError {
  code: 'photo_in_other_document';
  documentId: string;
}

/**
 * The only writer of `document_images` and `extraction_jobs`. Every upload
 * takes `ADVISORY_LOCKS.uploads` before the same-image check, so two uploads
 * of the same photos can't both create a document.
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: ImageStore,
  ) {}

  async upload(
    files: UploadedPhoto[] | undefined,
    user: SessionUser,
  ): Promise<UploadResult> {
    if (files === undefined || files.length === 0) throw invalidRequest();
    const pages = inspectPages(files);
    const hashes = pages.map(({ photo }) => photo.sha256);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.uploads})`;

      // Oldest document first, so a hash somehow in two keeps the oldest.
      // `bpchar[]`, the column's type: against `text[]` the column is cast,
      // and `document_images_sha256_idx` can't serve the lookup.
      const rows = await tx.$queryRaw<
        { sha256: string; document_id: string }[]
      >`
        SELECT i.sha256, i.document_id
        FROM document_images i
        JOIN documents d ON d.id = i.document_id
        WHERE d.deleted_at IS NULL AND i.sha256 = ANY(${hashes}::bpchar[])
        ORDER BY d.created_at, d.id`;
      const documentOf = new Map<string, string>();
      for (const row of rows) {
        if (!documentOf.has(row.sha256)) {
          documentOf.set(row.sha256, row.document_id);
        }
      }

      const matched = new Set(documentOf.values());
      if (documentOf.size === hashes.length && matched.size === 1) {
        const [id] = matched;
        return { id, alreadyUploaded: true };
      }
      if (documentOf.size > 0) {
        const errors: OtherDocumentError[] = hashes.flatMap((hash, i) => {
          const documentId = documentOf.get(hash);
          return documentId === undefined
            ? []
            : [
                {
                  field: `photos.${i}`,
                  code: 'photo_in_other_document' as const,
                  documentId,
                },
              ];
        });
        throw conflict(errors);
      }

      const keys: string[] = [];
      for (const { photo, bytes } of pages) {
        const key = this.store.newKey(photo.extension);
        await this.store.write(key, bytes);
        keys.push(key);
      }

      const { id } = await tx.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'processing',
          createdById: user.id,
          images: {
            create: pages.map(({ photo }, i) => ({
              position: i + 1,
              storageKey: keys[i],
              mimeType: photo.mimeType,
              width: photo.width,
              height: photo.height,
              sizeBytes: photo.sizeBytes,
              sha256: photo.sha256,
            })),
          },
          extractionJobs: {
            create: { status: 'queued', attempts: 0, runAfter: now() },
          },
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
      return { id, alreadyUploaded: false };
    });
  }

  /**
   * *Subidas*: uploads that aren't deleted (D3), from the last 7 calendar
   * days in Buenos Aires, plus every one still processing. The cutoff comes
   * from `today()`, never SQL `now()`.
   */
  async list(scope: UploadScope, user: SessionUser): Promise<UploadList> {
    const date = today();
    const cutoff = addDays(date, -(LISTED_DAYS - 1));
    const localCreatedAt = Prisma.sql`(d.created_at AT TIME ZONE ${BUSINESS_TIME_ZONE}::text)`;
    const mine =
      scope === 'mine'
        ? Prisma.sql`AND d.created_by = ${user.id}::uuid`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<UploadListRow[]>`
      SELECT d.id, d.review_status,
             (SELECT count(*)::int FROM document_images i WHERE i.document_id = d.id) AS page_count,
             to_char(${localCreatedAt}, 'YYYY-MM-DD') AS uploaded_on,
             to_char(${localCreatedAt}, 'HH24:MI') AS uploaded_time,
             ${date}::date - ${localCreatedAt}::date AS days_ago,
             u.name AS created_by_name,
             d.type, d.letter, d.number,
             s.name AS supplier_name,
             d.total::text AS total
      FROM documents d
      JOIN users u ON u.id = d.created_by
      LEFT JOIN suppliers s ON s.id = d.supplier_id
      WHERE d.source = 'upload'
        AND d.deleted_at IS NULL
        AND (d.review_status = 'processing' OR ${localCreatedAt}::date >= ${cutoff}::date)
        ${mine}
      ORDER BY d.created_at DESC, d.id DESC`;
    return {
      uploads: rows.map((row) => ({
        id: row.id,
        reviewStatus: row.review_status,
        pageCount: row.page_count,
        uploadedOn: row.uploaded_on,
        uploadedTime: row.uploaded_time,
        daysAgo: row.days_ago,
        createdByName: row.created_by_name,
        type: row.type,
        letter: row.letter,
        number: row.number,
        supplierName: row.supplier_name,
        total: row.total,
      })),
    };
  }

  /**
   * The bytes as stored. Not found for a bad id, an unknown one, or an image
   * of a deleted document (D3). A row whose file is missing throws: a 500.
   */
  async readImage(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (!isUuid(id)) throw new NotFoundException();
    const [row] = await this.prisma.$queryRaw<
      { storage_key: string; mime_type: string }[]
    >`
      SELECT i.storage_key, i.mime_type
      FROM document_images i
      JOIN documents d ON d.id = i.document_id
      WHERE i.id = ${id}::uuid AND d.deleted_at IS NULL`;
    if (row === undefined) throw new NotFoundException();
    return {
      bytes: await this.store.read(row.storage_key),
      mimeType: row.mime_type,
    };
  }
}

/**
 * Each file read from its bytes, or a 400 with every page error at once. A
 * photo with the same bytes as an earlier valid one is `photo_repeated`.
 */
function inspectPages(files: UploadedPhoto[]): PagePhoto[] {
  const errors: FieldError[] = [];
  const pages: PagePhoto[] = [];
  const seen = new Set<string>();
  files.forEach((file, i) => {
    const photo = inspectPhoto(file.buffer);
    if (photo === null) {
      errors.push({ field: `photos.${i}`, code: 'photo_type_invalid' });
    } else if (seen.has(photo.sha256)) {
      errors.push({ field: `photos.${i}`, code: 'photo_repeated' });
    } else {
      seen.add(photo.sha256);
      pages.push({ photo, bytes: file.buffer });
    }
  });
  if (errors.length > 0) throw invalidRequest(errors);
  return pages;
}
