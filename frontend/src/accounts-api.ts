// The supplier and document endpoints. The types mirror the backend's.

export type DocumentType = 'invoice' | 'delivery_note' | 'credit_note' | 'opening_balance'
export type DocumentSource = 'upload' | 'manual'
export type ReviewStatus = 'processing' | 'error' | 'unreviewed' | 'reviewed'
export type DueDateSource = 'supplier_term' | 'manual'
export type DocumentStatus = 'pending' | 'overdue'
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
  /** Null for credit notes. */
  status: DocumentStatus | null
  /** dueDate − today, computed by the backend. Null without a due date. */
  daysToDue: number | null
}

export interface SupplierAccount extends SupplierFigures {
  id: string
  name: string
  legalName: string | null
  /** 11 digits, null for an informal supplier. */
  cuit: string | null
  paymentTermDays: number | null
  notes: string | null
  documents: AccountDocument[]
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
