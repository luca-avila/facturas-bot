import {
  invoiceOutput,
  notADocumentOutput,
} from '../../test/extraction-outputs.js';
import { TEST_CUITS } from '../../test/test-cuits.js';
import { mapExtraction, type MappedExtraction } from './extraction-mapping.js';
import type { ExtractionOutput } from './prompt.js';

const [CUIT] = TEST_CUITS;
const dashed = `${CUIT.slice(0, 2)}-${CUIT.slice(2, 10)}-${CUIT.slice(10)}`;

type Document = Extract<MappedExtraction, { kind: 'document' }>;

function read(overrides: Partial<ExtractionOutput>): Document {
  const mapped = mapExtraction(invoiceOutput(overrides));
  if (mapped.kind !== 'document') throw new Error('expected a document');
  return mapped;
}

type Line = ExtractionOutput['lines'][number];
const line = (overrides: Partial<Line>): Line => ({
  ...invoiceOutput().lines[0],
  ...overrides,
});
type Tax = ExtractionOutput['taxes'][number];
const tax = (overrides: Partial<Tax>): Tax => ({
  ...invoiceOutput().taxes[0],
  ...overrides,
});

describe('mapExtraction', () => {
  it('reads a whole invoice', () => {
    const output = invoiceOutput({ supplierCuit: CUIT });
    expect(mapExtraction(output)).toEqual({
      kind: 'document',
      type: 'invoice',
      letter: 'A',
      number: '0003-00012345',
      numberNormalized: '000300012345',
      issueDate: '2026-10-21',
      supplierCuit: CUIT,
      supplierName: output.supplierName,
      subtotal: '41322.31',
      total: '50000.00',
      cae: '76543210987654',
      lines: [
        {
          position: 1,
          productCode: 'H-000',
          description: 'Harina 000',
          quantity: '4',
          unit: 'un',
          packageText: 'x 25 kg',
          unitPrice: '6198.35',
          ivaRate: '21.00',
          discountPct: null,
          lineTotal: '24793.40',
        },
        {
          position: 2,
          productCode: null,
          description: 'Aceite de girasol',
          quantity: '2.5',
          unit: 'l',
          packageText: null,
          unitPrice: '6611.564',
          ivaRate: '21',
          discountPct: null,
          lineTotal: '16528.91',
        },
      ],
      taxes: [
        {
          kind: 'iva',
          label: 'IVA 21%',
          rate: '21.00',
          base: '41322.31',
          amount: '8677.69',
        },
      ],
    });
  });

  it.each([
    ['hyphens', dashed],
    ['dots', `${CUIT.slice(0, 2)}.${CUIT.slice(2, 10)}.${CUIT.slice(10)}`],
    ['spaces', ` ${CUIT.slice(0, 2)} ${CUIT.slice(2, 10)} ${CUIT.slice(10)} `],
  ])('reads a CUIT printed with %s as its 11 digits', (_, printed) => {
    expect(read({ supplierCuit: printed }).supplierCuit).toBe(CUIT);
  });

  it('reads a CUIT with a wrong check digit, or with 10 digits, as none', () => {
    const wrong = `${CUIT.slice(0, 10)}${(Number(CUIT[10]) + 1) % 10}`;
    expect(read({ supplierCuit: wrong }).supplierCuit).toBeNull();
    expect(read({ supplierCuit: CUIT.slice(0, 10) }).supplierCuit).toBeNull();
  });

  it('reads a CUIT with letters around it as none', () => {
    expect(read({ supplierCuit: `CUIT ${CUIT}` }).supplierCuit).toBeNull();
  });

  it.each(['0.00', '-50000.00', '50000.001', 'abc'])(
    'reads a total of %s as none',
    (total) => {
      expect(read({ total }).total).toBeNull();
    },
  );

  it('reads a total written without cents as two decimals', () => {
    expect(read({ total: ' 50000 ' }).total).toBe('50000.00');
  });

  it('reads a negative subtotal as none, and keeps a subtotal of 0', () => {
    expect(read({ subtotal: '-1.00' }).subtotal).toBeNull();
    expect(read({ subtotal: '0' }).subtotal).toBe('0.00');
  });

  it.each(['21/10/2026', '2026-02-30'])(
    'reads an issue date of %s as none',
    (issueDate) => {
      expect(read({ issueDate }).issueDate).toBeNull();
    },
  );

  it('reads a number with no digits as none', () => {
    const mapped = read({ number: 's/n' });
    expect(mapped.number).toBeNull();
    expect(mapped.numberNormalized).toBeNull();
  });

  it('keeps a number as printed and normalizes it to its digits', () => {
    const mapped = read({ number: ' 0003-00012345 ' });
    expect(mapped.number).toBe('0003-00012345');
    expect(mapped.numberNormalized).toBe('000300012345');
  });

  it('reads a quantity with four decimals as none, and keeps its line', () => {
    const mapped = read({ lines: [line({ quantity: '1.2345' })] });
    expect(mapped.lines).toHaveLength(1);
    expect(mapped.lines[0].quantity).toBeNull();
    expect(mapped.lines[0].description).toBe('Harina 000');
  });

  it('reads a unit price with five decimals as none', () => {
    const mapped = read({ lines: [line({ unitPrice: '1.23456' })] });
    expect(mapped.lines[0].unitPrice).toBeNull();
  });

  it('reads a rate of 1000 as none, and keeps 999.99', () => {
    const mapped = read({
      lines: [
        line({ ivaRate: '1000', discountPct: '999.99' }),
        line({ discountPct: '10.555' }),
      ],
      taxes: [tax({ rate: '1000' })],
    });
    expect(mapped.lines[0].ivaRate).toBeNull();
    expect(mapped.lines[0].discountPct).toBe('999.99');
    expect(mapped.lines[1].discountPct).toBeNull();
    expect(mapped.taxes[0].rate).toBeNull();
  });

  it('drops a line with a blank description and numbers the rest 1, 2, 3', () => {
    const mapped = read({
      lines: [
        line({ description: 'Uno' }),
        line({ description: '   ' }),
        line({ description: 'Dos' }),
        line({ description: 'Tres' }),
      ],
    });
    expect(mapped.lines.map((l) => [l.position, l.description])).toEqual([
      [1, 'Uno'],
      [2, 'Dos'],
      [3, 'Tres'],
    ]);
  });

  it('drops a tax with no amount or a blank label', () => {
    const mapped = read({
      taxes: [
        tax({ amount: null }),
        tax({ amount: 'n/a' }),
        tax({ label: ' ' }),
        tax({ label: 'Perc. IIBB', kind: 'iibb_perception', amount: '300' }),
      ],
    });
    expect(mapped.taxes).toEqual([
      {
        kind: 'iibb_perception',
        label: 'Perc. IIBB',
        rate: '21.00',
        base: '41322.31',
        amount: '300.00',
      },
    ]);
  });

  it.each(['7654321098765', '765432109876543', '7654321098765A'])(
    'reads a CAE of %s as none',
    (cae) => {
      expect(read({ cae }).cae).toBeNull();
    },
  );

  it('reads a blank supplier name as none, and trims one', () => {
    expect(read({ supplierName: '  ' }).supplierName).toBeNull();
    expect(read({ supplierName: ' Molino Sur ' }).supplierName).toBe(
      'Molino Sur',
    );
  });

  it('reads a photo marked as not a document as unsupported, and nothing else', () => {
    expect(
      mapExtraction(invoiceOutput({ isDocument: false, supplierCuit: CUIT })),
    ).toEqual({ kind: 'unsupported' });
  });

  it('reads a photo typed other as unsupported', () => {
    expect(mapExtraction(invoiceOutput({ type: 'other' }))).toEqual({
      kind: 'unsupported',
    });
    expect(mapExtraction(notADocumentOutput())).toEqual({
      kind: 'unsupported',
    });
  });

  it('never reads the printed due date, the CAE expiry or the printed term', () => {
    const base = invoiceOutput();
    expect(
      mapExtraction({
        ...base,
        printedDueDate: '2026-11-30',
        caeDueDate: '2026-10-31',
        printedTermDays: 45,
      }),
    ).toEqual(mapExtraction(base));
  });
});
