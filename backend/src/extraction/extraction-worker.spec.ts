import { randomUUID } from 'node:crypto';
import { invoiceOutput } from '../../test/extraction-outputs.js';
import { ExtractionHarness } from '../../test/extraction-harness.js';
import { EXTRACTION_WORKER_CUITS } from '../../test/test-cuits.js';
import { now } from '../common/clock.js';
import { MAX_IMAGE_BYTES_PER_CALL } from './extraction-worker.js';
import { PROMPT_VERSION } from './prompt.js';

const NOW = '2026-11-24T15:00:00.000Z';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const [CUIT] = EXTRACTION_WORKER_CUITS;

describe('ExtractionWorker: claiming, leases and retries', () => {
  const h = new ExtractionHarness();

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await h.stop();
  });

  beforeEach(async () => {
    await h.newWorker();
    await h.freeCuits(EXTRACTION_WORKER_CUITS);
    await h.at(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A known supplier with a term, so a good output lands in *Sin revisar*. */
  const knownSupplier = () => h.supplier(`Molino ${randomUUID()}`, CUIT, 30);
  const output = (overrides = {}) =>
    invoiceOutput({ supplierCuit: CUIT, ...overrides });

  it('claims a queued upload whose time has come: running, attempt 1, a 5-minute lease, the model and prompt version', async () => {
    await knownSupplier();
    const id = await h.upload();
    const { received, release } = h.fake.hold(output());
    const running = h.runOnce(id);
    await received;

    const job = await h.job(id);
    expect(job).toMatchObject({
      status: 'running',
      attempts: 1,
      locked_until: new Date(new Date(NOW).getTime() + 5 * MINUTE),
      model: 'claude-haiku-5-5',
      prompt_version: PROMPT_VERSION,
    });
    release();
    await expect(running).resolves.toBe(true);
    expect(h.fake.requests).toHaveLength(1);
  });

  it('claims the job that is due first, then the oldest upload', async () => {
    const older = await h.upload();
    h.advance(SECOND);
    const newer = await h.upload();
    h.advance(SECOND);
    const newest = await h.upload();
    // The newest is due first; the other two tie on run_after.
    await h.prisma.$executeRaw`
      UPDATE extraction_jobs SET run_after = ${new Date(NOW)}
      WHERE document_id = ANY(${[older, newer]}::uuid[])`;
    await h.prisma.$executeRaw`
      UPDATE extraction_jobs SET run_after = ${new Date(new Date(NOW).getTime() - SECOND)}
      WHERE document_id = ${newest}::uuid`;
    const only = { documentIds: [newer, older, newest] };
    const attempts = async () =>
      Promise.all(
        [newest, older, newer].map(async (id) => (await h.job(id)).attempts),
      );
    h.fake.replyStatus(529).replyStatus(529);

    await h.worker.runOnce(only);
    expect(await attempts()).toEqual([1, 0, 0]);
    await h.worker.runOnce(only);
    expect(await attempts()).toEqual([1, 1, 0]);
  });

  it("doesn't claim a job whose retry time hasn't come", async () => {
    const id = await h.upload();
    await h.prisma.$executeRaw`
      UPDATE extraction_jobs SET run_after = ${new Date(new Date(NOW).getTime() + SECOND)}
      WHERE document_id = ${id}::uuid`;
    await expect(h.runOnce(id)).resolves.toBe(false);
    expect(h.fake.requests).toHaveLength(0);
  });

  it('skips a job another transaction holds, without waiting for it', async () => {
    const id = await h.upload();
    await h.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM extraction_jobs WHERE document_id = ${id}::uuid FOR UPDATE`;
        await expect(h.runOnce(id)).resolves.toBe(false);
      },
      { timeout: 15_000 },
    );
    expect(h.fake.requests).toHaveLength(0);
  });

  it("doesn't take a live lease, and claims the job again as attempt 2 once it expires", async () => {
    await knownSupplier();
    const id = await h.upload();
    const leaseEnd = new Date(new Date(NOW).getTime() + 5 * MINUTE);
    await h.prisma.$executeRaw`
      UPDATE extraction_jobs SET status = 'running', attempts = 1, locked_until = ${leaseEnd}
      WHERE document_id = ${id}::uuid`;

    h.advance(5 * MINUTE);
    await expect(h.runOnce(id)).resolves.toBe(false);

    h.advance(1);
    h.fake.reply(output());
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(await h.job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await h.lines(id)).toHaveLength(2);
    expect(await h.taxes(id)).toHaveLength(1);
    expect(
      (await h.workerEntries(id)).filter((e) => e.action === 'update'),
    ).toHaveLength(1);
  });

  it('drops the result of a worker that stalled past its lease', async () => {
    await knownSupplier();
    const id = await h.upload();
    const first = output({ number: '0001-00000001' });
    const second = output({
      number: '0002-00000002',
      lines: [output().lines[0]],
    });

    const stalled = h.fake.hold(first);
    const late = h.runOnce(id);
    await stalled.received;

    h.advance(5 * MINUTE + 1);
    h.fake.reply(second);
    await expect(h.runOnce(id)).resolves.toBe(true);

    stalled.release();
    await expect(late).resolves.toBe(true);

    expect(await h.document(id)).toMatchObject({
      review_status: 'unreviewed',
      number: '0002-00000002',
    });
    expect((await h.lines(id)).map((l) => l.description)).toEqual([
      'Harina 000',
    ]);
    expect(await h.taxes(id)).toHaveLength(1);
    expect(await h.workerEntries(id)).toHaveLength(1);
    expect(await h.job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it("drops the failed attempt of a worker that stalled past its lease, so it doesn't requeue the job", async () => {
    await knownSupplier();
    const id = await h.upload();
    // Breaks the schema, so the late call ends as a failed attempt.
    const stalled = h.fake.hold({ ...output(), type: 'receipt' });
    const late = h.runOnce(id);
    await stalled.received;

    h.advance(5 * MINUTE + 1);
    h.fake.reply(output());
    await expect(h.runOnce(id)).resolves.toBe(true);

    stalled.release();
    await expect(late).resolves.toBe(true);

    expect(await h.job(id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      locked_until: null,
      last_error: null,
    });
    expect(await h.document(id)).toMatchObject({
      review_status: 'unreviewed',
    });
  });

  it('ends a job whose lease expired after the last attempt, with no call', async () => {
    const id = await h.upload();
    await h.prisma.$executeRaw`
      UPDATE extraction_jobs SET status = 'running', attempts = 4,
        locked_until = ${new Date(new Date(NOW).getTime() - SECOND)}
      WHERE document_id = ${id}::uuid`;
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(h.fake.requests).toHaveLength(0);
    expect(await h.job(id)).toMatchObject({
      status: 'failed',
      locked_until: null,
    });
    expect(await h.document(id)).toMatchObject({
      review_status: 'error',
      issues: [{ code: 'extraction_failed' }],
    });
  });

  it('ends the job of a document deleted while queued, sending nothing', async () => {
    const id = await h.upload();
    await h.delete(`/api/documents/${id}`).expect(204);
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(h.fake.requests).toHaveLength(0);
    const job = await h.job(id);
    expect(job.status).toBe('failed');
    expect(job.last_error).toEqual(expect.any(String));
    expect(await h.document(id)).toMatchObject({
      review_status: 'processing',
      issues: [],
    });
    expect(await h.workerEntries(id)).toEqual([]);
  });

  it('ends a document whose pages add up to more than 22,000,000 bytes, sending nothing', async () => {
    const id = await h.upload(2);
    await h.prisma.$executeRaw`
      UPDATE document_images SET size_bytes = ${MAX_IMAGE_BYTES_PER_CALL / 2}
        + CASE WHEN position = 1 THEN 1 ELSE 0 END
      WHERE document_id = ${id}::uuid`;
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(h.fake.requests).toHaveLength(0);
    expect(await h.job(id)).toMatchObject({ status: 'failed' });
    expect(await h.document(id)).toMatchObject({
      review_status: 'error',
      issues: [{ code: 'extraction_failed' }],
    });
  });

  it('sends pages adding up to exactly 22,000,000 bytes', async () => {
    const id = await h.upload(2);
    await h.prisma.$executeRaw`
      UPDATE document_images SET size_bytes = ${MAX_IMAGE_BYTES_PER_CALL / 2}
      WHERE document_id = ${id}::uuid`;
    h.fake.replyStatus(529);
    await h.runOnce(id);
    expect(h.fake.requests).toHaveLength(1);
  });

  it('counts a stored image that cannot be read as a failed attempt, sending nothing', async () => {
    const id = await h.upload();
    await h.prisma.$executeRaw`
      UPDATE document_images SET storage_key = ${`${randomUUID()}.jpg`}
      WHERE document_id = ${id}::uuid`;
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(h.fake.requests).toHaveLength(0);
    const job = await h.job(id);
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job.last_error).toMatch(/ENOENT/);
  });

  it('retries after 30 s, 2 min and 8 min, then ends in extraction_failed', async () => {
    const id = await h.upload();
    h.fake.replyStatus(529).replyStatus(529).replyStatus(529).replyStatus(529);

    await expect(h.runOnce(id)).resolves.toBe(true);
    let job = await h.job(id);
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 1,
      locked_until: null,
      run_after: new Date(new Date(NOW).getTime() + 30 * SECOND),
    });
    expect(job.last_error).toMatch(/^OverloadedError 529/);

    h.advance(29 * SECOND);
    await expect(h.runOnce(id)).resolves.toBe(false);
    h.advance(SECOND);
    const second = now();
    await expect(h.runOnce(id)).resolves.toBe(true);
    job = await h.job(id);
    expect(job).toMatchObject({
      attempts: 2,
      run_after: new Date(second.getTime() + 2 * MINUTE),
    });

    h.advance(2 * MINUTE);
    const third = now();
    await expect(h.runOnce(id)).resolves.toBe(true);
    job = await h.job(id);
    expect(job).toMatchObject({
      attempts: 3,
      run_after: new Date(third.getTime() + 8 * MINUTE),
    });

    h.advance(8 * MINUTE);
    await expect(h.runOnce(id)).resolves.toBe(true);
    expect(await h.job(id)).toMatchObject({
      status: 'failed',
      attempts: 4,
      locked_until: null,
    });
    expect(await h.document(id)).toMatchObject({
      review_status: 'error',
      issues: [{ code: 'extraction_failed' }],
      supplier_id: null,
    });
    expect(await h.workerEntries(id)).toEqual([
      {
        entity: 'documents',
        action: 'update',
        user_id: null,
        before_status: 'processing',
        after_status: 'error',
      },
    ]);
    expect(h.fake.requests).toHaveLength(4);
  });

  it('ends a rejected key in extraction_failed after four attempts, mentioning 401', async () => {
    const id = await h.upload();
    for (let i = 0; i < 4; i++) h.fake.replyStatus(401);
    for (let i = 0; i < 4; i++) {
      await expect(h.runOnce(id)).resolves.toBe(true);
      h.advance(10 * MINUTE);
    }
    const job = await h.job(id);
    expect(job).toMatchObject({ status: 'failed', attempts: 4 });
    expect(job.last_error).toMatch(/401/);
    expect((await h.document(id)).issues).toEqual([
      { code: 'extraction_failed' },
    ]);
  });

  it('finishes a job that fails once and then succeeds', async () => {
    await knownSupplier();
    const id = await h.upload();
    h.fake.failNetwork().reply(output());
    await h.runOnce(id);
    h.advance(30 * SECOND);
    await h.runOnce(id);
    expect(await h.job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await h.document(id)).toMatchObject({
      review_status: 'unreviewed',
      total: '50000.00',
    });
  });

  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded'])(
    'counts stop_reason %s as a failed attempt',
    async (stopReason) => {
      const id = await h.upload();
      h.fake.reply(output(), { stopReason });
      await h.runOnce(id);
      const job = await h.job(id);
      expect(job).toMatchObject({ status: 'queued', attempts: 1 });
      expect(job.last_error).toBe(`stop_reason ${stopReason}`);
      expect(await h.document(id)).toMatchObject({
        review_status: 'processing',
      });
    },
  );

  it("doesn't write the result of a document deleted during its call", async () => {
    await knownSupplier();
    const id = await h.upload();
    const written = output();
    const { received, release } = h.fake.hold(written);
    const running = h.runOnce(id);
    await received;
    await h.delete(`/api/documents/${id}`).expect(204);
    release();
    await running;

    const job = await h.job(id);
    expect(job).toMatchObject({
      status: 'failed',
      raw_output: written,
      last_error: 'document no longer processing',
    });
    const doc = await h.document(id);
    expect(doc.deleted_at).not.toBeNull();
    expect(doc).toMatchObject({ review_status: 'processing', issues: [] });
    expect(await h.lines(id)).toEqual([]);
    expect(await h.workerEntries(id)).toEqual([]);
  });
});
