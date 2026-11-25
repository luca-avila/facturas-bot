import { now } from '../src/common/clock.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import type { ExtractionWorker } from '../src/extraction/extraction-worker.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from './app.js';
import { FakeLlm } from './fake-llm.js';
import { jpeg } from './photos.js';
import { createTestWorker } from './worker.js';

export interface JobRow {
  id: string;
  status: string;
  attempts: number;
  run_after: Date;
  locked_until: Date | null;
  model: string | null;
  prompt_version: string | null;
  raw_output: unknown;
  last_error: string | null;
}

export interface DocumentRow {
  review_status: string;
  type: string | null;
  supplier_id: string | null;
  letter: string | null;
  number: string | null;
  issue_date: string | null;
  due_date: string | null;
  due_date_source: string | null;
  subtotal: string | null;
  total: string | null;
  cae: string | null;
  issues: { code: string }[];
  deleted_at: Date | null;
}

/**
 * The real app, for uploads over HTTP, and a worker whose `fetch` goes to a
 * `FakeLlm`. Worker specs only ever claim their own documents' jobs.
 */
export class ExtractionHarness {
  app!: NestExpressApplication;
  prisma!: PrismaService;
  fake = new FakeLlm();
  worker!: ExtractionWorker;
  ana!: CreatedTestUser;
  private closeWorker: () => Promise<void> = () => Promise.resolve();
  private session = '';

  async start(
    override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  ): Promise<void> {
    this.app = await createTestApp();
    this.prisma = this.app.get(PrismaService);
    this.ana = await createUser(this.app, { name: 'Martín' });
    await this.newWorker(override);
  }

  /** A fresh FakeLlm and worker, closing the previous one. */
  async newWorker(
    override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  ): Promise<void> {
    await this.closeWorker();
    this.fake = new FakeLlm();
    const { worker, close } = await createTestWorker(this.fake, override);
    this.worker = worker;
    this.closeWorker = close;
  }

  async stop(): Promise<void> {
    await this.closeWorker();
    await this.app.close();
  }

  /** Fakes only `Date`, then signs in, so the session is issued at that instant. */
  async at(instant: string | Date): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    this.session = await signIn(this.app, this.ana);
  }

  /** Moves the fake clock by `ms`, without signing in again. */
  advance(ms: number): void {
    vi.setSystemTime(new Date(now().getTime() + ms));
  }

  http() {
    return request(this.app.getHttpServer());
  }

  get(url: string) {
    return this.http().get(url).set('Cookie', `session=${this.session}`);
  }

  post(url: string, body: object) {
    return this.http()
      .post(url)
      .set('Cookie', `session=${this.session}`)
      .send(body);
  }

  put(url: string, body: object) {
    return this.http()
      .put(url)
      .set('Cookie', `session=${this.session}`)
      .send(body);
  }

  delete(url: string) {
    return this.http().delete(url).set('Cookie', `session=${this.session}`);
  }

  /** Uploads `pages` random JPEGs and returns the new document's id. */
  async upload(pages = 1): Promise<string> {
    let req = this.http()
      .post('/api/uploads')
      .set('Cookie', `session=${this.session}`)
      .set('X-Requested-With', 'XMLHttpRequest');
    for (let i = 0; i < pages; i++) {
      req = req.attach('photos', jpeg(), `pagina-${i + 1}.jpg`);
    }
    const res = await req.expect(201);
    return (res.body as { id: string }).id;
  }

  runOnce(documentId: string): Promise<boolean> {
    return this.worker.runOnce({ documentIds: [documentId] });
  }

  async job(documentId: string): Promise<JobRow> {
    const [row] = await this.prisma.$queryRaw<JobRow[]>`
      SELECT id, status::text AS status, attempts, run_after, locked_until, model,
             prompt_version, raw_output, last_error
      FROM extraction_jobs WHERE document_id = ${documentId}::uuid`;
    return row;
  }

  async document(id: string): Promise<DocumentRow> {
    const [row] = await this.prisma.$queryRaw<DocumentRow[]>`
      SELECT review_status::text AS review_status, type::text AS type, supplier_id::text AS supplier_id,
             letter, number,
             to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
             to_char(due_date, 'YYYY-MM-DD') AS due_date,
             due_date_source::text AS due_date_source,
             subtotal::text AS subtotal, total::text AS total, cae, issues, deleted_at
      FROM documents WHERE id = ${id}::uuid`;
    return row;
  }

  async lines(documentId: string) {
    return this.prisma.$queryRaw<
      {
        position: number;
        description: string;
        quantity: string | null;
        unit_price: string | null;
        line_total: string | null;
      }[]
    >`
      SELECT position, description, quantity::text AS quantity,
             unit_price::text AS unit_price, line_total::text AS line_total
      FROM document_lines WHERE document_id = ${documentId}::uuid
      ORDER BY position`;
  }

  async taxes(documentId: string) {
    return this.prisma.$queryRaw<
      { kind: string; label: string; amount: string }[]
    >`
      SELECT kind::text AS kind, label, amount::text AS amount
      FROM document_taxes WHERE document_id = ${documentId}::uuid
      ORDER BY kind, label, amount, id`;
  }

  /** The worker's audit entries (no user) for `entityId`, oldest first. */
  async workerEntries(entityId: string) {
    return this.prisma.$queryRaw<
      {
        entity: string;
        action: string;
        user_id: string | null;
        before_status: string | null;
        after_status: string | null;
      }[]
    >`
      SELECT entity, action, user_id::text AS user_id,
             before->>'review_status' AS before_status,
             after->>'review_status' AS after_status
      FROM audit_log
      WHERE entity_id = ${entityId}::uuid AND user_id IS NULL
      ORDER BY created_at, id`;
  }

  /** Frees `cuits` from any supplier, as each CUIT spec does before each test. */
  async freeCuits(cuits: readonly string[]): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE suppliers SET cuit = NULL WHERE cuit = ANY(${[...cuits]}::text[])`;
  }

  async supplier(
    name: string,
    cuit: string,
    paymentTermDays: number | null,
  ): Promise<string> {
    const { id } = await this.prisma.supplier.create({
      data: { name, legalName: name, cuit, paymentTermDays },
    });
    return id;
  }
}
