import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';

/** The spec's "under 7 MB" for originals. In base64 it still fits the API's 10 MB per image. */
export const MAX_PHOTO_BYTES = 7 * 1024 * 1024;
export const MAX_PAGES = 10;

export interface Photo {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  /** As displayed, after EXIF orientation. */
  width: number;
  height: number;
  sizeBytes: number;
  /** Lowercase hex digest of the bytes. */
  sha256: string;
}

const TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const satisfies Record<Photo['extension'], Photo['mimeType']>;

function isAccepted(type: string | undefined): type is Photo['extension'] {
  return type !== undefined && Object.hasOwn(TYPES, type);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * What a photo is, read from its headers only. The client's `Content-Type`
 * and file name never count. Null when it isn't a JPEG, PNG or WebP. It never
 * decodes or changes the bytes (E5).
 */
export function inspectPhoto(bytes: Buffer): Photo | null {
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(bytes);
  } catch {
    return null;
  }
  const { type } = size;
  if (!isAccepted(type)) return null;
  if (!isPositiveInteger(size.width) || !isPositiveInteger(size.height)) {
    return null;
  }
  // Orientations 5 to 8 turn the image a quarter, so the header's sizes swap.
  // `image-size` reports the raw value, and browsers ignore one outside 1 to 8.
  const turned =
    size.orientation !== undefined &&
    size.orientation >= 5 &&
    size.orientation <= 8;
  return {
    mimeType: TYPES[type],
    extension: type,
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
