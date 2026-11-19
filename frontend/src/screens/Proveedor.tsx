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
import { DOCUMENT_STATUS_LABELS, PAYMENT_FILTER_LABELS, REVIEW_STATUS_LABELS, UNAVAILABLE_MESSAGE } from '../labels'
import { matchesFilter, PAYMENT_FILTERS, type PaymentFilter } from '../payment-filter'
import { messagesByField } from './form-errors'
import { paymentSummaryLine } from './payment-lines'
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
  const [filter, setFilter] = useState<PaymentFilter>('with_balance')

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
    } else if (result.error === 'rejected' && result.fieldErrors.length > 0) {
      setDeleteError(Object.values(messagesByField(result.fieldErrors)).join(' '))
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
  const payPath = `/pagos/nuevo?proveedor=${encodeURIComponent(supplier.id)}`
  const shown = supplier.documents.filter((doc) => matchesFilter(filter, doc.status))
  const hiddenPaid =
    filter === 'with_balance' ? supplier.documents.filter((doc) => matchesFilter('paid', doc.status)).length : 0

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
          <dd>
            {formatCredit(supplier.credit)}
            {supplier.credit !== '0.00' && (
              <>
                {' '}
                <Link to={`/proveedores/${supplier.id}/aplicar-credito`}>Aplicar</Link>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className="strong">{formatMoney(supplier.balance)}</dd>
        </div>
      </dl>

      <div className="buttons">
        <Link className="button" to={payPath}>
          Registrar pago
        </Link>
        <Link className="button secondary" to={loadPath}>
          Cargar documento
        </Link>
      </div>

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
        <>
          <div className="chips" role="group" aria-label="Filtrar por estado de pago">
            {PAYMENT_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                className={option === filter ? 'chip selected' : 'chip'}
                aria-pressed={option === filter}
                onClick={() => setFilter(option)}
              >
                {PAYMENT_FILTER_LABELS[option]}
              </button>
            ))}
          </div>
          {shown.length === 0 && <p className="muted">No hay documentos en este filtro.</p>}
          <ul className="list">
            {shown.map((doc) => (
              <li key={doc.id} className="row">
                <span className="row-main">
                  <span className="row-title">{documentTitle(doc)}</span>
                  <span className="row-amount">
                    {doc.type === 'credit_note' ? formatCredit(doc.total) : formatMoney(doc.total)}
                  </span>
                </span>
                <span className="row-detail">{documentDetail(doc)}</span>
                {doc.partial && (
                  <span className="row-detail">
                    {doc.type === 'credit_note' ? '' : 'Pago parcial · '}quedan {formatMoney(doc.remaining)}
                  </span>
                )}
                <span className="row-actions">
                  <span className={`badge ${doc.status}`}>{DOCUMENT_STATUS_LABELS[doc.status]}</span>
                  {doc.reviewStatus === 'unreviewed' && (
                    <span className="quiet">{REVIEW_STATUS_LABELS.unreviewed}</span>
                  )}
                  {(doc.status === 'pending' || doc.status === 'overdue') && (
                    <Link className="row-link" to={`/proveedores/${supplier.id}/documentos/${doc.id}/marcar-pagado`}>
                      Marcar como pagado
                    </Link>
                  )}
                  <button type="button" className="link" onClick={() => void discard(doc)}>
                    Descartar
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {hiddenPaid > 0 && (
            <button type="button" className="link" onClick={() => setFilter('paid')}>
              Ver {hiddenPaid} {hiddenPaid === 1 ? 'pagado' : 'pagados'}
            </button>
          )}
        </>
      )}

      <h2>Pagos ({supplier.payments.length})</h2>
      {supplier.payments.length === 0 ? (
        <p className="muted">Todavía no hay pagos de este proveedor.</p>
      ) : (
        <ul className="list">
          {supplier.payments.map((payment) => (
            <li key={payment.id}>
              <Link className="row" to={`/pagos/${payment.id}`}>
                <span className="row-main">
                  <span className="row-title">{paymentSummaryLine(payment)}</span>
                  <span className="row-amount">{formatMoney(payment.amount)}</span>
                </span>
                {payment.status === 'available' && (
                  <span className="row-detail">Sin aplicar {formatMoney(payment.unapplied)}</span>
                )}
              </Link>
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
  if (doc.status === 'paid') return `Vence ${formatDate(doc.dueDate)}`
  return `Vence ${formatDate(doc.dueDate)} · ${formatDueIn(doc.daysToDue)}`
}

export default Proveedor
