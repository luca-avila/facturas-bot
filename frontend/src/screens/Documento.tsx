import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { getDocument, imageUrl, type ApiResult, type DocumentDetail, type DocumentLine } from '../accounts-api'
import { documentTitle, formatDate, formatDecimal, formatMoney } from '../format'
import { DOCUMENT_TYPE_LABELS, DUE_DATE_SOURCE_LABELS, ISSUE_MESSAGES, REVIEW_STATUS_LABELS } from '../labels'

/** How long after each response a `processing` document is checked again. */
const POLL_MS = 3000

const NBSP = ' '
const MISSING = '—'

interface Loaded {
  key: string
  result: ApiResult<DocumentDetail>
}

type Tab = 'datos' | 'foto'

function heading(doc: DocumentDetail): string | null {
  if (doc.type !== null) return documentTitle({ type: doc.type, letter: doc.letter, number: doc.number })
  return doc.reviewStatus === 'processing' ? null : 'Documento sin datos'
}

function routeState(state: unknown): { alreadyUploaded: boolean; fromResolver: boolean } {
  const record = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {}
  return { alreadyUploaded: record.alreadyUploaded === true, fromResolver: record.from === 'a-resolver' }
}

/** *Documento* (5a–5d, 5g, 4f): one document, its data and its pages. */
function Documento() {
  const { id = '' } = useParams()
  const location = useLocation()
  const { alreadyUploaded, fromResolver } = routeState(location.state)
  const [attempt, setAttempt] = useState(0)
  const [check, setCheck] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [tab, setTab] = useState<Tab>('datos')
  const key = `${id}\n${attempt}`

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
  const title = heading(doc)
  const count = doc.images.length
  const by = doc.source === 'upload' ? 'Subido por' : 'Cargado por'
  const tabbed = count > 0 && !processing

  return (
    <section className="screen">
      {back}
      {alreadyUploaded && <p className="notice callout">Este documento ya estaba subido. No se creó uno nuevo.</p>}
      <div className="document-heading">
        {title !== null && <h1>{title}</h1>}
        <span className={`badge review-${doc.reviewStatus}`}>{REVIEW_STATUS_LABELS[doc.reviewStatus]}</span>
      </div>

      {doc.reviewStatus === 'error' && (
        <div className="callout error-callout">
          <p>
            <strong>No cuenta en el saldo. No admite pagos.</strong>
          </p>
          {doc.issues.map((code) => (
            <p key={code}>{ISSUE_MESSAGES[code]}</p>
          ))}
        </div>
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

      {!processing && (!tabbed || tab === 'datos') && <Datos doc={doc} />}
      {tabbed && tab === 'foto' && <Pages doc={doc} />}

      {count === 0 && <p className="muted">Este documento se cargó a mano y no tiene fotos.</p>}

      <p className="muted">
        {by} {doc.createdByName} · {formatDate(doc.createdOn)} {doc.createdTime}
      </p>
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

function letterAndNumber(doc: DocumentDetail): string {
  const parts = [doc.letter, doc.number].filter((part) => part !== null)
  return parts.length === 0 ? MISSING : parts.join(' · ')
}

/** "4 un × $ 6.198,35", or null without a quantity or a unit price. */
function lineAmounts(line: DocumentLine): string | null {
  if (line.quantity === null || line.unitPrice === null) return null
  const quantity = [formatDecimal(line.quantity, 0), line.unit].filter((part) => part !== null).join(' ')
  return `${quantity} × $${NBSP}${formatDecimal(line.unitPrice, 2)}`
}

/** *Datos*, read-only. A missing value shows "—". */
function Datos({ doc }: { doc: DocumentDetail }) {
  return (
    <>
      <dl className="data-list">
        <div>
          <dt>Proveedor</dt>
          <dd>
            {doc.supplier === null ? MISSING : <Link to={`/proveedores/${doc.supplier.id}`}>{doc.supplier.name}</Link>}
          </dd>
        </div>
        <div>
          <dt>Tipo</dt>
          <dd>{doc.type === null ? MISSING : DOCUMENT_TYPE_LABELS[doc.type]}</dd>
        </div>
        <div>
          <dt>Letra · Número</dt>
          <dd>{letterAndNumber(doc)}</dd>
        </div>
        <div>
          <dt>Fecha de emisión</dt>
          <dd>{doc.issueDate === null ? MISSING : formatDate(doc.issueDate)}</dd>
        </div>
        <div>
          <dt>Vencimiento</dt>
          <dd>
            {doc.dueDate === null ? MISSING : formatDate(doc.dueDate)}
            {doc.dueDateSource !== null && <span className="hint">{DUE_DATE_SOURCE_LABELS[doc.dueDateSource]}</span>}
          </dd>
        </div>
        <div>
          <dt>Subtotal</dt>
          <dd className="amount">{money(doc.subtotal)}</dd>
        </div>
        {doc.taxes.map((tax, index) => (
          <div key={`${tax.kind}-${tax.label}-${index}`}>
            <dt>{tax.label}</dt>
            <dd className="amount">{formatMoney(tax.amount)}</dd>
          </div>
        ))}
        <div>
          <dt>Total</dt>
          <dd className="amount strong">{money(doc.total)}</dd>
        </div>
        <div>
          <dt>CAE</dt>
          <dd>{doc.cae ?? MISSING}</dd>
        </div>
        <div>
          <dt>Notas</dt>
          <dd>{doc.notes ?? MISSING}</dd>
        </div>
      </dl>

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

      {doc.reviewStatus === 'unreviewed' && <p className="muted">Leído automáticamente · pasó todos los controles</p>}
    </>
  )
}

export default Documento
