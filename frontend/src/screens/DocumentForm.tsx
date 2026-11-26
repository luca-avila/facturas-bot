import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  createDocument,
  listSuppliers,
  type ApiResult,
  type DocumentInput,
  type DocumentType,
  type SupplierList,
} from '../accounts-api'
import { parseAmountInput } from '../format'
import { DOCUMENT_TYPE_LABELS, ISSUE_MESSAGES } from '../labels'
import Field from './Field'
import { failedSave, localError, type FieldMessages } from './form-errors'

const TYPES = Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]
const LETTERS = ['A', 'B', 'C', 'M', 'X']

interface Details {
  letter: string
  number: string
  issueDate: string
  dueDate: string
  total: string
  notes: string
}

interface SuspectedDuplicatePrompt {
  documentId: string
  another: boolean
}

const EMPTY: Details = { letter: '', number: '', issueDate: '', dueDate: '', total: '', notes: '' }

/** *Cargar documento*, with the supplier from the path preselected. */
function DocumentForm() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const ids = useId()
  const [suppliers, setSuppliers] = useState<ApiResult<SupplierList> | null>(null)
  const [supplierId, setSupplierId] = useState(id)
  const [type, setType] = useState<DocumentType>(params.get('tipo') === 'saldo-inicial' ? 'opening_balance' : 'invoice')
  const [details, setDetails] = useState<Details>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const [suspectedDuplicate, setSuspectedDuplicate] = useState<SuspectedDuplicatePrompt | null>(null)

  useEffect(() => {
    let current = true
    void listSuppliers({ q: '', sort: 'name' }).then((result) => {
      if (current) setSuppliers(result)
    })
    return () => {
      current = false
    }
  }, [])

  const set = (key: keyof Details, value: string) => {
    setSavedNotice(false)
    setSuspectedDuplicate(null)
    setDetails((d) => ({ ...d, [key]: value }))
  }
  const supplier = suppliers?.ok ? suppliers.value.suppliers.find((s) => s.id === supplierId) : undefined
  const isOpening = type === 'opening_balance'
  const hasDueDate = type !== 'credit_note'
  const needsTypedDueDate = (type === 'invoice' || type === 'delivery_note') && supplier?.paymentTermDays === null

  async function submitDocument(another: boolean, allowSuspectedDuplicate: boolean) {
    setFormMessage(null)
    setSavedNotice(false)
    const total = parseAmountInput(details.total)
    if (total === null) {
      setFieldMessages(localError('total', 'total_invalid'))
      return
    }
    const input: DocumentInput = {
      supplierId,
      type,
      letter: isOpening || details.letter === '' ? null : details.letter,
      number: isOpening ? null : details.number,
      issueDate: details.issueDate,
      dueDate: !hasDueDate || details.dueDate === '' ? null : details.dueDate,
      total,
      notes: details.notes,
      ...(allowSuspectedDuplicate ? { allowSuspectedDuplicate: true } : {}),
    }
    setSaving(true)
    const result = await createDocument(input)
    setSaving(false)
    if (result.ok) {
      setFieldMessages({})
      setSuspectedDuplicate(null)
      if (another) {
        setDetails(EMPTY)
        setSavedNotice(true)
      } else {
        navigate(`/proveedores/${supplierId}`)
      }
      return
    }
    if (result.error === 'rejected') {
      const dup = result.fieldErrors.find(
        (err) => err.code === 'duplicate_suspected' && typeof err.documentId === 'string',
      )
      if (dup?.documentId !== undefined) {
        setFieldMessages({})
        setFormMessage(null)
        setSuspectedDuplicate({ documentId: dup.documentId, another })
        return
      }
    }
    setSuspectedDuplicate(null)
    const failure = failedSave(result)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const another = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'another'
    void submitDocument(another, false)
  }

  return (
    <section className="screen">
      <div className="top-bar">
        <Link to={`/proveedores/${supplierId}`}>Cancelar</Link>
        <span className="top-title">Cargar documento</span>
      </div>

      {suppliers !== null && !suppliers.ok && (
        <p role="alert" className="error">
          No pudimos cargar los proveedores. Revisá la conexión.
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <Field id={`${ids}-supplier`} label="Proveedor">
          <select
            id={`${ids}-supplier`}
            value={supplierId}
            onChange={(e) => {
              setSuspectedDuplicate(null)
              setSupplierId(e.target.value)
            }}
          >
            {supplier === undefined && <option value={supplierId}>{suppliers === null ? 'Cargando…' : ''}</option>}
            {suppliers?.ok &&
              suppliers.value.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>

        <Field id={`${ids}-type`} label="Tipo">
          <select
            id={`${ids}-type`}
            value={type}
            onChange={(e) => {
              setSuspectedDuplicate(null)
              setType(TYPES.find((t) => t === e.target.value) ?? 'invoice')
            }}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {isOpening && (
            <span className="hint">
              Uno para lo vencido y otro para lo que todavía no venció. Copiá los montos de la planilla.
            </span>
          )}
        </Field>

        {!isOpening && (
          <div className="pair">
            <Field id={`${ids}-letter`} label="Letra">
              <select id={`${ids}-letter`} value={details.letter} onChange={(e) => set('letter', e.target.value)}>
                <option value="">—</option>
                {LETTERS.map((letter) => (
                  <option key={letter} value={letter}>
                    {letter}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${ids}-number`} label="Número" error={fieldMessages.number}>
              <input id={`${ids}-number`} value={details.number} onChange={(e) => set('number', e.target.value)} />
            </Field>
          </div>
        )}

        <Field id={`${ids}-issue`} label={isOpening ? 'Fecha' : 'Fecha de emisión'} error={fieldMessages.issueDate}>
          <input
            id={`${ids}-issue`}
            type="date"
            value={details.issueDate}
            onChange={(e) => set('issueDate', e.target.value)}
          />
        </Field>

        {hasDueDate && (
          <Field
            id={`${ids}-due`}
            label={needsTypedDueDate ? 'Vencimiento *' : 'Vencimiento'}
            error={fieldMessages.dueDate}
          >
            <input
              id={`${ids}-due`}
              type="date"
              value={details.dueDate}
              onChange={(e) => set('dueDate', e.target.value)}
            />
            <span className="hint">
              {isOpening ? (
                'Si no tiene vencimiento, cuenta como sin vencer.'
              ) : needsTypedDueDate && supplier ? (
                <>
                  {supplier.name} no tiene plazo de pago: ingresá el vencimiento a mano o{' '}
                  <Link to={`/proveedores/${supplier.id}/editar`}>definí el plazo</Link>.
                </>
              ) : supplier?.paymentTermDays != null ? (
                `Si lo dejás vacío, vence ${supplier.paymentTermDays} días después de la fecha de emisión, según el plazo del proveedor.`
              ) : (
                ''
              )}
            </span>
          </Field>
        )}

        <Field id={`${ids}-total`} label="Total" error={fieldMessages.total}>
          <input
            id={`${ids}-total`}
            inputMode="decimal"
            placeholder="$ 0,00"
            value={details.total}
            onChange={(e) => set('total', e.target.value)}
          />
        </Field>

        <Field id={`${ids}-notes`} label="Notas">
          <textarea id={`${ids}-notes`} value={details.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>

        <p role="alert" className="error">
          {formMessage ?? ''}
        </p>
        {savedNotice && <p className="notice">Guardado.</p>}

        {suspectedDuplicate !== null && (
          <div className="inline-panel" role="alert">
            <p>
              <strong>{ISSUE_MESSAGES.duplicate_suspected}</strong>
            </p>
            <div className="resolver-actions">
              <button
                type="button"
                className="compact-btn"
                disabled={saving}
                onClick={() => void submitDocument(suspectedDuplicate.another, true)}
              >
                {saving ? 'Guardando…' : 'Guardar igual'}
              </button>
              <Link className="button secondary compact" to={`/documentos/${suspectedDuplicate.documentId}`}>
                Ver el existente
              </Link>
              <button
                type="button"
                className="secondary compact-btn"
                disabled={saving}
                onClick={() => setSuspectedDuplicate(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        <div className="buttons">
          <button type="submit" value="save" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="submit" value="another" className="secondary" disabled={saving}>
            Guardar y cargar otro
          </button>
        </div>
      </form>
    </section>
  )
}

export default DocumentForm
