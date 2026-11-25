import { randomUUID } from 'node:crypto';
import type { ExtractionOutput } from '../src/extraction/prompt.js';

/**
 * Model outputs with invented data. Amounts add up: two lines make the
 * subtotal, and IVA 21% on it makes the total. There's no supplier CUIT by
 * default: each spec file passes one from its own group in `test-cuits.ts`.
 */
export function invoiceOutput(
  overrides: Partial<ExtractionOutput> = {},
): ExtractionOutput {
  return {
    isDocument: true,
    type: 'invoice',
    letter: 'A',
    number: '0003-00012345',
    issueDate: '2026-10-21',
    supplierCuit: null,
    supplierName: `Distribuidora ${randomUUID()}`,
    recipientCuit: null,
    subtotal: '41322.31',
    taxes: [
      {
        kind: 'iva',
        label: 'IVA 21%',
        rate: '21.00',
        base: '41322.31',
        amount: '8677.69',
      },
    ],
    total: '50000.00',
    cae: '76543210987654',
    caeDueDate: null,
    printedDueDate: null,
    printedTermDays: null,
    lines: [
      {
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
    ...overrides,
  };
}

/** A credit note, with no lines. */
export function creditNoteOutput(
  overrides: Partial<ExtractionOutput> = {},
): ExtractionOutput {
  return invoiceOutput({
    type: 'credit_note',
    number: '0003-00000077',
    subtotal: '8264.46',
    taxes: [
      {
        kind: 'iva',
        label: 'IVA 21%',
        rate: '21.00',
        base: '8264.46',
        amount: '1735.54',
      },
    ],
    total: '10000.00',
    lines: [],
    ...overrides,
  });
}

/** A photo that isn't a document. */
export function notADocumentOutput(
  overrides: Partial<ExtractionOutput> = {},
): ExtractionOutput {
  return {
    isDocument: false,
    type: 'other',
    letter: null,
    number: null,
    issueDate: null,
    supplierCuit: null,
    supplierName: null,
    recipientCuit: null,
    subtotal: null,
    taxes: [],
    total: null,
    cae: null,
    caeDueDate: null,
    printedDueDate: null,
    printedTermDays: null,
    lines: [],
    ...overrides,
  };
}
