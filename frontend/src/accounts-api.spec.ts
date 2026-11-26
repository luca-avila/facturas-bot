import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyCredit,
  createDocument,
  createPayment,
  getDocument,
  getPayment,
  imageUrl,
  listPayments,
  listUploads,
  markPaid,
  previewSplit,
  previewSupplierTerm,
  retryDocument,
  reviewDocument,
  setSupplierTerm,
  createSupplier,
  deleteDocument,
  getSupplier,
  listSuppliers,
  onUnauthorized,
  updateDocument,
  updateSupplier,
  uploadPhotos,
  type ApplyCreditInput,
  type DocumentInput,
  type MarkPaidInput,
  type PaymentInput,
  type SplitRequest,
  type SupplierInput,
  type UpdateDocumentInput,
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

const updateDocumentInput: UpdateDocumentInput = {
  supplierId: id,
  type: 'invoice',
  letter: 'A',
  number: '0001-00004521',
  issueDate: '2026-10-09',
  dueDate: null,
  dueDateSource: 'supplier_term',
  subtotal: '71818.60',
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
    ['listUploads', () => listUploads('mine'), '/api/uploads?scope=mine', { method: 'GET' }],
    ['getDocument', () => getDocument(id), `/api/documents/${id}`, { method: 'GET' }],
    ['updateDocument', () => updateDocument(id, updateDocumentInput), `/api/documents/${id}`, withJson('PUT', updateDocumentInput)],
    ['reviewDocument', () => reviewDocument(id), `/api/documents/${id}/review`, withJson('POST', {})],
    ['retryDocument', () => retryDocument(id), `/api/documents/${id}/retry`, withJson('POST', {})],
    [
      'previewSupplierTerm',
      () => previewSupplierTerm(id, 30),
      `/api/suppliers/${id}/term/preview`,
      withJson('POST', { paymentTermDays: 30 }),
    ],
    [
      'setSupplierTerm',
      () => setSupplierTerm(id, 30),
      `/api/suppliers/${id}/term`,
      withJson('POST', { paymentTermDays: 30 }),
    ],
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

describe('imageUrl', () => {
  it('encodes the id', () => {
    expect(imageUrl(id)).toBe(`/api/images/${id}`)
    expect(imageUrl('a/../b')).toBe('/api/images/a%2F..%2Fb')
  })
})

/** Records what `uploadPhotos` does, and lets a test answer like the browser would. */
class FakeXhr extends EventTarget {
  static last: FakeXhr | null = null
  readonly upload = new EventTarget()
  opened: [string, string] | null = null
  headers: Record<string, string> = {}
  body: FormData | null = null
  aborted = false
  status = 0
  responseText = ''

  constructor() {
    super()
    FakeXhr.last = this
  }

  open(method: string, url: string) {
    this.opened = [method, url]
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  send(body: FormData) {
    this.body = body
  }

  abort() {
    this.aborted = true
    this.dispatchEvent(new Event('abort'))
  }

  respond(status: number, body?: unknown) {
    this.status = status
    this.responseText = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    this.dispatchEvent(new Event('load'))
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.dispatchEvent(Object.assign(new Event('progress'), { loaded, total, lengthComputable }))
  }
}

describe('uploadPhotos', () => {
  const photos = [new Blob(['pagina uno'], { type: 'image/jpeg' }), new Blob(['pagina dos'], { type: 'image/jpeg' })]

  function start(options?: Parameters<typeof uploadPhotos>[1]) {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.last = null
    const result = uploadPhotos(photos, options)
    const xhr = FakeXhr.last as FakeXhr | null
    if (xhr === null) throw new Error('No request was made.')
    return { result, xhr }
  }

  it('POSTs the photos in order to /api/uploads, with the header', async () => {
    const { xhr } = start()
    expect(xhr.opened).toEqual(['POST', '/api/uploads'])
    expect(xhr.headers).toEqual({ 'X-Requested-With': 'XMLHttpRequest' })
    const entries = xhr.body?.getAll('photos') ?? []
    expect(entries.map((entry) => (entry as File).name)).toEqual(['pagina-1', 'pagina-2'])
    expect(await Promise.all(entries.map((entry) => (entry as File).text()))).toEqual(['pagina uno', 'pagina dos'])
    expect([...(xhr.body?.keys() ?? [])]).toEqual(['photos', 'photos'])
  })

  it('reports progress fractions, only when the length is known', () => {
    const onProgress = vi.fn()
    const { xhr } = start({ onProgress })
    xhr.progress(25, 100)
    xhr.progress(10, 100, false)
    xhr.progress(100, 100)
    expect(onProgress.mock.calls).toEqual([[0.25], [1]])
  })

  it.each([
    [201, false],
    [200, true],
  ])('maps %i to alreadyUploaded %s', async (status, alreadyUploaded) => {
    const { result, xhr } = start()
    xhr.respond(status, { id, alreadyUploaded })
    expect(await result).toEqual({ ok: true, id, alreadyUploaded })
  })

  it('gives unavailable when a 201 body is not what it should be', async () => {
    const { result, xhr } = start()
    xhr.respond(201, '<html>')
    expect(await result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('maps a 409 to page errors with their index and document', async () => {
    const { result, xhr } = start()
    xhr.respond(409, {
      errors: [
        { field: 'photos.1', code: 'photo_in_other_document', documentId: id },
        { field: 'photos.12', code: 'photo_in_other_document', documentId: id },
        { field: 'scope', code: 'photo_repeated' },
      ],
    })
    expect(await result).toEqual({
      ok: false,
      error: 'rejected',
      pageErrors: [
        { page: 1, code: 'photo_in_other_document', documentId: id },
        { page: 12, code: 'photo_in_other_document', documentId: id },
      ],
    })
  })

  it('maps a 400 page error with no document to a null documentId', async () => {
    const { result, xhr } = start()
    xhr.respond(400, { errors: [{ field: 'photos.0', code: 'photo_type_invalid' }] })
    expect(await result).toEqual({
      ok: false,
      error: 'rejected',
      pageErrors: [{ page: 0, code: 'photo_type_invalid', documentId: null }],
    })
  })

  it.each([
    ['an empty list', { errors: [] }],
    ['a body without one', { message: 'Too many files', statusCode: 400 }],
    ['a field that is no page', { errors: [{ field: 'xphotos.0', code: 'photo_repeated' }] }],
    ['a field under a page', { errors: [{ field: 'photos.0.name', code: 'photo_repeated' }] }],
  ])('gives no page errors on a 400 with %s', async (_, body) => {
    const { result, xhr } = start()
    xhr.respond(400, body)
    expect(await result).toEqual({ ok: false, error: 'rejected', pageErrors: [] })
  })

  it('maps 413 to too_large', async () => {
    const { result, xhr } = start()
    xhr.respond(413)
    expect(await result).toEqual({ ok: false, error: 'too_large' })
  })

  it('maps 401 to unauthorized, and calls the handler', async () => {
    const handler = vi.fn()
    const unsubscribe = onUnauthorized(handler)
    const { result, xhr } = start()
    xhr.respond(401)
    expect(await result).toEqual({ ok: false, error: 'unauthorized' })
    expect(handler).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('maps another status to unavailable', async () => {
    const { result, xhr } = start()
    xhr.respond(502)
    expect(await result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('maps a network error to unavailable', async () => {
    const { result, xhr } = start()
    xhr.dispatchEvent(new Event('error'))
    expect(await result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('aborts the request when the signal aborts', async () => {
    const controller = new AbortController()
    const { result, xhr } = start({ signal: controller.signal })
    controller.abort()
    expect(xhr.aborted).toBe(true)
    expect(await result).toEqual({ ok: false, error: 'aborted' })
  })
})
