import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = Record<string, string | number | null>;

describe('document_images and extraction_jobs tables', () => {
  const prisma = new PrismaService();
  let userId: string;

  beforeAll(async () => {
    const [user] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, password_set_at, role)
      VALUES (${`ana-${randomUUID()}@example.com`}, 'Ana', 'not-a-real-hash', now(), 'staff')
      RETURNING id`;
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newUpload(): Promise<string> {
    const [doc] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO documents (source, review_status, created_by)
      VALUES ('upload', 'processing', ${userId}::uuid) RETURNING id`;
    return doc.id;
  }

  /** A hash computed from fresh bytes, never written out. */
  function newHash(): string {
    return createHash('sha256').update(randomBytes(16)).digest('hex');
  }

  /** A valid image of `documentId`, changed by `overrides`. */
  function image(documentId: string, overrides: Row = {}): Row {
    return {
      document_id: documentId,
      position: 1,
      storage_key: `${randomUUID()}.jpg`,
      mime_type: 'image/jpeg',
      width: 1650,
      height: 2200,
      size_bytes: 1000,
      sha256: newHash(),
      ...overrides,
    };
  }

  async function insert(table: string, row: Row): Promise<string> {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    const casts: Record<string, string> = {
      document_id: '::uuid',
      status: '::extraction_job_status',
      run_after: '::timestamptz',
    };
    const sql = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((c, i) => `$${i + 1}${casts[c] ?? ''}`).join(', ')}) RETURNING id`;
    const [inserted] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...values,
    );
    return inserted.id;
  }

  function job(documentId: string, overrides: Row = {}): Row {
    return {
      document_id: documentId,
      status: 'queued',
      attempts: 0,
      run_after: '2026-11-19T02:30:00Z',
      ...overrides,
    };
  }

  it('accepts a valid image and a valid job', async () => {
    const documentId = await newUpload();
    await expect(
      insert('document_images', image(documentId, { position: 3 })),
    ).resolves.toEqual(expect.any(String));
    await expect(insert('extraction_jobs', job(documentId))).resolves.toEqual(
      expect.any(String),
    );
  });

  it.each<[string, Row, RegExp]>([
    ['position 0', { position: 0 }, /document_images_position_positive/],
    ['width 0', { width: 0 }, /document_images_dimensions_positive/],
    ['height 0', { height: 0 }, /document_images_dimensions_positive/],
    ['size_bytes 0', { size_bytes: 0 }, /document_images_size_positive/],
    ['image/heic', { mime_type: 'image/heic' }, /document_images_mime_type/],
    [
      'a storage key with a path',
      { storage_key: '../x.jpg' },
      /document_images_storage_key_format/,
    ],
    [
      'a storage key ending in .gif',
      { storage_key: `${randomUUID()}.gif` },
      /document_images_storage_key_format/,
    ],
  ])('refuses %s', async (_, overrides, constraint) => {
    const row = image(await newUpload(), overrides);
    await expect(insert('document_images', row)).rejects.toThrow(constraint);
  });

  it('refuses an uppercase hash', async () => {
    const row = image(await newUpload(), { sha256: newHash().toUpperCase() });
    await expect(insert('document_images', row)).rejects.toThrow(
      /document_images_sha256_hex/,
    );
  });

  it('refuses a 63-character hash', async () => {
    const row = image(await newUpload(), { sha256: newHash().slice(1) });
    await expect(insert('document_images', row)).rejects.toThrow(
      /document_images_sha256_hex/,
    );
  });

  it('refuses a second image at the same position', async () => {
    const documentId = await newUpload();
    await insert('document_images', image(documentId, { position: 2 }));
    await expect(
      insert('document_images', image(documentId, { position: 2 })),
    ).rejects.toThrow(/document_images_document_id_position_key/);
  });

  it('refuses a repeated storage key', async () => {
    const key = `${randomUUID()}.png`;
    await insert(
      'document_images',
      image(await newUpload(), { storage_key: key }),
    );
    await expect(
      insert('document_images', image(await newUpload(), { storage_key: key })),
    ).rejects.toThrow(/document_images_storage_key_key/);
  });

  it('refuses a job with attempts -1', async () => {
    await expect(
      insert('extraction_jobs', job(await newUpload(), { attempts: -1 })),
    ).rejects.toThrow(/extraction_jobs_attempts_non_negative/);
  });

  it('refuses a hard delete of a document that has images', async () => {
    const documentId = await newUpload();
    await insert('document_images', image(documentId));
    await expect(
      prisma.$executeRaw`DELETE FROM documents WHERE id = ${documentId}::uuid`,
    ).rejects.toThrow(/document_images_document_id_fkey/);
  });
});
