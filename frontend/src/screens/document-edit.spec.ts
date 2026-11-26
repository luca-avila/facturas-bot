import { describe, expect, it } from 'vitest'
import type { DocumentDetail } from '../accounts-api'
import {
  allowedTypesForSource,
  buildUpdatePayload,
  initialEditValues,
  isAppliedLocked,
  isEditDirty,
} from './document-edit'

function makeDoc(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: 'd1',
    source: 'upload',
    reviewStatus: 'unreviewed',
    type: 'invoice',
    letter: 'A',
    number: '0001-00001234',
    createdByName: 'Ana',
    createdOn: '2026-11-01',
    createdTime: '10:00',
    reviewedByName: null,
    reviewedOn: null,
    reviewedTime: null,
    images: [{ id: 'img1', position: 1 }],
    supplier: { id: 's1', name: 'Proveedor 1', paymentTermDays: 30 },
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    dueDateSource: 'supplier_term',
    subtotal: '1000.00',
    total: '1210.00',
    appliedAmount: '0.00',
    suggestedTermDays: null,
    cae: '1234',
    notes: null,
    issues: [],
    acceptedIssues: [],
    suspectedDuplicate: null,
    consistencySummary: { taxSum: null, subtotalPlusTaxes: null, lineTotalSum: null },
    lines: [],
    taxes: [],
    ...overrides,
  }
}

describe('document-edit helpers', () => {
  it('detects dirty state accurately and resets when values match initial', () => {
    const doc = makeDoc()
    const values = initialEditValues(doc)
    expect(isEditDirty(doc, values)).toBe(false)

    const modified = { ...values, total: '1.500,00' }
    expect(isEditDirty(doc, modified)).toBe(true)

    const reverted = { ...modified, total: '1.210,00' }
    expect(isEditDirty(doc, reverted)).toBe(false)
  })

  it('marks applied documents as locked and restricts upload document types', () => {
    expect(isAppliedLocked(makeDoc({ appliedAmount: '0.00' }))).toBe(false)
    expect(isAppliedLocked(makeDoc({ appliedAmount: '500.00' }))).toBe(true)

    expect(allowedTypesForSource('upload')).toEqual(['invoice', 'delivery_note', 'credit_note'])
    expect(allowedTypesForSource('manual')).toEqual(['invoice', 'delivery_note', 'credit_note', 'opening_balance'])
  })

  it('builds UpdateDocumentInput for invoice with supplier_term (clearing dueDate) and manual', () => {
    const base = initialEditValues(makeDoc({ dueDate: '2026-10-31', dueDateSource: 'supplier_term' }))
    expect(buildUpdatePayload(base)).toEqual({
      ok: true,
      input: {
        supplierId: 's1',
        type: 'invoice',
        letter: 'A',
        number: '0001-00001234',
        issueDate: '2026-10-01',
        dueDate: null,
        dueDateSource: 'supplier_term',
        subtotal: '1000.00',
        total: '1210.00',
        notes: null,
      },
    })

    const manual = { ...base, dueDateSource: 'manual' as const, dueDate: '2026-11-15' }
    expect(buildUpdatePayload(manual)).toEqual({
      ok: true,
      input: {
        supplierId: 's1',
        type: 'invoice',
        letter: 'A',
        number: '0001-00001234',
        issueDate: '2026-10-01',
        dueDate: '2026-11-15',
        dueDateSource: 'manual',
        subtotal: '1000.00',
        total: '1210.00',
        notes: null,
      },
    })
  })

  it('clears dueDate and dueDateSource for credit_note and clears letter/number/subtotal for opening_balance', () => {
    const cn = { ...initialEditValues(makeDoc()), type: 'credit_note' as const }
    expect(buildUpdatePayload(cn)).toEqual({
      ok: true,
      input: {
        supplierId: 's1',
        type: 'credit_note',
        letter: 'A',
        number: '0001-00001234',
        issueDate: '2026-10-01',
        dueDate: null,
        dueDateSource: null,
        subtotal: '1000.00',
        total: '1210.00',
        notes: null,
      },
    })

    const obWithDate = { ...initialEditValues(makeDoc()), type: 'opening_balance' as const, dueDate: '2026-09-01' }
    expect(buildUpdatePayload(obWithDate)).toEqual({
      ok: true,
      input: {
        supplierId: 's1',
        type: 'opening_balance',
        letter: null,
        number: null,
        issueDate: '2026-10-01',
        dueDate: '2026-09-01',
        dueDateSource: 'manual',
        subtotal: null,
        total: '1210.00',
        notes: null,
      },
    })

    const obWithoutDate = { ...obWithDate, dueDate: '' }
    expect(buildUpdatePayload(obWithoutDate)).toEqual({
      ok: true,
      input: {
        supplierId: 's1',
        type: 'opening_balance',
        letter: null,
        number: null,
        issueDate: '2026-10-01',
        dueDate: null,
        dueDateSource: null,
        subtotal: null,
        total: '1210.00',
        notes: null,
      },
    })
  })

  it('reports local parse errors for invalid subtotal or total', () => {
    const base = initialEditValues(makeDoc())
    expect(buildUpdatePayload({ ...base, subtotal: 'abc' })).toEqual({
      ok: false,
      field: 'subtotal',
      code: 'subtotal_invalid',
    })
    expect(buildUpdatePayload({ ...base, total: '' })).toEqual({
      ok: false,
      field: 'total',
      code: 'total_invalid',
    })
  })
})
