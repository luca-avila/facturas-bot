import { describe, expect, it } from 'vitest'
import type { UploadRow } from '../accounts-api'
import { groupByDay } from './subidas-groups'

function row(id: string, daysAgo: number, uploadedOn: string): UploadRow {
  return {
    id,
    reviewStatus: 'processing',
    pageCount: 1,
    uploadedOn,
    uploadedTime: '10:00',
    daysAgo,
    createdByName: 'Ana',
    type: null,
    letter: null,
    number: null,
    supplierName: null,
    total: null,
  }
}

describe('groupByDay', () => {
  it('groups consecutive rows by day, as Hoy, Ayer and the date', () => {
    const groups = groupByDay([
      row('a', 0, '2026-11-19'),
      row('b', 0, '2026-11-19'),
      row('c', 1, '2026-11-18'),
      row('d', 3, '2026-11-16'),
    ])
    expect(groups.map((group) => [group.label, group.rows.map((r) => r.id)])).toEqual([
      ['Hoy', ['a', 'b']],
      ['Ayer', ['c']],
      ['16/11/2026', ['d']],
    ])
  })

  it('gives no groups for no rows', () => {
    expect(groupByDay([])).toEqual([])
  })
})
