import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../../test/app.js';
import { Ledger, type SplitRowBody } from '../../test/ledger.js';
import type { Split } from './applications.types.js';

describe('applying existing credit', () => {
  let app: NestExpressApplication;
  let ledger: Ledger;

  beforeAll(async () => {
    app = await createTestApp();
    ledger = new Ledger(app);
    await ledger.createAna();
  });

  beforeEach(async () => {
    await ledger.signInAtNow();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  type Source = { kind: 'payment' | 'credit_note'; id: string };

  const apply = (source: Source, applications: SplitRowBody[]) =>
    ledger.post('/api/applications', { source, applications });

  async function preview(
    source: Source,
    applications: SplitRowBody[] | null,
  ): Promise<Split> {
    const res = await ledger
      .post('/api/applications/preview', { source, applications })
      .expect(200);
    return res.body as Split;
  }

  it('acceptance 5: a credit note of 30.00 on B, with 30.00 left, leaves B paid and the note applied', async () => {
    const supplier = await ledger.supplier();
    const b = await ledger.invoice(supplier, '50.00', '2026-11-20');
    await ledger.pay(supplier, '20.00', [{ documentId: b, amount: '20.00' }]);
    const note = await ledger.creditNote(supplier, '30.00');

    await apply({ kind: 'credit_note', id: note }, [
      { documentId: b, amount: '30.00' },
    ]).expect(204);

    expect(await ledger.doc(supplier, b)).toMatchObject({
      status: 'paid',
      remaining: '0.00',
    });
    expect(await ledger.doc(supplier, note)).toMatchObject({
      status: 'applied',
      remaining: '0.00',
      partial: false,
    });
    expect(await ledger.account(supplier)).toMatchObject({
      credit: '0.00',
      balance: '0.00',
    });
  });

  it('acceptance 8: 50.00 of an unapplied 80.00 payment leaves 30.00 of it as credit', async () => {
    const supplier = await ledger.supplier();
    const payment = await ledger.pay(supplier, '80.00');
    const invoice = await ledger.invoice(supplier, '50.00', '2026-11-25');

    await apply({ kind: 'payment', id: payment }, [
      { documentId: invoice, amount: '50.00' },
    ]).expect(204);

    const account = await ledger.account(supplier);
    expect(account.payments).toEqual([
      expect.objectContaining({
        id: payment,
        status: 'available',
        unapplied: '30.00',
      }),
    ]);
    expect(account).toMatchObject({ credit: '30.00', balance: '-30.00' });
    expect(account.documents.find((d) => d.id === invoice)).toMatchObject({
      status: 'paid',
    });
  });

  it('audits each application by Ana', async () => {
    const supplier = await ledger.supplier();
    const note = await ledger.creditNote(supplier, '30.00');
    const invoice = await ledger.invoice(supplier, '50.00', '2026-11-25');
    await apply({ kind: 'credit_note', id: note }, [
      { documentId: invoice, amount: '30.00' },
    ]).expect(204);
    const entries = await ledger.prisma.$queryRaw<
      { action: string; user_id: string; note: string }[]
    >`
      SELECT a.action, a.user_id, a.after->>'credit_note_id' AS note FROM audit_log a
      JOIN applications x ON x.id = a.entity_id
      WHERE a.entity = 'applications' AND x.document_id = ${invoice}::uuid`;
    expect(entries).toEqual([
      { action: 'create', user_id: ledger.ana.id, note },
    ]);
  });

  describe('a partly applied credit note', () => {
    async function partly() {
      const supplier = await ledger.supplier();
      const note = await ledger.creditNote(supplier, '50.00');
      const first = await ledger.invoice(supplier, '20.00', '2026-11-20');
      await apply({ kind: 'credit_note', id: note }, [
        { documentId: first, amount: '20.00' },
      ]).expect(204);
      return { supplier, note };
    }

    it('is available and partial with 30.00 left, and Crédito counts 30.00', async () => {
      const { supplier, note } = await partly();
      expect(await ledger.doc(supplier, note)).toMatchObject({
        status: 'available',
        partial: true,
        remaining: '30.00',
      });
      expect((await ledger.account(supplier)).credit).toBe('30.00');
    });

    it('suggests what it has left, 30.00, not its 50.00 total', async () => {
      const { supplier, note } = await partly();
      const invoice = await ledger.invoice(supplier, '100.00', '2026-11-25');
      const split = await preview({ kind: 'credit_note', id: note }, null);
      expect(split).toMatchObject({
        available: '30.00',
        applied: '30.00',
        unapplied: '0.00',
        errors: [],
      });
      expect(split.rows.map((r) => [r.documentId, r.amount])).toEqual([
        [invoice, '30.00'],
      ]);
    });
  });

  it('refuses more than the source has left with exceeds_source, and writes nothing', async () => {
    const supplier = await ledger.supplier();
    const note = await ledger.creditNote(supplier, '30.00');
    const invoice = await ledger.invoice(supplier, '50.00', '2026-11-25');
    const before = await ledger.writes(supplier);

    const res = await apply({ kind: 'credit_note', id: note }, [
      { documentId: invoice, amount: '30.01' },
    ]).expect(409);
    expect(res.body).toEqual({
      errors: [{ field: 'applications', code: 'exceeds_source' }],
    });
    expect(await ledger.writes(supplier)).toEqual(before);
  });

  it('refuses every row at zero with nothing_to_apply, in the save and the preview', async () => {
    const supplier = await ledger.supplier();
    const payment = await ledger.pay(supplier, '30.00');
    const invoice = await ledger.invoice(supplier, '50.00', '2026-11-25');
    const rows = [{ documentId: invoice, amount: '0' }];

    const res = await apply({ kind: 'payment', id: payment }, rows).expect(409);
    const errors = [{ field: 'applications', code: 'nothing_to_apply' }];
    expect(res.body).toEqual({ errors });
    expect(
      (await preview({ kind: 'payment', id: payment }, rows)).errors,
    ).toEqual(errors);
    expect(await ledger.applicationsTo([invoice])).toEqual([]);
  });

  describe('a source that cannot give', () => {
    const sources: [string, (supplier: string) => Promise<Source>][] = [
      [
        'a deleted payment',
        async (supplier) => {
          const { id } = await ledger.prisma.payment.create({
            data: {
              supplierId: supplier,
              amount: '50.00',
              paidOn: new Date('2026-11-01'),
              method: 'transfer',
              createdById: ledger.ana.id,
              deletedAt: new Date('2026-11-02T12:00:00Z'),
            },
          });
          return { kind: 'payment', id };
        },
      ],
      [
        'a credit note in error',
        async (supplier) => ({
          kind: 'credit_note',
          id: await ledger.errorDocument(supplier, 'credit_note'),
        }),
      ],
      [
        'a deleted credit note',
        async (supplier) => {
          const id = await ledger.creditNote(supplier, '50.00');
          await ledger.delete(`/api/documents/${id}`).expect(204);
          return { kind: 'credit_note', id };
        },
      ],
      [
        'an invoice sent as a credit note',
        async (supplier) => ({
          kind: 'credit_note',
          id: await ledger.invoice(supplier, '50.00', '2026-11-30'),
        }),
      ],
      [
        'an unknown id',
        () => Promise.resolve({ kind: 'payment', id: randomUUID() }),
      ],
    ];

    it.each(sources)(
      'refuses %s with not_applicable on source, in the save and the preview',
      async (_, make) => {
        const supplier = await ledger.supplier();
        const invoice = await ledger.invoice(supplier, '50.00', '2026-11-25');
        const source = await make(supplier);
        const rows = [{ documentId: invoice, amount: '10.00' }];
        const errors = [{ field: 'source', code: 'not_applicable' }];

        const res = await apply(source, rows).expect(409);
        expect(res.body).toEqual({ errors });
        expect(await preview(source, rows)).toEqual({
          available: '0.00',
          applied: '0.00',
          unapplied: '0.00',
          excess: '0.00',
          rows: [],
          errors,
        });
        expect(await ledger.applicationsTo([invoice])).toEqual([]);
      },
    );
  });

  it.each([
    ['a new_payment source', { kind: 'new_payment', id: randomUUID() }],
    [
      'a source with an extra key',
      { kind: 'payment', id: randomUUID(), amount: '1.00' },
    ],
    ['a non-UUID id', { kind: 'credit_note', id: 'nope' }],
  ])('refuses %s with 400 and no field errors', async (_, source) => {
    const res = await ledger
      .post('/api/applications', { source, applications: [] })
      .expect(400);
    expect(res.body).toEqual({ errors: [] });
  });

  describe('concurrency', () => {
    it.each([1, 2, 3, 4, 5])(
      'two applies of 40.00 at once from a credit note of 50.00: exactly one wins (run %i)',
      async () => {
        const supplier = await ledger.supplier();
        const note = await ledger.creditNote(supplier, '50.00');
        const first = await ledger.invoice(supplier, '40.00', '2026-11-20');
        const second = await ledger.invoice(supplier, '40.00', '2026-11-21');
        const source: Source = { kind: 'credit_note', id: note };

        const results = await Promise.all([
          apply(source, [{ documentId: first, amount: '40.00' }]),
          apply(source, [{ documentId: second, amount: '40.00' }]),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
        expect(results.find((r) => r.status === 409)?.body).toEqual({
          errors: [{ field: 'applications', code: 'exceeds_source' }],
        });
        expect(await ledger.doc(supplier, note)).toMatchObject({
          remaining: '10.00',
        });
        expect(
          (await ledger.applicationsTo([first, second])).map(([, a]) => a),
        ).toEqual(['40.00']);
      },
    );
  });

  describe('lock order', () => {
    /**
     * Holds a document's row lock from a third connection until `release()`.
     * Resolves once the lock is held, and rejects if the transaction fails.
     */
    async function holdLock(
      documentId: string,
    ): Promise<{ pid: number; release: () => Promise<void> }> {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: (pid: number) => void;
      const lockedPid = new Promise<number>((resolve) => {
        locked = resolve;
      });
      const transaction = ledger.prisma.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
          locked(pid);
          await released;
        },
        { timeout: 10_000 },
      );
      const pid = await Promise.race([
        lockedPid,
        transaction.then(() => {
          throw new Error('The holder ended before taking its lock.');
        }),
      ]);
      return {
        pid,
        release: async () => {
          release();
          await transaction;
        },
      };
    }

    /** Polls until at least `count` backends wait on one of `pids`, and returns them. */
    async function waitersOn(pids: number[], count: number): Promise<number[]> {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const rows = await ledger.prisma.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && ${pids}::int[]`;
        if (rows.length >= count) return rows.map((row) => row.pid);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Fewer than ${count} backends waited on ${pids.join(', ')}.`,
      );
    }

    /** Two new document ids, the lower first. */
    const twoIds = () => [randomUUID(), randomUUID()].sort();

    it('a credit note named as a row while it is being applied gets not_applicable, not a deadlock', async () => {
      const supplier = await ledger.supplier();
      const [f, nc] = twoIds();
      await ledger.insertDocument(supplier, { id: f, total: '50.00' });
      await ledger.insertDocument(supplier, {
        id: nc,
        type: 'credit_note',
        total: '30.00',
        due_date: null,
        due_date_source: null,
      });
      const holder = await holdLock(nc);

      const first = apply({ kind: 'credit_note', id: nc }, [
        { documentId: f, amount: '30.00' },
      ]).then((res) => res);
      const [firstPid] = await waitersOn([holder.pid], 1);
      const second = ledger
        .post(
          '/api/payments',
          ledger.paymentBody(supplier, '20.00', [
            { documentId: nc, amount: '10.00' },
            { documentId: f, amount: '10.00' },
          ]),
        )
        .then((res) => res);
      await waitersOn([holder.pid, firstPid], 2);
      await holder.release();

      const [applied, paid] = await Promise.all([first, second]);
      expect(applied.status).toBe(204);
      expect(paid.status).toBe(409);
      expect(paid.body).toEqual({
        errors: [{ field: `applications.${nc}`, code: 'not_applicable' }],
      });
      expect(await ledger.applicationsTo([f])).toEqual([[f, '30.00']]);
      expect((await ledger.writes(supplier)).payments).toBe(0);
    });

    it('an invoice sent as a credit-note source gets not_applicable, not a deadlock', async () => {
      const supplier = await ledger.supplier();
      const [g, f] = twoIds();
      await ledger.insertDocument(supplier, { id: g, total: '50.00' });
      await ledger.insertDocument(supplier, { id: f, total: '50.00' });
      const holder = await holdLock(f);

      const first = apply({ kind: 'credit_note', id: f }, [
        { documentId: g, amount: '10.00' },
      ]).then((res) => res);
      const [firstPid] = await waitersOn([holder.pid], 1);
      const second = ledger
        .post(
          '/api/payments',
          ledger.paymentBody(supplier, '20.00', [
            { documentId: f, amount: '10.00' },
            { documentId: g, amount: '10.00' },
          ]),
        )
        .then((res) => res);
      await waitersOn([holder.pid, firstPid], 2);
      await holder.release();

      const [applied, paid] = await Promise.all([first, second]);
      expect(applied.status).toBe(409);
      expect(applied.body).toEqual({
        errors: [{ field: 'source', code: 'not_applicable' }],
      });
      expect(paid.status).toBe(201);
      expect(await ledger.applicationsTo([g, f])).toEqual([
        [g, '10.00'],
        [f, '10.00'],
      ]);
    });
  });
});
