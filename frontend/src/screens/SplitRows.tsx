import { useId } from 'react'
import type { FieldError, SplitRowResult } from '../accounts-api'
import { documentTitle, formatDueIn, formatMoney } from '../format'
import { FIELD_ERROR_MESSAGES } from '../labels'
import type { SplitState } from './use-split'

/** "vencido hace 42 días", "en 8 días", or "Sin vencimiento". */
function when(row: SplitRowResult): string {
  if (row.dueDate === null || row.daysToDue === null) return 'Sin vencimiento'
  const dueIn = formatDueIn(row.daysToDue)
  return row.status === 'overdue' ? `vencido ${dueIn}` : dueIn
}

/** What saving would do to the row, or nothing when it applies nothing. */
function effect(row: SplitRowResult): string | null {
  if (row.amount === '0.00') return null
  return row.after.status === 'paid' ? '→ Pagado' : `→ quedan ${formatMoney(row.after.remaining)}`
}

function rowMessage(row: SplitRowResult, error: FieldError | undefined): string | null {
  if (error === undefined) return null
  if (error.code === 'exceeds_remaining') {
    return `Es más de lo que falta pagar de este documento (${formatMoney(row.remaining)}).`
  }
  return FIELD_ERROR_MESSAGES[error.code]
}

/** The editable rows of a split, shared by *Registrar pago* and *Aplicar crédito* (7c, 7d, 7e, 7h). */
function SplitRows({ state }: { state: SplitState }) {
  const ids = useId()
  const split = state.split
  if (split === null) return null
  const errors = [...state.saveErrors, ...split.errors]

  return (
    <>
      {state.edited && (
        <p className="notice split-edited">
          Cambiaste el reparto.{' '}
          <button type="button" className="link" onClick={state.reset}>
            Volver al sugerido
          </button>
        </p>
      )}
      <ul className="list split-rows">
        {split.rows.map((row) => {
          const inputId = `${ids}-${row.documentId}`
          const invalid = state.invalid(row.documentId)
          const error = errors.find((e) => e.field === `applications.${row.documentId}`)
          const message = invalid ? FIELD_ERROR_MESSAGES.application_amount_invalid : rowMessage(row, error)
          const after = message === null && !state.pending ? effect(row) : null
          return (
            <li key={row.documentId} className="split-row">
              <div className="split-row-main">
                <label htmlFor={inputId} className="split-row-label">
                  <span className="row-title">{documentTitle(row)}</span>
                  <span className={row.status === 'overdue' ? 'row-detail overdue' : 'row-detail'}>{when(row)}</span>
                  <span className="row-detail">
                    Falta {formatMoney(row.remaining)}
                    {after !== null && <strong className="split-after"> {after}</strong>}
                  </span>
                </label>
                <input
                  id={inputId}
                  className="split-amount"
                  inputMode="decimal"
                  aria-invalid={message !== null}
                  value={state.text(row.documentId)}
                  onChange={(event) => state.setText(row.documentId, event.target.value)}
                />
              </div>
              {message !== null && <span className="field-error">{message}</span>}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default SplitRows
