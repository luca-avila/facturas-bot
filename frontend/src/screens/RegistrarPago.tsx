import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  createPayment,
  listSuppliers,
  previewSplit,
  type ApiResult,
  type Split,
  type SplitSource,
  type SupplierList,
} from '../accounts-api'
import { formatMoney, parseAmountInput } from '../format'
import { FIELD_ERROR_MESSAGES, REJECTED_WITHOUT_FIELDS_MESSAGE } from '../labels'
import Field from './Field'
import { failedSave, localError, type FieldMessages } from './form-errors'
import PaymentFields from './PaymentFields'
import { initialPaymentFields, valueDateFor, type PaymentFieldValues } from './payment-fields'
import SplitRows from './SplitRows'
import { splitFormErrors, useSplit } from './use-split'

interface Details {
  supplierId: string
  amount: string
  fields: PaymentFieldValues
  notes: string
}

/** Fields of step 1 that a save can still refuse. */
const STEP_ONE_FIELDS = ['amount', 'paidOn', 'valueDate']

/** *Registrar pago*: the payment's data (7b), then its split (7c, 7d, 7e). */
function RegistrarPago() {
  const [params] = useSearchParams()
  const ids = useId()
  const [suppliers, setSuppliers] = useState<ApiResult<SupplierList> | null>(null)
  const [details, setDetails] = useState<Details>({
    supplierId: params.get('proveedor') ?? '',
    amount: '',
    fields: initialPaymentFields(''),
    notes: '',
  })
  const [messages, setMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [step2, setStep2] = useState<{ source: SplitSource & { kind: 'new_payment' }; initial: Split } | null>(null)

  useEffect(() => {
    let current = true
    void listSuppliers({ q: '', sort: 'name' }).then((result) => {
      if (!current) return
      setSuppliers(result)
      if (result.ok) {
        const today = result.value.today
        setDetails((d) => {
          const fields = d.fields.paidOn === '' ? { ...d.fields, paidOn: today } : d.fields
          return { ...d, fields }
        })
      }
    })
    return () => {
      current = false
    }
  }, [])

  const supplier = suppliers?.ok ? suppliers.value.suppliers.find((s) => s.id === details.supplierId) : undefined
  const cancelPath = details.supplierId === '' ? '/pagos' : `/proveedores/${details.supplierId}`

  async function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormMessage(null)
    const amount = parseAmountInput(details.amount)
    if (amount === null) {
      setMessages(localError('amount', 'amount_invalid'))
      return
    }
    const source = { kind: 'new_payment' as const, supplierId: details.supplierId, amount }
    setLoading(true)
    const result = await previewSplit({ source, applications: null })
    setLoading(false)
    if (result.ok) {
      setMessages({})
      setStep2({ source, initial: result.value })
      return
    }
    const failure = failedSave(result)
    setMessages(failure.fields)
    setFormMessage(failure.form)
  }

  if (step2 !== null) {
    return (
      <Reparto
        key={JSON.stringify(step2.source)}
        source={step2.source}
        initial={step2.initial}
        details={details}
        onBack={(stepOneMessages) => {
          setMessages(stepOneMessages)
          setStep2(null)
        }}
      />
    )
  }

  return (
    <section className="screen">
      <div className="top-bar">
        <Link to={cancelPath}>Cancelar</Link>
        <span className="top-title">Registrar pago</span>
        <span className="muted">1 de 2</span>
      </div>

      {suppliers !== null && !suppliers.ok && (
        <p role="alert" className="error">
          No pudimos cargar los proveedores. Revisá la conexión.
        </p>
      )}

      <form onSubmit={(event) => void next(event)} noValidate>
        <Field id={`${ids}-supplier`} label="Proveedor">
          <select
            id={`${ids}-supplier`}
            value={details.supplierId}
            onChange={(e) => setDetails((d) => ({ ...d, supplierId: e.target.value }))}
          >
            {supplier === undefined && (
              <option value={details.supplierId}>
                {suppliers === null ? 'Cargando…' : details.supplierId === '' ? 'Elegí un proveedor' : ''}
              </option>
            )}
            {suppliers?.ok &&
              suppliers.value.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          {supplier !== undefined && (
            <span className="hint">
              Debe {formatMoney(supplier.balance)} · vencido {formatMoney(supplier.overdue)}
            </span>
          )}
        </Field>

        <Field id={`${ids}-amount`} label="Monto" error={messages.amount}>
          <input
            id={`${ids}-amount`}
            inputMode="decimal"
            placeholder="$ 0,00"
            value={details.amount}
            onChange={(e) => setDetails((d) => ({ ...d, amount: e.target.value }))}
          />
        </Field>

        <PaymentFields
          values={details.fields}
          onChange={(fields) => setDetails((d) => ({ ...d, fields }))}
          messages={messages}
        />

        <Field id={`${ids}-notes`} label="Notas">
          <textarea
            id={`${ids}-notes`}
            value={details.notes}
            onChange={(e) => setDetails((d) => ({ ...d, notes: e.target.value }))}
          />
        </Field>

        <p role="alert" className="error">
          {formMessage ?? ''}
        </p>

        <button type="submit" disabled={loading || details.supplierId === ''}>
          {loading ? 'Cargando…' : 'Siguiente: repartir'}
        </button>
      </form>
    </section>
  )
}

/** Step 2: the split of the payment, then the save. */
function Reparto({
  source,
  initial,
  details,
  onBack,
}: {
  source: SplitSource & { kind: 'new_payment' }
  initial: Split
  details: Details
  onBack: (stepOneMessages: FieldMessages) => void
}) {
  const navigate = useNavigate()
  const state = useSplit(source, initial)
  const [saving, setSaving] = useState(false)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const split = state.split

  async function save() {
    setFormMessage(null)
    setSaving(true)
    const result = await createPayment({
      supplierId: source.supplierId,
      amount: source.amount,
      paidOn: details.fields.paidOn,
      method: details.fields.method,
      reference: details.fields.reference,
      valueDate: valueDateFor(details.fields),
      notes: details.notes,
      applications: state.rows(),
    })
    setSaving(false)
    if (result.ok) {
      navigate(`/pagos/${result.value.id}`)
      return
    }
    if (result.error === 'rejected' && result.fieldErrors.some((e) => STEP_ONE_FIELDS.includes(e.field))) {
      onBack(failedSave(result).fields)
      return
    }
    if (result.error === 'rejected' && result.fieldErrors.length > 0) {
      state.setSaveErrors(result.fieldErrors)
      state.refresh()
      return
    }
    setFormMessage(failedSave(result).form ?? REJECTED_WITHOUT_FIELDS_MESSAGE)
  }

  const formErrors = splitFormErrors(state)
  const blocked = saving || state.pending || state.anyInvalid || split === null || split.errors.length > 0

  return (
    <section className="screen">
      <div className="top-bar">
        <button type="button" className="link back" onClick={() => onBack({})}>
          ← Atrás
        </button>
        <span className="top-title">Repartir {formatMoney(initial.available)}</span>
        <span className="muted">2 de 2</span>
      </div>

      {split !== null && split.rows.length === 0 ? (
        <p className="empty-title">
          Este proveedor no tiene documentos con saldo. Todo el pago queda como crédito a favor.
        </p>
      ) : (
        <p className="hint">Lo repartimos desde el vencimiento más viejo. Podés cambiar cada monto.</p>
      )}

      <SplitRows state={state} />

      {state.failed && (
        <p role="alert" className="error">
          No pudimos calcular el reparto. Revisá la conexión.{' '}
          <button type="button" className="link" onClick={state.refresh}>
            Reintentar
          </button>
        </p>
      )}

      {split !== null && (
        <div className="split-footer">
          <dl className="figures">
            <div>
              <dt>Aplicado</dt>
              <dd>{formatMoney(split.applied)}</dd>
            </div>
            <div>
              <dt>Sin aplicar</dt>
              <dd>{split.excess === '0.00' ? formatMoney(split.unapplied) : '−'}</dd>
            </div>
          </dl>
          {split.excess !== '0.00' && (
            <p className="field-error">Repartiste {formatMoney(split.excess)} más que el pago.</p>
          )}
          {split.unapplied !== '0.00' && (
            <p className="notice">→ {formatMoney(split.unapplied)} queda como crédito a favor</p>
          )}
        </div>
      )}

      <p role="alert" className="error">
        {formMessage ?? formErrors.map((e) => FIELD_ERROR_MESSAGES[e.code]).join(' ')}
      </p>

      <button type="button" disabled={blocked} onClick={() => void save()}>
        {saving ? 'Guardando…' : 'Guardar pago'}
      </button>
    </section>
  )
}

export default RegistrarPago
