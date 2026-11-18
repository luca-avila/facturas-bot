import { useEffect, useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { applyCredit, getSupplier, type ApiResult, type SupplierAccount } from '../accounts-api'
import { documentTitle, formatDate, formatMoney } from '../format'
import { FIELD_ERROR_MESSAGES, PAYMENT_METHOD_LABELS, REJECTED_WITHOUT_FIELDS_MESSAGE } from '../labels'
import { failedSave } from './form-errors'
import SplitRows from './SplitRows'
import { splitFormErrors, useSplit } from './use-split'

interface CreditSource {
  kind: 'payment' | 'credit_note'
  id: string
  title: string
  detail: string
  available: string
}

/** Available credit notes first, then available payments, each in the backend's order. */
function creditSources(account: SupplierAccount): CreditSource[] {
  const notes = account.documents
    .filter((doc) => doc.type === 'credit_note' && doc.status === 'available')
    .map((doc) => ({
      kind: 'credit_note' as const,
      id: doc.id,
      title: documentTitle(doc),
      detail: `Emitida ${formatDate(doc.issueDate)}`,
      available: doc.remaining,
    }))
  const payments = account.payments
    .filter((payment) => payment.status === 'available')
    .map((payment) => ({
      kind: 'payment' as const,
      id: payment.id,
      title: `Pago ${PAYMENT_METHOD_LABELS[payment.method]} · ${formatDate(payment.paidOn)}`,
      detail: payment.reference ?? '',
      available: payment.unapplied,
    }))
  return [...notes, ...payments]
}

/** *Aplicar crédito* (7h), from *Proveedor*'s *Crédito a favor* card. */
function AplicarCredito() {
  const { id = '' } = useParams()
  const ids = useId()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; result: ApiResult<SupplierAccount> } | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
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
  const cancel = <Link to={supplierPath}>Cancelar</Link>

  if (result === null || !result.ok) {
    return (
      <section className="screen">
        <div className="top-bar">{cancel}</div>
        {result === null ? (
          <p className="muted">Cargando…</p>
        ) : result.error === 'not_found' ? (
          <p className="empty-title">No encontramos este proveedor.</p>
        ) : (
          <div className="empty">
            <p className="empty-title">No pudimos cargar el crédito.</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </section>
    )
  }

  const account = result.value
  const sources = creditSources(account)
  const source = sources.find((s) => s.id === chosen) ?? sources[0]

  return (
    <section className="screen">
      <div className="top-bar">
        {cancel}
        <span className="top-title">Aplicar crédito</span>
      </div>
      <p className="muted">{account.name} · crédito disponible</p>

      {source === undefined ? (
        <p className="empty-title">No hay crédito a favor para aplicar.</p>
      ) : (
        <>
          {sources.length === 1 ? (
            <SourceCard source={source} />
          ) : (
            <fieldset className="radio-list">
              <legend className="visually-hidden">Crédito a aplicar</legend>
              {sources.map((s) => (
                <label key={s.id} className="radio-row" htmlFor={`${ids}-${s.id}`}>
                  <input
                    id={`${ids}-${s.id}`}
                    type="radio"
                    name={`${ids}-source`}
                    checked={s.id === source.id}
                    onChange={() => setChosen(s.id)}
                  />
                  <SourceCard source={s} />
                </label>
              ))}
            </fieldset>
          )}
          <CreditSplit
            key={`${source.kind}:${source.id}`}
            source={{ kind: source.kind, id: source.id }}
            onSourceRefused={() => setAttempt((n) => n + 1)}
            supplierPath={supplierPath}
          />
        </>
      )}
    </section>
  )
}

function SourceCard({ source }: { source: CreditSource }) {
  return (
    <span className="source-card">
      <span className="row-title">{source.title}</span>
      <span className="row-detail">
        {[source.detail, `Disponible ${formatMoney(source.available)}`].filter((part) => part !== '').join(' · ')}
      </span>
    </span>
  )
}

function CreditSplit({
  source,
  supplierPath,
  onSourceRefused,
}: {
  source: { kind: 'payment' | 'credit_note'; id: string }
  supplierPath: string
  /** The source can't give any more, so the list of sources is reloaded. */
  onSourceRefused: () => void
}) {
  const navigate = useNavigate()
  const state = useSplit(source)
  const [saving, setSaving] = useState(false)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const split = state.split

  async function apply() {
    setFormMessage(null)
    setSaving(true)
    const result = await applyCredit({ source, applications: state.rows() })
    setSaving(false)
    if (result.ok) {
      navigate(supplierPath)
      return
    }
    if (result.error === 'rejected' && result.fieldErrors.length > 0) {
      state.setSaveErrors(result.fieldErrors)
      state.refresh()
      if (result.fieldErrors.some((e) => e.field === 'source')) onSourceRefused()
      return
    }
    setFormMessage(failedSave(result).form ?? REJECTED_WITHOUT_FIELDS_MESSAGE)
  }

  const formErrors = splitFormErrors(state)
  const blocked = saving || state.pending || state.anyInvalid || split === null || split.errors.length > 0

  return (
    <>
      <h2 className="section-label">Aplicar a</h2>
      {split !== null && split.rows.length === 0 ? (
        <p className="empty-title">No hay documentos con saldo para aplicar el crédito.</p>
      ) : (
        <SplitRows state={state} />
      )}

      {state.failed && (
        <p role="alert" className="error">
          No pudimos calcular el reparto. Revisá la conexión.{' '}
          <button type="button" className="link" onClick={state.refresh}>
            Reintentar
          </button>
        </p>
      )}

      {split !== null && split.rows.length > 0 && (
        <div className="split-footer">
          <dl className="figures">
            <div>
              <dt>Aplicado</dt>
              <dd>{formatMoney(split.applied)}</dd>
            </div>
            <div>
              <dt>Queda crédito</dt>
              <dd>{split.excess === '0.00' ? formatMoney(split.unapplied) : '−'}</dd>
            </div>
          </dl>
          {split.excess !== '0.00' && (
            <p className="field-error">Aplicaste {formatMoney(split.excess)} más que el crédito disponible.</p>
          )}
        </div>
      )}

      <p role="alert" className="error">
        {formMessage ?? formErrors.map((e) => FIELD_ERROR_MESSAGES[e.code]).join(' ')}
      </p>

      <button type="button" disabled={blocked} onClick={() => void apply()}>
        {saving ? 'Aplicando…' : 'Aplicar'}
      </button>
    </>
  )
}

export default AplicarCredito
