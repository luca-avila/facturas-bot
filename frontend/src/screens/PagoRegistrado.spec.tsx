import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PaymentDetail } from '../accounts-api'
import PagoRegistrado from './PagoRegistrado'
import { ok, renderAt, stubApi } from './screen-test'

// $ 40.000 paid $ 20.000 of one invoice when recorded, and later gave $ 10.000
// of its leftover to the same invoice from Aplicar crédito. The backend lists
// that invoice once, with both applications added up.
const payment: PaymentDetail = {
  id: 'pay-1',
  supplierId: 'sup-1',
  supplierName: 'Panadería Sol',
  amount: '40000.00',
  paidOn: '2026-11-20',
  valueDate: null,
  method: 'transfer',
  reference: null,
  createdByName: 'Ana',
  unapplied: '5000.00',
  status: 'available',
  notes: null,
  applied: '35000.00',
  applications: [
    {
      documentId: 'doc-1',
      type: 'invoice',
      letter: 'A',
      number: '0001-00000123',
      amount: '30000.00',
      status: 'pending',
      remaining: '10000.00',
      partial: true,
    },
    {
      documentId: 'doc-2',
      type: 'invoice',
      letter: 'A',
      number: '0001-00000124',
      amount: '5000.00',
      status: 'paid',
      remaining: '0.00',
      partial: false,
    },
  ],
}

describe('Pago registrado', () => {
  it('lists a document the payment applied to twice once, with what it applied in total', async () => {
    stubApi({ 'GET /api/payments/pay-1': () => ok(payment) })
    renderAt(<PagoRegistrado />, '/pagos/:id', '/pagos/pay-1')

    expect(await screen.findAllByText('Factura A 0001-00000123')).toHaveLength(1)
    expect(screen.getByText('aplicado $ 30.000,00')).toBeDefined()
    expect(screen.getByText('Pago parcial · quedan $ 10.000,00')).toBeDefined()
    expect(screen.getAllByText('Factura A 0001-00000124')).toHaveLength(1)
    // A duplicate React key would log console.error, which fails the test.
  })
})
