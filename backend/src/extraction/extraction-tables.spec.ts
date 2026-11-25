import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

describe('extraction tables', () => {
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

  async function newJob(
    status: string,
    lockedUntil: string | null,
    rawOutput: string | null = null,
  ): Promise<string> {
    const [job] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO extraction_jobs (document_id, status, attempts, run_after, locked_until, raw_output, model, prompt_version)
      VALUES (${await newUpload()}::uuid, ${status}::extraction_job_status, 1, '2026-11-24T12:00:00Z',
              ${lockedUntil}::timestamptz, ${rawOutput}::jsonb, 'claude-haiku-5-5', '1')
      RETURNING id`;
    return job.id;
  }

  const addLine = (documentId: string, position: number) =>
    prisma.$executeRaw`
      INSERT INTO document_lines (document_id, position, description)
      VALUES (${documentId}::uuid, ${position}, 'Harina 000')`;

  it('refuses issues stored as an object', async () => {
    const id = await newUpload();
    await expect(
      prisma.$executeRaw`UPDATE documents SET issues = '{"code": "missing_total"}' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/documents_issues_array/);
  });

  it('refuses a subtotal of -0.01, and takes 0', async () => {
    const id = await newUpload();
    await expect(
      prisma.$executeRaw`UPDATE documents SET subtotal = -0.01 WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/documents_subtotal_non_negative/);
    await expect(
      prisma.$executeRaw`UPDATE documents SET subtotal = 0 WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);
  });

  it('refuses a line at position 0, and takes one at 1', async () => {
    const id = await newUpload();
    await expect(addLine(id, 0)).rejects.toThrow(
      /document_lines_position_positive/,
    );
    await expect(addLine(id, 1)).resolves.toBe(1);
  });

  it('refuses a repeated line position', async () => {
    const id = await newUpload();
    await addLine(id, 1);
    await expect(addLine(id, 1)).rejects.toThrow(
      /document_lines_document_id_position_key/,
    );
  });

  it('refuses a running job with no lease', async () => {
    await expect(newJob('running', null)).rejects.toThrow(
      /extraction_jobs_running_leased/,
    );
  });

  it('refuses a queued job with a lease', async () => {
    await expect(newJob('queued', '2026-11-24T12:05:00Z')).rejects.toThrow(
      /extraction_jobs_running_leased/,
    );
  });

  it('takes a running job with a lease', async () => {
    await expect(newJob('running', '2026-11-24T12:05:00Z')).resolves.toEqual(
      expect.any(String),
    );
  });

  it('refuses a succeeded job with no raw_output', async () => {
    await expect(newJob('succeeded', null)).rejects.toThrow(
      /extraction_jobs_succeeded_output/,
    );
  });

  it('refuses a succeeded job with no model or prompt version', async () => {
    const id = await newJob('failed', null, '{"isDocument": false}');
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET status = 'succeeded', model = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/extraction_jobs_succeeded_output/);
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET status = 'succeeded', prompt_version = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/extraction_jobs_succeeded_output/);
  });

  it('sets raw_output the first time, then refuses to change it', async () => {
    const id = await newJob('running', '2026-11-24T12:05:00Z');
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET status = 'succeeded', locked_until = NULL, raw_output = '{"a": 1}' WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET raw_output = '{"a": 2}' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/extraction_jobs_keep_raw_output/);
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET raw_output = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/extraction_jobs_keep_raw_output/);
  });

  it('changes another column of a job that has its raw_output', async () => {
    const id = await newJob('failed', null, '{"a": 1}');
    await expect(
      prisma.$executeRaw`UPDATE extraction_jobs SET last_error = 'document no longer processing' WHERE id = ${id}::uuid`,
    ).resolves.toBe(1);
  });
});
