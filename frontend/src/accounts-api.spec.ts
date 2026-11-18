import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyCredit,
  createDocument,
  createPayment,
  getPayment,
  listPayments,
  markPaid,
  previewSplit,
  createSupplier,
  deleteDocument,
  getSupplier,
  listSuppliers,
  onUnauthorized,
  updateSupplier,
  type ApplyCreditInput,
  type DocumentInput,
  type MarkPaidInput,
  type PaymentInput,
  type SplitRequest,
  type SupplierInput,
} from './accounts-api'

function respond(status: number, body?: unknown) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function failToConnect() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const id = 'a1626f92-16b7-4ef8-a762-7bd31048aa4f'

const supplierInput: SupplierInput = {
  name: 'Panadería El Ceibo',
  legalName: 'El Ceibo S.R.L.',
  cuit: '30000000015',
  paymentTermDays: 30,
  notes: null,
}

const documentInput: DocumentInput = {
  supplierId: id,
  type: 'invoice',
  letter: 'A',
  number: '0001-00004521',
  issueDate: '2026-10-09',
  dueDate: null,
  total: '86900.50',
  notes: null,
}

const splitRequest: SplitRequest = {
  source: { kind: 'new_payment', supplierId: id, amount: '120.00' },
  applications: null,
}

const paymentInput: PaymentInput = {
  supplierId: id,
  amount: '120.00',
  paidOn: '2026-11-09',
  method: 'echeq',
  reference: '00012345',
  valueDate: '2026-12-01',
  notes: null,
  applications: [{ documentId: id, amount: '100.00' }],
}

const applyCreditInput: ApplyCreditInput = {
  source: { kind: 'credit_note', id },
  applications: [{ documentId: id, amount: '30.00' }],
}

const markPaidInput: MarkPaidInput = {
  documentId: id,
  amount: '64380.00',
  paidOn: '2026-11-09',
  method: 'transfer',
  reference: null,
  valueDate: null,
}

const withJson = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('requests', () => {
  it.each([
    ['listSuppliers', () => listSuppliers({ q: 'ceibo', sort: 'name' }), '/api/suppliers?sort=name&q=ceibo', { method: 'GET' }],
    ['getSupplier', () => getSupplier(id), `/api/suppliers/${id}`, { method: 'GET' }],
    ['createSupplier', () => createSupplier(supplierInput), '/api/suppliers', withJson('POST', supplierInput)],
    ['updateSupplier', () => updateSupplier(id, supplierInput), `/api/suppliers/${id}`, withJson('PUT', supplierInput)],
    ['createDocument', () => createDocument(documentInput), '/api/documents', withJson('POST', documentInput)],
    ['deleteDocument', () => deleteDocument(id), `/api/documents/${id}`, { method: 'DELETE' }],
    ['previewSplit', () => previewSplit(splitRequest), '/api/applications/preview', withJson('POST', splitRequest)],
    ['applyCredit', () => applyCredit(applyCreditInput), '/api/applications', withJson('POST', applyCreditInput)],
    ['createPayment', () => createPayment(paymentInput), '/api/payments', withJson('POST', paymentInput)],
    ['markPaid', () => markPaid(markPaidInput), '/api/payments/mark-paid', withJson('POST', markPaidInput)],
    ['listPayments', () => listPayments({ supplierId: id }), `/api/payments?supplierId=${id}`, { method: 'GET' }],
    ['getPayment', () => getPayment(id), `/api/payments/${id}`, { method: 'GET' }],
  ])('%s calls the right URL and method', async (_, call, url, init) => {
    const fetch = respond(200, {})
    await call()
    expect(fetch).toHaveBeenCalledWith(url, init)
  })

  it('listPayments leaves out a null supplierId', async () => {
    const fetch = respond(200, { payments: [] })
    await listPayments({ supplierId: null })
    expect(fetch).toHaveBeenCalledWith('/api/payments', { method: 'GET' })
  })

  it.each(['', '   '])('listSuppliers leaves out a blank q (%j)', async (q) => {
    const fetch = respond(200, {})
    await listSuppliers({ q, sort: 'overdue' })
    expect(fetch).toHaveBeenCalledWith('/api/suppliers?sort=overdue', { method: 'GET' })
  })

  it('listSuppliers encodes the search', async () => {
    const fetch = respond(200, {})
    await listSuppliers({ q: 'Ñandú & Cía', sort: 'total' })
    expect(fetch.mock.calls[0][0]).toBe('/api/suppliers?sort=total&q=%C3%91and%C3%BA+%26+C%C3%ADa')
  })
})

describe('responses', () => {
  const list = {
    suppliers: [],
    totals: { notDue: '0.00', overdue: '0.00', credit: '0.00', balance: '0.00' },
    today: '2026-11-09',
  }

  it('gives the value on 200', async () => {
    respond(200, list)
    expect(await listSuppliers({ q: '', sort: 'overdue' })).toEqual({ ok: true, value: list })
  })

  it('gives the id on 201', async () => {
    respond(201, { id })
    expect(await createSupplier(supplierInput)).toEqual({ ok: true, value: { id } })
  })

  it('gives undefined on 204', async () => {
    respond(204)
    expect(await deleteDocument(id)).toEqual({ ok: true, value: undefined })
  })

  it.each([400, 409])('gives rejected with the errors on %i', async (status) => {
    const errors = [{ field: 'cuit', code: 'cuit_taken' }]
    respond(status, { errors })
    expect(await updateSupplier(id, supplierInput)).toEqual({ ok: false, error: 'rejected', fieldErrors: errors })
  })

  it('gives rejected with no field errors for an empty list, or a body without one', async () => {
    respond(400, { errors: [] })
    expect(await createDocument(documentInput)).toEqual({ ok: false, error: 'rejected', fieldErrors: [] })
    respond(400, { message: 'Bad Request' })
    expect(await createDocument(documentInput)).toEqual({ ok: false, error: 'rejected', fieldErrors: [] })
  })

  it.each([
    ['previewSplit', () => previewSplit(splitRequest)],
    ['createPayment', () => createPayment(paymentInput)],
    ['applyCredit', () => applyCredit(applyCreditInput)],
    ['markPaid', () => markPaid(markPaidInput)],
  ])('%s gives rejected with the errors on 409', async (_, call) => {
    const errors = [{ field: 'amount', code: 'remaining_changed' }]
    respond(409, { errors })
    expect(await call()).toEqual({ ok: false, error: 'rejected', fieldErrors: errors })
  })

  it('applyCredit gives undefined on 204', async () => {
    respond(204)
    expect(await applyCredit(applyCreditInput)).toEqual({ ok: true, value: undefined })
  })

  it('getPayment gives not_found on 404, and unavailable on 500', async () => {
    respond(404)
    expect(await getPayment(id)).toEqual({ ok: false, error: 'not_found' })
    respond(500)
    expect(await getPayment(id)).toEqual({ ok: false, error: 'unavailable' })
  })

  it('gives not_found on 404', async () => {
    respond(404)
    expect(await getSupplier(id)).toEqual({ ok: false, error: 'not_found' })
  })

  it.each([500, 502])('gives unavailable on %i', async (status) => {
    respond(status)
    expect(await getSupplier(id)).toEqual({ ok: false, error: 'unavailable' })
  })

  it('gives unavailable when fetch rejects', async () => {
    failToConnect()
    expect(await createDocument(documentInput)).toEqual({ ok: false, error: 'unavailable' })
  })

  it('gives unavailable when a 200 body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>', { status: 200 }))),
    )
    expect(await getSupplier(id)).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('unauthorized', () => {
  it('gives unauthorized on 401 and calls the registered handler', async () => {
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)
    respond(401)
    expect(await getSupplier(id)).toEqual({ ok: false, error: 'unauthorized' })
    expect(handler).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("doesn't call a handler once it's unsubscribed", async () => {
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)
    unsubscribe()
    respond(401)
    expect(await listSuppliers({ q: '', sort: 'overdue' })).toEqual({ ok: false, error: 'unauthorized' })
    expect(handler).not.toHaveBeenCalled()
  })

  it("doesn't call the handler on other statuses", async () => {
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)
    respond(404)
    await getSupplier(id)
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })
})
