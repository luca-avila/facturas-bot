import type { DocumentType, ReviewStatus } from '../generated/prisma/client.js';

export type UploadScope = 'mine' | 'all';

export interface UploadRow {
  id: string;
  reviewStatus: ReviewStatus;
  pageCount: number;
  /** YYYY-MM-DD and HH:MM of created_at in Buenos Aires. */
  uploadedOn: string;
  uploadedTime: string;
  /** Today minus uploadedOn, in Buenos Aires: 0 today, 1 yesterday. */
  daysAgo: number;
  createdByName: string;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  supplierName: string | null;
  /** Canonical, such as "53600.00". */
  total: string | null;
}

export interface UploadList {
  /** Newest first, by created_at then id. */
  uploads: UploadRow[];
}
