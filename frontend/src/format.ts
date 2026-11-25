// String work only: the frontend never turns an amount into a number (D1).

import type { DocumentType, ErrorSummary } from './accounts-api'
import { DOCUMENT_TYPE_LABELS } from './labels'

const NBSP = ' '
const MINUS = '−'
const CANONICAL_AMOUNT = /^(-?)(\d+)\.(\d{2})$/

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** "599280.50" → "$ 599.280,50", "-15000.00" → "− $ 15.000,00". Throws on anything else. */
export function formatMoney(amount: string): string {
  const match = CANONICAL_AMOUNT.exec(amount)
  if (!match) throw new Error(`Not an amount: "${amount}"`)
  const [, sign, integer, cents] = match
  const formatted = `$${NBSP}${groupThousands(integer)},${cents}`
  return sign === '-' ? `${MINUS}${NBSP}${formatted}` : formatted
}

/** "86900.50" → "86.900,50", "0.00" → "0,00", to prefill an amount input. Throws on anything else. */
export function formatAmountInput(amount: string): string {
  const match = CANONICAL_AMOUNT.exec(amount)
  if (!match) throw new Error(`Not an amount: "${amount}"`)
  const [, sign, integer, cents] = match
  return `${sign}${groupThousands(integer)},${cents}`
}

/** A credit is shown subtracted: "30.00" → "− $ 30,00", and "0.00" → "$ 0,00". */
export function formatCredit(amount: string): string {
  return amount === '0.00' ? formatMoney(amount) : `${MINUS}${NBSP}${formatMoney(amount)}`
}

const TYPED_AMOUNT = /^\s*\$?\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*$/

/**
 * An amount typed in Argentine format, such as "86.900,50" or "$ 1.500", as
 * the canonical string ("86900.50", "1500"), or null. It checks the shape
 * only: the backend checks the size and the sign.
 */
export function parseAmountInput(text: string): string | null {
  const match = TYPED_AMOUNT.exec(text)
  if (!match) return null
  const [, integer, decimals] = match
  const digits = integer.replace(/\./g, '')
  return decimals === undefined ? digits : `${digits}.${decimals}`
}

/** "2026-10-01" → "01/10/2026". */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** Days to the due date, as the backend computed them: 0 → "hoy", 8 → "en 8 días", -1 → "hace 1 día". */
export function formatDueIn(daysToDue: number): string {
  if (daysToDue === 0) return 'hoy'
  const days = Math.abs(daysToDue)
  const unit = days === 1 ? 'día' : 'días'
  return daysToDue > 0 ? `en ${days} ${unit}` : `hace ${days} ${unit}`
}

/** "30000000015" → "30-00000001-5". */
export function formatCuit(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
}

/** "Factura A 0003-00012345", "Remito s/n", or "Saldo inicial". */
export function documentTitle(doc: { type: DocumentType; letter: string | null; number: string | null }): string {
  if (doc.type === 'opening_balance') return DOCUMENT_TYPE_LABELS.opening_balance
  return [DOCUMENT_TYPE_LABELS[doc.type], doc.letter, doc.number ?? 's/n'].filter((part) => part !== null).join(' ')
}

/** 1 → "1 página", 2 → "2 páginas". */
export function formatPageCount(n: number): string {
  return n === 1 ? '1 página' : `${n} páginas`
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * A decimal string as the backend sends it, with at least `minDecimals`
 * decimals and no trailing zeros past them: "4.000", 0 → "4"; "2.500", 0 →
 * "2,5"; "6198.3500", 2 → "6.198,35". Throws on anything else.
 */
export function formatDecimal(value: string, minDecimals: number): string {
  const match = DECIMAL.exec(value)
  if (!match) throw new Error(`Not a decimal: "${value}"`)
  const [, sign, integer, fraction = ''] = match
  let decimals = fraction.replace(/0+$/, '')
  if (decimals.length < minDecimals) decimals = fraction.slice(0, minDecimals).padEnd(minDecimals, '0')
  const formatted = decimals === '' ? groupThousands(integer) : `${groupThousands(integer)},${decimals}`
  return sign === '-' ? `${MINUS}${formatted}` : formatted
}

/** The Resumen warning about Error documents. */
export function errorBanner(summary: ErrorSummary): { title: string; detail: string } {
  const one = summary.count === 1
  const documents = one ? '1 documento' : `${summary.count} documentos`
  const title =
    summary.supplierName === null
      ? `${documents} con error`
      : `${documents} de ${summary.supplierName} con error`
  const included = one ? 'está incluido' : 'están incluidos'
  const detail =
    summary.amount === '0.00'
      ? `No ${included} en el saldo.`
      : `por ${formatMoney(summary.amount)} no ${included} en el saldo.`
  return { title, detail }
}
