import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  deleteDocument,
  getSupplier,
  type AccountDocument,
  type ApiResult,
  type SupplierAccount,
} from '../accounts-api'
import { documentTitle, formatCredit, formatCuit, formatDate, formatDueIn, formatMoney } from '../format'
import { DOCUMENT_STATUS_LABELS, REVIEW_STATUS_LABELS, UNAVAILABLE_MESSAGE } from '../labels'
import { resumenPath } from './resumen-search'

interface Loaded {
  id: string
  result: ApiResult<SupplierAccount>
}

function Proveedor() {
  const { id = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void getSupplier(id).then((result) => {
      if (current) setLoaded({ id, result })
    })
    return () => {
      current = false
    }
  }, [id, attempt])

  async function discard(doc: AccountDocument) {
    const title = documentTitle(doc)
    if (!window.confirm(`¿Descartar ${title}? Deja de contar en el saldo del proveedor.`)) return
    const result = await deleteDocument(doc.id)
    if (result.ok || result.error === 'not_found') {
      setDeleteError(null)
      setAttempt((n) => n + 1)
    } else if (result.error !== 'unauthorized') {
      setDeleteError(result.error === 'unavailable' ? UNAVAILABLE_MESSAGE : 'No se pudo descartar el documento.')
    }
  }

  // While reloading after a change, the previous figures stay on screen.
  const result = loaded?.id === id ? loaded.result : null
  const back = (
    <Link className="back" to={resumenPath()}>
      ← Resumen
    </Link>
  )

  if (result === null) {
    return (
      <section className="screen">
        {back}
        <p className="muted">Cargando…</p>
      </section>
    )
  }

  if (!result.ok) {
    return (
      <section className="screen">
        {back}
        {result.error === 'not_found' ? (
          <p className="empty-title">No encontramos este proveedor.</p>
        ) : (
          <div className="empty">
            <p className="empty-title">No pudimos cargar el proveedor.</p>
            <p className="muted">Revisá la conexión.</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </section>
    )
  }

  const supplier = result.value
  const editPath = `/proveedores/${supplier.id}/editar`
  const loadPath = `/proveedores/${supplier.id}/cargar`

  return (
    <section className="screen">
      <div className="top-bar">
        {back}
        <Link to={editPath}>Editar proveedor</Link>
      </div>

      <h1>{supplier.name}</h1>
      <p className="muted">
        {supplier.cuit === null
          ? [supplier.legalName, 'Proveedor informal'].filter(Boolean).join(' · ')
          : [supplier.legalName, `CUIT ${formatCuit(supplier.cuit)}`].filter(Boolean).join(' · ')}
      </p>
      <p>
        {supplier.paymentTermDays === null ? (
          <>
            Plazo de pago: sin definir · <Link to={editPath}>Definir plazo</Link>
          </>
        ) : (
          <>
            Plazo de pago: {supplier.paymentTermDays} {supplier.paymentTermDays === 1 ? 'día' : 'días'} ·{' '}
            <Link to={editPath}>Cambiar</Link>
          </>
        )}
      </p>
      {supplier.notes !== null && <p className="muted">Notas: {supplier.notes}</p>}

      <dl className="card figures four">
        <div>
          <dt>Sin vencer</dt>
          <dd>{formatMoney(supplier.notDue)}</dd>
        </div>
        <div>
          <dt>Vencido</dt>
          <dd>{formatMoney(supplier.overdue)}</dd>
        </div>
        <div>
          <dt>Crédito a favor</dt>
          <dd>{formatCredit(supplier.credit)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className="strong">{formatMoney(supplier.balance)}</dd>
        </div>
      </dl>

      <Link className="button" to={loadPath}>
        Cargar documento
      </Link>

      <h2>Documentos ({supplier.documents.length})</h2>
      {deleteError !== null && (
        <p role="alert" className="error">
          {deleteError}
        </p>
      )}

      {supplier.documents.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Todavía no hay documentos de este proveedor.</p>
          <p className="muted">
            Si le debían plata antes de usar la app, cargá el saldo de la planilla como Saldo inicial.
          </p>
          <Link className="button secondary" to={`${loadPath}?tipo=saldo-inicial`}>
            Cargar saldo inicial
          </Link>
        </div>
      ) : (
        <ul className="list">
          {supplier.documents.map((doc) => (
            <li key={doc.id} className="row">
              <span className="row-main">
                <span className="row-title">{documentTitle(doc)}</span>
                <span className="row-amount">
                  {doc.type === 'credit_note' ? formatCredit(doc.total) : formatMoney(doc.total)}
                </span>
              </span>
              <span className="row-detail">{documentDetail(doc)}</span>
              <span className="row-actions">
                {doc.status !== null && (
                  <span className={`badge ${doc.status}`}>{DOCUMENT_STATUS_LABELS[doc.status]}</span>
                )}
                {doc.reviewStatus === 'unreviewed' && (
                  <span className="quiet">{REVIEW_STATUS_LABELS.unreviewed}</span>
                )}
                <button type="button" className="link" onClick={() => void discard(doc)}>
                  Descartar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function documentDetail(doc: AccountDocument): string {
  if (doc.type === 'credit_note') return `Emitida ${formatDate(doc.issueDate)}`
  if (doc.dueDate === null || doc.daysToDue === null) return 'Sin vencimiento'
  return `Vence ${formatDate(doc.dueDate)} · ${formatDueIn(doc.daysToDue)}`
}

export default Proveedor
