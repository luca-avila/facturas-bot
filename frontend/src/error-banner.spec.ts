import { describe, expect, it } from 'vitest'
import { errorBanner } from './format'

const NBSP = '\u00a0'

describe('errorBanner', () => {
  it('names the supplier of a single document and its amount', () => {
    expect(errorBanner({ count: 1, amount: '98700.00', supplierName: 'Bebidas Norte' })).toEqual({
      title: '1 documento de Bebidas Norte con error',
      detail: `por $${NBSP}98.700,00 no está incluido en el saldo.`,
    })
  })

  it('counts several documents with no supplier name', () => {
    expect(errorBanner({ count: 3, amount: '10.00', supplierName: null })).toEqual({
      title: '3 documentos con error',
      detail: `por $${NBSP}10,00 no están incluidos en el saldo.`,
    })
  })

  it('leaves the amount out when it is 0.00', () => {
    expect(errorBanner({ count: 2, amount: '0.00', supplierName: null })).toEqual({
      title: '2 documentos con error',
      detail: 'No están incluidos en el saldo.',
    })
    expect(errorBanner({ count: 1, amount: '0.00', supplierName: null }).detail).toBe(
      'No está incluido en el saldo.',
    )
  })
})
