import {
  creditNoteOutput,
  invoiceOutput,
  notADocumentOutput,
} from '../../test/extraction-outputs.js';
import { TEST_CUITS } from '../../test/test-cuits.js';
import {
  checkExtraction,
  type ExtractionCheckInput,
} from './extraction-checks.js';
import { mapExtraction } from './extraction-mapping.js';
import type { ExtractionOutput } from './prompt.js';

const [CUIT] = TEST_CUITS;
const withTerm = { resolved: true, paymentTermDays: 30 } as const;
const noTerm = { resolved: true, paymentTermDays: null } as const;
const unresolved = { resolved: false } as const;

function check(
  output: ExtractionOutput,
  supplier: ExtractionCheckInput['supplier'] = withTerm,
  duplicateNumber = false,
) {
  return checkExtraction({
    mapped: mapExtraction(output),
    supplier,
    duplicateNumber,
  });
}

const invoice = (overrides: Partial<ExtractionOutput> = {}) =>
  invoiceOutput({ supplierCuit: CUIT, ...overrides });

describe('checkExtraction', () => {
  it('gives an unsupported photo only unsupported_document', () => {
    expect(check(notADocumentOutput(), unresolved, true)).toEqual([
      'unsupported_document',
    ]);
  });

  it('gives a document no unsupported_document', () => {
    expect(check(invoice())).not.toContain('unsupported_document');
  });

  it('flags an unresolved supplier, and not a resolved one', () => {
    expect(check(invoice(), unresolved)).toEqual(['supplier_unresolved']);
    expect(check(invoice(), withTerm)).toEqual([]);
  });

  it('flags a missing total, and not a present one', () => {
    expect(check(invoice({ total: null }))).toEqual(['missing_total']);
    expect(check(invoice({ total: '1.00' }))).toEqual([]);
  });

  it('flags a missing issue date, and not a present one', () => {
    expect(check(invoice({ issueDate: null }))).toEqual(['missing_issue_date']);
    expect(check(invoice({ issueDate: '2026-01-01' }))).toEqual([]);
  });

  it.each(['invoice', 'delivery_note'] as const)(
    'flags a %s from a supplier with no term',
    (type) => {
      expect(check(invoice({ type }), noTerm)).toEqual([
        'supplier_term_missing',
      ]);
    },
  );

  it.each(['invoice', 'delivery_note'] as const)(
    "doesn't flag a %s from a supplier with a term of 0 days",
    (type) => {
      expect(
        check(invoice({ type }), { resolved: true, paymentTermDays: 0 }),
      ).toEqual([]);
    },
  );

  it("doesn't flag a credit note from a supplier with no term", () => {
    expect(check(creditNoteOutput({ supplierCuit: CUIT }), noTerm)).toEqual([]);
  });

  it('gives an unresolved supplier supplier_unresolved only, not supplier_term_missing', () => {
    expect(check(invoice(), unresolved)).toEqual(['supplier_unresolved']);
  });

  it('flags a duplicate number, and not when there is none', () => {
    expect(check(invoice(), withTerm, true)).toEqual(['duplicate_number']);
    expect(check(invoice(), withTerm, false)).toEqual([]);
  });

  it('gives several issues in the fixed order', () => {
    expect(
      check(invoice({ total: null, issueDate: null }), unresolved, true),
    ).toEqual([
      'supplier_unresolved',
      'missing_total',
      'missing_issue_date',
      'duplicate_number',
    ]);
    expect(check(invoice({ total: null }), noTerm, true)).toEqual([
      'missing_total',
      'supplier_term_missing',
      'duplicate_number',
    ]);
  });

  it('passes an invoice only when it has everything invariant 1 needs', () => {
    const mapped = mapExtraction(invoice());
    expect(
      checkExtraction({ mapped, supplier: withTerm, duplicateNumber: false }),
    ).toEqual([]);
    if (mapped.kind !== 'document') throw new Error('expected a document');
    expect(mapped.type).not.toBeNull();
    expect(mapped.issueDate).not.toBeNull();
    expect(mapped.total).not.toBeNull();
  });
});
