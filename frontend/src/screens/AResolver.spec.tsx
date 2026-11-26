import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ErrorDocumentRow, TermPreview, UpdateDocumentInput } from '../accounts-api'
import AResolver from './AResolver'
import { documentDetail, errorRow, ok, renderAt, stubApi, supplierList, supplierRow } from './screen-test'

describe('A resolver', () => {
  it('assigns a supplier with the term just saved from Definir plazo', async () => {
    // doc-1 waits for Panadería Sol's term. doc-2's supplier couldn't be read.
    let term: number | null = null
    let assigned = false
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
      'GET /api/error-documents': () => {
        const documents: ErrorDocumentRow[] = []
        if (term === null) {
          documents.push(
            errorRow({
              id: 'doc-1',
              number: '0001-00000123',
              supplier: { id: 'sup-1', name: 'Panadería Sol' },
              issues: ['supplier_term_missing'],
            }),
          )
        }
        if (!assigned) documents.push(errorRow({ id: 'doc-2', issues: ['supplier_unresolved'] }))
        // Each one totals $ 1.000.
        const amount = ['0.00', '1000.00', '2000.00'][documents.length]
        return ok({ summary: { count: documents.length, amount, supplierName: null }, documents })
      },
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: term })])),
      'POST /api/suppliers/sup-1/term/preview': () => ok(preview()),
      'POST /api/suppliers/sup-1/term': (body) => {
        term = (body as { paymentTermDays: number }).paymentTermDays
        return ok(preview())
      },
      'GET /api/documents/doc-2': () =>
        ok(documentDetail({ id: 'doc-2', reviewStatus: 'error', letter: 'A', number: null, issues: ['supplier_unresolved'] })),
      // Like the backend: an invoice takes its supplier's term, or a typed date.
      'PUT /api/documents/doc-2': (body) => {
        const input = body as UpdateDocumentInput
        const dated =
          (input.dueDateSource === 'supplier_term' && term !== null) ||
          (input.dueDateSource === 'manual' && input.dueDate !== null)
        if (!dated) return { status: 400, body: { errors: [{ field: 'dueDate', code: 'due_date_required' }] } }
        assigned = true
        return ok()
      },
    })
    renderAt(<AResolver />, '/a-resolver', '/a-resolver')
    await screen.findByText('2 documentos · $ 2.000,00 fuera del saldo')

    fireEvent.click(screen.getByRole('button', { name: 'Definir plazo' }))
    fireEvent.change(screen.getByLabelText('Plazo de pago'), { target: { value: '30' } })
    await screen.findByText('Factura A 0001-00000123: vence el 02/12/2026')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar 30 días' }))
    await screen.findByText('Plazo guardado. 1 documento de Panadería Sol pasó a Sin revisar.')
    await screen.findByText('1 documento · $ 1.000,00 fuera del saldo')

    fireEvent.click(screen.getByRole('button', { name: 'Elegir proveedor' }))
    fireEvent.change(screen.getByLabelText('Proveedor'), { target: { value: 'sup-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(await screen.findByText('Proveedor asignado. El documento pasó a Revisado.')).toBeDefined()
    expect(await screen.findByText('No hay nada para resolver.')).toBeDefined()
  })

  it('shows inline accept action and Ver el existente link for duplicate_suspected, and removes resolved document on accept', async () => {
    let resolved = false
    stubApi({
      'GET /api/error-documents': () => {
        const documents: ErrorDocumentRow[] = resolved
          ? []
          : [
              errorRow({
                id: 'doc-dup',
                type: 'delivery_note',
                letter: 'X',
                number: null,
                supplier: { id: 'sup-1', name: 'Panadería Sol' },
                issues: ['duplicate_suspected'],
                suspectedDuplicateId: 'doc-orig',
              }),
            ]
        return ok({
          summary: { count: documents.length, amount: resolved ? '0.00' : '1000.00', supplierName: null },
          documents,
        })
      },
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'POST /api/documents/doc-dup/issues/duplicate_suspected/accept': () => {
        resolved = true
        return ok()
      },
    })

    renderAt(<AResolver />, '/a-resolver', '/a-resolver')
    const link = await screen.findByRole('link', { name: 'Ver el existente' })
    expect(link.getAttribute('href')).toBe('/documentos/doc-orig')
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Aceptar igual' }))
    expect(await screen.findByText('Aceptado. El documento pasó a Revisado.')).toBeDefined()
    expect(await screen.findByText('No hay nada para resolver.')).toBeDefined()
  })

  it('shows a pending-issues notice when Elegir proveedor leaves an acceptable issue open', async () => {
    let assigned = false
    stubApi({
      'GET /api/error-documents': () =>
        ok({
          summary: { count: 1, amount: '1000.00', supplierName: null },
          documents: [
            errorRow({
              id: 'doc-3',
              supplier: assigned ? { id: 'sup-1', name: 'Panadería Sol' } : null,
              issues: assigned ? ['wrong_recipient'] : ['supplier_unresolved', 'wrong_recipient'],
            }),
          ],
        }),
      'GET /api/suppliers': () =>
        ok(supplierList([supplierRow({ id: 'sup-1', name: 'Panadería Sol', paymentTermDays: 30 })])),
      'GET /api/documents/doc-3': () =>
        ok(
          documentDetail({
            id: 'doc-3',
            reviewStatus: 'error',
            issues: ['supplier_unresolved', 'wrong_recipient'],
          }),
        ),
      'PUT /api/documents/doc-3': () => {
        assigned = true
        return ok()
      },
    })

    renderAt(<AResolver />, '/a-resolver', '/a-resolver')
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir proveedor' }))
    fireEvent.change(screen.getByLabelText('Proveedor'), { target: { value: 'sup-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(
      await screen.findByText('Proveedor asignado. Quedan avisos pendientes en el documento.'),
    ).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Aceptar CUIT' })).toBeDefined()
  })
})
