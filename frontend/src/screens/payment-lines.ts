import type { PaymentDetail, PaymentSummary } from '../accounts-api'
import { formatDate } from '../format'
import { PAYMENT_METHOD_LABELS } from '../labels'

/** "Transferencia · TRF-884120 · 12/11/2026 · por Ana", plus the value date for an eCheq. */
export function paymentLine(payment: PaymentDetail): string {
  const parts = [PAYMENT_METHOD_LABELS[payment.method]]
  if (payment.reference !== null) parts.push(payment.reference)
  parts.push(formatDate(payment.paidOn), `por ${payment.createdByName}`)
  if (payment.valueDate !== null) parts.push(`cobro ${formatDate(payment.valueDate)}`)
  return parts.join(' · ')
}

/** "12/11/2026 · Transferencia · TRF-884120 · cobro 20/11/2026", leaving out what isn't set. */
export function paymentSummaryLine(payment: PaymentSummary): string {
  const parts = [formatDate(payment.paidOn), PAYMENT_METHOD_LABELS[payment.method]]
  if (payment.reference !== null) parts.push(payment.reference)
  if (payment.valueDate !== null) parts.push(`cobro ${formatDate(payment.valueDate)}`)
  return parts.join(' · ')
}
