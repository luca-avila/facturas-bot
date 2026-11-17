// Every Spanish label for an enum or error code. Each Record is exhaustive,
// so a missing label doesn't compile.

import type {
  DocumentSource,
  DocumentStatus,
  DocumentType,
  DueDateSource,
  FieldErrorCode,
  ReviewStatus,
  SupplierSort,
} from './accounts-api'

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
  total_invalid: 'Ingresá un total mayor a cero, como 86.900,50.',
  duplicate_number: 'Ya existe un documento de este proveedor con el mismo tipo, letra y número.',
}

export const REJECTED_WITHOUT_FIELDS_MESSAGE = 'No se pudo guardar. Revisá los datos y volvé a intentar.'
export const UNAVAILABLE_MESSAGE = 'No se pudo conectar con el servidor. Volvé a intentar.'
