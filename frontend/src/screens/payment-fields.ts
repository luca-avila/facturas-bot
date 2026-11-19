import type { PaymentMethod } from '../accounts-api'

export interface PaymentFieldValues {
  method: PaymentMethod
  paidOn: string
  reference: string
  valueDate: string
}

/** Transferencia preselected, and *Fecha de pago* today as the backend gave it. */
export function initialPaymentFields(today: string): PaymentFieldValues {
  return { method: 'transfer', paidOn: today, reference: '', valueDate: '' }
}

/** The value date to send: only for an eCheq, and null when empty. */
export function valueDateFor(values: PaymentFieldValues): string | null {
  return values.method === 'echeq' && values.valueDate !== '' ? values.valueDate : null
}
