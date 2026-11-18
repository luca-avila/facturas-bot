// The payment-status filter on Proveedor. It only picks statuses the backend
// derived: it never looks at amounts or dates (D1).

import type { DocumentStatus } from './accounts-api'

export type PaymentFilter = 'with_balance' | 'overdue' | 'pending' | 'paid'

export const PAYMENT_FILTERS: readonly PaymentFilter[] = ['with_balance', 'overdue', 'pending', 'paid']

/** Credit notes count too: available credit has a balance, and applied credit is settled. */
export const PAYMENT_FILTER_STATUSES: Record<PaymentFilter, readonly DocumentStatus[]> = {
  with_balance: ['pending', 'overdue', 'available'],
  overdue: ['overdue'],
  pending: ['pending'],
  paid: ['paid', 'applied'],
}

export function matchesFilter(filter: PaymentFilter, status: DocumentStatus): boolean {
  return PAYMENT_FILTER_STATUSES[filter].includes(status)
}
