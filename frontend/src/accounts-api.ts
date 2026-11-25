// The supplier and document endpoints. The types mirror the backend's.

export type DocumentType = 'invoice' | 'delivery_note' | 'credit_note' | 'opening_balance'
export type DocumentSource = 'upload' | 'manual'
export type ReviewStatus = 'processing' | 'error' | 'unreviewed' | 'reviewed'
export type DueDateSource = 'supplier_term' | 'manual'
export type DebtStatus = 'pending' | 'overdue' | 'paid'
export type CreditStatus = 'available' | 'applied'
/** A `DebtStatus` for debts, a `CreditStatus` for credit notes. */
export type DocumentStatus = DebtStatus | CreditStatus
export type ReceivingType = Exclude<DocumentType, 'credit_note'>
export type PaymentMethod = 'transfer' | 'echeq' | 'cash' | 'mercado_pago' | 'other'
export type SupplierSort = 'overdue' | 'name' | 'total'
/** Every issue code, in stored order. */
export type IssueCode =
  | 'extraction_failed'
  | 'unsupported_document'
  | 'supplier_unresolved'
  | 'missing_total'
  | 'missing_issue_date'
  | 'supplier_term_missing'
  | 'duplicate_number'
export type TaxKind = 'iva' | 'iva_perception' | 'iibb_perception' | 'other'

export type FieldErrorCode =
  | 'name_required'
  | 'cuit_required'
  | 'cuit_invalid'
  | 'cuit_taken'
  | 'payment_term_invalid'
  | 'number_invalid'
  | 'issue_date_invalid'
  | 'due_date_invalid'
  | 'due_date_required'
  | 'due_date_before_issue'
  | 'total_invalid'
  | 'duplicate_number'
  | 'amount_invalid'
  | 'paid_on_invalid'
  | 'value_date_invalid'
  | 'application_amount_invalid'
  | 'exceeds_remaining'
  | 'exceeds_source'
  | 'nothing_to_apply'
  | 'not_applicable'
  | 'remaining_changed'
  | 'document_has_applications'
  | 'photo_type_invalid'
  | 'photo_repeated'
  | 'photo_in_other_document'

export interface FieldError {
  field: string
  code: FieldErrorCode
}

/** Amounts are strings with exactly two decimals, such as "0.00" or "-15000.00". */
export interface SupplierFigures {
  notDue: string
  overdue: string
  /** Positive: it's subtracted. */
  credit: string
  /** notDue + overdue − credit, negative when the supplier owes the restaurant. */
  balance: string
}

export interface SupplierListRow extends SupplierFigures {
  id: string
  name: string
  legalName: string | null
  paymentTermDays: number | null
}

export interface SupplierList {
  suppliers: SupplierListRow[]
  totals: SupplierFigures
  /** YYYY-MM-DD in Buenos Aires, the date the statuses were derived for. */
  today: string
  /** Every Error document, from the same snapshot. */
  errors: ErrorSummary
}

/** The Error warning. */
export interface ErrorSummary {
  count: number
  /** Totals of the ones that aren't credit notes. */
  amount: string
  /** Only when every one has the same known supplier. */
  supplierName: string | null
}

export interface ErrorDocumentRow {
  id: string
  type: Exclude<DocumentType, 'opening_balance'> | null
  letter: string | null
  number: string | null
  supplier: { id: string; name: string } | null
  issueDate: string | null
  total: string | null
  createdByName: string
  /** The upload date in Buenos Aires. */
  createdOn: string
  issues: IssueCode[]
}

export interface ErrorDocumentList {
  summary: ErrorSummary
  /** Oldest upload first. */
  documents: ErrorDocumentRow[]
}

export interface AccountDocument {
  id: string
  type: DocumentType
  letter: string | null
  number: string | null
  /** YYYY-MM-DD */
  issueDate: string
  dueDate: string | null
  total: string
  reviewStatus: 'unreviewed' | 'reviewed'
  status: DocumentStatus
  /** Left to pay on a debt, left to apply on a credit note. */
  remaining: string
  /** Something applied and something left. */
  partial: boolean
  /** dueDate − today, computed by the backend. Null without a due date. */
  daysToDue: number | null
}

export interface PaymentSummary {
  id: string
  amount: string
  paidOn: string
  valueDate: string | null
  method: PaymentMethod
  reference: string | null
  createdByName: string
  unapplied: string
  status: CreditStatus
}

export interface PaymentListRow extends PaymentSummary {
  supplierId: string
  supplierName: string
}

export interface PaymentList {
  /** Newest paid first. */
  payments: PaymentListRow[]
}

export interface PaymentDetail extends PaymentListRow {
  notes: string | null
  applied: string
  /** One per document, in split order. Status and remaining are as of now. */
  applications: {
    documentId: string
    type: ReceivingType
    letter: string | null
    number: string | null
    /** What this payment applied to it, across all its applications to it. */
    amount: string
    status: DebtStatus
    remaining: string
    partial: boolean
  }[]
}

export interface SplitRow {
  documentId: string
  /** Canonical, such as "20000.00"; "0" applies nothing. */
  amount: string
}

export type SplitSource =
  | { kind: 'new_payment'; supplierId: string; amount: string }
  | { kind: 'payment'; id: string }
  | { kind: 'credit_note'; id: string }

export interface SplitRequest {
  source: SplitSource
  /** Null asks for the suggestion. */
  applications: SplitRow[] | null
}

export interface SplitRowResult {
  documentId: string
  type: ReceivingType
  letter: string | null
  number: string | null
  issueDate: string
  dueDate: string | null
  daysToDue: number | null
  status: DebtStatus
  remaining: string
  amount: string
  /** As it would be after saving. */
  after: { status: DebtStatus; remaining: string; partial: boolean }
}

export interface Split {
  available: string
  applied: string
  unapplied: string
  excess: string
  rows: SplitRowResult[]
  /** What a save would refuse with. Empty when the split can be saved. */
  errors: FieldError[]
}

export interface PaymentInput {
  supplierId: string
  amount: string
  paidOn: string
  method: PaymentMethod
  reference: string | null
  /** eCheq only. */
  valueDate: string | null
  notes: string | null
  applications: SplitRow[]
}

export interface ApplyCreditInput {
  source: { kind: 'payment' | 'credit_note'; id: string }
  applications: SplitRow[]
}

export interface MarkPaidInput {
  documentId: string
  /** What the person saw as left. Refused if it's no longer exactly that. */
  amount: string
  paidOn: string
  method: PaymentMethod
  reference: string | null
  valueDate: string | null
}

export interface SupplierAccount extends SupplierFigures {
  id: string
  name: string
  legalName: string | null
  /** 11 digits, null for an informal supplier. */
  cuit: string | null
  paymentTermDays: number | null
  notes: string | null
  /** YYYY-MM-DD in Buenos Aires. */
  today: string
  documents: AccountDocument[]
  /** Newest paid first. */
  payments: PaymentSummary[]
}

export interface SupplierInput {
  name: string
  legalName: string | null
  cuit: string | null
  paymentTermDays: number | null
  notes: string | null
}

export interface DocumentInput {
  supplierId: string
  type: DocumentType
  letter: string | null
  number: string | null
  issueDate: string
  dueDate: string | null
  /** "86900.50": dot decimal, no thousands separator. */
  total: string
  notes: string | null
}

export type UploadScope = 'mine' | 'all'

export interface UploadRow {
  id: string
  reviewStatus: ReviewStatus
  pageCount: number
  /** YYYY-MM-DD and HH:MM in Buenos Aires. */
  uploadedOn: string
  uploadedTime: string
  /** Today minus uploadedOn, in Buenos Aires: 0 today, 1 yesterday. */
  daysAgo: number
  createdByName: string
  type: DocumentType | null
  letter: string | null
  number: string | null
  supplierName: string | null
  /** Canonical, such as "53600.00". */
  total: string | null
}

export interface UploadList {
  /** Newest first. */
  uploads: UploadRow[]
}

export interface DocumentDetail {
  id: string
  source: DocumentSource
  reviewStatus: ReviewStatus
  type: DocumentType | null
  letter: string | null
  number: string | null
  createdByName: string
  /** YYYY-MM-DD and HH:MM in Buenos Aires. */
  createdOn: string
  createdTime: string
  /** By position. Empty for a manual document. */
  images: { id: string; position: number }[]
  supplier: { id: string; name: string } | null
  issueDate: string | null
  dueDate: string | null
  dueDateSource: DueDateSource | null
  /** Numbers keep their column's scale, such as "4.000" or "6198.3500". */
  subtotal: string | null
  total: string | null
  cae: string | null
  notes: string | null
  /** In stored order. */
  issues: IssueCode[]
  /** By position. */
  lines: DocumentLine[]
  taxes: DocumentTax[]
}

export interface DocumentLine {
  position: number
  productCode: string | null
  description: string
  quantity: string | null
  unit: string | null
  packageText: string | null
  unitPrice: string | null
  ivaRate: string | null
  discountPct: string | null
  lineTotal: string | null
}

export interface DocumentTax {
  kind: TaxKind
  label: string
  rate: string | null
  base: string | null
  amount: string
}

/** A field error on one photo of an upload. */
export interface PageError {
  /** 0-based, in the order the photos were sent. */
  page: number
  code: FieldErrorCode
  /** The document that already has the photo, for `photo_in_other_document`. */
  documentId: string | null
}

export type UploadResult =
  | { ok: true; id: string; alreadyUploaded: boolean }
  | { ok: false; error: 'unavailable' | 'unauthorized' | 'too_large' | 'aborted' }
  | { ok: false; error: 'rejected'; pageErrors: PageError[] }

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'unavailable' | 'not_found' | 'unauthorized' }
  | { ok: false; error: 'rejected'; fieldErrors: FieldError[] }

const unauthorizedHandlers = new Set<() => void>()

/** Called on every 401, so an expired session in any screen goes back to sign-in. Returns the unsubscribe function. */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandlers.add(handler)
  return () => {
    unauthorizedHandlers.delete(handler)
  }
}

function notifyUnauthorized(): void {
  for (const handler of [...unauthorizedHandlers]) handler()
}

function fieldErrors(body: unknown): FieldError[] {
  if (typeof body !== 'object' || body === null) return []
  const { errors } = body as { errors?: unknown }
  return Array.isArray(errors) ? (errors as FieldError[]) : []
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

async function call<T>(
  url: string,
  init: RequestInit,
  read: (res: Response) => Promise<T>,
): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  if (res.status >= 200 && res.status < 300) {
    try {
      return { ok: true, value: await read(res) }
    } catch {
      return { ok: false, error: 'unavailable' }
    }
  }
  switch (res.status) {
    case 400:
    case 409:
      return { ok: false, error: 'rejected', fieldErrors: fieldErrors(await readJson(res)) }
    case 404:
      return { ok: false, error: 'not_found' }
    case 401:
      notifyUnauthorized()
      return { ok: false, error: 'unauthorized' }
    default:
      return { ok: false, error: 'unavailable' }
  }
}

const json = <T>(res: Response) => res.json() as Promise<T>
const nothing = () => Promise.resolve()

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function listSuppliers(params: { q: string; sort: SupplierSort }): Promise<ApiResult<SupplierList>> {
  const search = new URLSearchParams({ sort: params.sort })
  if (params.q.trim() !== '') search.set('q', params.q)
  return call(`/api/suppliers?${search.toString()}`, { method: 'GET' }, json<SupplierList>)
}

export function getSupplier(id: string): Promise<ApiResult<SupplierAccount>> {
  return call(`/api/suppliers/${encodeURIComponent(id)}`, { method: 'GET' }, json<SupplierAccount>)
}

export function createSupplier(input: SupplierInput): Promise<ApiResult<{ id: string }>> {
  return call('/api/suppliers', jsonBody('POST', input), json<{ id: string }>)
}

export function updateSupplier(id: string, input: SupplierInput): Promise<ApiResult<void>> {
  return call(`/api/suppliers/${encodeURIComponent(id)}`, jsonBody('PUT', input), nothing)
}

export function createDocument(input: DocumentInput): Promise<ApiResult<{ id: string }>> {
  return call('/api/documents', jsonBody('POST', input), json<{ id: string }>)
}

export function deleteDocument(id: string): Promise<ApiResult<void>> {
  return call(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }, nothing)
}

export function previewSplit(request: SplitRequest): Promise<ApiResult<Split>> {
  return call('/api/applications/preview', jsonBody('POST', request), json<Split>)
}

export function applyCredit(input: ApplyCreditInput): Promise<ApiResult<void>> {
  return call('/api/applications', jsonBody('POST', input), nothing)
}

export function createPayment(input: PaymentInput): Promise<ApiResult<{ id: string }>> {
  return call('/api/payments', jsonBody('POST', input), json<{ id: string }>)
}

export function markPaid(input: MarkPaidInput): Promise<ApiResult<{ id: string }>> {
  return call('/api/payments/mark-paid', jsonBody('POST', input), json<{ id: string }>)
}

export function listPayments(params: { supplierId: string | null }): Promise<ApiResult<PaymentList>> {
  const search = params.supplierId === null ? '' : `?${new URLSearchParams({ supplierId: params.supplierId }).toString()}`
  return call(`/api/payments${search}`, { method: 'GET' }, json<PaymentList>)
}

export function getPayment(id: string): Promise<ApiResult<PaymentDetail>> {
  return call(`/api/payments/${encodeURIComponent(id)}`, { method: 'GET' }, json<PaymentDetail>)
}

export function listUploads(scope: UploadScope): Promise<ApiResult<UploadList>> {
  return call(`/api/uploads?${new URLSearchParams({ scope }).toString()}`, { method: 'GET' }, json<UploadList>)
}

export function listErrorDocuments(): Promise<ApiResult<ErrorDocumentList>> {
  return call('/api/error-documents', { method: 'GET' }, json<ErrorDocumentList>)
}

export function getDocument(id: string): Promise<ApiResult<DocumentDetail>> {
  return call(`/api/documents/${encodeURIComponent(id)}`, { method: 'GET' }, json<DocumentDetail>)
}

/** Where an image is served, only with a session. */
export function imageUrl(id: string): string {
  return `/api/images/${encodeURIComponent(id)}`
}

const PAGE_FIELD = /^photos\.(\d+)$/

function pageErrors(body: unknown): PageError[] {
  if (typeof body !== 'object' || body === null) return []
  const { errors } = body as { errors?: unknown }
  if (!Array.isArray(errors)) return []
  return errors.flatMap((error: unknown): PageError[] => {
    if (typeof error !== 'object' || error === null) return []
    const { field, code, documentId } = error as Record<string, unknown>
    const match = typeof field === 'string' ? PAGE_FIELD.exec(field) : null
    if (match === null || typeof code !== 'string') return []
    return [
      {
        page: Number(match[1]),
        code: code as FieldErrorCode,
        documentId: typeof documentId === 'string' ? documentId : null,
      },
    ]
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function uploadResult(xhr: XMLHttpRequest): UploadResult {
  switch (xhr.status) {
    case 200:
    case 201: {
      const body = parseJson(xhr.responseText)
      if (typeof body !== 'object' || body === null) return { ok: false, error: 'unavailable' }
      const { id, alreadyUploaded } = body as Record<string, unknown>
      if (typeof id !== 'string' || typeof alreadyUploaded !== 'boolean') return { ok: false, error: 'unavailable' }
      return { ok: true, id, alreadyUploaded }
    }
    case 400:
    case 409:
      return { ok: false, error: 'rejected', pageErrors: pageErrors(parseJson(xhr.responseText)) }
    case 413:
      return { ok: false, error: 'too_large' }
    case 401:
      notifyUnauthorized()
      return { ok: false, error: 'unauthorized' }
    default:
      return { ok: false, error: 'unavailable' }
  }
}

/**
 * Sends the photos in page order. `XMLHttpRequest`, since `fetch` can't
 * report upload progress. Sending the same blobs again is safe: the backend
 * answers with the document that already has them.
 */
export function uploadPhotos(
  photos: Blob[],
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadResult> {
  const { onProgress, signal } = options
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'aborted' })
      return
    }
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    photos.forEach((photo, i) => {
      form.append('photos', photo, `pagina-${i + 1}`)
    })
    const abort = () => {
      xhr.abort()
    }
    const settle = (result: UploadResult) => {
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    })
    xhr.addEventListener('load', () => {
      settle(uploadResult(xhr))
    })
    xhr.addEventListener('error', () => {
      settle({ ok: false, error: 'unavailable' })
    })
    xhr.addEventListener('abort', () => {
      settle({ ok: false, error: 'aborted' })
    })
    signal?.addEventListener('abort', abort)
    xhr.open('POST', '/api/uploads')
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.send(form)
  })
}
