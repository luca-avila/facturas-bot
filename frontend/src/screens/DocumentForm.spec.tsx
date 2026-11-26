import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { DocumentInput } from '../accounts-api'
import DocumentForm from './DocumentForm'
import { ok, stubApi, supplierList, supplierRow } from './screen-test'

function renderForm(path = '/proveedores/sup-1/cargar') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/proveedores/:id/cargar" element={<DocumentForm />} />
        <Route path="/proveedores/:id" element={<h1>Cuenta del proveedor</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('DocumentForm', () => {
  it('warns on 409 duplicate_suspected with link to existing document, clears on edit, and saves on Guardar igual', async () => {
    const sent: DocumentInput[] = []
    stubApi({
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'POST /api/documents': (body) => {
        const input = body as DocumentInput
        sent.push(input)
        if (input.allowSuspectedDuplicate !== true) {
          return {
            status: 409,
            body: {
              errors: [{ field: 'document', code: 'duplicate_suspected', documentId: 'doc-existing' }],
            },
          }
        }
        return { status: 201, body: { id: 'doc-new' } }
      },
    })

    renderForm()
    await screen.findByRole('option', { name: 'Panadería Sol' })

    fireEvent.change(screen.getByLabelText('Fecha de emisión'), { target: { value: '2026-11-10' } })
    fireEvent.change(screen.getByLabelText('Total'), { target: { value: '15000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    const link = await screen.findByRole('link', { name: 'Ver el existente' })
    expect(link.getAttribute('href')).toBe('/documentos/doc-existing')
    expect(screen.getByRole('button', { name: 'Guardar igual' })).toBeDefined()

    // Editing a field clears the warning
    fireEvent.change(screen.getByLabelText('Notas'), { target: { value: 'otro' } })
    expect(screen.queryByRole('button', { name: 'Guardar igual' })).toBeNull()

    // Re-submitting triggers warning again; Guardar igual saves and navigates to Proveedor
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar igual' }))

    expect(await screen.findByRole('heading', { name: 'Cuenta del proveedor' })).toBeDefined()
    expect(sent[sent.length - 1].allowSuspectedDuplicate).toBe(true)
  })

  it('preserves Guardar y cargar otro behavior when confirming Guardar igual', async () => {
    const sent: DocumentInput[] = []
    stubApi({
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'POST /api/documents': (body) => {
        const input = body as DocumentInput
        sent.push(input)
        if (input.allowSuspectedDuplicate !== true) {
          return {
            status: 409,
            body: {
              errors: [{ field: 'document', code: 'duplicate_suspected', documentId: 'doc-existing' }],
            },
          }
        }
        return { status: 201, body: { id: 'doc-new' } }
      },
    })

    renderForm()
    await screen.findByRole('option', { name: 'Panadería Sol' })

    fireEvent.change(screen.getByLabelText('Fecha de emisión'), { target: { value: '2026-11-10' } })
    fireEvent.change(screen.getByLabelText('Total'), { target: { value: '15000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y cargar otro' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Guardar igual' }))

    expect(await screen.findByText('Guardado.')).toBeDefined()
    expect((screen.getByLabelText('Total') as HTMLInputElement).value).toBe('')
    expect(sent[sent.length - 1].allowSuspectedDuplicate).toBe(true)
  })
})
