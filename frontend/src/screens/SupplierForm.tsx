import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  createSupplier,
  getSupplier,
  updateSupplier,
  type SupplierAccount,
  type SupplierInput,
} from '../accounts-api'
import { formatCuit } from '../format'
import Field from './Field'
import { failedSave, localError, type FieldMessages } from './form-errors'
import { resumenPath } from './resumen-search'

interface Values {
  name: string
  legalName: string
  informal: boolean
  cuit: string
  paymentTermDays: string
  notes: string
}

const EMPTY: Values = { name: '', legalName: '', informal: false, cuit: '', paymentTermDays: '', notes: '' }

function valuesOf(supplier: SupplierAccount): Values {
  return {
    name: supplier.name,
    legalName: supplier.legalName ?? '',
    informal: supplier.cuit === null,
    cuit: supplier.cuit === null ? '' : formatCuit(supplier.cuit),
    paymentTermDays: supplier.paymentTermDays === null ? '' : String(supplier.paymentTermDays),
    notes: supplier.notes ?? '',
  }
}

/** The term as the API wants it, or 'invalid' when the field isn't only digits or empty. */
function readTerm(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid'
}

type Loaded = { kind: 'loading' } | { kind: 'ready'; saved: SupplierAccount | null } | { kind: 'not_found' } | { kind: 'failed' }

/** *Proveedor nuevo* without an id in the path, *Editar proveedor* with one. */
function SupplierForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const ids = useId()
  const [loaded, setLoaded] = useState<Loaded>(id === undefined ? { kind: 'ready', saved: null } : { kind: 'loading' })
  const [values, setValues] = useState<Values>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)

  useEffect(() => {
    if (id === undefined) return
    let current = true
    void getSupplier(id).then((result) => {
      if (!current) return
      if (result.ok) {
        setValues(valuesOf(result.value))
        setLoaded({ kind: 'ready', saved: result.value })
      } else {
        setLoaded(result.error === 'not_found' ? { kind: 'not_found' } : { kind: 'failed' })
      }
    })
    return () => {
      current = false
    }
  }, [id])

  const cancelPath = id === undefined ? resumenPath() : `/proveedores/${id}`
  const title = id === undefined ? 'Proveedor nuevo' : 'Editar proveedor'
  const header = (
    <div className="top-bar">
      <Link to={cancelPath}>Cancelar</Link>
      <span className="top-title">{title}</span>
    </div>
  )

  if (loaded.kind !== 'ready') {
    return (
      <section className="screen">
        {header}
        <p className="muted">
          {loaded.kind === 'loading'
            ? 'Cargando…'
            : loaded.kind === 'not_found'
              ? 'No encontramos este proveedor.'
              : 'No pudimos cargar el proveedor. Revisá la conexión.'}
        </p>
      </section>
    )
  }

  const saved = loaded.saved
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }))
  const term = readTerm(values.paymentTermDays)
  const termChanged = saved !== null && term !== 'invalid' && term !== saved.paymentTermDays

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormMessage(null)
    if (term === 'invalid') {
      setFieldMessages(localError('paymentTermDays', 'payment_term_invalid'))
      return
    }
    const input: SupplierInput = {
      name: values.name,
      legalName: values.legalName,
      cuit: values.informal ? null : values.cuit,
      paymentTermDays: term,
      notes: values.notes,
    }
    setSaving(true)
    const result =
      id === undefined
        ? await createSupplier(input)
        : await updateSupplier(id, input).then((r) => (r.ok ? { ok: true as const, value: { id } } : r))
    setSaving(false)
    if (result.ok) {
      navigate(`/proveedores/${result.value.id}`)
      return
    }
    const failure = failedSave(result)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form)
  }

  return (
    <section className="screen">
      {header}
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field id={`${ids}-name`} label="Nombre (como lo llaman ustedes)" error={fieldMessages.name}>
          <input id={`${ids}-name`} value={values.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id={`${ids}-legal`} label="Razón social" error={fieldMessages.legalName}>
          <input id={`${ids}-legal`} value={values.legalName} onChange={(e) => set('legalName', e.target.value)} />
        </Field>
        <div className="checkbox">
          <input
            id={`${ids}-informal`}
            type="checkbox"
            checked={values.informal}
            onChange={(e) => set('informal', e.target.checked)}
          />
          <label htmlFor={`${ids}-informal`}>
            Proveedor informal
            <span className="hint">No tiene CUIT</span>
          </label>
        </div>
        {!values.informal && (
          <Field id={`${ids}-cuit`} label="CUIT" error={fieldMessages.cuit}>
            <input
              id={`${ids}-cuit`}
              inputMode="numeric"
              value={values.cuit}
              onChange={(e) => set('cuit', e.target.value)}
            />
          </Field>
        )}
        <Field id={`${ids}-term`} label="Plazo de pago" error={fieldMessages.paymentTermDays}>
          <span className="with-unit">
            <input
              id={`${ids}-term`}
              inputMode="numeric"
              value={values.paymentTermDays}
              onChange={(e) => set('paymentTermDays', e.target.value)}
            />
            <span>días</span>
            {termChanged && (
              <span className="hint">antes: {saved.paymentTermDays === null ? 'sin definir' : saved.paymentTermDays}</span>
            )}
          </span>
          <span className="hint">0 = paga al recibir. Si todavía no lo sabés, dejalo vacío.</span>
          {termChanged && <span className="warning">No cambia el vencimiento de los documentos ya cargados.</span>}
        </Field>
        <Field id={`${ids}-notes`} label="Notas" error={fieldMessages.notes}>
          <textarea
            id={`${ids}-notes`}
            placeholder="Opcional"
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
        <p role="alert" className="error">
          {formMessage ?? ''}
        </p>
        <button type="submit" disabled={saving}>
          {saving ? 'Guardando…' : id === undefined ? 'Guardar proveedor' : 'Guardar cambios'}
        </button>
      </form>
    </section>
  )
}

export default SupplierForm
