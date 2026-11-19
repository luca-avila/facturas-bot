import { useId } from 'react'
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '../labels'
import Field from './Field'
import type { FieldMessages } from './form-errors'
import type { PaymentFieldValues } from './payment-fields'

/** The payment fields *Registrar pago* and *Marcar como pagado* share: *Medio*, the dates and *Referencia*. */
function PaymentFields({
  values,
  onChange,
  messages,
}: {
  values: PaymentFieldValues
  onChange: (next: PaymentFieldValues) => void
  messages: FieldMessages
}) {
  const ids = useId()
  const set = <K extends keyof PaymentFieldValues>(key: K, value: PaymentFieldValues[K]) =>
    onChange({ ...values, [key]: value })

  return (
    <>
      <fieldset className="field chips-field">
        <legend>Medio</legend>
        <div className="chips">
          {PAYMENT_METHODS.map((method) => (
            <button
              key={method}
              type="button"
              className={method === values.method ? 'chip selected' : 'chip'}
              aria-pressed={method === values.method}
              onClick={() => set('method', method)}
            >
              {PAYMENT_METHOD_LABELS[method]}
            </button>
          ))}
        </div>
      </fieldset>

      <Field id={`${ids}-paid-on`} label="Fecha de pago" error={messages.paidOn}>
        <input
          id={`${ids}-paid-on`}
          type="date"
          value={values.paidOn}
          onChange={(e) => set('paidOn', e.target.value)}
        />
      </Field>

      <Field id={`${ids}-reference`} label="Referencia">
        <input
          id={`${ids}-reference`}
          placeholder="Opcional"
          value={values.reference}
          onChange={(e) => set('reference', e.target.value)}
        />
      </Field>

      {values.method === 'echeq' && (
        <Field id={`${ids}-value-date`} label="Fecha de cobro" error={messages.valueDate}>
          <input
            id={`${ids}-value-date`}
            type="date"
            value={values.valueDate}
            onChange={(e) => set('valueDate', e.target.value)}
          />
          <span className="hint">Opcional.</span>
        </Field>
      )}
    </>
  )
}

export default PaymentFields
