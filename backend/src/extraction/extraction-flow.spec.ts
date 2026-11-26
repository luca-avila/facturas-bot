import { randomUUID } from 'node:crypto';
import { invoiceOutput } from '../../test/extraction-outputs.js';
import { ExtractionHarness } from '../../test/extraction-harness.js';
import { EXTRACTION_FLOW_CUITS } from '../../test/test-cuits.js';
import type {
  ErrorDocumentList,
  SupplierAccount,
  SupplierList,
} from '../balances/balances.types.js';

const NOW = '2026-11-24T15:00:00.000Z';
const [CUIT] = EXTRACTION_FLOW_CUITS;

/** Acceptance 1 and 2: a new supplier's first document, then its term. */
describe('extraction flow, over HTTP and the worker', () => {
  const h = new ExtractionHarness();

  beforeAll(async () => {
    await h.start();
    await h.at(NOW);
  });

  beforeEach(async () => {
    await h.freeCuits(EXTRACTION_FLOW_CUITS);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await h.stop();
  });

  it('stops a new supplier in Error, then counts its next document once it has a term', async () => {
    const name = `Distribuidora ${randomUUID()}`;
    const first = await h.upload();
    h.fake.reply(
      invoiceOutput({
        supplierCuit: CUIT,
        supplierName: name,
        number: '0003-00000001',
      }),
    );
    await h.runOnce(first);

    const errors = (await h.get('/api/error-documents').expect(200))
      .body as ErrorDocumentList;
    expect(errors.documents.find((doc) => doc.id === first)).toMatchObject({
      issues: ['supplier_term_missing'],
      total: '50000.00',
      supplier: { name },
    });

    const suppliers = (
      await h.get(`/api/suppliers?q=${encodeURIComponent(name)}`).expect(200)
    ).body as SupplierList;
    expect(suppliers.errors.count).toBeGreaterThanOrEqual(1);
    expect(suppliers.suppliers).toEqual([
      expect.objectContaining({
        name,
        paymentTermDays: null,
        notDue: '0.00',
        overdue: '0.00',
        credit: '0.00',
        balance: '0.00',
      }),
    ]);
    const supplierId = suppliers.suppliers[0].id;

    await h
      .put(`/api/suppliers/${supplierId}`, {
        name,
        legalName: name,
        cuit: CUIT,
        paymentTermDays: 30,
        notes: null,
      })
      .expect(204);

    const second = await h.upload();
    h.fake.reply(
      invoiceOutput({
        supplierCuit: CUIT,
        supplierName: name,
        number: '0003-00000002',
        issueDate: '2026-11-02',
      }),
    );
    await h.runOnce(second);

    const doc = (await h.get(`/api/documents/${second}`).expect(200)).body as {
      reviewStatus: string;
      dueDate: string;
    };
    expect(doc).toMatchObject({
      reviewStatus: 'unreviewed',
      dueDate: '2026-12-02',
    });

    const account = (await h.get(`/api/suppliers/${supplierId}`).expect(200))
      .body as SupplierAccount;
    expect(account.documents.map((d) => d.id)).toEqual([second]);
    expect(account.notDue).toBe('50000.00');

    await h
      .post('/api/payments', {
        supplierId,
        amount: '20000.00',
        paidOn: '2026-11-24',
        method: 'transfer',
        reference: null,
        valueDate: null,
        notes: null,
        applications: [{ documentId: second, amount: '20000.00' }],
      })
      .expect(201);
    const paid = (await h.get(`/api/suppliers/${supplierId}`).expect(200))
      .body as SupplierAccount;
    expect(paid.notDue).toBe('30000.00');

    // Re-checking the first document via POST /api/suppliers/:id/term unblocks it.
    expect((await h.document(first)).review_status).toBe('error');

    const termRes = await h
      .post(`/api/suppliers/${supplierId}/term`, { paymentTermDays: 30 })
      .expect(200);
    expect(termRes.body).toMatchObject({
      paymentTermDays: 30,
      unblockedCount: 1,
    });
    expect((await h.document(first)).review_status).toBe('unreviewed');
    expect((await h.document(first)).due_date).toBe('2026-11-20');

    const afterUnblock = (
      await h.get(`/api/suppliers/${supplierId}`).expect(200)
    ).body as SupplierAccount;
    expect(afterUnblock.documents.map((d) => d.id)).toEqual([first, second]);
    expect(afterUnblock.overdue).toBe('50000.00');
    expect(afterUnblock.notDue).toBe('30000.00');
    expect(afterUnblock.balance).toBe('80000.00');
  });

  it('does not deadlock when setTerm runs alongside a processing job of the same supplier', async () => {
    const cuit = EXTRACTION_FLOW_CUITS[0];
    const name = `Concurrente ${randomUUID()}`;
    const supplierId = await h.supplier(name, cuit, null);

    const errorDoc = await h.prisma.document.create({
      data: {
        source: 'upload',
        reviewStatus: 'error',
        type: 'invoice',
        supplierId,
        letter: 'A',
        number: '0005-00000001',
        numberNormalized: '000500000001',
        issueDate: new Date('2026-10-01'),
        total: '1000.00',
        issues: [{ code: 'supplier_term_missing' }],
        createdById: h.ana.id,
      },
    });
    const processingDoc = await h.upload();
    const held = h.fake.hold(
      invoiceOutput({
        supplierCuit: cuit,
        supplierName: name,
        number: '0005-00000002',
      }),
    );
    const workerPromise = h.runOnce(processingDoc);
    await held.received;
    held.release();

    const [workerOk, termRes] = await Promise.all([
      workerPromise,
      h.post(`/api/suppliers/${supplierId}/term`, { paymentTermDays: 30 }),
    ]);
    expect(workerOk).toBe(true);
    expect(termRes.status).toBe(200);
    expect((await h.document(errorDoc.id)).review_status).toBe('unreviewed');
    expect(['unreviewed', 'error']).toContain(
      (await h.document(processingDoc)).review_status,
    );
  });
});
