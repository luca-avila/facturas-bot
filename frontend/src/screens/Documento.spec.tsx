import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { TermPreview, UpdateDocumentInput } from '../accounts-api'
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

  it('displays open acceptable issue cards with consistency summary and duplicate link, disables accept while dirty, and transitions to Revisado on accept', async () => {
    let accepted = false
    stubApi({
      'GET /api/documents/doc-1': () =>
        ok(
          accepted
            ? documentDetail({
                reviewStatus: 'reviewed',
                reviewedByName: 'Ana',
                reviewedOn: '2026-11-26',
                reviewedTime: '14:30',
                supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
                dueDate: '2026-12-02',
                dueDateSource: 'supplier_term',
                subtotal: '1000.00',
                total: '1250.00',
                issues: [],
                acceptedIssues: [
                  {
                    code: 'totals_mismatch',
                    acceptedByName: 'Ana',
                    acceptedOn: '2026-11-26',
                    acceptedTime: '14:30',
                  },
                ],
                consistencySummary: { taxSum: '210.00', subtotalPlusTaxes: '1210.00', lineTotalSum: null },
              })
            : documentDetail({
                reviewStatus: 'error',
                supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
                dueDate: '2026-12-02',
                dueDateSource: 'supplier_term',
                subtotal: '1000.00',
                total: '1250.00',
                issues: ['duplicate_suspected', 'totals_mismatch'],
                suspectedDuplicate: {
                  id: 'doc-existing',
                  type: 'delivery_note',
                  letter: 'X',
                  number: null,
                  issueDate: '2026-11-02',
                  total: '1250.00',
                },
                consistencySummary: { taxSum: '210.00', subtotalPlusTaxes: '1210.00', lineTotalSum: null },
              }),
        ),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'POST /api/documents/doc-1/issues/totals_mismatch/accept': () => {
        accepted = true
        return ok()
      },
    })

    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-1')
    expect(await screen.findByText(/Subtotal \$ 1\.000,00 \+ impuestos \$ 210,00 = \$ 1\.210,00/)).toBeDefined()
    const existingLink = screen.getByRole('link', { name: 'Ver el existente' })
    expect(existingLink.getAttribute('href')).toBe('/documentos/doc-existing')

    // Editing a field disables accept buttons until saved or undone
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'cambio sin guardar' } })
    expect((screen.getByRole('button', { name: 'Aceptar como está' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect((screen.getByRole('button', { name: 'Aceptar como está' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar como está' }))
    expect(await screen.findByText('Aceptado. El documento pasó a Revisado.')).toBeDefined()
    expect(await screen.findByText('Aceptado por Ana · 26/11/2026 14:30')).toBeDefined()
  })

  it('prompts for Aceptar y guardar on 409 acceptable issues when editing an unreviewed document and clears on field edit', async () => {
    const receivedInputs: UpdateDocumentInput[] = []
    let saved = false
    stubApi({
      'GET /api/documents/doc-1': () =>
        ok(
          documentDetail({
            reviewStatus: saved ? 'reviewed' : 'unreviewed',
            supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
            dueDate: '2026-12-02',
            dueDateSource: 'supplier_term',
            subtotal: saved ? '1005.00' : '1000.00',
            total: '1210.00',
          }),
        ),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'PUT /api/documents/doc-1': (body) => {
        const input = body as UpdateDocumentInput
        receivedInputs.push(input)
        if (!input.acceptIssues?.includes('totals_mismatch')) {
          return { status: 409, body: { errors: [{ field: 'document', code: 'totals_mismatch' }] } }
        }
        saved = true
        return ok()
      },
    })

    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-1')
    await screen.findByRole('option', { name: 'Panadería Sol' })

    fireEvent.change(screen.getByLabelText('Subtotal'), { target: { value: '1.005,00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(await screen.findByText('Este cambio genera avisos que requieren confirmación:')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Aceptar y guardar' })).toBeDefined()

    // Editing another field clears the pending confirmation prompt
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'revisado' } })
    expect(screen.queryByRole('button', { name: 'Aceptar y guardar' })).toBeNull()

    // Saving again re-triggers prompt, then confirming sends acceptIssues
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar y guardar' }))

    expect(await screen.findByText('Guardado en Revisado.')).toBeDefined()
    expect(receivedInputs[receivedInputs.length - 1].acceptIssues).toEqual(['totals_mismatch'])
  })

  it('shows a pending-issues notice when saving an error document leaves acceptable issues open', async () => {
    let saved = false
    stubApi({
      'GET /api/documents/doc-1': () =>
        ok(
          documentDetail({
            reviewStatus: 'error',
            supplier: saved ? { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 } : null,
            dueDate: saved ? '2026-12-02' : null,
            dueDateSource: saved ? 'supplier_term' : null,
            issues: saved ? ['totals_mismatch'] : ['supplier_unresolved', 'totals_mismatch'],
          }),
        ),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'PUT /api/documents/doc-1': () => {
        saved = true
        return ok()
      },
    })

    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-1')
    await screen.findByRole('option', { name: 'Panadería Sol' })

    fireEvent.change(screen.getByLabelText('Proveedor'), { target: { value: 'sup-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(
      await screen.findByText('Cambios guardados. Quedan avisos pendientes para aceptar o corregir.'),
    ).toBeDefined()
  })

  it('discards a duplicate_suspected document inline from its card even while viewing the Foto tab', async () => {
    let deleted = false
    stubApi({
      'GET /api/documents/doc-dup': () =>
        ok(
          documentDetail({
            id: 'doc-dup',
            reviewStatus: 'error',
            images: [{ id: 'img-1', position: 1 }],
            supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
            issues: ['duplicate_suspected'],
            suspectedDuplicate: {
              id: 'doc-existing',
              type: 'delivery_note',
              letter: 'X',
              number: null,
              issueDate: '2026-11-02',
              total: '1210.00',
            },
          }),
        ),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'DELETE /api/documents/doc-dup': () => {
        deleted = true
        return ok()
      },
    })

    render(
      <MemoryRouter initialEntries={['/documentos/doc-dup']}>
        <Routes>
          <Route path="/documentos/:id" element={<Documento />} />
          <Route path="/subidas" element={<h1>Subidas</h1>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Foto (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar descarte' }))

    expect(await screen.findByRole('heading', { name: 'Subidas' })).toBeDefined()
    expect(deleted).toBe(true)
  })

  it('resets transient discard confirmation when navigating to another document via Ver el existente', async () => {
    stubApi({
      'GET /api/documents/doc-dup': () =>
        ok(
          documentDetail({
            id: 'doc-dup',
            reviewStatus: 'error',
            supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
            issues: ['duplicate_suspected'],
            suspectedDuplicate: {
              id: 'doc-existing',
              type: 'delivery_note',
              letter: 'X',
              number: null,
              issueDate: '2026-11-02',
              total: '1210.00',
            },
          }),
        ),
      'GET /api/documents/doc-existing': () =>
        ok(
          documentDetail({
            id: 'doc-existing',
            reviewStatus: 'reviewed',
            type: 'delivery_note',
            letter: 'X',
            number: null,
            supplier: { id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 },
            issues: [],
          }),
        ),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
    })

    renderAt(<Documento />, '/documentos/:id', '/documentos/doc-dup')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Descartar' }))[0])
    expect(await screen.findByRole('button', { name: 'Confirmar descarte' })).toBeDefined()

    fireEvent.click(screen.getByRole('link', { name: 'Ver el existente' }))
    expect(await screen.findByText('Revisado')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Confirmar descarte' })).toBeNull()
  })
})
