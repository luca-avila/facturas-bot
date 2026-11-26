import { randomUUID } from 'node:crypto';
import {
  creditNoteOutput,
  invoiceOutput,
  notADocumentOutput,
} from '../../test/extraction-outputs.js';
import { ExtractionHarness } from '../../test/extraction-harness.js';
import {
  EXTRACTION_RESULT_CUITS,
  RESTAURANT_TEST_CUIT,
} from '../../test/test-cuits.js';
import { DuplicateNumberCheck } from './duplicate-number-check.js';
import type { ExtractionOutput } from './prompt.js';

const NOW = '2026-11-24T15:00:00.000Z';
const [KNOWN_CUIT, NEW_CUIT] = EXTRACTION_RESULT_CUITS;

describe('ExtractionWriter: writing the result', () => {
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
    await h.freeCuits(EXTRACTION_RESULT_CUITS);
    await h.at(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Uploads a document and runs its job once with `output`. */
  async function extract(output: ExtractionOutput): Promise<string> {
    const id = await h.upload();
    h.fake.reply(output);
    await expect(h.runOnce(id)).resolves.toBe(true);
    return id;
  }

  const known = (term: number | null = 30) =>
    h.supplier(`Molino ${randomUUID()}`, KNOWN_CUIT, term);

  const suppliersWith = (cuit: string) =>
    h.prisma.supplier.findMany({ where: { cuit } });

  const codes = async (id: string) =>
    (await h.document(id)).issues.map((issue) => issue.code);

  describe('a known supplier with a term', () => {
    it('lands in Sin revisar, due by the term, with everything read', async () => {
      const supplierId = await known(30);
      const output = invoiceOutput({ supplierCuit: KNOWN_CUIT });
      const id = await extract(output);

      expect(await h.document(id)).toMatchObject({
        review_status: 'unreviewed',
        type: 'invoice',
        supplier_id: supplierId,
        letter: 'A',
        number: '0003-00012345',
        issue_date: '2026-10-21',
        due_date: '2026-11-20',
        due_date_source: 'supplier_term',
        subtotal: '41322.31',
        total: '50000.00',
        cae: '76543210987654',
        issues: [],
      });
      expect(await h.lines(id)).toEqual([
        {
          position: 1,
          description: 'Harina 000',
          quantity: '4.000',
          unit_price: '6198.3500',
          line_total: '24793.40',
        },
        {
          position: 2,
          description: 'Aceite de girasol',
          quantity: '2.500',
          unit_price: '6611.5640',
          line_total: '16528.91',
        },
      ]);
      expect(await h.taxes(id)).toEqual([
        { kind: 'iva', label: 'IVA 21%', amount: '8677.69' },
      ]);
      expect(await h.workerEntries(id)).toEqual([
        {
          entity: 'documents',
          action: 'update',
          user_id: null,
          before_status: 'processing',
          after_status: 'unreviewed',
        },
      ]);
      expect(await h.job(id)).toMatchObject({
        status: 'succeeded',
        raw_output: output,
        locked_until: null,
      });
    });

    it('ignores the printed due date and the CAE expiry', async () => {
      await known(30);
      const id = await extract(
        invoiceOutput({
          supplierCuit: KNOWN_CUIT,
          printedDueDate: '2026-11-05',
          caeDueDate: '2026-10-31',
          printedTermDays: 15,
        }),
      );
      expect(await h.document(id)).toMatchObject({
        due_date: '2026-11-20',
        due_date_source: 'supplier_term',
      });
    });
  });

  describe('a new supplier', () => {
    it('creates it from a valid CUIT and a printed name, and stops in Error for its term', async () => {
      const name = `Distribuidora ${randomUUID()}`;
      const id = await extract(
        invoiceOutput({ supplierCuit: NEW_CUIT, supplierName: ` ${name} ` }),
      );

      const [supplier] = await suppliersWith(NEW_CUIT);
      expect(supplier).toMatchObject({
        name,
        legalName: name,
        cuit: NEW_CUIT,
        paymentTermDays: null,
      });
      expect(await h.workerEntries(supplier.id)).toEqual([
        {
          entity: 'suppliers',
          action: 'create',
          user_id: null,
          before_status: null,
          after_status: null,
        },
      ]);
      expect(await h.document(id)).toMatchObject({
        review_status: 'error',
        supplier_id: supplier.id,
        due_date: null,
        issues: [{ code: 'supplier_term_missing' }],
      });
    });

    it('gives supplier_unresolved for a new CUIT with no name, and creates nothing', async () => {
      const id = await extract(
        invoiceOutput({ supplierCuit: NEW_CUIT, supplierName: null }),
      );
      expect(await codes(id)).toEqual(['supplier_unresolved']);
      expect(await suppliersWith(NEW_CUIT)).toEqual([]);
      expect((await h.document(id)).supplier_id).toBeNull();
    });
  });

  it("gives supplier_unresolved for the restaurant's own CUIT, and no supplier has it", async () => {
    const id = await extract(
      invoiceOutput({ supplierCuit: RESTAURANT_TEST_CUIT }),
    );
    expect(await codes(id)).toEqual(['supplier_unresolved']);
    expect(await suppliersWith(RESTAURANT_TEST_CUIT)).toEqual([]);
  });

  it.each([
    [
      'a wrong check digit',
      `${KNOWN_CUIT.slice(0, 10)}${(Number(KNOWN_CUIT[10]) + 1) % 10}`,
    ],
    ['no CUIT', null],
  ])('gives supplier_unresolved for %s', async (_, supplierCuit) => {
    await known(30);
    const id = await extract(invoiceOutput({ supplierCuit }));
    expect(await codes(id)).toEqual(['supplier_unresolved']);
  });

  it('gives supplier_term_missing to a delivery note from a known supplier with no term', async () => {
    await known(null);
    const id = await extract(
      invoiceOutput({
        supplierCuit: KNOWN_CUIT,
        type: 'delivery_note',
        letter: 'X',
      }),
    );
    expect(await codes(id)).toEqual(['supplier_term_missing']);
  });

  describe('credit notes', () => {
    it('lands in Sin revisar with no due date, from a known supplier with a term', async () => {
      await known(30);
      const id = await extract(creditNoteOutput({ supplierCuit: KNOWN_CUIT }));
      expect(await h.document(id)).toMatchObject({
        review_status: 'unreviewed',
        type: 'credit_note',
        due_date: null,
        due_date_source: null,
        issues: [],
      });
    });

    it('lands in Sin revisar from a new supplier too (question 14)', async () => {
      const id = await extract(creditNoteOutput({ supplierCuit: NEW_CUIT }));
      const [supplier] = await suppliersWith(NEW_CUIT);
      expect(await h.document(id)).toMatchObject({
        review_status: 'unreviewed',
        supplier_id: supplier.id,
        issues: [],
      });
    });
  });

  describe('missing values', () => {
    it('gives missing_total for a missing total', async () => {
      await known(30);
      const id = await extract(
        invoiceOutput({ supplierCuit: KNOWN_CUIT, total: null }),
      );
      expect(await codes(id)).toEqual(['missing_total']);
    });

    it('gives missing_issue_date and no due date for a missing issue date', async () => {
      await known(30);
      const id = await extract(
        invoiceOutput({ supplierCuit: KNOWN_CUIT, issueDate: null }),
      );
      expect(await codes(id)).toEqual(['missing_issue_date']);
      expect((await h.document(id)).due_date).toBeNull();
    });

    it('gives three codes in order with both missing and an unresolved supplier', async () => {
      const id = await extract(
        invoiceOutput({ supplierCuit: null, total: null, issueDate: null }),
      );
      expect(await codes(id)).toEqual([
        'supplier_unresolved',
        'missing_total',
        'missing_issue_date',
      ]);
    });
  });

  describe('a photo that is not a document', () => {
    it('gives Error with unsupported_document only, and nothing read', async () => {
      const id = await extract(notADocumentOutput());
      expect(await h.document(id)).toMatchObject({
        review_status: 'error',
        type: null,
        supplier_id: null,
        total: null,
        issues: [{ code: 'unsupported_document' }],
      });
      expect(await h.lines(id)).toEqual([]);
      expect(await h.taxes(id)).toEqual([]);
    });

    it('creates no supplier, even when the output carries a CUIT and a name', async () => {
      const id = await extract(
        invoiceOutput({ isDocument: false, supplierCuit: NEW_CUIT }),
      );
      expect(await codes(id)).toEqual(['unsupported_document']);
      expect(await suppliersWith(NEW_CUIT)).toEqual([]);
      expect(await h.lines(id)).toEqual([]);
    });
  });

  describe('the same number', () => {
    /** A counted invoice of the known supplier, extracted first. */
    async function first(overrides: Partial<ExtractionOutput> = {}) {
      return extract(invoiceOutput({ supplierCuit: KNOWN_CUIT, ...overrides }));
    }

    it('gives duplicate_number for the same supplier, type, letter and number as a document in Sin revisar', async () => {
      await known(30);
      await first();
      h.advance(1000);
      const id = await first();
      expect(await codes(id)).toEqual(['duplicate_number']);
    });

    it('is still a duplicate written with other separators', async () => {
      await known(30);
      await first();
      h.advance(1000);
      const id = await first({ number: '0003 00012345' });
      expect(await codes(id)).toEqual(['duplicate_number']);
    });

    it('is still a duplicate when neither has a letter', async () => {
      await known(30);
      await first({ letter: null });
      h.advance(1000);
      const id = await first({ letter: null });
      expect(await codes(id)).toEqual(['duplicate_number']);
    });

    it('is no duplicate when the other document is deleted', async () => {
      await known(30);
      const other = await first();
      await h.delete(`/api/documents/${other}`).expect(204);
      const id = await first();
      expect(await codes(id)).toEqual([]);
    });

    it('is no duplicate when the other document is in Error', async () => {
      await known(30);
      await first({ issueDate: null });
      const id = await first();
      expect(await codes(id)).toEqual([]);
    });

    it('is no duplicate with another type', async () => {
      await known(30);
      await first({ type: 'delivery_note' });
      const id = await first();
      expect(await codes(id)).toEqual([]);
    });

    it('is no duplicate from another supplier', async () => {
      await known(30);
      await h.supplier(`Otro ${randomUUID()}`, NEW_CUIT, 30);
      await first({ supplierCuit: NEW_CUIT });
      const id = await first();
      expect(await codes(id)).toEqual([]);
    });

    it('is no duplicate with another letter', async () => {
      await known(30);
      await first({ letter: 'B' });
      const id = await first();
      expect(await codes(id)).toEqual([]);
    });
  });

  describe('a duplicate only the index catches', () => {
    beforeEach(async () => {
      await h.newWorker((builder) =>
        builder
          .overrideProvider(DuplicateNumberCheck)
          .useValue({ exists: () => Promise.resolve(false) }),
      );
    });

    it('still ends in Error with duplicate_number, and the attempt succeeded', async () => {
      await known(30);
      await extract(invoiceOutput({ supplierCuit: KNOWN_CUIT }));
      const id = await extract(invoiceOutput({ supplierCuit: KNOWN_CUIT }));
      expect(await codes(id)).toEqual(['duplicate_number']);
      expect(await h.job(id)).toMatchObject({
        status: 'succeeded',
        attempts: 1,
      });
      expect(await h.workerEntries(id)).toHaveLength(1);
    });
  });

  it('leaves one set of lines and taxes when a job runs twice', async () => {
    await known(30);
    const id = await extract(invoiceOutput({ supplierCuit: KNOWN_CUIT }));
    await h.prisma.$executeRaw`
      UPDATE documents SET review_status = 'processing' WHERE id = ${id}::uuid`;
    // raw_output is written once (the extraction_jobs_keep_raw_output
    // trigger), so a requeued job couldn't store a second one: the second
    // run gets a fresh job row instead.
    await h.prisma
      .$executeRaw`DELETE FROM extraction_jobs WHERE document_id = ${id}::uuid`;
    await h.prisma.$executeRaw`
      INSERT INTO extraction_jobs (document_id, status, attempts, run_after)
      VALUES (${id}::uuid, 'queued', 0, ${new Date(NOW)})`;

    const fewer = invoiceOutput({ supplierCuit: KNOWN_CUIT });
    h.fake.reply({ ...fewer, lines: [fewer.lines[1]] });
    await h.runOnce(id);
    expect((await h.lines(id)).map((l) => [l.position, l.description])).toEqual(
      [[1, 'Aceite de girasol']],
    );
    expect(await h.taxes(id)).toHaveLength(1);
  });
});
