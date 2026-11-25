import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

/** The document being written is `processing`, so it never matches itself. */
export interface DuplicateNumberQuery {
  documentId: string;
  supplierId: string;
  type: 'invoice' | 'delivery_note' | 'credit_note';
  letter: string | null;
  numberNormalized: string;
}

/**
 * Invariant 7's set, checked before the write: another document of the same
 * supplier, type, letter and number that isn't deleted and counts. The
 * unique index `documents_number_unique` still decides in the end. A
 * provider of its own only so a spec can make it miss.
 */
@Injectable()
export class DuplicateNumberCheck {
  async exists(
    tx: Prisma.TransactionClient,
    query: DuplicateNumberQuery,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM documents
        WHERE supplier_id = ${query.supplierId}::uuid
          AND type = ${query.type}::document_type
          AND letter IS NOT DISTINCT FROM ${query.letter}
          AND number_normalized = ${query.numberNormalized}
          AND deleted_at IS NULL
          AND review_status IN ('unreviewed', 'reviewed')
      ) AS exists`;
    return row.exists;
  }
}
