import { Money } from '../common/money.js';
import type { DocumentType } from '../generated/prisma/client.js';
import type { ErrorSummary } from './balances.types.js';

export interface ErrorSummaryRow {
  type: DocumentType | null;
  total: string | null;
  supplier: { id: string; name: string } | null;
}

/**
 * The *Error* warning (decision 17). Every row counts. The amount adds the
 * totals of rows that aren't credit notes: a credit note would lower the
 * debt, not raise it. The supplier is named only when every row has the same
 * known one.
 */
export function summarizeErrors(
  rows: readonly ErrorSummaryRow[],
): ErrorSummary {
  const amount = rows.reduce(
    (sum, row) =>
      row.total === null || row.type === 'credit_note'
        ? sum
        : sum.add(Money.fromString(row.total)),
    Money.fromString('0.00'),
  );
  const supplier = rows[0]?.supplier ?? null;
  const oneSupplier =
    supplier !== null && rows.every((row) => row.supplier?.id === supplier.id);
  return {
    count: rows.length,
    amount: amount.toString(),
    supplierName: oneSupplier ? supplier.name : null,
  };
}
