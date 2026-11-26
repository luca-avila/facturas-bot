import { isValidCuit } from '../common/cuit.js';
import { isIsoDate } from '../common/dates.js';
import { Money } from '../common/money.js';
import { normalizeNumber } from '../documents/document-number.js';
import type { ExtractionOutput } from './prompt.js';

export interface MappedLine {
  /** 1..n, in printed order. */
  position: number;
  productCode: string | null;
  description: string;
  /** Fits `numeric(14,3)`. */
  quantity: string | null;
  unit: string | null;
  packageText: string | null;
  /** Fits `numeric(16,4)`. */
  unitPrice: string | null;
  /** 0 to 999.99, two decimals at most. */
  ivaRate: string | null;
  discountPct: string | null;
  /** Money.toString(). */
  lineTotal: string | null;
}

export interface MappedTax {
  kind: 'iva' | 'iva_perception' | 'iibb_perception' | 'other';
  label: string;
  rate: string | null;
  base: string | null;
  amount: string;
}

export type MappedExtraction =
  | { kind: 'unsupported' }
  | {
      kind: 'document';
      type: 'invoice' | 'delivery_note' | 'credit_note';
      letter: 'A' | 'B' | 'C' | 'M' | 'X' | null;
      /** Trimmed, as printed. */
      number: string | null;
      /** normalizeNumber(number). */
      numberNormalized: string | null;
      /** YYYY-MM-DD. */
      issueDate: string | null;
      /** 11 digits with a valid check digit. */
      supplierCuit: string | null;
      /** Trimmed, never blank. */
      supplierName: string | null;
      /** 11 digits with a valid check digit, or null when missing/invalid. */
      recipientCuit: string | null;
      /** Money.toString(), never negative. */
      subtotal: string | null;
      /** Money.toString(), positive. */
      total: string | null;
      /** 14 digits. */
      cae: string | null;
      lines: MappedLine[];
      taxes: MappedTax[];
    };

const QUANTITY = /^-?\d{1,11}(\.\d{1,3})?$/;
const UNIT_PRICE = /^-?\d{1,12}(\.\d{1,4})?$/;
const RATE = /^\d{1,3}(\.\d{1,2})?$/;
const CAE = /^\d{14}$/;

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function matching(value: string | null, pattern: RegExp): string | null {
  const trimmed = text(value);
  return trimmed !== null && pattern.test(trimmed) ? trimmed : null;
}

function money(value: string | null): Money | null {
  const trimmed = text(value);
  if (trimmed === null) return null;
  try {
    return Money.fromString(trimmed);
  } catch {
    return null;
  }
}

function cuit(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/[\s.-]/g, '');
  return isValidCuit(digits) ? digits : null;
}

/**
 * What was read, fitted to the columns (decision 10). Anything that doesn't
 * fit becomes null, never an error. The printed due date, the CAE expiry and
 * the printed term are never read: `due_date` only comes from the supplier's
 * term (D4).
 */
export function mapExtraction(output: ExtractionOutput): MappedExtraction {
  if (!output.isDocument || output.type === 'other') {
    return { kind: 'unsupported' };
  }

  const number = text(output.number);
  const numberNormalized = number === null ? null : normalizeNumber(number);
  const issueDate = text(output.issueDate);
  const subtotal = money(output.subtotal);
  const total = money(output.total);

  const lines = output.lines
    .filter((line) => text(line.description) !== null)
    .map((line, i): MappedLine => ({
      position: i + 1,
      productCode: text(line.productCode),
      description: line.description.trim(),
      quantity: matching(line.quantity, QUANTITY),
      unit: text(line.unit),
      packageText: text(line.packageText),
      unitPrice: matching(line.unitPrice, UNIT_PRICE),
      ivaRate: matching(line.ivaRate, RATE),
      discountPct: matching(line.discountPct, RATE),
      lineTotal: money(line.lineTotal)?.toString() ?? null,
    }));

  const taxes = output.taxes.flatMap((tax): MappedTax[] => {
    const label = text(tax.label);
    const amount = money(tax.amount);
    if (label === null || amount === null) return [];
    return [
      {
        kind: tax.kind,
        label,
        rate: matching(tax.rate, RATE),
        base: money(tax.base)?.toString() ?? null,
        amount: amount.toString(),
      },
    ];
  });

  return {
    kind: 'document',
    type: output.type,
    letter: output.letter,
    number: numberNormalized === null ? null : number,
    numberNormalized,
    issueDate: issueDate !== null && isIsoDate(issueDate) ? issueDate : null,
    supplierCuit: cuit(output.supplierCuit),
    supplierName: text(output.supplierName),
    recipientCuit: cuit(output.recipientCuit),
    subtotal:
      subtotal !== null && subtotal.compare(Money.fromString('0.00')) >= 0
        ? subtotal.toString()
        : null,
    total: total?.isPositive() ? total.toString() : null,
    cae: matching(output.cae, CAE),
    lines,
    taxes,
  };
}
