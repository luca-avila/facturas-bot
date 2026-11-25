import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import { Money } from '../common/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupplierAccount, SupplierList } from './balances.types.js';

type Row = Record<string, string | null>;

/**
 * Suppliers here are informal and carry a unique token in their name, since
 * `GET /api/suppliers` also returns other spec files' suppliers.
 */
describe('balances', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let session: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ana = await createUser(app);
    session = await signIn(app, ana);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await at('2026-11-10T12:00:00Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', `session=${session}`);

  async function list(query: string): Promise<SupplierList> {
    const res = await get(`/api/suppliers?${query}`).expect(200);
    return res.body as SupplierList;
  }

  async function account(id: string): Promise<SupplierAccount> {
    const res = await get(`/api/suppliers/${id}`).expect(200);
    return res.body as SupplierAccount;
  }

  async function newSupplier(
    name: string,
    legalName: string | null = null,
  ): Promise<string> {
    const { id } = await prisma.supplier.create({
      data: { name, legalName, paymentTermDays: 30 },
    });
    return id;
  }

  /** A reviewed invoice by Ana, changed by `overrides`. */
  async function insertDocument(
    supplierId: string,
    overrides: Row = {},
  ): Promise<string> {
    const row: Row = {
      source: 'manual',
      review_status: 'reviewed',
      type: 'invoice',
      supplier_id: supplierId,
      issue_date: '2026-10-01',
      due_date: '2026-12-31',
      due_date_source: 'manual',
      total: '100.00',
      created_by: ana.id,
      reviewed_by: ana.id,
      reviewed_at: '2026-11-01T12:00:00Z',
      ...overrides,
    };
    const columns = Object.keys(row);
    const sql = `INSERT INTO documents (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const [inserted] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...columns.map((c) => row[c]),
    );
    return inserted.id;
  }

  /** A transfer by Ana, changed by `overrides`. */
  async function insertPayment(
    supplierId: string,
    overrides: Row = {},
  ): Promise<string> {
    const row: Row = {
      supplier_id: supplierId,
      amount: '80.00',
      paid_on: '2026-11-05',
      method: 'transfer',
      created_by: ana.id,
      ...overrides,
    };
    const columns = Object.keys(row);
    const sql = `INSERT INTO payments (${columns.map((c) => `"${c}"`).join(', ')})
      VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const [inserted] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      sql,
      ...columns.map((c) => row[c]),
    );
    return inserted.id;
  }

  /** Written directly, which only spec files may do. */
  async function apply(
    documentId: string,
    source: { paymentId: string } | { creditNoteId: string },
    amount: string,
  ): Promise<void> {
    const paymentId = 'paymentId' in source ? source.paymentId : null;
    const creditNoteId = 'creditNoteId' in source ? source.creditNoteId : null;
    await prisma.$executeRaw`
      INSERT INTO applications (document_id, payment_id, credit_note_id, amount)
      VALUES (${documentId}::uuid, ${paymentId}::uuid, ${creditNoteId}::uuid, ${amount}::numeric)`;
  }

  const unreviewed = {
    review_status: 'unreviewed',
    reviewed_by: null,
    reviewed_at: null,
  };
  const creditNote = {
    type: 'credit_note',
    due_date: null,
    due_date_source: null,
  };
  const openingBalance = { type: 'opening_balance' };

  /** Fakes only `Date`, then signs in again, so the session is issued at that instant. */
  async function at(instant: string): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    session = await signIn(app, ana);
  }

  const figures = (f: {
    notDue: string;
    overdue: string;
    credit: string;
    balance: string;
  }) => ({
    notDue: f.notDue,
    overdue: f.overdue,
    credit: f.credit,
    balance: f.balance,
  });

  const ZERO = {
    notDue: '0.00',
    overdue: '0.00',
    credit: '0.00',
    balance: '0.00',
  };

  describe('Resumen', () => {
    it('shows 0.00 in all four figures for a supplier with no documents', async () => {
      const token = randomUUID();
      const id = await newSupplier(`Panadería ${token}`);
      const result = await list(`q=${token}`);
      expect(result.suppliers).toEqual([
        {
          id,
          name: `Panadería ${token}`,
          legalName: null,
          paymentTermDays: 30,
          ...ZERO,
        },
      ]);
      expect(result.totals).toEqual(ZERO);
    });

    it('finds a supplier by part of its legal name, ignoring case and accents', async () => {
      const token = randomUUID();
      const id = await newSupplier(
        `Lácteos ${randomUUID()}`,
        `Ñandú ${token} S.R.L.`,
      );
      const result = await list(
        `q=${encodeURIComponent(` NANDU ${token.toUpperCase()} `)}`,
      );
      expect(result.suppliers.map((s) => s.id)).toEqual([id]);
    });

    it('finds a supplier by part of its name, ignoring case and accents', async () => {
      const token = randomUUID();
      const id = await newSupplier(`Panadería ÑANDÚ ${token}`);
      const result = await list(
        `q=${encodeURIComponent(`panaderia ñandu ${token.slice(0, 13)}`)}`,
      );
      expect(result.suppliers.map((s) => s.id)).toEqual([id]);
    });

    it('returns no rows and zero totals when nothing matches', async () => {
      const result = await list(`q=${randomUUID()}`);
      // `errors` is global: other spec files add Error documents.
      expect(result.suppliers).toEqual([]);
      expect(result.totals).toEqual(ZERO);
      expect(result.today).toBe('2026-11-10');
      expect(Object.keys(result.errors).sort()).toEqual([
        'amount',
        'count',
        'supplierName',
      ]);
    });

    it('returns every supplier for a blank search', async () => {
      const token = randomUUID();
      const id = await newSupplier(`Panadería ${token}`);
      const result = await list(`q=${encodeURIComponent('   ')}`);
      expect(result.suppliers.map((s) => s.id)).toContain(id);
    });

    it('adds the totals up from the returned rows, column by column', async () => {
      const token = randomUUID();
      const a = await newSupplier(`A ${token}`);
      const b = await newSupplier(`B ${token}`);
      await newSupplier(`C ${token}`);
      await insertDocument(a, { total: '100.10' });
      await insertDocument(a, { total: '0.20', due_date: '2026-01-01' });
      await insertDocument(b, { total: '50.05', due_date: '2026-01-01' });
      await insertDocument(b, { ...creditNote, total: '75.00' });

      const result = await list(`q=${token}`);
      expect(result.suppliers).toHaveLength(3);
      const sum = (key: 'notDue' | 'overdue' | 'credit' | 'balance') =>
        result.suppliers
          .reduce(
            (total, row) => total.add(Money.fromString(row[key])),
            Money.fromString('0'),
          )
          .toString();
      expect(result.totals).toEqual({
        notDue: sum('notDue'),
        overdue: sum('overdue'),
        credit: sum('credit'),
        balance: sum('balance'),
      });
      expect(result.totals).toEqual({
        notDue: '100.10',
        overdue: '50.25',
        credit: '75.00',
        balance: '75.35',
      });
    });

    describe('sorting', () => {
      let token: string;
      let bigTotal: string;
      let bigOverdue: string;

      beforeAll(async () => {
        token = randomUUID();
        bigTotal = await newSupplier(`Mucho total ${token}`);
        await insertDocument(bigTotal, { total: '1000.00' });
        await insertDocument(bigTotal, {
          total: '50.00',
          due_date: '2026-01-01',
        });
        bigOverdue = await newSupplier(`Mucho vencido ${token}`);
        await insertDocument(bigOverdue, {
          total: '200.00',
          due_date: '2026-01-01',
        });
      });

      it('puts the largest Vencido first by default', async () => {
        const result = await list(`q=${token}`);
        expect(result.suppliers.map((s) => s.id)).toEqual([
          bigOverdue,
          bigTotal,
        ]);
      });

      it('puts the largest Total first with sort=total', async () => {
        const result = await list(`q=${token}&sort=total`);
        expect(result.suppliers.map((s) => s.id)).toEqual([
          bigTotal,
          bigOverdue,
        ]);
      });

      it('sorts A–Z with the Spanish collator with sort=name', async () => {
        const nameToken = randomUUID();
        for (const name of ['Oso', 'Ñandú', 'árbol', 'Abeja']) {
          await newSupplier(`${name} ${nameToken}`);
        }
        const result = await list(`q=${nameToken}&sort=name`);
        expect(result.suppliers.map((s) => s.name)).toEqual(
          ['Abeja', 'árbol', 'Ñandú', 'Oso'].map(
            (name) => `${name} ${nameToken}`,
          ),
        );
      });

      it('breaks ties by name', async () => {
        const tieToken = randomUUID();
        await newSupplier(`Zeta ${tieToken}`);
        await newSupplier(`Abeja ${tieToken}`);
        const result = await list(`q=${tieToken}`);
        expect(result.suppliers.map((s) => s.name)).toEqual([
          `Abeja ${tieToken}`,
          `Zeta ${tieToken}`,
        ]);
      });
    });

    it.each([
      ['an unknown sort', 'sort=newest'],
      ['a repeated sort', 'sort=name&sort=total'],
      ['a repeated search', 'q=a&q=b'],
    ])('returns 400 for %s', async (_, query) => {
      const res = await get(`/api/suppliers?${query}`).expect(400);
      expect(res.body).toEqual({ errors: [] });
    });
  });

  describe('status and balances', () => {
    it('uses the day in Buenos Aires: due today is Sin vencer until midnight there', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const dueThe9th = await insertDocument(supplier, {
        due_date: '2026-11-09',
      });
      const dueThe8th = await insertDocument(supplier, {
        due_date: '2026-11-08',
      });

      await at('2026-11-10T02:59:59Z');
      let docs = (await account(supplier)).documents;
      expect(docs.find((d) => d.id === dueThe9th)).toMatchObject({
        status: 'pending',
        daysToDue: 0,
      });
      expect(docs.find((d) => d.id === dueThe8th)).toMatchObject({
        status: 'overdue',
        daysToDue: -1,
      });

      await at('2026-11-10T03:00:00Z');
      docs = (await account(supplier)).documents;
      expect(docs.find((d) => d.id === dueThe9th)).toMatchObject({
        status: 'overdue',
        daysToDue: -1,
      });
    });

    it('leaves out deleted, processing and error documents, and counts unreviewed ones', async () => {
      const token = randomUUID();
      const supplier = await newSupplier(`Panadería ${token}`);
      await insertDocument(supplier, { deleted_at: '2026-11-05T12:00:00Z' });
      await insertDocument(supplier, {
        review_status: 'processing',
        reviewed_by: null,
        reviewed_at: null,
        source: 'upload',
      });
      await insertDocument(supplier, {
        review_status: 'error',
        reviewed_by: null,
        reviewed_at: null,
        source: 'upload',
      });
      const counted = await insertDocument(supplier, {
        ...unreviewed,
        total: '40.00',
      });

      const result = await account(supplier);
      expect(result.documents.map((d) => [d.id, d.reviewStatus])).toEqual([
        [counted, 'unreviewed'],
      ]);
      expect(figures(result)).toEqual({
        ...ZERO,
        notDue: '40.00',
        balance: '40.00',
      });
      expect(figures((await list(`q=${token}`)).totals)).toEqual(
        figures(result),
      );
    });

    it('subtracts a credit note, which is available', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      await insertDocument(supplier, { total: '100.00' });
      const credit = await insertDocument(supplier, {
        ...creditNote,
        total: '30.00',
      });

      const result = await account(supplier);
      expect(figures(result)).toEqual({
        notDue: '100.00',
        overdue: '0.00',
        credit: '30.00',
        balance: '70.00',
      });
      expect(result.documents.find((d) => d.id === credit)).toMatchObject({
        type: 'credit_note',
        status: 'available',
        remaining: '30.00',
        partial: false,
        dueDate: null,
        daysToDue: null,
        total: '30.00',
      });
    });

    it('gives a negative Total when the credit is larger than the debt', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      await insertDocument(supplier, { total: '30.00' });
      await insertDocument(supplier, { ...creditNote, total: '50.00' });
      expect((await account(supplier)).balance).toBe('-20.00');
    });

    it('counts an opening balance with a past due date as Vencido, and one without as Sin vencer', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const past = await insertDocument(supplier, {
        ...openingBalance,
        due_date: '2026-10-15',
        total: '500.00',
      });
      const undated = await insertDocument(supplier, {
        ...openingBalance,
        due_date: null,
        due_date_source: null,
        total: '250.00',
      });

      const result = await account(supplier);
      expect(figures(result)).toEqual({
        notDue: '250.00',
        overdue: '500.00',
        credit: '0.00',
        balance: '750.00',
      });
      expect(result.documents.find((d) => d.id === past)).toMatchObject({
        status: 'overdue',
        daysToDue: -26,
      });
      expect(result.documents.find((d) => d.id === undated)).toMatchObject({
        status: 'pending',
        dueDate: null,
        daysToDue: null,
      });
    });

    it('lists documents by due date, or issue date without one, then issue date, then creation', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const late = await insertDocument(supplier, { due_date: '2026-12-20' });
      // Issued 2026-10-01: a credit note sorts by its issue date.
      const credit = await insertDocument(supplier, creditNote);
      const middle = await insertDocument(supplier, { due_date: '2026-11-15' });
      const undated = await insertDocument(supplier, {
        ...openingBalance,
        issue_date: '2026-09-30',
        due_date: null,
        due_date_source: null,
      });
      const sameDueLaterIssue = await insertDocument(supplier, {
        issue_date: '2026-10-20',
        due_date: '2026-11-15',
      });
      const createdAfterIt = await insertDocument(supplier, {
        issue_date: '2026-10-20',
        due_date: '2026-11-15',
      });
      const early = await insertDocument(supplier, { due_date: '2026-09-29' });

      const result = await account(supplier);
      expect(result.documents.map((d) => d.id)).toEqual([
        early,
        undated,
        credit,
        middle,
        sameDueLaterIssue,
        createdAfterIt,
        late,
      ]);
    });

    it('returns the supplier fields and each document as the API documents them', async () => {
      const name = `Panadería ${randomUUID()}`;
      const { id } = await prisma.supplier.create({
        data: {
          name,
          legalName: 'El Ceibo S.R.L.',
          paymentTermDays: 30,
          notes: 'Martes',
        },
      });
      const doc = await insertDocument(id, {
        letter: 'A',
        number: '0001-00004521',
        number_normalized: '000100004521',
        issue_date: '2026-10-09',
        due_date: '2026-11-08',
        due_date_source: 'supplier_term',
        total: '86900.50',
      });

      expect(await account(id)).toEqual({
        id,
        name,
        legalName: 'El Ceibo S.R.L.',
        cuit: null,
        paymentTermDays: 30,
        notes: 'Martes',
        notDue: '0.00',
        overdue: '86900.50',
        credit: '0.00',
        balance: '86900.50',
        today: '2026-11-10',
        documents: [
          {
            id: doc,
            type: 'invoice',
            letter: 'A',
            number: '0001-00004521',
            issueDate: '2026-10-09',
            dueDate: '2026-11-08',
            total: '86900.50',
            reviewStatus: 'reviewed',
            status: 'overdue',
            remaining: '86900.50',
            partial: false,
            daysToDue: -2,
          },
        ],
        payments: [],
      });
    });

    it('gives the Buenos Aires date as today, in the list and the account', async () => {
      const token = randomUUID();
      const supplier = await newSupplier(`Panadería ${token}`);
      await at('2026-11-10T02:59:59Z');
      expect((await list(`q=${token}`)).today).toBe('2026-11-09');
      expect((await account(supplier)).today).toBe('2026-11-09');
    });

    it.each([
      ['an unknown id', randomUUID()],
      ['a non-UUID id', 'not-a-uuid'],
    ])('returns 404 for %s', async (_, id) => {
      await get(`/api/suppliers/${id}`).expect(404);
    });
  });

  describe('payments and applications', () => {
    it('shows a partly paid invoice as pending, partial, with what is left in Sin vencer', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const doc = await insertDocument(supplier, { total: '100.00' });
      await apply(
        doc,
        { paymentId: await insertPayment(supplier, { amount: '40.00' }) },
        '40.00',
      );

      const result = await account(supplier);
      expect(result.documents.find((d) => d.id === doc)).toMatchObject({
        status: 'pending',
        remaining: '60.00',
        partial: true,
      });
      expect(figures(result)).toEqual({
        notDue: '60.00',
        overdue: '0.00',
        credit: '0.00',
        balance: '60.00',
      });
    });

    it('shows a fully applied invoice due yesterday as paid, adding nothing to Vencido', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const doc = await insertDocument(supplier, {
        total: '100.00',
        due_date: '2026-11-09',
      });
      await apply(
        doc,
        { paymentId: await insertPayment(supplier, { amount: '100.00' }) },
        '100.00',
      );

      const result = await account(supplier);
      expect(result.documents.find((d) => d.id === doc)).toMatchObject({
        status: 'paid',
        remaining: '0.00',
        partial: false,
        daysToDue: -1,
      });
      expect(figures(result)).toEqual(ZERO);
      expect(result.payments.map((p) => p.status)).toEqual(['applied']);
    });

    it('adds an unapplied payment and a partly applied credit note to Crédito, and the rows still add up', async () => {
      const token = randomUUID();
      const supplier = await newSupplier(`Panadería ${token}`);
      const other = await newSupplier(`Lácteos ${token}`);
      await insertDocument(other, { total: '10.00', due_date: '2026-01-01' });
      const invoice = await insertDocument(supplier, { total: '100.00' });
      const credit = await insertDocument(supplier, {
        ...creditNote,
        total: '50.00',
      });
      await apply(invoice, { creditNoteId: credit }, '20.00');
      const payment = await insertPayment(supplier, { amount: '80.00' });

      const result = await account(supplier);
      expect(result.documents.find((d) => d.id === credit)).toMatchObject({
        status: 'available',
        remaining: '30.00',
        partial: true,
      });
      expect(result.payments).toEqual([
        {
          id: payment,
          amount: '80.00',
          paidOn: '2026-11-05',
          valueDate: null,
          method: 'transfer',
          reference: null,
          createdByName: 'Ana',
          unapplied: '80.00',
          status: 'available',
        },
      ]);
      // Sin vencer 80.00 + Vencido 0.00 − Crédito 110.00.
      expect(figures(result)).toEqual({
        notDue: '80.00',
        overdue: '0.00',
        credit: '110.00',
        balance: '-30.00',
      });

      const both = await list(`q=${token}`);
      expect(both.suppliers.find((s) => s.id === supplier)).toMatchObject(
        figures(result),
      );
      expect(both.totals).toEqual({
        notDue: '80.00',
        overdue: '10.00',
        credit: '110.00',
        balance: '-20.00',
      });
    });

    it('derives the planned example: an opening balance, two invoices, a credit note and a payment', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      const opening = await insertDocument(supplier, {
        ...openingBalance,
        issue_date: '2026-09-30',
        due_date: null,
        due_date_source: null,
        total: '40.00',
      });
      const a = await insertDocument(supplier, {
        total: '100.00',
        due_date: '2026-11-15',
      });
      const b = await insertDocument(supplier, {
        total: '50.00',
        due_date: '2026-11-20',
      });
      await insertDocument(supplier, { ...creditNote, total: '30.00' });
      await apply(
        a,
        { paymentId: await insertPayment(supplier, { amount: '100.00' }) },
        '100.00',
      );
      await apply(
        b,
        { paymentId: await insertPayment(supplier, { amount: '20.00' }) },
        '20.00',
      );
      await insertPayment(supplier, { amount: '80.00' });

      const result = await account(supplier);
      expect(figures(result)).toEqual({
        notDue: '70.00',
        overdue: '0.00',
        credit: '110.00',
        balance: '-40.00',
      });
      expect(result.documents[0].id).toBe(opening);
      expect(result.documents.find((d) => d.id === b)).toMatchObject({
        status: 'pending',
        partial: true,
        remaining: '30.00',
      });
    });

    it('counts a deleted payment nowhere, and does not list it', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      await insertPayment(supplier, { deleted_at: '2026-11-06T12:00:00Z' });

      const result = await account(supplier);
      expect(figures(result)).toEqual(ZERO);
      expect(result.payments).toEqual([]);
    });

    it('lists the account payments newest paid first, then newest created', async () => {
      const supplier = await newSupplier(`Panadería ${randomUUID()}`);
      // Created in another order than paid, so creation alone can't pass.
      const newest = await insertPayment(supplier, { paid_on: '2026-11-08' });
      const old = await insertPayment(supplier, { paid_on: '2026-10-01' });
      const first = await insertPayment(supplier, { paid_on: '2026-11-05' });
      const second = await insertPayment(supplier, { paid_on: '2026-11-05' });

      const result = await account(supplier);
      expect(result.payments.map((p) => p.id)).toEqual([
        newest,
        second,
        first,
        old,
      ]);
    });
  });
});
