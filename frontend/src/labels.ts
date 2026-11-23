// Every Spanish label for an enum or error code. Each Record is exhaustive,
// so a missing label doesn't compile.

import type {
  DocumentSource,
  DocumentStatus,
  DocumentType,
  DueDateSource,
  FieldErrorCode,
  PaymentMethod,
  ReviewStatus,
  SupplierSort,
  UploadScope,
} from './accounts-api'
import type { PaymentFilter } from './payment-filter'

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: 'Factura',
  delivery_note: 'Remito',
  credit_note: 'Nota de crédito',
  opening_balance: 'Saldo inicial',
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  processing: 'Procesando',
  error: 'Error',
  unreviewed: 'Sin revisar',
  reviewed: 'Revisado',
}

export const DOCUMENT_SOURCE_LABELS: Record<DocumentSource, string> = {
  upload: 'Subido',
  manual: 'Cargado a mano',
}

export const DUE_DATE_SOURCE_LABELS: Record<DueDateSource, string> = {
  supplier_term: 'Según el plazo del proveedor',
  manual: 'Ingresado a mano',
}

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: 'Sin vencer',
  overdue: 'Vencido',
  paid: 'Pagado',
  available: 'Disponible',
  applied: 'Aplicada',
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  transfer: 'Transferencia',
  echeq: 'eCheq',
  cash: 'Efectivo',
  mercado_pago: 'Mercado Pago',
  other: 'Otro',
}

/** The chip order, Transferencia first. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['transfer', 'echeq', 'cash', 'mercado_pago', 'other']

export const PAYMENT_FILTER_LABELS: Record<PaymentFilter, string> = {
  with_balance: 'Con saldo',
  overdue: 'Vencido',
  pending: 'Sin vencer',
  paid: 'Pagado',
}

export const SUPPLIER_SORT_LABELS: Record<SupplierSort, string> = {
  overdue: 'Vencido primero',
  name: 'A–Z',
  total: 'Mayor total',
}

export const FIELD_ERROR_MESSAGES: Record<FieldErrorCode, string> = {
  name_required: 'Ingresá el nombre.',
  cuit_required: 'Ingresá el CUIT o marcá que es un proveedor informal.',
  cuit_invalid: 'El CUIT no es válido.',
  cuit_taken: 'Ya hay un proveedor con ese CUIT.',
  payment_term_invalid: 'Ingresá un plazo de 0 a 365 días, o dejalo vacío.',
  number_invalid: 'El número tiene que tener al menos un dígito.',
  issue_date_invalid: 'Ingresá una fecha de emisión válida.',
  due_date_invalid: 'Ingresá un vencimiento válido.',
  due_date_required: 'Este proveedor no tiene plazo de pago: ingresá el vencimiento o definí el plazo.',
  due_date_before_issue: 'El vencimiento no puede ser anterior a la fecha de emisión. Revisá el año.',
  total_invalid: 'Ingresá un total mayor a cero, como 86.900,50.',
  duplicate_number: 'Ya existe un documento de este proveedor con el mismo tipo, letra y número.',
  amount_invalid: 'Ingresá un monto mayor a cero, como 120.000,00.',
  paid_on_invalid: 'Ingresá una fecha de pago válida.',
  value_date_invalid: 'Ingresá una fecha de cobro válida.',
  application_amount_invalid: 'Ingresá un monto válido, como 20.000,00, o 0 para no aplicar nada.',
  exceeds_remaining: 'Es más de lo que falta pagar de este documento.',
  exceeds_source: 'Repartiste más de lo que hay para aplicar.',
  nothing_to_apply: 'Ingresá cuánto aplicar en al menos un documento.',
  not_applicable: 'Este documento o este crédito ya no se puede usar. Volvé a abrir el reparto.',
  remaining_changed: 'Lo que falta pagar cambió mientras tanto. Volvé a abrir el documento.',
  document_has_applications: 'No se puede descartar: tiene pagos o créditos aplicados.',
  photo_type_invalid: 'Este formato no se puede subir. Sacá la foto desde la app o elegí JPG/PNG.',
  photo_repeated: 'Esta foto ya está en otra página de este documento.',
  photo_in_other_document: 'Esta foto ya está en otro documento.',
}

export const UPLOAD_SCOPE_LABELS: Record<UploadScope, string> = {
  mine: 'Mías',
  all: 'Todas',
}

/** A photo the browser couldn't compress and the backend wouldn't take as is. */
export function photoFormatMessage(format: string | null): string {
  const named = format === null ? '' : ` (${format})`
  return `Este formato no se puede subir${named}. Sacá la foto desde la app o elegí JPG/PNG.`
}

export const PHOTO_TOO_LARGE_MESSAGE = 'La imagen es demasiado grande.'
export const UPLOAD_FAILED_MESSAGE = 'No se pudo subir. Volvé a intentar.'

export const REJECTED_WITHOUT_FIELDS_MESSAGE = 'No se pudo guardar. Revisá los datos y volvé a intentar.'
export const UNAVAILABLE_MESSAGE = 'No se pudo conectar con el servidor. Volvé a intentar.'
