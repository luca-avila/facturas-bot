import { describe, expect, it } from 'vitest'
import type { DocumentStatus } from './accounts-api'
import { matchesFilter, type PaymentFilter } from './payment-filter'

const STATUSES: DocumentStatus[] = ['pending', 'overdue', 'paid', 'available', 'applied']

const matching = (filter: PaymentFilter) => STATUSES.filter((status) => matchesFilter(filter, status))

describe('matchesFilter', () => {
  it.each<[PaymentFilter, DocumentStatus[]]>([
    ['with_balance', ['pending', 'overdue', 'available']],
    ['overdue', ['overdue']],
    ['pending', ['pending']],
    ['paid', ['paid', 'applied']],
  ])('%s matches exactly %j', (filter, expected) => {
    expect(matching(filter)).toEqual(expected)
  })

  it('puts every status under Con saldo or Pagado, and never both', () => {
    for (const status of STATUSES) {
      expect([matchesFilter('with_balance', status), matchesFilter('paid', status)].filter(Boolean)).toHaveLength(1)
    }
  })
})
