// Helpers for screen tests (`*.spec.tsx`), which run in jsdom. Not imported by the app.
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { vi } from 'vitest'
import type {
  DocumentDetail,
  ErrorDocumentRow,
  ErrorSummary,
  SupplierFigures,
  SupplierList,
  SupplierListRow,
} from '../accounts-api'

export interface Reply {
  status: number
  body?: unknown
}

/** Answers one request, given its parsed JSON body. */
export type Handler = (body: unknown) => Reply

/** 200 with `body`, or 204 without one. */
export function ok(body?: unknown): Reply {
  return body === undefined ? { status: 204 } : { status: 200, body }
}

/**
 * Replaces `fetch` with a backend made of `routes`, keyed by method and path,
 * such as "GET /api/suppliers", ignoring the query string. Handlers can share
 * state, so a save changes what the next read returns. A request no route
 * answers gets a 500 and logs console.error, which fails the test.
 */
export function stubApi(routes: Record<string, Handler>) {
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url, 'http://localhost').pathname
    const handler = routes[`${method} ${path}`]
    if (handler === undefined) {
      console.error(`No stubbed route for ${method} ${path}`)
      return Promise.resolve(new Response(null, { status: 500 }))
    }
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const reply = handler(body)
    return Promise.resolve(
      reply.body === undefined
        ? new Response(null, { status: reply.status })
        : Response.json(reply.body, { status: reply.status }),
    )
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** Renders `element` at `path`, matched by `route`, so it reads its params as in the app. */
export function renderAt(element: ReactElement, route: string, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  )
}

const NO_FIGURES: SupplierFigures = { notDue: '0.00', overdue: '0.00', credit: '0.00', balance: '0.00' }
const NO_ERRORS: ErrorSummary = { count: 0, amount: '0.00', supplierName: null }

export function supplierRow(supplier: Pick<SupplierListRow, 'id' | 'name' | 'paymentTermDays'>): SupplierListRow {
  return { legalName: null, ...NO_FIGURES, ...supplier }
}

export function supplierList(suppliers: SupplierListRow[]): SupplierList {
  return { suppliers, totals: NO_FIGURES, today: '2026-11-26', errors: NO_ERRORS }
}

/** An unreviewed invoice from an upload, with no supplier and no photos. */
export function documentDetail(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: 'doc-1',
    source: 'upload',
    reviewStatus: 'unreviewed',
    type: 'invoice',
    letter: 'A',
    number: '0001-00000123',
    createdByName: 'Ana',
    createdOn: '2026-11-02',
    createdTime: '10:15',
    reviewedByName: null,
    reviewedOn: null,
    reviewedTime: null,
    images: [],
    supplier: null,
    issueDate: '2026-11-02',
    dueDate: null,
    dueDateSource: null,
    subtotal: null,
    total: '1000.00',
    appliedAmount: '0.00',
    suggestedTermDays: null,
    cae: null,
    notes: null,
    issues: [],
    lines: [],
    taxes: [],
    ...overrides,
  }
}

/** A row of *A resolver*: an invoice with the given issues. */
export function errorRow(overrides: Partial<ErrorDocumentRow> & Pick<ErrorDocumentRow, 'id' | 'issues'>): ErrorDocumentRow {
  return {
    type: 'invoice',
    letter: 'A',
    number: null,
    supplier: null,
    issueDate: '2026-11-02',
    total: '1000.00',
    createdByName: 'Ana',
    createdOn: '2026-11-02',
    suggestedTermDays: null,
    ...overrides,
  }
}
