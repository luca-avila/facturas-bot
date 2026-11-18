import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { listPayments, listSuppliers, type ApiResult, type PaymentList, type SupplierList } from '../accounts-api'
import { formatMoney } from '../format'
import { paymentSummaryLine } from './payment-lines'

interface Loaded {
  key: string
  result: ApiResult<PaymentList>
}

/** *Pagos* (7a): every payment, newest first, filtered by supplier. */
function Pagos() {
  const [params, setParams] = useSearchParams()
  const supplierId = params.get('proveedor')
  const [suppliers, setSuppliers] = useState<ApiResult<SupplierList> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${supplierId ?? ''}\n${attempt}`

  useEffect(() => {
    let current = true
    void listSuppliers({ q: '', sort: 'name' }).then((result) => {
      if (current) setSuppliers(result)
    })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    // Only the latest response is applied.
    let current = true
    void listPayments({ supplierId }).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [supplierId, key])

  const result = loaded?.key === key ? loaded.result : null
  const newPath = supplierId === null ? '/pagos/nuevo' : `/pagos/nuevo?proveedor=${encodeURIComponent(supplierId)}`

  return (
    <section className="screen">
      <div className="top-bar">
        <h1>Pagos</h1>
        <Link className="button compact" to={newPath}>
          + Registrar pago
        </Link>
      </div>

      <select
        aria-label="Proveedor"
        value={supplierId ?? ''}
        onChange={(event) => setParams(event.target.value === '' ? {} : { proveedor: event.target.value }, { replace: true })}
      >
        <option value="">Todos los proveedores</option>
        {suppliers?.ok &&
          suppliers.value.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
      </select>

      {result === null && <p className="muted">Cargando…</p>}

      {result !== null && !result.ok && (
        <div className="empty">
          <p className="empty-title">No pudimos cargar los pagos.</p>
          <p className="muted">Revisá la conexión.</p>
          <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {result?.ok && result.value.payments.length === 0 && (
        <p className="empty-title">{supplierId === null ? 'Todavía no hay pagos.' : 'Este proveedor no tiene pagos.'}</p>
      )}

      {result?.ok && result.value.payments.length > 0 && (
        <ul className="list">
          {result.value.payments.map((payment) => (
            <li key={payment.id}>
              <Link className="row" to={`/pagos/${payment.id}`}>
                <span className="row-main">
                  <span className="row-title">{payment.supplierName}</span>
                  <span className="row-amount">{formatMoney(payment.amount)}</span>
                </span>
                <span className="row-detail">{paymentSummaryLine(payment)}</span>
                <span className="row-detail">{payment.createdByName}</span>
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

export default Pagos
