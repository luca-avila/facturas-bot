import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Test } from 'supertest';
import type { SupplierAccount } from '../src/balances/balances.types.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createUser, signIn, type CreatedTestUser } from './app.js';

type Row = Record<string, string | null>;

/** 12:00 in Buenos Aires on 2026-11-09. */
export const NOW = '2026-11-09T15:00:00.000Z';

export interface SplitRowBody {
  documentId: string;
  amount: string;
}

/**
 * Suppliers, documents and payments for the payment and application specs,
 * as Ana. Suppliers are informal, with a unique token in the name.
 */
export class Ledger {
  readonly prisma: PrismaService;
  ana!: CreatedTestUser;
  private session = '';
  private ticks = 0;

  constructor(private readonly app: NestExpressApplication) {
    this.prisma = app.get(PrismaService);
  }

  async createAna(): Promise<void> {
    this.ana = await createUser(this.app, { name: 'Ana' });
  }

  /** Fakes only `Date` at `NOW`, then signs in, so the session is issued then. */
  async signInAtNow(): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    this.ticks = 0;
    this.session = await signIn(this.app, this.ana);
  }

  /**
   * Moves the fake clock on a second. Prisma fills `created_at` from the JS
   * clock, so rows created at the same faked instant tie, and only their
   * random ids order them.
   */
  tick(): void {
    this.ticks += 1;
    vi.setSystemTime(new Date(new Date(NOW).getTime() + this.ticks * 1000));
  }

  http(): ReturnType<typeof request> {
    return request(this.app.getHttpServer());
  }

  private withSession(req: Test): Test {
    return req.set('Cookie', `session=${this.session}`);
  }

  post(url: string, body: unknown): Test {
    return this.withSession(this.http().post(url)).send(body as object);
  }

  get(url: string): Test {
    return this.withSession(this.http().get(url));
  }

  delete(url: string): Test {
    return this.withSession(this.http().delete(url));
  }

  async supplier(token: string = randomUUID()): Promise<string> {
    const { id } = await this.prisma.supplier.create({
      data: { name: `Panadería ${token}`, paymentTermDays: 30 },
    });
    return id;
  }

  /** An invoice without a number, entered through the API with a typed due date. */
  async invoice(
    supplierId: string,
    total: string,
    dueDate: string,
    issueDate = '2026-10-01',
  ): Promise<string> {
    return this.enter({
      supplierId,
      type: 'invoice',
      letter: null,
      number: null,
      issueDate,
      dueDate,
      total,
      notes: null,
    });
  }

  async creditNote(supplierId: string, total: string): Promise<string> {
    return this.enter({
      supplierId,
      type: 'credit_note',
      letter: null,
      number: null,
      issueDate: '2026-10-01',
      dueDate: null,
      total,
      notes: null,
    });
  }

  async openingBalance(
    supplierId: string,
    total: string,
    issueDate: string,
    dueDate: string | null,
  ): Promise<string> {
    return this.enter({
      supplierId,
      type: 'opening_balance',
      letter: null,
      number: null,
      issueDate,
      dueDate,
      total,
      notes: null,
    });
  }

  private async enter(body: unknown): Promise<string> {
    const res = await this.post('/api/documents', body).expect(201);
    return (res.body as { id: string }).id;
  }

  /** A reviewed invoice of 100.00 written directly, changed by `overrides`, for states the API can't make. */
  async insertDocument(
    supplierId: string,
    overrides: Row = {},
  ): Promise<string> {
    const row: Row = {
      source: 'manual',
      review_status: 'reviewed',
      type: 'invoice',
      supplier_id: supplierId,
      issue_date: '2026-10-01',
      due_date: '2026-11-20',
      due_date_source: 'manual',
      total: '100.00',
      created_by: this.ana.id,
      reviewed_by: this.ana.id,
      reviewed_at: '2026-11-01T12:00:00Z',
      ...overrides,
    };
    const columns = Object.keys(row);
    const sql = `INSERT INTO documents (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const [inserted] = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...columns.map((c) => row[c]),
    );
    return inserted.id;
  }

  /** A document in `error`, which doesn't count. */
  errorDocument(supplierId: string, type = 'invoice'): Promise<string> {
    return this.insertDocument(supplierId, {
      type,
      review_status: 'error',
      source: 'upload',
      reviewed_by: null,
      reviewed_at: null,
      ...(type === 'credit_note'
        ? { due_date: null, due_date_source: null }
        : {}),
    });
  }

  /** The `POST /api/payments` body: a transfer paid today, changed by `overrides`. */
  paymentBody(
    supplierId: string,
    amount: string,
    applications: SplitRowBody[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      supplierId,
      amount,
      paidOn: '2026-11-09',
      method: 'transfer',
      reference: null,
      valueDate: null,
      notes: null,
      applications,
      ...overrides,
    };
  }

  /** Records a payment and returns its id. */
  async pay(
    supplierId: string,
    amount: string,
    applications: SplitRowBody[] = [],
  ): Promise<string> {
    const res = await this.post(
      '/api/payments',
      this.paymentBody(supplierId, amount, applications),
    ).expect(201);
    return (res.body as { id: string }).id;
  }

  async account(supplierId: string): Promise<SupplierAccount> {
    const res = await this.get(`/api/suppliers/${supplierId}`).expect(200);
    return res.body as SupplierAccount;
  }

  async doc(supplierId: string, id: string) {
    const account = await this.account(supplierId);
    const doc = account.documents.find((d) => d.id === id);
    if (!doc) throw new Error(`Document ${id} isn't counted.`);
    return doc;
  }

  /**
   * The supplier's payments and the applications to its documents, and Ana's
   * audit entries, so a test can check nothing was written. Ana is this spec
   * file's own user, and its tests run one at a time.
   */
  async writes(
    supplierId: string,
  ): Promise<{ payments: number; applications: number; audit: number }> {
    const [row] = await this.prisma.$queryRaw<
      { payments: number; applications: number; audit: number }[]
    >`
      SELECT (SELECT count(*)::int FROM payments WHERE supplier_id = ${supplierId}::uuid) AS payments,
             (SELECT count(*)::int FROM applications x JOIN documents d ON d.id = x.document_id
              WHERE d.supplier_id = ${supplierId}::uuid) AS applications,
             (SELECT count(*)::int FROM audit_log WHERE user_id = ${this.ana.id}::uuid) AS audit`;
    return row;
  }

  /** The applications to these documents, as `[documentId, amount]`, sorted. */
  async applicationsTo(documentIds: string[]): Promise<[string, string][]> {
    const rows = await this.prisma.$queryRaw<
      { document_id: string; amount: string }[]
    >`
      SELECT document_id, amount::text AS amount FROM applications
      WHERE document_id = ANY(${documentIds}::uuid[]) ORDER BY document_id, amount`;
    return rows.map((r) => [r.document_id, r.amount]);
  }
}
