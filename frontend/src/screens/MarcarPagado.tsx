import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { getSupplier, markPaid, type AccountDocument, type ApiResult, type SupplierAccount } from '../accounts-api'
import { documentTitle, formatMoney } from '../format'
import { failedSave, type FieldMessages } from './form-errors'
import PaymentFields from './PaymentFields'
import { initialPaymentFields, valueDateFor, type PaymentFieldValues } from './payment-fields'

/** *Marcar como pagado* (7g): a payment of exactly what's left on one document. */
function MarcarPagado() {
  const { id = '', documentId = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; result: ApiResult<SupplierAccount> } | null>(null)
  const key = `${id}\n${attempt}`

  useEffect(() => {
    let current = true
    void getSupplier(id).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [id, key])

  const supplierPath = `/proveedores/${id}`
  // While reloading after a refusal, the previous data stays on screen.
  const result = loaded?.result ?? null

  if (result === null || !result.ok) {
    return (
      <section className="screen">
        <Link className="back" to={supplierPath}>
          ← Proveedor
        </Link>
        {result === null ? (
          <p className="muted">Cargando…</p>
        ) : (
          <div className="empty">
            <p className="empty-title">No pudimos cargar el documento.</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </section>
    )
  }

  const account = result.value
  const doc = account.documents.find((d) => d.id === documentId)
  if (doc === undefined || (doc.status !== 'pending' && doc.status !== 'overdue')) {
    return (
      <section className="screen">
        <div className="top-bar">
          <Link className="back" to={supplierPath}>
            ← {account.name}
          </Link>
        </div>
        <p className="empty-title">Este documento ya no tiene saldo.</p>
      </section>
    )
  }

  return (
    <SettleForm
      key={doc.id}
      account={account}
      doc={doc}
      onRefused={() => setAttempt((n) => n + 1)}
    />
  )
}

function SettleForm({
  account,
  doc,
  onRefused,
}: {
  account: SupplierAccount
  doc: AccountDocument
  onRefused: () => void
}) {
  const navigate = useNavigate()
  const ids = useId()
  const [fields, setFields] = useState<PaymentFieldValues>(initialPaymentFields(account.today))
  const [messages, setMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const supplierPath = `/proveedores/${account.id}`

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormMessage(null)
    setSaving(true)
    const result = await markPaid({
      documentId: doc.id,
      amount: doc.remaining,
      paidOn: fields.paidOn,
      method: fields.method,
      reference: fields.reference,
      valueDate: valueDateFor(fields),
    })
    setSaving(false)
    if (result.ok) {
      navigate(supplierPath)
      return
    }
    const failure = failedSave(result)
    setMessages(failure.fields)
    setFormMessage(failure.form)
    if (result.error === 'rejected' && result.fieldErrors.some((e) => e.field === 'amount' || e.field === 'documentId')) {
      setFormMessage(Object.values(failure.fields).join(' '))
      onRefused()
    }
  }

  return (
    <section className="screen">
      <div className="top-bar">
        <Link className="back" to={supplierPath}>
          ← {account.name}
        </Link>
      </div>
      <h1>Marcar como pagado</h1>
      <p className="muted">
        {documentTitle(doc)} · {account.name}
      </p>

      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <span className="label-text" id={`${ids}-amount`}>
            Monto (lo que falta)
          </span>
          <span className="summary-total" aria-labelledby={`${ids}-amount`}>
            {formatMoney(doc.remaining)}
          </span>
        </div>

        <PaymentFields values={fields} onChange={setFields} messages={messages} />

        <p role="alert" className="error">
          {formMessage ?? ''}
        </p>

        <button type="submit" disabled={saving}>
          {saving ? 'Guardando…' : 'Marcar como pagado'}
        </button>
      </form>

      <Link to={`/pagos/nuevo?proveedor=${encodeURIComponent(account.id)}`}>¿Pagaste otro monto? Registrar pago</Link>
    </section>
  )
}

export default MarcarPagado
