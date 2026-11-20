import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { SessionUser } from '../auth/session.js';
import { ADVISORY_LOCKS } from '../common/advisory-locks.js';
import { now } from '../common/clock.js';
import {
  conflict,
  type FieldError,
  invalidRequest,
} from '../common/field-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageStore } from './image-store.js';
import { inspectPhoto, type Photo } from './photo.js';

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
      const rows = await tx.$queryRaw<
        { sha256: string; document_id: string }[]
      >`
        SELECT i.sha256, i.document_id
        FROM document_images i
        JOIN documents d ON d.id = i.document_id
        WHERE d.deleted_at IS NULL AND i.sha256 = ANY(${hashes}::text[])
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
