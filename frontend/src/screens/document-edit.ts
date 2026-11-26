import type {
  DocumentDetail,
  DocumentSource,
  DocumentType,
  DueDateSource,
  FieldErrorCode,
  UpdateDocumentInput,
} from '../accounts-api'
import { formatAmountInput, parseAmountInput } from '../format'

export interface DocumentEditValues {
  supplierId: string
  type: DocumentType
  letter: string
  number: string
  issueDate: string
  dueDate: string
  dueDateSource: DueDateSource | null
  subtotal: string
  total: string
  notes: string
}

const UPLOAD_TYPES: readonly DocumentType[] = ['invoice', 'delivery_note', 'credit_note']
const MANUAL_TYPES: readonly DocumentType[] = ['invoice', 'delivery_note', 'credit_note', 'opening_balance']

export function allowedTypesForSource(source: DocumentSource): readonly DocumentType[] {
  return source === 'upload' ? UPLOAD_TYPES : MANUAL_TYPES
}

/** True when payments or credits are applied, locking supplier, type, and min total. */
export function isAppliedLocked(doc: DocumentDetail): boolean {
  return doc.appliedAmount !== '0.00'
}

export function initialDueDateSource(doc: DocumentDetail, type: DocumentType): DueDateSource | null {
  if (type === 'credit_note') return null
  if (type === 'opening_balance') return doc.dueDate !== null ? 'manual' : null
  if (doc.dueDateSource !== null) return doc.dueDateSource
  return doc.supplier?.paymentTermDays !== null && doc.supplier?.paymentTermDays !== undefined ? 'supplier_term' : null
}

export function initialEditValues(doc: DocumentDetail): DocumentEditValues {
  const type: DocumentType = doc.type ?? 'invoice'
  return {
    supplierId: doc.supplier?.id ?? '',
    type,
    letter: doc.letter ?? '',
    number: doc.number ?? '',
    issueDate: doc.issueDate ?? '',
    dueDate: doc.dueDate ?? '',
    dueDateSource: initialDueDateSource(doc, type),
    subtotal: doc.subtotal === null ? '' : formatAmountInput(doc.subtotal),
    total: doc.total === null ? '' : formatAmountInput(doc.total),
    notes: doc.notes ?? '',
  }
}

export function isEditDirty(doc: DocumentDetail, values: DocumentEditValues): boolean {
  const initial = initialEditValues(doc)
  return (
    values.supplierId !== initial.supplierId ||
    values.type !== initial.type ||
    values.letter !== initial.letter ||
    values.number !== initial.number ||
    values.issueDate !== initial.issueDate ||
    values.dueDate !== initial.dueDate ||
    values.dueDateSource !== initial.dueDateSource ||
    values.subtotal !== initial.subtotal ||
    values.total !== initial.total ||
    values.notes !== initial.notes
  )
}

export type PayloadResult =
  | { ok: true; input: UpdateDocumentInput }
  | { ok: false; field: 'subtotal' | 'total'; code: FieldErrorCode }

export function buildUpdatePayload(values: DocumentEditValues): PayloadResult {
  let subtotal: string | null = null
  if (values.type !== 'opening_balance' && values.subtotal.trim() !== '') {
    subtotal = parseAmountInput(values.subtotal)
    if (subtotal === null) {
      return { ok: false, field: 'subtotal', code: 'subtotal_invalid' }
    }
  }

  const total = parseAmountInput(values.total)
  if (total === null) {
    return { ok: false, field: 'total', code: 'total_invalid' }
  }

  const trimmedNotes = values.notes.trim()
  const notes = trimmedNotes === '' ? null : values.notes
  const supplierId = values.supplierId.trim() === '' ? null : values.supplierId

  if (values.type === 'opening_balance') {
    const dueDate = values.dueDate.trim() === '' ? null : values.dueDate
    return {
      ok: true,
      input: {
        supplierId,
        type: 'opening_balance',
        letter: null,
        number: null,
        issueDate: values.issueDate,
        dueDate,
        dueDateSource: dueDate === null ? null : 'manual',
        subtotal: null,
        total,
        notes,
      },
    }
  }

  const letter = values.letter === '' ? null : values.letter
  const number = values.number.trim() === '' ? null : values.number

  if (values.type === 'credit_note') {
    return {
      ok: true,
      input: {
        supplierId,
        type: 'credit_note',
        letter,
        number,
        issueDate: values.issueDate,
        dueDate: null,
        dueDateSource: null,
        subtotal,
        total,
        notes,
      },
    }
  }

  const dueDateSource = values.dueDateSource
  const dueDate = dueDateSource === 'manual' ? (values.dueDate.trim() === '' ? null : values.dueDate) : null

  return {
    ok: true,
    input: {
      supplierId,
      type: values.type,
      letter,
      number,
      issueDate: values.issueDate,
      dueDate,
      dueDateSource,
      subtotal,
      total,
      notes,
    },
  }
}
