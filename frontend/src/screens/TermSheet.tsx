import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  previewSupplierTerm,
  setSupplierTerm,
  type ApiResult,
  type TermPreview,
  type TermPreviewDocument,
} from '../accounts-api'
import { documentTitle, formatDate } from '../format'
import { ISSUE_MESSAGES } from '../labels'
import Field from './Field'
import { failedSave, localError, type FieldMessages } from './form-errors'

interface Props {
  supplierId: string
  supplierName: string
  suggestedTermDays: number | null
  onSaved: (preview: TermPreview) => void
  onClose: () => void
  onManualDueDate?: () => void
}

function readTerm(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 0 && value <= 365 ? value : null
}

function previewDocLine(doc: TermPreviewDocument): string {
  const title = documentTitle({ type: doc.type, letter: doc.letter, number: doc.number })
  if (doc.willUnblock && doc.dueDate !== null) {
    return `${title}: vence el ${formatDate(doc.dueDate)}`
  }
  const issues = doc.remainingIssues.map((code) => ISSUE_MESSAGES[code]).join(' ')
  return doc.dueDate !== null
    ? `${title} (vence el ${formatDate(doc.dueDate)}): sigue en Error (${issues})`
    : `${title}: sigue en Error (${issues})`
}

/** *Definir plazo* (6d): previews which Error documents unblock before saving. */
function TermSheet({ supplierId, supplierName, suggestedTermDays, onSaved, onClose, onManualDueDate }: Props) {
  const ids = useId()
  const [termText, setTermText] = useState(suggestedTermDays === null ? '' : String(suggestedTermDays))
  const [previewState, setPreviewState] = useState<{ key: string; result: ApiResult<TermPreview> } | null>(null)
  const [saving, setSaving] = useState(false)
  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)

  const term = readTerm(termText)
  const previewKey = term === null ? null : `${supplierId}\n${term}`

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  useEffect(() => {
    if (term === null || previewKey === null) return
    let current = true
    void previewSupplierTerm(supplierId, term).then((result) => {
      if (current) setPreviewState({ key: previewKey, result })
    })
    return () => {
      current = false
    }
  }, [supplierId, term, previewKey])

  const previewResult = previewKey !== null && previewState?.key === previewKey ? previewState.result : null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormMessage(null)
    if (term === null) {
      setFieldMessages(localError('paymentTermDays', 'payment_term_invalid'))
      return
    }
    setSaving(true)
    const result = await setSupplierTerm(supplierId, term)
    setSaving(false)
    if (result.ok) {
      onSaved(result.value)
      return
    }
    const failure = failedSave(result)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form)
  }

  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`}>
        <div className="top-bar">
          <h2 id={`${ids}-title`} className="sheet-title">
            Plazo de pago de {supplierName}
          </h2>
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <p className="muted">Se usa para calcular el vencimiento de cada documento.</p>

        {suggestedTermDays !== null && (
          <p className="callout">
            El documento dice <strong>{suggestedTermDays} días</strong>.
          </p>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <Field id={`${ids}-term`} label="Plazo de pago" error={fieldMessages.paymentTermDays}>
            <span className="with-unit">
              <input
                id={`${ids}-term`}
                inputMode="numeric"
                value={termText}
                onChange={(e) => {
                  setTermText(e.target.value)
                  setFieldMessages({})
                  setFormMessage(null)
                }}
              />
              <span>días</span>
            </span>
            <span className="hint">0 = paga al recibir. Máximo 365 días.</span>
          </Field>

          {term !== null && (
            <div className="term-preview">
              {previewResult === null && <p className="muted">Calculando vencimientos…</p>}
              {previewResult !== null && !previewResult.ok && (
                <p className="muted">No pudimos previsualizar los vencimientos.</p>
              )}
              {previewResult?.ok && (
                <>
                  {previewResult.value.documents.length === 0 ? (
                    <p className="muted">No hay documentos en Error esperando este plazo.</p>
                  ) : (
                    <>
                      <p>
                        {previewResult.value.unblockedCount === 0 ? (
                          'Ningún documento se destraba por completo.'
                        ) : (
                          <>
                            Se {previewResult.value.unblockedCount === 1 ? 'destraba' : 'destraban'}{' '}
                            <strong>
                              {previewResult.value.unblockedCount}{' '}
                              {previewResult.value.unblockedCount === 1 ? 'documento' : 'documentos'}
                            </strong>
                            :
                          </>
                        )}
                      </p>
                      <ul className="term-preview-list">
                        {previewResult.value.documents.map((doc) => (
                          <li key={doc.id}>{previewDocLine(doc)}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {formMessage && (
            <p role="alert" className="error">
              {formMessage}
            </p>
          )}

          <div className="buttons">
            <button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : term === null ? 'Guardar plazo' : `Guardar ${term} días`}
            </button>
            {onManualDueDate && (
              <button type="button" className="secondary" disabled={saving} onClick={onManualDueDate}>
                Prefiero poner el vencimiento a mano
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

export default TermSheet
