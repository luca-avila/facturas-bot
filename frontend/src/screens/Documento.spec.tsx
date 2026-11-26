import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TermPreview } from '../accounts-api'
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

  it('shows the term saved from Definir plazo on the same screen', async () => {
    // An invoice in Error because Panadería Sol has no term, until it gets one.
    let term: number | null = null
    const preview = (): TermPreview => ({
      paymentTermDays: 30,
      documents: [
        {
          id: 'doc-1',
          type: 'invoice',
          letter: 'A',
          number: '0001-00000123',
          issueDate: '2026-11-02',
          dueDate: '2026-12-02',
          willUnblock: true,
          remainingIssues: [],
        },
      ],
      unblockedCount: 1,
    })
    stubApi({
      'GET /api/documents/doc-1': () =>
        ok(
          term === null
            ? documentDetail({
                reviewStatus: 'error',
                issues: ['supplier_term_missing'],
                supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: null },
              })
            : documentDetail({
                supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: term },
                dueDate: '2026-12-02',
                dueDateSource: 'supplier_term',
              }),
        ),
      'GET /api/suppliers': () =>
        ok(
          supplierList([
            supplierRow({ id: 'sup-2', name: 'Distribuidora Norte', paymentTermDays: null }),
            supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: term }),
          ]),
        ),
      'POST /api/suppliers/sup-1/term/preview': () => ok(preview()),
      'POST /api/suppliers/sup-1/term': (body) => {
        term = (body as { paymentTermDays: number }).paymentTermDays
        return ok(preview())
      },
    })
    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-1')
    await screen.findByText('Panadería Sol no tiene plazo de pago.')
    await screen.findByRole('option', { name: 'Distribuidora Norte' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Definir plazo' })[0])
    fireEvent.change(screen.getByLabelText('Plazo de pago'), { target: { value: '30' } })
    await screen.findByText('Factura A 0001-00000123: vence el 02/12/2026')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar 30 días' }))

    expect(await screen.findByText('Plazo guardado. El documento pasó a Sin revisar.')).toBeDefined()
    expect(await screen.findByText('Según el plazo del proveedor (30 días).')).toBeDefined()
    expect(dueDateField().value).toBe('02/12/2026')
  })
})
