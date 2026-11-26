import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import {
  acceptDocumentIssue,
  deleteDocument,
  getDocument,
  imageUrl,
  isAcceptableIssueCode,
  listSuppliers,
  retryDocument,
  reviewDocument,
  updateDocument,
  type AcceptableIssueCode,
  type ApiResult,
  type DocumentDetail,
  type DocumentLine,
  type DocumentType,
  type SupplierList,
  type TermPreview,
} from '../accounts-api'
import { documentTitle, formatDate, formatDecimal, formatMoney } from '../format'
import { ACCEPT_ISSUE_LABELS, DOCUMENT_TYPE_LABELS, ISSUE_MESSAGES, REVIEW_STATUS_LABELS } from '../labels'
import {
  allowedTypesForSource,
  buildUpdatePayload,
  initialEditValues,
  isAppliedLocked,
  isEditDirty,
  type DocumentEditValues,
} from './document-edit'
import Field from './Field'
import { failedSave, localError, type FieldMessages } from './form-errors'
import TermSheet from './TermSheet'

/** How long after each response a `processing` document is checked again. */
const POLL_MS = 3000

const NBSP = ' '
const MISSING = '—'
const LETTERS = ['A', 'B', 'C', 'M', 'X']

interface Loaded {
  key: string
  result: ApiResult<DocumentDetail>
}

interface EditState {
  docId: string
  values: DocumentEditValues
}

interface PendingAcceptState {
  codes: AcceptableIssueCode[]
  suspectedDuplicateId: string | null
}

type Tab = 'datos' | 'foto'
type ConfirmDiscard = 'card' | 'form' | null

function heading(doc: DocumentDetail): string | null {
  if (doc.type !== null) return documentTitle({ type: doc.type, letter: doc.letter, number: doc.number })
  return doc.reviewStatus === 'processing' ? null : 'Documento sin datos'
}

function routeState(state: unknown): { alreadyUploaded: boolean; fromResolver: boolean; manualEntry: boolean } {
  const record = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {}
  return {
    alreadyUploaded: record.alreadyUploaded === true,
    fromResolver: record.from === 'a-resolver',
    manualEntry: record.manualEntry === true,
  }
}

function isPureExtractionFailure(doc: DocumentDetail): boolean {
  return (
    doc.reviewStatus === 'error' &&
    doc.source === 'upload' &&
    doc.issues.includes('extraction_failed') &&
    doc.type === null &&
    doc.supplier === null &&
    doc.issueDate === null &&
    doc.total === null &&
    doc.lines.length === 0 &&
    doc.taxes.length === 0
  )
}

/** *Documento* (5a–5g, 4f): one document, its photos, and editable header. */
function Documento() {
  const { id = '' } = useParams()
  return <DocumentoView key={id} id={id} />
}

function DocumentoView({ id }: { id: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { alreadyUploaded, fromResolver, manualEntry } = routeState(location.state)
  const [attempt, setAttempt] = useState(0)
  const [check, setCheck] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [suppliers, setSuppliers] = useState<ApiResult<SupplierList> | null>(null)
  const [tab, setTab] = useState<Tab>('datos')
  const [editState, setEditState] = useState<EditState | null>(null)
  const [manualMode, setManualMode] = useState(manualEntry)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState<ConfirmDiscard>(null)
  const [termSheetOpen, setTermSheetOpen] = useState(false)
  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({})
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingAccept, setPendingAccept] = useState<PendingAcceptState | null>(null)
  const pendingNoticeRef = useRef<'save' | 'accept' | null>(null)
  const key = `${id}\n${attempt}`

  // Reloads with the document, so a term saved here reaches `supplierTermDays`.
  useEffect(() => {
    let current = true
    void listSuppliers({ q: '', sort: 'name' }).then((result) => {
      if (current) setSuppliers(result)
    })
    return () => {
      current = false
    }
  }, [attempt])

  useEffect(() => {
    let current = true
    void getDocument(id).then((result) => {
      if (!current) return
      setLoaded((prev) => {
        // A failed re-check keeps what's on screen. A new object still
        // schedules the next check.
        if (!result.ok && prev?.key === key && prev.result.ok) return { ...prev }
        return { key, result }
      })
      if (result.ok) {
        setEditState({ docId: result.value.id, values: initialEditValues(result.value) })
        setPendingAccept(null)
        const pendingKind = pendingNoticeRef.current
        if (pendingKind !== null) {
          pendingNoticeRef.current = null
          if (pendingKind === 'save') {
            setNotice(
              result.value.reviewStatus === 'reviewed'
                ? 'Guardado en Revisado.'
                : 'Cambios guardados. Quedan avisos pendientes para aceptar o corregir.',
            )
          } else {
            setNotice(
              result.value.reviewStatus === 'reviewed'
                ? 'Aceptado. El documento pasó a Revisado.'
                : 'Aviso aceptado. Quedan otros avisos pendientes.',
            )
          }
        }
      }
    })
    return () => {
      current = false
    }
  }, [id, key, check])

  const result = loaded?.key === key ? loaded.result : null
  const processing = result?.ok === true && result.value.reviewStatus === 'processing'

  // Checks again 3 s after each response, while it's still being read.
  useEffect(() => {
    if (!processing) return
    const timer = setTimeout(() => setCheck((n) => n + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [processing, loaded])

  const back = fromResolver ? (
    <Link className="back" to="/a-resolver">
      ← A resolver
    </Link>
  ) : (
    <Link className="back" to="/subidas">
      ← Subidas
    </Link>
  )

  if (result === null) {
    return (
      <section className="screen">
        {back}
        <p className="muted">Cargando…</p>
      </section>
    )
  }
  if (!result.ok) {
    return (
      <section className="screen">
        {back}
        {result.error === 'not_found' ? (
          <p className="empty-title">No encontramos este documento.</p>
        ) : (
          <div className="empty">
            <p className="empty-title">No pudimos cargar el documento.</p>
            <p className="muted">Revisá la conexión.</p>
            <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}
      </section>
    )
  }

  const doc = result.value
  const values = editState?.docId === doc.id ? editState.values : initialEditValues(doc)
  const dirty = isEditDirty(doc, values)
  const locked = isAppliedLocked(doc)
  const title = heading(doc)
  const count = doc.images.length
  const by = doc.source === 'upload' ? 'Subido por' : 'Cargado por'
  const tabbed = count > 0 && !processing
  const showExtractionFailedCard = isPureExtractionFailure(doc) && !manualMode
  const openAcceptableIssues = doc.issues.filter(isAcceptableIssueCode)
  const openBlockingIssues = doc.issues.filter((code) => !isAcceptableIssueCode(code))

  const refreshDoc = () => setAttempt((n) => n + 1)

  async function handleAcceptIssue(code: AcceptableIssueCode) {
    setSaving(true)
    setFormMessage(null)
    setNotice(null)
    const res = await acceptDocumentIssue(doc.id, code)
    setSaving(false)
    if (res.ok) {
      pendingNoticeRef.current = 'accept'
      refreshDoc()
      return
    }
    const failure = failedSave(res)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form ?? Object.values(failure.fields)[0] ?? 'No pudimos aceptar el aviso.')
  }

  async function handleSave(acceptIssues?: AcceptableIssueCode[]) {
    setFormMessage(null)
    setNotice(null)
    const built = buildUpdatePayload(values)
    if (!built.ok) {
      setFieldMessages(localError(built.field, built.code))
      return
    }
    setSaving(true)
    const payload = acceptIssues !== undefined ? { ...built.input, acceptIssues } : built.input
    const res = await updateDocument(doc.id, payload)
    setSaving(false)
    if (res.ok) {
      setFieldMessages({})
      setFormMessage(null)
      setPendingAccept(null)
      setManualMode(false)
      pendingNoticeRef.current = 'save'
      refreshDoc()
      return
    }
    if (
      res.error === 'rejected' &&
      doc.reviewStatus !== 'error' &&
      res.fieldErrors.length > 0 &&
      res.fieldErrors.every((err) => isAcceptableIssueCode(err.code))
    ) {
      const codes = res.fieldErrors.map((err) => err.code as AcceptableIssueCode)
      const suspectedDuplicateId =
        res.fieldErrors.find((err) => err.code === 'duplicate_suspected')?.documentId ?? null
      setFieldMessages({})
      setFormMessage(null)
      setPendingAccept({ codes, suspectedDuplicateId })
      return
    }
    setPendingAccept(null)
    const failure = failedSave(res)
    setFieldMessages(failure.fields)
    if (doc.reviewStatus !== 'error') {
      setFormMessage(
        failure.form ??
          'No se guardó. Este documento no puede quedar con errores. Corregí lo marcado o deshacé los cambios.',
      )
    } else {
      setFormMessage(failure.form)
    }
  }

  async function handleRetry() {
    setSaving(true)
    setFormMessage(null)
    const res = await retryDocument(doc.id)
    setSaving(false)
    if (res.ok) {
      setNotice('Reintentando lectura…')
      refreshDoc()
      return
    }
    const failure = failedSave(res)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form ?? Object.values(failure.fields)[0] ?? 'No pudimos reintentar.')
  }

  async function handleDiscard() {
    setSaving(true)
    setFormMessage(null)
    const res = await deleteDocument(doc.id)
    setSaving(false)
    if (res.ok) {
      navigate(fromResolver ? '/a-resolver' : '/subidas')
      return
    }
    setConfirmDiscard(null)
    const failure = failedSave(res)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form ?? Object.values(failure.fields)[0] ?? 'No pudimos descartar el documento.')
  }

  async function handleReview() {
    setSaving(true)
    setFormMessage(null)
    const res = await reviewDocument(doc.id)
    setSaving(false)
    if (res.ok) {
      setNotice('Marcado como revisado.')
      refreshDoc()
      return
    }
    const failure = failedSave(res)
    setFieldMessages(failure.fields)
    setFormMessage(failure.form ?? Object.values(failure.fields)[0] ?? 'No pudimos confirmar el documento.')
  }

  function handleTermSaved(preview: TermPreview) {
    setTermSheetOpen(false)
    const unblocked = preview.documents.find((d) => d.id === doc.id)?.willUnblock === true
    setNotice(
      unblocked
        ? 'Plazo guardado. El documento pasó a Sin revisar.'
        : 'Plazo guardado.',
    )
    setFieldMessages({})
    setFormMessage(null)
    refreshDoc()
  }

  return (
    <section className="screen">
      {back}
      {alreadyUploaded && <p className="notice callout">Este documento ya estaba subido. No se creó uno nuevo.</p>}
      {notice && (
        <p className="notice callout" role="status">
          {notice}
        </p>
      )}
      <div className="document-heading">
        {title !== null && <h1>{title}</h1>}
        <span className={`badge review-${doc.reviewStatus}`}>{REVIEW_STATUS_LABELS[doc.reviewStatus]}</span>
      </div>

      {doc.reviewStatus === 'error' && !showExtractionFailedCard && (
        <div className="callout error-callout">
          <p>
            <strong>No cuenta en el saldo. No admite pagos.</strong>
          </p>
          {openBlockingIssues.map((code) => (
            <p key={code}>{ISSUE_MESSAGES[code]}</p>
          ))}
        </div>
      )}

      {doc.reviewStatus === 'error' && !showExtractionFailedCard && openAcceptableIssues.length > 0 && (
        <div className="issue-cards">
          {openAcceptableIssues.map((code) => (
            <div key={code} className="card issue-card">
              <p>
                <strong>{ISSUE_MESSAGES[code]}</strong>
              </p>
              {code === 'duplicate_suspected' && doc.suspectedDuplicate !== null && (
                <p className="muted">
                  Existente:{' '}
                  {documentTitle({
                    type: doc.suspectedDuplicate.type,
                    letter: doc.suspectedDuplicate.letter,
                    number: doc.suspectedDuplicate.number,
                  })}{' '}
                  · {formatDate(doc.suspectedDuplicate.issueDate)} · {formatMoney(doc.suspectedDuplicate.total)}
                </p>
              )}
              {code === 'totals_mismatch' &&
                doc.subtotal !== null &&
                doc.consistencySummary.taxSum !== null &&
                doc.consistencySummary.subtotalPlusTaxes !== null &&
                doc.total !== null && (
                  <p className="muted">
                    Subtotal {formatMoney(doc.subtotal)} + impuestos {formatMoney(doc.consistencySummary.taxSum)} ={' '}
                    {formatMoney(doc.consistencySummary.subtotalPlusTaxes)} (total {formatMoney(doc.total)}).
                  </p>
                )}
              {code === 'lines_mismatch' && doc.consistencySummary.lineTotalSum !== null && (
                <p className="muted">
                  Suma de ítems: {formatMoney(doc.consistencySummary.lineTotalSum)}
                  {doc.subtotal !== null ? ` · Subtotal: ${formatMoney(doc.subtotal)}` : ''}
                  {doc.total !== null ? ` · Total: ${formatMoney(doc.total)}` : ''}.
                </p>
              )}
              <div className="resolver-actions">
                <button
                  type="button"
                  className="compact-btn"
                  disabled={saving || dirty}
                  onClick={() => void handleAcceptIssue(code)}
                >
                  {ACCEPT_ISSUE_LABELS[code]}
                </button>
                {code === 'duplicate_suspected' && doc.suspectedDuplicate !== null && (
                  <Link className="button secondary compact" to={`/documentos/${doc.suspectedDuplicate.id}`}>
                    Ver el existente
                  </Link>
                )}
                {code === 'duplicate_suspected' && !locked && confirmDiscard !== 'card' && (
                  <button
                    type="button"
                    className="secondary compact-btn"
                    disabled={saving}
                    onClick={() => setConfirmDiscard('card')}
                  >
                    Descartar
                  </button>
                )}
              </div>
              {code === 'duplicate_suspected' && !locked && confirmDiscard === 'card' && (
                <div className="inline-panel">
                  <p className="muted">¿Descartar este documento? Deja de aparecer en el sistema.</p>
                  <div className="resolver-actions">
                    <button
                      type="button"
                      className="compact-btn"
                      disabled={saving}
                      onClick={() => void handleDiscard()}
                    >
                      {saving ? 'Descartando…' : 'Confirmar descarte'}
                    </button>
                    <button
                      type="button"
                      className="secondary compact-btn"
                      disabled={saving}
                      onClick={() => setConfirmDiscard(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {dirty && <p className="hint">Guardá o deshacé los cambios antes de aceptar.</p>}
            </div>
          ))}
        </div>
      )}

      {!processing && doc.acceptedIssues.length > 0 && (
        <ul className="accepted-issues">
          {doc.acceptedIssues.map((item) => (
            <li key={item.code} className="accepted-issue">
              <s>{ISSUE_MESSAGES[item.code]}</s>
              <span className="muted">
                Aceptado por {item.acceptedByName} · {formatDate(item.acceptedOn)} {item.acceptedTime}
              </span>
            </li>
          ))}
        </ul>
      )}

      {processing && (
        <>
          <Pages doc={doc} />
          <p className="notice">
            Leyendo el documento… Tarda menos de un minuto. Podés salir: lo vas a encontrar en{' '}
            <Link to="/subidas">Subidas</Link>.
          </p>
        </>
      )}

      {showExtractionFailedCard && (
        <>
          {count > 0 && <Pages doc={doc} />}
          <div className="card resolver-group">
            <p>
              <strong>No pudimos leer el documento.</strong>
            </p>
            {formMessage && (
              <p role="alert" className="error">
                {formMessage}
              </p>
            )}
            <div className="buttons">
              <button type="button" disabled={saving} onClick={() => void handleRetry()}>
                {saving ? 'Reintentando…' : 'Reintentar'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => setManualMode(true)}
              >
                Cargar a mano
              </button>
              {confirmDiscard !== 'form' ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={() => setConfirmDiscard('form')}
                >
                  Descartar
                </button>
              ) : (
                <div className="inline-panel">
                  <p className="muted">¿Descartar este documento?</p>
                  <div className="pair-buttons">
                    <button type="button" disabled={saving} onClick={() => void handleDiscard()}>
                      Confirmar descarte
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={saving}
                      onClick={() => setConfirmDiscard(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!showExtractionFailedCard && (
        <>
          {tabbed && (
            <div className="tabs" role="tablist" aria-label="Ver">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'datos'}
                className={tab === 'datos' ? 'tab selected' : 'tab'}
                onClick={() => setTab('datos')}
              >
                Datos
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'foto'}
                className={tab === 'foto' ? 'tab selected' : 'tab'}
                onClick={() => setTab('foto')}
              >
                Foto ({count})
              </button>
            </div>
          )}

          {!processing && (!tabbed || tab === 'datos') && (
            <DatosForm
              doc={doc}
              values={values}
              suppliers={suppliers}
              saving={saving}
              confirmDiscard={confirmDiscard === 'form'}
              fieldMessages={fieldMessages}
              formMessage={formMessage}
              pendingAccept={pendingAccept}
              onChange={(next) => {
                setEditState({ docId: doc.id, values: next })
                setPendingAccept(null)
                setNotice(null)
              }}
              onSave={() => void handleSave()}
              onAcceptAndSave={(codes) => void handleSave(codes)}
              onCancelAccept={() => setPendingAccept(null)}
              onReview={() => void handleReview()}
              onUndo={() => {
                setEditState({ docId: doc.id, values: initialEditValues(doc) })
                setFieldMessages({})
                setFormMessage(null)
                setPendingAccept(null)
              }}
              onOpenTermSheet={() => setTermSheetOpen(true)}
              onRequestDiscard={() => setConfirmDiscard('form')}
              onCancelDiscard={() => setConfirmDiscard(null)}
              onConfirmDiscard={() => void handleDiscard()}
            />
          )}
          {tabbed && tab === 'foto' && <Pages doc={doc} />}
        </>
      )}

      {count === 0 && <p className="muted">Este documento se cargó a mano y no tiene fotos.</p>}

      <div className="provenance">
        <p className="muted">
          {by} {doc.createdByName} · {formatDate(doc.createdOn)} {doc.createdTime}
        </p>
        {doc.reviewedByName !== null && doc.reviewedOn !== null && doc.reviewedTime !== null ? (
          <p className="muted">
            Revisado por {doc.reviewedByName} · {formatDate(doc.reviewedOn)} {doc.reviewedTime}
          </p>
        ) : (
          doc.reviewStatus === 'unreviewed' && (
            <p className="muted">Leído automáticamente · pasó todos los controles</p>
          )
        )}
      </div>

      {termSheetOpen && doc.supplier !== null && (
        <TermSheet
          supplierId={doc.supplier.id}
          supplierName={doc.supplier.name}
          suggestedTermDays={doc.suggestedTermDays}
          onSaved={handleTermSaved}
          onClose={() => setTermSheetOpen(false)}
          onManualDueDate={() => {
            setTermSheetOpen(false)
            setEditState({
              docId: doc.id,
              values: { ...values, dueDateSource: 'manual' },
            })
          }}
        />
      )}
    </section>
  )
}

function Pages({ doc }: { doc: DocumentDetail }) {
  const count = doc.images.length
  return (
    <div className="document-pages">
      {doc.images.map((image, index) => (
        <figure key={image.id} className="document-page">
          <a href={imageUrl(image.id)} target="_blank" rel="noopener">
            <img src={imageUrl(image.id)} alt={`Página ${index + 1} de ${count}`} />
          </a>
          <figcaption className="muted">
            pág. {index + 1} de {count}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function money(amount: string | null): string {
  return amount === null ? MISSING : formatMoney(amount)
}

/** "4 un × $ 6.198,35", or null without a quantity or a unit price. */
function lineAmounts(line: DocumentLine): string | null {
  if (line.quantity === null || line.unitPrice === null) return null
  const quantity = [formatDecimal(line.quantity, 0), line.unit].filter((part) => part !== null).join(' ')
  return `${quantity} × $${NBSP}${formatDecimal(line.unitPrice, 2)}`
}

interface DatosFormProps {
  doc: DocumentDetail
  values: DocumentEditValues
  suppliers: ApiResult<SupplierList> | null
  saving: boolean
  confirmDiscard: boolean
  fieldMessages: FieldMessages
  formMessage: string | null
  pendingAccept: PendingAcceptState | null
  onChange: (next: DocumentEditValues) => void
  onSave: () => void
  onAcceptAndSave: (codes: AcceptableIssueCode[]) => void
  onCancelAccept: () => void
  onReview: () => void
  onUndo: () => void
  onOpenTermSheet: () => void
  onRequestDiscard: () => void
  onCancelDiscard: () => void
  onConfirmDiscard: () => void
}

function DatosForm({
  doc,
  values,
  suppliers,
  saving,
  confirmDiscard,
  fieldMessages,
  formMessage,
  pendingAccept,
  onChange,
  onSave,
  onAcceptAndSave,
  onCancelAccept,
  onReview,
  onUndo,
  onOpenTermSheet,
  onRequestDiscard,
  onCancelDiscard,
  onConfirmDiscard,
}: DatosFormProps) {
  const ids = useId()
  const dueDateInputRef = useRef<HTMLInputElement>(null)
  const locked = isAppliedLocked(doc)
  const dirty = isEditDirty(doc, values)
  const allowedTypes = allowedTypesForSource(doc.source)
  const supplierList = suppliers?.ok ? suppliers.value.suppliers : []
  const selectedSupplier = supplierList.find((s) => s.id === values.supplierId)
  const supplierTermDays =
    selectedSupplier !== undefined
      ? selectedSupplier.paymentTermDays
      : doc.supplier?.id === values.supplierId
        ? doc.supplier.paymentTermDays
        : null

  const isOpening = values.type === 'opening_balance'
  const isCreditNote = values.type === 'credit_note'
  const hasDueDate = !isCreditNote

  const set = <K extends keyof DocumentEditValues>(field: K, value: DocumentEditValues[K]) => {
    onChange({ ...values, [field]: value })
  }

  function handleSupplierChange(nextSupplierId: string) {
    const nextSupplier = supplierList.find((s) => s.id === nextSupplierId)
    let nextDueDateSource = values.dueDateSource
    if (values.type === 'invoice' || values.type === 'delivery_note') {
      const hasTerm = nextSupplier?.paymentTermDays !== null && nextSupplier?.paymentTermDays !== undefined
      const preservesOriginalTerm =
        nextSupplierId === doc.supplier?.id && doc.dueDateSource === 'supplier_term' && doc.dueDate !== null
      if (hasTerm || preservesOriginalTerm) {
        if (nextDueDateSource === null) nextDueDateSource = 'supplier_term'
      } else if (
        nextDueDateSource === 'supplier_term' &&
        (nextSupplierId === '' || nextSupplier !== undefined)
      ) {
        nextDueDateSource = null
      }
    }
    onChange({ ...values, supplierId: nextSupplierId, dueDateSource: nextDueDateSource })
  }

  function handleTypeChange(nextType: DocumentType) {
    let nextDueDateSource = values.dueDateSource
    let nextDueDate = values.dueDate
    if (nextType === 'credit_note') {
      nextDueDateSource = null
      nextDueDate = ''
    } else if (nextType === 'opening_balance') {
      nextDueDateSource = nextDueDate.trim() !== '' ? 'manual' : null
    } else if (nextDueDateSource === null) {
      nextDueDateSource = supplierTermDays !== null ? 'supplier_term' : null
    }
    onChange({ ...values, type: nextType, dueDateSource: nextDueDateSource, dueDate: nextDueDate })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSave()
  }

  const showTermBanner =
    doc.reviewStatus === 'error' &&
    doc.issues.includes('supplier_term_missing') &&
    doc.supplier !== null &&
    values.supplierId === doc.supplier.id &&
    values.dueDateSource !== 'manual'

  const termDueLabel =
    doc.dueDate !== null &&
    values.issueDate === doc.issueDate &&
    values.supplierId === doc.supplier?.id &&
    doc.dueDateSource === 'supplier_term'
      ? formatDate(doc.dueDate)
      : 'Se calcula al guardar'

  return (
    <>
      {showTermBanner && doc.supplier !== null && (
        <div className="card resolver-group">
          <p>
            <strong>{doc.supplier.name} no tiene plazo de pago.</strong>
          </p>
          {doc.suggestedTermDays !== null && (
            <p className="muted">El documento dice {doc.suggestedTermDays} días.</p>
          )}
          <div className="pair-buttons">
            <button type="button" onClick={onOpenTermSheet}>
              Definir plazo
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                set('dueDateSource', 'manual')
                setTimeout(() => dueDateInputRef.current?.focus(), 0)
              }}
            >
              Vencimiento a mano
            </button>
          </div>
        </div>
      )}

      {locked && (
        <p className="callout muted">
          Proveedor y tipo no se pueden cambiar porque el documento tiene pagos o créditos aplicados.
        </p>
      )}

      {fieldMessages.document && (
        <p role="alert" className="error">
          {fieldMessages.document}
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <Field
          id={`${ids}-supplier`}
          label={locked ? 'Proveedor (bloqueado)' : 'Proveedor'}
          error={fieldMessages.supplierId}
        >
          <select
            id={`${ids}-supplier`}
            value={values.supplierId}
            disabled={locked || saving}
            onChange={(e) => handleSupplierChange(e.target.value)}
          >
            <option value="">{suppliers === null ? 'Cargando…' : 'Elegí un proveedor'}</option>
            {doc.supplier !== null && !supplierList.some((s) => s.id === doc.supplier!.id) && (
              <option value={doc.supplier.id}>{doc.supplier.name}</option>
            )}
            {supplierList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field id={`${ids}-type`} label={locked ? 'Tipo (bloqueado)' : 'Tipo'}>
          <select
            id={`${ids}-type`}
            value={values.type}
            disabled={locked || saving}
            onChange={(e) =>
              handleTypeChange(allowedTypes.find((t) => t === e.target.value) ?? 'invoice')
            }
          >
            {allowedTypes.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>

        {!isOpening && (
          <div className="pair">
            <Field id={`${ids}-letter`} label="Letra">
              <select
                id={`${ids}-letter`}
                value={values.letter}
                disabled={saving}
                onChange={(e) => set('letter', e.target.value)}
              >
                <option value="">—</option>
                {LETTERS.map((letter) => (
                  <option key={letter} value={letter}>
                    {letter}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${ids}-number`} label="Número" error={fieldMessages.number}>
              <input
                id={`${ids}-number`}
                value={values.number}
                disabled={saving}
                onChange={(e) => set('number', e.target.value)}
              />
            </Field>
          </div>
        )}

        <Field
          id={`${ids}-issue`}
          label={isOpening ? 'Fecha' : 'Fecha de emisión'}
          error={fieldMessages.issueDate}
        >
          <input
            id={`${ids}-issue`}
            type="date"
            value={values.issueDate}
            disabled={saving}
            onChange={(e) => set('issueDate', e.target.value)}
          />
        </Field>

        {hasDueDate && (
          <Field id={`${ids}-due`} label="Vencimiento" error={fieldMessages.dueDate}>
            {isOpening ? (
              <>
                <input
                  id={`${ids}-due`}
                  type="date"
                  value={values.dueDate}
                  disabled={saving}
                  onChange={(e) => set('dueDate', e.target.value)}
                />
                <span className="hint">Si no tiene vencimiento, cuenta como sin vencer.</span>
              </>
            ) : values.dueDateSource === 'manual' ? (
              <>
                <input
                  ref={dueDateInputRef}
                  id={`${ids}-due`}
                  type="date"
                  value={values.dueDate}
                  disabled={saving}
                  onChange={(e) => set('dueDate', e.target.value)}
                />
                <span className="hint">
                  Ingresado a mano.{' '}
                  {supplierTermDays !== null && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => onChange({ ...values, dueDateSource: 'supplier_term', dueDate: '' })}
                    >
                      Usar plazo del proveedor ({supplierTermDays} días)
                    </button>
                  )}
                </span>
              </>
            ) : values.dueDateSource === 'supplier_term' ? (
              <>
                <input id={`${ids}-due`} type="text" value={termDueLabel} readOnly disabled />
                <span className="hint">
                  Según el plazo del proveedor
                  {supplierTermDays !== null ? ` (${supplierTermDays} días)` : ''}.{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      set('dueDateSource', 'manual')
                      setTimeout(() => dueDateInputRef.current?.focus(), 0)
                    }}
                  >
                    Cambiar a mano
                  </button>
                </span>
              </>
            ) : (
              <>
                <input id={`${ids}-due`} type="text" value="Falta plazo o vencimiento" readOnly disabled />
                <span className="hint">
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      set('dueDateSource', 'manual')
                      setTimeout(() => dueDateInputRef.current?.focus(), 0)
                    }}
                  >
                    Ingresar vencimiento a mano
                  </button>
                  {doc.supplier !== null && values.supplierId === doc.supplier.id && (
                    <>
                      {' · '}
                      <button type="button" className="link" onClick={onOpenTermSheet}>
                        Definir plazo
                      </button>
                    </>
                  )}
                </span>
              </>
            )}
          </Field>
        )}

        {!isOpening && (
          <Field id={`${ids}-subtotal`} label="Subtotal" error={fieldMessages.subtotal}>
            <input
              id={`${ids}-subtotal`}
              inputMode="decimal"
              placeholder="Opcional"
              value={values.subtotal}
              disabled={saving}
              onChange={(e) => set('subtotal', e.target.value)}
            />
          </Field>
        )}

        {doc.taxes.length > 0 && (
          <dl className="data-list">
            {doc.taxes.map((tax, index) => (
              <div key={`${tax.kind}-${tax.label}-${index}`}>
                <dt>{tax.label}</dt>
                <dd className="amount">{formatMoney(tax.amount)}</dd>
              </div>
            ))}
          </dl>
        )}

        <Field id={`${ids}-total`} label="Total" error={fieldMessages.total}>
          <input
            id={`${ids}-total`}
            inputMode="decimal"
            placeholder="$ 0,00"
            value={values.total}
            disabled={saving}
            onChange={(e) => set('total', e.target.value)}
          />
          {locked && (
            <span className="hint">
              No puede ser menor que lo ya aplicado: {formatMoney(doc.appliedAmount)}.
            </span>
          )}
        </Field>

        <dl className="data-list">
          <div>
            <dt>CAE</dt>
            <dd>{doc.cae ?? MISSING}</dd>
          </div>
        </dl>

        <Field id={`${ids}-notes`} label="Notas">
          <textarea
            id={`${ids}-notes`}
            value={values.notes}
            disabled={saving}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>

        {formMessage && (
          <p role="alert" className="error">
            {formMessage}
          </p>
        )}

        {pendingAccept !== null && (
          <div className="inline-panel" role="alert">
            <p>
              <strong>Este cambio genera avisos que requieren confirmación:</strong>
            </p>
            {pendingAccept.codes.map((code) => (
              <p key={code}>{ISSUE_MESSAGES[code]}</p>
            ))}
            <div className="resolver-actions">
              <button
                type="button"
                className="compact-btn"
                disabled={saving}
                onClick={() => onAcceptAndSave(pendingAccept.codes)}
              >
                {saving ? 'Guardando…' : 'Aceptar y guardar'}
              </button>
              {pendingAccept.suspectedDuplicateId !== null && (
                <Link className="button secondary compact" to={`/documentos/${pendingAccept.suspectedDuplicateId}`}>
                  Ver el existente
                </Link>
              )}
              <button type="button" className="secondary compact-btn" disabled={saving} onClick={onCancelAccept}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        <div className="buttons">
          {doc.reviewStatus === 'unreviewed' && !dirty ? (
            <button type="button" disabled={saving} onClick={onReview}>
              {saving ? 'Confirmando…' : 'Marcar como revisado'}
            </button>
          ) : (
            <button type="submit" disabled={saving || (doc.reviewStatus === 'reviewed' && !dirty)}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          )}

          {dirty && (
            <button type="button" className="secondary" disabled={saving} onClick={onUndo}>
              Deshacer
            </button>
          )}

          {!locked && !confirmDiscard && (
            <button type="button" className="secondary" disabled={saving} onClick={onRequestDiscard}>
              Descartar
            </button>
          )}
        </div>

        {!locked && confirmDiscard && (
          <div className="inline-panel">
            <p className="muted">¿Descartar este documento? Deja de aparecer en el sistema.</p>
            <div className="pair-buttons">
              <button type="button" disabled={saving} onClick={onConfirmDiscard}>
                {saving ? 'Descartando…' : 'Confirmar descarte'}
              </button>
              <button type="button" className="secondary" disabled={saving} onClick={onCancelDiscard}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </form>

      {doc.lines.length > 0 && (
        <details className="document-lines">
          <summary>Ítems ({doc.lines.length})</summary>
          <ul className="list">
            {doc.lines.map((line) => {
              const amounts = lineAmounts(line)
              return (
                <li key={line.position} className="line-row">
                  <span className="row-main">
                    <span className="row-title">{line.description}</span>
                    <span className="row-amount">{money(line.lineTotal)}</span>
                  </span>
                  {amounts !== null && <span className="row-detail">{amounts}</span>}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </>
  )
}

export default Documento
