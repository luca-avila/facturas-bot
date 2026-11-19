import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getPayment, type ApiResult, type PaymentDetail } from '../accounts-api'
import { documentTitle, formatMoney } from '../format'
import { DOCUMENT_STATUS_LABELS } from '../labels'
import { paymentLine } from './payment-lines'

interface Loaded {
  key: string
  result: ApiResult<PaymentDetail>
}

/** *Pago registrado* (7f): what the payment applied, and how each document is now. */
function PagoRegistrado() {
  const { id = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${id}\n${attempt}`

  useEffect(() => {
    let current = true
    void getPayment(id).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [id, key])

  const result = loaded?.key === key ? loaded.result : null
  if (result === null) {
    return (
      <section className="screen">
        <p className="muted">Cargando…</p>
      </section>
    )
  }
  if (!result.ok) {
    return (
      <section className="screen">
        <Link className="back" to="/pagos">
          ← Pagos
        </Link>
        {result.error === 'not_found' ? (
          <p className="empty-title">No encontramos este pago.</p>
        ) : (
          <div className="empty">
            <p className="empty-title">No pudimos cargar el pago.</p>
            <p className="muted">Revisá la conexión.</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </section>
    )
  }

  const payment = result.value
  const supplierPath = `/proveedores/${payment.supplierId}`
  return (
    <section className="screen">
      <div className="top-bar">
        <Link className="back" to={supplierPath}>
          ← {payment.supplierName}
        </Link>
      </div>
      <h1>Pago registrado</h1>
      <p className="muted">{paymentLine(payment)}</p>
      <p className="summary-total">{formatMoney(payment.amount)}</p>
      {payment.notes !== null && <p className="muted">Notas: {payment.notes}</p>}

      {payment.applications.length > 0 && (
        <ul className="list">
          {payment.applications.map((application) => (
            <li key={application.documentId} className="row">
              <span className="row-main">
                <span className="row-title">{documentTitle(application)}</span>
                <span className={`badge ${application.status}`}>{DOCUMENT_STATUS_LABELS[application.status]}</span>
              </span>
              <span className="row-detail">aplicado {formatMoney(application.amount)}</span>
              {application.partial && (
                <span className="row-detail">Pago parcial · quedan {formatMoney(application.remaining)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <dl className="figures">
        <div>
          <dt>Sin aplicar</dt>
          <dd>{formatMoney(payment.unapplied)}</dd>
        </div>
      </dl>

      <Link className="button" to={supplierPath}>
        Volver al proveedor
      </Link>
    </section>
  )
}

export default PagoRegistrado
