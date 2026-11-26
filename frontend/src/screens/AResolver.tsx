import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  deleteDocument,
  getDocument,
  listErrorDocuments,
  listSuppliers,
  retryDocument,
  updateDocument,
  type ApiResult,
  type ErrorDocumentList,
  type ErrorDocumentRow,
  type ErrorSummary,
  type SupplierList,
  type TermPreview,
} from '../accounts-api'
import { documentTitle, formatDate, formatMoney } from '../format'
import { ISSUE_MESSAGES } from '../labels'
import { buildUpdatePayload, initialEditValues } from './document-edit'
import { failedSave } from './form-errors'
import { groupResolverDocuments } from './resolver-groups'
import TermSheet from './TermSheet'

interface Loaded {
  key: number
  result: ApiResult<ErrorDocumentList>
}

interface TermModalState {
  supplierId: string
  supplierName: string
  suggestedTermDays: number | null
}

interface SupplierPickerState {
  documentId: string
  supplierId: string
  saving: boolean
  error: string | null
}

interface NoticeState {
  text: string
  supplierId?: string
  showSubidasLink?: boolean
}

/** "2 documentos · $ 152.300,00 fuera del saldo", with no amount part for 0.00. */
function countLine(summary: ErrorSummary): string {
  const documents = summary.count === 1 ? '1 documento' : `${summary.count} documentos`
  return summary.amount === '0.00' ? documents : `${documents} · ${formatMoney(summary.amount)} fuera del saldo`
}

function supplierLine(row: ErrorDocumentRow): string {
  if (row.supplier !== null) return row.supplier.name
  return row.issues.includes('supplier_unresolved') ? 'Proveedor sin identificar' : 'Sin datos'
}

function detailLine(row: ErrorDocumentRow): string {
  const title = row.type === null ? null : documentTitle({ type: row.type, letter: row.letter, number: row.number })
  return [title, formatDate(row.createdOn), `Subido por ${row.createdByName}`]
    .filter((part) => part !== null)
    .join(' · ')
}

/** *A resolver* (6a–6c): Error documents grouped for action, with inline quick fixes. */
function AResolver() {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [suppliers, setSuppliers] = useState<ApiResult<SupplierList> | null>(null)
  const [termModal, setTermModal] = useState<TermModalState | null>(null)
  const [picker, setPicker] = useState<SupplierPickerState | null>(null)
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)

  useEffect(() => {
    let current = true
    void listErrorDocuments().then((result) => {
      if (current) setLoaded({ key: attempt, result })
    })
    return () => {
      current = false
    }
  }, [attempt])

  useEffect(() => {
    let current = true
    void listSuppliers({ q: '', sort: 'name' }).then((result) => {
      if (current) setSuppliers(result)
    })
    return () => {
      current = false
    }
  }, [])

  const result = loaded?.key === attempt ? loaded.result : null
  const refresh = () => setAttempt((n) => n + 1)

  function handleTermSaved(preview: TermPreview) {
    if (termModal === null) return
    const { supplierId, supplierName } = termModal
    setTermModal(null)
    if (preview.unblockedCount > 0) {
      const noun = preview.unblockedCount === 1 ? 'documento' : 'documentos'
      const verb = preview.unblockedCount === 1 ? 'pasó' : 'pasaron'
      setNotice({
        text: `Plazo guardado. ${preview.unblockedCount} ${noun} de ${supplierName} ${verb} a Sin revisar.`,
        supplierId,
      })
    } else {
      setNotice({ text: `Plazo guardado para ${supplierName}.` })
    }
    refresh()
  }

  async function handleRetry(row: ErrorDocumentRow) {
    setBusyId(row.id)
    setActionError(null)
    const res = await retryDocument(row.id)
    setBusyId(null)
    if (res.ok) {
      setNotice({ text: 'Reintentando lectura…', showSubidasLink: true })
      refresh()
      return
    }
    const failure = failedSave(res)
    const firstField = Object.values(failure.fields)[0]
    setActionError({ id: row.id, message: firstField ?? failure.form ?? 'No pudimos reintentar.' })
  }

  async function handleDiscard(row: ErrorDocumentRow) {
    setBusyId(row.id)
    setActionError(null)
    const res = await deleteDocument(row.id)
    setBusyId(null)
    setConfirmDiscardId(null)
    if (res.ok) {
      setNotice({ text: 'Documento descartado.' })
      refresh()
      return
    }
    const failure = failedSave(res)
    const firstField = Object.values(failure.fields)[0]
    setActionError({ id: row.id, message: firstField ?? failure.form ?? 'No pudimos descartar el documento.' })
  }

  async function handleAssignSupplier(row: ErrorDocumentRow) {
    if (picker === null || picker.documentId !== row.id) return
    if (picker.supplierId === '') {
      setPicker({ ...picker, error: 'Elegí un proveedor.' })
      return
    }
    setPicker({ ...picker, saving: true, error: null })
    const docRes = await getDocument(row.id)
    if (!docRes.ok) {
      setPicker({ ...picker, saving: false, error: 'No pudimos cargar el documento.' })
      return
    }
    const supplier = suppliers?.ok ? suppliers.value.suppliers.find((s) => s.id === picker.supplierId) : undefined
    const values = initialEditValues(docRes.value)
    values.supplierId = picker.supplierId
    if (values.type === 'invoice' || values.type === 'delivery_note') {
      values.dueDateSource =
        supplier?.paymentTermDays !== null && supplier?.paymentTermDays !== undefined
          ? 'supplier_term'
          : values.dueDate.trim() !== ''
            ? 'manual'
            : null
    }
    const payload = buildUpdatePayload(values)
    if (!payload.ok) {
      setPicker({
        ...picker,
        saving: false,
        error: 'Faltan datos para guardar. Completalos desde el documento.',
      })
      return
    }
    const updateRes = await updateDocument(row.id, payload.input)
    if (updateRes.ok) {
      setPicker(null)
      setNotice({ text: 'Proveedor asignado. El documento pasó a Revisado.' })
      refresh()
      return
    }
    const failure = failedSave(updateRes)
    const firstField = Object.values(failure.fields)[0]
    setPicker({
      ...picker,
      saving: false,
      error: firstField ?? failure.form ?? 'No se pudo asignar el proveedor.',
    })
  }

  const layout = result?.ok ? groupResolverDocuments(result.value.documents) : null

  return (
    <section className="screen">
      <h1>A resolver</h1>

      {notice && (
        <div className="callout notice-banner" role="status">
          <span>
            {notice.text}{' '}
            {notice.supplierId && <Link to={`/proveedores/${notice.supplierId}`}>Ver</Link>}
            {notice.showSubidasLink && <Link to="/subidas">Ver en Subidas</Link>}
          </span>
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Cerrar
          </button>
        </div>
      )}

      {result === null && <p className="muted">Cargando…</p>}

      {result !== null && !result.ok && (
        <div className="empty">
          <p className="empty-title">No pudimos cargar los documentos con error.</p>
          <p className="muted">Revisá la conexión.</p>
          <button type="button" className="secondary" onClick={refresh}>
            Reintentar
          </button>
        </div>
      )}

      {result?.ok && result.value.documents.length === 0 && (
        <div className="empty">
          <p className="empty-title">No hay nada para resolver.</p>
          <p className="muted">Todos los documentos cuentan en el saldo.</p>
        </div>
      )}

      {result?.ok && layout !== null && result.value.documents.length > 0 && (
        <>
          <p className="muted">{countLine(result.value.summary)}</p>

          {layout.termGroups.map((group) => (
            <div key={group.supplier.id} className="card resolver-group">
              <div className="resolver-group-head">
                <p>
                  <strong>
                    {group.documents.length} documentos de {group.supplier.name} esperan un plazo de pago.
                  </strong>
                </p>
                {group.suggestedTermDays !== null && (
                  <p className="muted">Los documentos dicen {group.suggestedTermDays} días.</p>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setTermModal({
                      supplierId: group.supplier.id,
                      supplierName: group.supplier.name,
                      suggestedTermDays: group.suggestedTermDays,
                    })
                  }
                >
                  Definir plazo
                </button>
              </div>
              <ul className="list">
                {group.documents.map((doc) => {
                  const extraIssues = doc.issues.filter((code) => code !== 'supplier_term_missing')
                  return (
                    <li key={doc.id}>
                      <Link className="row" to={`/documentos/${doc.id}`} state={{ from: 'a-resolver' }}>
                        <span className="row-main">
                          <span className="row-title">
                            {doc.type === null
                              ? group.supplier.name
                              : documentTitle({ type: doc.type, letter: doc.letter, number: doc.number })}
                          </span>
                          <span className="row-amount">
                            {doc.total === null ? 'sin total' : formatMoney(doc.total)}
                          </span>
                        </span>
                        <span className="row-detail">
                          {formatDate(doc.createdOn)} · Subido por {doc.createdByName}
                        </span>
                        {extraIssues.map((code) => (
                          <span key={code} className="row-issue">
                            + {ISSUE_MESSAGES[code]}
                          </span>
                        ))}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}

          {layout.ungrouped.length > 0 && (
            <ul className="list">
              {layout.ungrouped.map((row) => {
                const isPicking = picker?.documentId === row.id
                const isConfirmingDiscard = confirmDiscardId === row.id
                const isBusy = busyId === row.id
                const hasTermMissing = row.issues.includes('supplier_term_missing') && row.supplier !== null
                const hasSupplierUnresolved = row.issues.includes('supplier_unresolved')
                const hasExtractionFailed = row.issues.includes('extraction_failed')
                const canDiscardInline =
                  row.issues.includes('unsupported_document') ||
                  row.issues.includes('duplicate_number') ||
                  hasExtractionFailed

                return (
                  <li key={row.id} className="resolver-item">
                    <Link className="row" to={`/documentos/${row.id}`} state={{ from: 'a-resolver' }}>
                      <span className="row-main">
                        <span className="row-title">{supplierLine(row)}</span>
                        <span className="row-amount">{row.total === null ? 'sin total' : formatMoney(row.total)}</span>
                      </span>
                      <span className="row-detail">{detailLine(row)}</span>
                      {row.issues.map((code) => (
                        <span key={code} className="row-issue">
                          {ISSUE_MESSAGES[code]}
                        </span>
                      ))}
                    </Link>

                    {(hasTermMissing || hasSupplierUnresolved || hasExtractionFailed || canDiscardInline) && (
                      <div className="resolver-actions">
                        {hasTermMissing && row.supplier !== null && (
                          <button
                            type="button"
                            className="compact-btn"
                            disabled={isBusy}
                            onClick={() =>
                              setTermModal({
                                supplierId: row.supplier!.id,
                                supplierName: row.supplier!.name,
                                suggestedTermDays: row.suggestedTermDays,
                              })
                            }
                          >
                            Definir plazo
                          </button>
                        )}

                        {hasSupplierUnresolved && !isPicking && (
                          <button
                            type="button"
                            className="secondary compact-btn"
                            disabled={isBusy}
                            onClick={() => setPicker({ documentId: row.id, supplierId: '', saving: false, error: null })}
                          >
                            Elegir proveedor
                          </button>
                        )}

                        {hasExtractionFailed && (
                          <>
                            <button
                              type="button"
                              className="compact-btn"
                              disabled={isBusy}
                              onClick={() => void handleRetry(row)}
                            >
                              {isBusy ? 'Reintentando…' : 'Reintentar'}
                            </button>
                            <Link
                              className="button secondary compact"
                              to={`/documentos/${row.id}`}
                              state={{ from: 'a-resolver', manualEntry: true }}
                            >
                              Cargar a mano
                            </Link>
                          </>
                        )}

                        {canDiscardInline && !isConfirmingDiscard && (
                          <button
                            type="button"
                            className="secondary compact-btn"
                            disabled={isBusy}
                            onClick={() => setConfirmDiscardId(row.id)}
                          >
                            Descartar
                          </button>
                        )}
                      </div>
                    )}

                    {isConfirmingDiscard && (
                      <div className="inline-panel">
                        <p className="muted">¿Descartar este documento? Deja de aparecer en el sistema.</p>
                        <div className="resolver-actions">
                          <button
                            type="button"
                            className="compact-btn"
                            disabled={isBusy}
                            onClick={() => void handleDiscard(row)}
                          >
                            {isBusy ? 'Descartando…' : 'Confirmar descarte'}
                          </button>
                          <button
                            type="button"
                            className="secondary compact-btn"
                            disabled={isBusy}
                            onClick={() => setConfirmDiscardId(null)}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {isPicking && (
                      <div className="inline-panel">
                        <label>
                          Proveedor
                          <select
                            value={picker.supplierId}
                            disabled={picker.saving}
                            onChange={(e) => setPicker({ ...picker, supplierId: e.target.value, error: null })}
                          >
                            <option value="">{suppliers === null ? 'Cargando…' : 'Elegí un proveedor'}</option>
                            {suppliers?.ok &&
                              suppliers.value.suppliers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        {picker.error && (
                          <p className="field-error" role="alert">
                            {picker.error}{' '}
                            <Link to={`/documentos/${row.id}`} state={{ from: 'a-resolver' }}>
                              Completar en Documento
                            </Link>
                          </p>
                        )}
                        <div className="resolver-actions">
                          <button
                            type="button"
                            className="compact-btn"
                            disabled={picker.saving}
                            onClick={() => void handleAssignSupplier(row)}
                          >
                            {picker.saving ? 'Guardando…' : 'Guardar'}
                          </button>
                          <button
                            type="button"
                            className="secondary compact-btn"
                            disabled={picker.saving}
                            onClick={() => setPicker(null)}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {actionError?.id === row.id && (
                      <p className="field-error" role="alert">
                        {actionError.message}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {termModal !== null && (
        <TermSheet
          supplierId={termModal.supplierId}
          supplierName={termModal.supplierName}
          suggestedTermDays={termModal.suggestedTermDays}
          onSaved={handleTermSaved}
          onClose={() => setTermModal(null)}
        />
      )}
    </section>
  )
}

export default AResolver
