import { describe, expect, it } from 'vitest'
import {
  documentTitle,
  formatCredit,
  formatCuit,
  formatDate,
  formatAmountInput,
  formatDueIn,
  formatMoney,
  parseAmountInput,
} from './format'

const NBSP = ' '

describe('formatMoney', () => {
  it.each([
    ['599280.50', `$${NBSP}599.280,50`],
    ['-15000.00', `−${NBSP}$${NBSP}15.000,00`],
    ['0.00', `$${NBSP}0,00`],
    ['999.99', `$${NBSP}999,99`],
    ['1000.00', `$${NBSP}1.000,00`],
    ['999999999999.99', `$${NBSP}999.999.999.999,99`],
  ])('formats %s as %j', (amount, expected) => {
    expect(formatMoney(amount)).toBe(expected)
  })

  it.each(['1.5', '1', '', '1,50', 'abc', '1.505', '+1.00'])('throws on %j', (amount) => {
    expect(() => formatMoney(amount)).toThrow()
  })
})

describe('formatAmountInput', () => {
  it.each([
    ['86900.50', '86.900,50'],
    ['0.00', '0,00'],
    ['1000000.00', '1.000.000,00'],
  ])('formats %s as %j', (amount, expected) => {
    expect(formatAmountInput(amount)).toBe(expected)
  })

  it('reads back as the same amount', () => {
    expect(parseAmountInput(formatAmountInput('86900.50'))).toBe('86900.50')
  })

  it.each(['1.5', '', '1,50', 'abc'])('throws on %j', (amount) => {
    expect(() => formatAmountInput(amount)).toThrow()
  })
})

describe('formatCredit', () => {
  it('shows no credit as $ 0,00', () => {
    expect(formatCredit('0.00')).toBe(`$${NBSP}0,00`)
  })

  it('shows a credit as subtracted', () => {
    expect(formatCredit('15000.00')).toBe(`−${NBSP}$${NBSP}15.000,00`)
  })
})

describe('parseAmountInput', () => {
  it.each([
    ['86.900,50', '86900.50'],
    ['86900,5', '86900.5'],
    ['$ 1.500', '1500'],
    ['  $86.900,50  ', '86900.50'],
    ['1500', '1500'],
    ['0', '0'],
    ['1.234.567,89', '1234567.89'],
  ])('reads %j as %j', (text, expected) => {
    expect(parseAmountInput(text)).toBe(expected)
  })

  it.each(['86900.50', '8.69.00', '-5', '1,505', 'abc', '12a', '', '   ', '$', '1.5000', ',50'])(
    'rejects %j',
    (text) => {
      expect(parseAmountInput(text)).toBeNull()
    },
  )
})

describe('formatDate', () => {
  it('turns 2026-10-01 into 01/10/2026', () => {
    expect(formatDate('2026-10-01')).toBe('01/10/2026')
  })
})

describe('formatDueIn', () => {
  it.each([
    [0, 'hoy'],
    [1, 'en 1 día'],
    [8, 'en 8 días'],
    [-1, 'hace 1 día'],
    [-42, 'hace 42 días'],
  ])('formats %i as %j', (days, expected) => {
    expect(formatDueIn(days)).toBe(expected)
  })
})

describe('formatCuit', () => {
  it('adds the hyphens', () => {
    expect(formatCuit('30000000015')).toBe('30-00000001-5')
  })
})

describe('documentTitle', () => {
  it('joins the type, letter and number', () => {
    expect(documentTitle({ type: 'invoice', letter: 'A', number: '0003-00012345' })).toBe('Factura A 0003-00012345')
  })

  it('says s/n when there is no number', () => {
    expect(documentTitle({ type: 'delivery_note', letter: null, number: null })).toBe('Remito s/n')
  })

  it('says Saldo inicial for an opening balance', () => {
    expect(documentTitle({ type: 'opening_balance', letter: null, number: null })).toBe('Saldo inicial')
  })

  it('names a credit note', () => {
    expect(documentTitle({ type: 'credit_note', letter: 'B', number: '0001-00000042' })).toBe(
      'Nota de crédito B 0001-00000042',
    )
  })
})
