import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Documento from './Documento'
import { documentDetail, ok, renderAt, stubApi, supplierList, supplierRow } from './screen-test'

function dueDateField(): HTMLInputElement {
  return screen.getByLabelText('Vencimiento')
}

describe('Documento', () => {
  it('asks for a due date after switching to a supplier with no payment term', async () => {
    stubApi({
      'GET /api/documents/doc-1': () =>
        ok(
          documentDetail({
            supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
            dueDate: '2026-12-02',
            dueDateSource: 'supplier_term',
          }),
        ),
      'GET /api/suppliers': () =>
        ok(
          supplierList([
            supplierRow({ id: 'sup-2', name: 'Distribuidora Norte', paymentTermDays: null }),
            supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 }),
          ]),
        ),
    })
    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-1')
    await screen.findByRole('option', { name: 'Distribuidora Norte' })
    expect(dueDateField().value).toBe('02/12/2026')

    fireEvent.change(screen.getByLabelText('Proveedor'), { target: { value: 'sup-2' } })

    expect(dueDateField().value).toBe('Falta plazo o vencimiento')
    expect(screen.getByRole('button', { name: 'Ingresar vencimiento a mano' })).toBeDefined()
  })
})
