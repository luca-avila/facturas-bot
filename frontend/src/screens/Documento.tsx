import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { getDocument, imageUrl, type ApiResult, type DocumentDetail } from '../accounts-api'
import { documentTitle, formatDate } from '../format'
import { REVIEW_STATUS_LABELS } from '../labels'

interface Loaded {
  key: string
  result: ApiResult<DocumentDetail>
}

function heading(doc: DocumentDetail): string | null {
  if (doc.type !== null) return documentTitle({ type: doc.type, letter: doc.letter, number: doc.number })
  return doc.reviewStatus === 'processing' ? null : 'Documento sin datos'
}

function alreadyUploaded(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { alreadyUploaded?: unknown }).alreadyUploaded === true
}

/** *Documento* (5a, 4f): the pages of one document and who brought it in. */
function Documento() {
  const { id = '' } = useParams()
  const location = useLocation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${id}\n${attempt}`

  useEffect(() => {
    let current = true
    void getDocument(id).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [id, key])

  const result = loaded?.key === key ? loaded.result : null
  const back = (
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

  return (
    <section className="screen">
      {back}
      {alreadyUploaded(location.state) && (
        <p className="notice callout">Este documento ya estaba subido. No se creó uno nuevo.</p>
      )}
      <div className="document-heading">
        {title !== null && <h1>{title}</h1>}
        <span className={`badge review-${doc.reviewStatus}`}>{REVIEW_STATUS_LABELS[doc.reviewStatus]}</span>
      </div>

      {count === 0 ? (
        <p className="muted">Este documento se cargó a mano y no tiene fotos.</p>
      ) : (
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
      )}

      {doc.reviewStatus === 'processing' && (
        <p className="notice">
          Leyendo el documento… Tarda menos de un minuto. Podés salir: lo vas a encontrar en{' '}
          <Link to="/subidas">Subidas</Link>.
        </p>
      )}

      <p className="muted">
        {by} {doc.createdByName} · {formatDate(doc.createdOn)} {doc.createdTime}
      </p>
    </section>
  )
}

export default Documento
