import { describe, expect, it } from 'vitest'
import type { ErrorDocumentRow, IssueCode } from '../accounts-api'
import { groupResolverDocuments } from './resolver-groups'

function row(
  id: string,
  overrides: {
    supplier?: { id: string; name: string } | null
    issues?: IssueCode[]
    suggestedTermDays?: number | null
  } = {},
): ErrorDocumentRow {
  return {
    id,
    type: 'invoice',
    letter: 'A',
    number: `0001-0000000${id}`,
    supplier: overrides.supplier === undefined ? { id: 's1', name: 'Proveedor 1' } : overrides.supplier,
    issueDate: '2026-10-01',
    total: '1000.00',
    createdByName: 'Ana',
    createdOn: '2026-11-01',
    issues: overrides.issues ?? ['supplier_term_missing'],
    suggestedTermDays: overrides.suggestedTermDays ?? null,
  }
}

describe('groupResolverDocuments', () => {
  it('groups suppliers with 2+ supplier_term_missing docs and preserves ungrouped order', () => {
    const s1 = { id: 's1', name: 'Bebidas Norte' }
    const s2 = { id: 's2', name: 'Lácteos Sur' }

    const layout = groupResolverDocuments([
      row('1', { supplier: null, issues: ['extraction_failed'] }),
      row('2', { supplier: s1, issues: ['supplier_term_missing'], suggestedTermDays: 30 }),
      row('3', { supplier: s2, issues: ['supplier_term_missing'], suggestedTermDays: 15 }),
      row('4', { supplier: s1, issues: ['missing_total'] }),
      row('5', { supplier: s1, issues: ['supplier_term_missing'], suggestedTermDays: null }),
    ])

    expect(layout.termGroups).toHaveLength(1)
    expect(layout.termGroups[0].supplier).toEqual(s1)
    expect(layout.termGroups[0].documents.map((d) => d.id)).toEqual(['2', '5'])
    expect(layout.termGroups[0].suggestedTermDays).toBe(30)
    expect(layout.ungrouped.map((d) => d.id)).toEqual(['1', '3', '4'])
  })

  it('keeps suggestedTermDays when all non-null suggestions agree and returns null when they disagree', () => {
    const s1 = { id: 's1', name: 'A' }
    const s2 = { id: 's2', name: 'B' }

    const layout = groupResolverDocuments([
      row('1', { supplier: s1, suggestedTermDays: 45 }),
      row('2', { supplier: s1, suggestedTermDays: 45 }),
      row('3', { supplier: s2, suggestedTermDays: 30 }),
      row('4', { supplier: s2, suggestedTermDays: 60 }),
    ])

    expect(layout.termGroups[0].suggestedTermDays).toBe(45)
    expect(layout.termGroups[1].suggestedTermDays).toBeNull()
  })

  it('returns null suggestedTermDays when every document in the group has null', () => {
    const s1 = { id: 's1', name: 'A' }
    const layout = groupResolverDocuments([
      row('1', { supplier: s1, suggestedTermDays: null }),
      row('2', { supplier: s1, suggestedTermDays: null }),
    ])
    expect(layout.termGroups[0].suggestedTermDays).toBeNull()
  })
})
