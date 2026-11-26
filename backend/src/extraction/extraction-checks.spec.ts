import {
  creditNoteOutput,
  invoiceOutput,
  notADocumentOutput,
} from '../../test/extraction-outputs.js';
import { RESTAURANT_TEST_CUIT, TEST_CUITS } from '../../test/test-cuits.js';
import {
  checkExtraction,
  type ExtractionCheckInput,
} from './extraction-checks.js';
import { mapExtraction } from './extraction-mapping.js';
import type { ExtractionOutput } from './prompt.js';

const [CUIT, OTHER_CUIT] = TEST_CUITS;
const withTerm = { resolved: true, paymentTermDays: 30 } as const;
const noTerm = { resolved: true, paymentTermDays: null } as const;
const unresolved = { resolved: false } as const;

function check(
  output: ExtractionOutput,
  supplier: ExtractionCheckInput['supplier'] = withTerm,
  duplicateNumber = false,
  duplicateSuspected = false,
  restaurantCuit = RESTAURANT_TEST_CUIT,
) {
  return checkExtraction({
    mapped: mapExtraction(output),
    supplier,
    duplicateNumber,
    duplicateSuspected,
    restaurantCuit,
  });
}

const invoice = (overrides: Partial<ExtractionOutput> = {}) =>
  invoiceOutput({ supplierCuit: CUIT, ...overrides });

describe('checkExtraction', () => {
  it('gives an unsupported photo only unsupported_document', () => {
    expect(check(notADocumentOutput(), unresolved, true, true)).toEqual([
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
    expect(
      check(
        invoice({
          subtotal: null,
          taxes: [],
          lines: [],
          total: '1.00',
        }),
      ),
    ).toEqual([]);
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

  it('flags duplicate_suspected, totals_mismatch, lines_mismatch, and wrong_recipient', () => {
    expect(check(invoice(), withTerm, false, true)).toEqual([
      'duplicate_suspected',
    ]);
    expect(check(invoice({ total: '50005.00' }))).toEqual(['totals_mismatch']);
    expect(
      check(
        invoice({
          lines: [
            { ...invoice().lines[0], lineTotal: '10000.00' },
            { ...invoice().lines[1], lineTotal: '10000.00' },
          ],
        }),
      ),
    ).toEqual(['lines_mismatch']);
    expect(check(invoice({ recipientCuit: OTHER_CUIT }))).toEqual([
      'wrong_recipient',
    ]);
    expect(check(invoice({ recipientCuit: RESTAURANT_TEST_CUIT }))).toEqual([]);
    expect(check(invoice({ recipientCuit: null }))).toEqual([]);
  });

  it('gives several blocking and acceptable issues in the fixed order', () => {
    expect(
      check(
        invoice({
          total: null,
          issueDate: null,
          recipientCuit: OTHER_CUIT,
          lines: [{ ...invoice().lines[0], lineTotal: '100.00' }],
        }),
        unresolved,
        true,
        true,
      ),
    ).toEqual([
      'supplier_unresolved',
      'missing_total',
      'missing_issue_date',
      'duplicate_number',
      'duplicate_suspected',
      'lines_mismatch',
      'wrong_recipient',
    ]);
    expect(
      check(
        invoice({
          total: '50010.00',
          recipientCuit: OTHER_CUIT,
          lines: [{ ...invoice().lines[0], lineTotal: '100.00' }],
        }),
        noTerm,
        true,
        true,
      ),
    ).toEqual([
      'supplier_term_missing',
      'duplicate_number',
      'duplicate_suspected',
      'totals_mismatch',
      'lines_mismatch',
      'wrong_recipient',
    ]);
  });

  it('passes an invoice only when it has everything invariant 1 needs', () => {
    const mapped = mapExtraction(invoice());
    expect(
      checkExtraction({
        mapped,
        supplier: withTerm,
        duplicateNumber: false,
        duplicateSuspected: false,
        restaurantCuit: RESTAURANT_TEST_CUIT,
      }),
    ).toEqual([]);
    if (mapped.kind !== 'document') throw new Error('expected a document');
    expect(mapped.type).not.toBeNull();
    expect(mapped.issueDate).not.toBeNull();
    expect(mapped.total).not.toBeNull();
  });
});
