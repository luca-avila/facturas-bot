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
  /** In split order. Status and remaining are as of now. */
  applications: {
    documentId: string
    type: ReceivingType
    letter: string | null
    number: string | null
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
      for (const handler of [...unauthorizedHandlers]) handler()
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
