import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Image bytes built at run time: image files can't be committed, since the
 * CUIT check fails on binaries. Every call puts 16 random bytes inside, so
 * it has new bytes and a new hash.
 */

/** Lowercase hex sha256 of the bytes. Tests compute hashes, never write them out. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function u16be(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}

function u32be(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

function u32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function u24le(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

/** A JPEG segment: marker, then a length that counts itself. */
function segment(marker: number, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, marker]),
    u16be(body.length + 2),
    body,
  ]);
}

/** An APP1 segment with a big-endian TIFF block holding only the orientation. */
function exifOrientation(orientation: number): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('MM'),
    u16be(42),
    u32be(8),
    u16be(1),
    // Tag 0x0112, type 3 (short), count 1, the value padded to 4 bytes.
    u16be(0x0112),
    u16be(3),
    u32be(1),
    u16be(orientation),
    u16be(0),
    u32be(0),
  ]);
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
}

export function jpeg({
  width = 1650,
  height = 2200,
  size,
  orientation,
}: {
  width?: number;
  height?: number;
  size?: number;
  orientation?: number;
} = {}): Buffer {
  const sof0 = segment(
    0xc0,
    Buffer.concat([
      Buffer.from([8]),
      u16be(height),
      u16be(width),
      Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ]),
  );
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xfe, randomBytes(16)),
    ...(orientation === undefined ? [] : [exifOrientation(orientation)]),
    sof0,
    Buffer.from([0xff, 0xd9]),
  ]);
  if (size === undefined) return bytes;
  if (size < bytes.length)
    throw new Error(`A JPEG can't be under ${bytes.length} bytes.`);
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

export function png({
  width = 1650,
  height = 2200,
}: { width?: number; height?: number } = {}): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk(
      'IHDR',
      Buffer.concat([
        u32be(width),
        u32be(height),
        Buffer.from([8, 2, 0, 0, 0]),
      ]),
    ),
    pngChunk('tEXt', Buffer.from(randomBytes(16).toString('hex'), 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const padded =
    data.length % 2 === 0 ? data : Buffer.concat([data, Buffer.alloc(1)]);
  return Buffer.concat([
    Buffer.from(type, 'latin1'),
    u32le(data.length),
    padded,
  ]);
}

export function webp({
  width = 1650,
  height = 2200,
}: { width?: number; height?: number } = {}): Buffer {
  const vp8x = Buffer.concat([
    Buffer.alloc(4),
    u24le(width - 1),
    u24le(height - 1),
  ]);
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    riffChunk('VP8X', vp8x),
    riffChunk('XTRA', randomBytes(16)),
  ]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}

/** A HEIC `ftyp` box, which no step accepts. */
export function heic(): Buffer {
  return Buffer.concat([
    u32be(24),
    Buffer.from('ftypheic'),
    u32be(0),
    Buffer.from('mif1heic'),
    randomBytes(16),
  ]);
}

export function gif(): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt16LE(16, 0);
  size.writeUInt16LE(16, 2);
  return Buffer.concat([Buffer.from('GIF89a'), size, randomBytes(16)]);
}
