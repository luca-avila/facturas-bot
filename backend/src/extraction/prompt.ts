import { z } from 'zod/v4';

/**
 * Everything E4 covers, in one file: the prompt, the schema, the effort and
 * `max_tokens`. Changing any of it after merge bumps `PROMPT_VERSION`, so each
 * stored result can be traced to what produced it.
 */
export const PROMPT_VERSION = '1';

/** Chosen from the levels that passed every sample in the extraction test (system-design.md). */
export const EXTRACTION_EFFORT: ExtractionEffort = 'medium';

export type ExtractionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Thinking counts toward it, so a long invoice isn't cut off. */
export const MAX_TOKENS = 16_000;

export const PROMPT = `These photos are the pages of one document that a restaurant in Argentina received from a supplier, in page order. Read it and fill in the schema.

- Copy what is printed. When a field isn't printed, can't be read, or you aren't sure, use null. Never guess, and never work out a value that isn't printed.
- Amounts are decimal strings with a dot for decimals and no thousands separator or currency sign. Argentine documents print "1.234,50", which is "1234.50". Amounts are positive, also on a credit note.
- Dates are YYYY-MM-DD. Printed dates are day/month/year, so 03/11/2026 is "2026-11-03".
- The supplier is the issuer, in the header. The restaurant is the customer. Several CUITs can appear on the page: never put the customer's CUIT in supplierCuit.
- A factura A can print several "Neto" lines, one per IVA rate, such as 10.5% and 21%. The subtotal is the sum of all the Neto lines. Each IVA line is a separate tax, with its own Neto as its base.
- "Per. IVA" and "Per. IIBB <jurisdiction>" are perceptions, not IVA. Extract each one as its own tax, even when it is 0.00. They add to the total: total = sum of the Netos + sum of the IVA lines + sum of the perceptions.
- The CAE expiry date (Fecha de Vto. de CAE, Vto. CAE) is not a payment due date. It goes in caeDueDate only.
- Ignore handwriting, stamps, highlighter, and text showing through from the back of the page or from another page.
- If the photos don't show an invoice, a delivery note or a credit note, set isDocument to false and type to "other", leave every other field null and the lists empty.`;

// No .int(), .regex() or .min(): parse() throws on a value that breaks the
// schema, so one odd field would fail the whole attempt. The mapping checks
// values instead.
const decimal = (what: string) =>
  z
    .string()
    .nullable()
    .describe(
      `${what}, as a decimal string such as "1234.50". Null if it isn't printed or can't be read.`,
    );
const date = (what: string) =>
  z
    .string()
    .nullable()
    .describe(
      `${what}, as YYYY-MM-DD. Null if it isn't printed or can't be read.`,
    );

export const EXTRACTION_SCHEMA = z.object({
  isDocument: z
    .boolean()
    .describe(
      'True only if the photos show an invoice (factura), a delivery note (remito) or a credit note (nota de crédito).',
    ),
  type: z
    .enum(['invoice', 'delivery_note', 'credit_note', 'other'])
    .describe(
      'factura: invoice. remito: delivery_note. nota de crédito: credit_note. Anything else, including a nota de débito, a presupuesto or a recibo: other.',
    ),
  letter: z
    .enum(['A', 'B', 'C', 'M', 'X'])
    .nullable()
    .describe('The large letter in the box at the top.'),
  number: z
    .string()
    .nullable()
    .describe(
      'The document number as printed, with its point of sale, such as "0003-00012345".',
    ),
  issueDate: date('The issue date (fecha de emisión)'),
  supplierCuit: z
    .string()
    .nullable()
    .describe("The issuer's CUIT, from the header, as printed."),
  supplierName: z
    .string()
    .nullable()
    .describe("The issuer's business name (razón social), as printed."),
  recipientCuit: z
    .string()
    .nullable()
    .describe("The customer's CUIT (Señor/es, Cliente), as printed."),
  subtotal: decimal('The amount before taxes'),
  taxes: z
    .array(
      z.object({
        kind: z
          .enum(['iva', 'iva_perception', 'iibb_perception', 'other'])
          .describe(
            'iva: IVA at one rate. iva_perception: percepción de IVA. iibb_perception: percepción de Ingresos Brutos. other: any other tax.',
          ),
        label: z.string().describe('The tax as printed, such as "IVA 21%".'),
        rate: decimal('The rate as a percentage, such as "21.00"'),
        base: decimal('The amount the tax applies to'),
        amount: decimal('The tax amount'),
      }),
    )
    .describe(
      'Each tax amount printed with the totals, one per row. Empty if there are none.',
    ),
  total: decimal(
    'The final total. On a delivery note with no total, its declared or insured value',
  ),
  cae: z.string().nullable().describe('The CAE number, as printed.'),
  caeDueDate: date(
    'The CAE expiry (Fecha de Vto. de CAE). It is not a payment due date',
  ),
  printedDueDate: date(
    'A payment due date printed as such (Vencimiento, Fecha de vencimiento del pago). Never the CAE expiry',
  ),
  printedTermDays: z
    .number()
    .nullable()
    .describe(
      'The payment term in days, if printed, such as 30 for "30 días". Null otherwise.',
    ),
  lines: z
    .array(
      z.object({
        productCode: z
          .string()
          .nullable()
          .describe('The item code, if printed.'),
        description: z.string().describe('The item description, as printed.'),
        quantity: decimal('The quantity'),
        unit: z.string().nullable().describe('The unit, such as "kg" or "un".'),
        packageText: z
          .string()
          .nullable()
          .describe(
            'The packaging, as printed, such as "x 25 kg" or "caja x 12".',
          ),
        unitPrice: decimal('The unit price'),
        ivaRate: decimal('The IVA rate as a percentage'),
        discountPct: decimal('The discount as a percentage'),
        lineTotal: decimal('The line total'),
      }),
    )
    .describe(
      'The item rows, in printed order, without the subtotal, tax or total rows. Empty if there are none.',
    ),
});

export type ExtractionOutput = z.infer<typeof EXTRACTION_SCHEMA>;
