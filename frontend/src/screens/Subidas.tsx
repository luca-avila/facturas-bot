import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { listUploads, type ApiResult, type UploadList, type UploadRow, type UploadScope } from '../accounts-api'
import { documentTitle, formatMoney, formatPageCount } from '../format'
import { REVIEW_STATUS_LABELS, UPLOAD_SCOPE_LABELS } from '../labels'
import { groupByDay } from './subidas-groups'

interface Loaded {
  key: string
  result: ApiResult<UploadList>
}

const SCOPES: readonly UploadScope[] = ['mine', 'all']

function rowTitle(row: UploadRow): string {
  if (row.reviewStatus === 'processing') return 'Leyendo el documento…'
  if (row.type === null) return 'Documento sin datos'
  return documentTitle({ type: row.type, letter: row.letter, number: row.number })
}

function rowDetail(row: UploadRow): string {
  if (row.reviewStatus === 'processing') return `${formatPageCount(row.pageCount)} · ${row.uploadedTime}`
  const parts = [row.supplierName, row.total === null ? null : formatMoney(row.total), row.uploadedTime]
  return parts.filter((part) => part !== null).join(' · ')
}

/** *Subidas* (4g): what was uploaded in the last 7 days, and what's still being read. */
function Subidas() {
  const [params, setParams] = useSearchParams()
  const scope: UploadScope = params.get('ver') === 'todas' ? 'all' : 'mine'
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${scope}\n${attempt}`

  useEffect(() => {
    // Only the latest response is applied.
    let current = true
    void listUploads(scope).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [scope, key])

  const result = loaded?.key === key ? loaded.result : null

  return (
    <section className="screen">
      <div className="top-bar">
        <h1>Subidas</h1>
        <Link className="button compact" to="/subir">
          + Subir
        </Link>
      </div>

      <div className="chips" role="group" aria-label="Mostrar subidas">
        {SCOPES.map((option) => (
          <button
            key={option}
            type="button"
            className={option === scope ? 'chip selected' : 'chip'}
            aria-pressed={option === scope}
            onClick={() => setParams(option === 'all' ? { ver: 'todas' } : {}, { replace: true })}
          >
            {UPLOAD_SCOPE_LABELS[option]}
          </button>
        ))}
      </div>

      {result === null && <p className="muted">Cargando…</p>}

      {result !== null && !result.ok && (
        <div className="empty">
          <p className="empty-title">No pudimos cargar las subidas.</p>
          <p className="muted">Revisá la conexión.</p>
          <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {result?.ok && result.value.uploads.length === 0 && (
        <p className="empty-title">
          {scope === 'mine' ? 'No subiste nada en los últimos 7 días.' : 'No se subió nada en los últimos 7 días.'}
        </p>
      )}

      {result?.ok &&
        groupByDay(result.value.uploads).map((group) => (
          <div key={group.label}>
            <h2 className="section-label">{group.label}</h2>
            <ul className="list">
              {group.rows.map((row) => (
                <li key={row.id}>
                  <Link className="row" to={`/documentos/${row.id}`}>
                    <span className="row-main">
                      <span className="row-title">{rowTitle(row)}</span>
                      <span className={`badge review-${row.reviewStatus}`}>
                        {REVIEW_STATUS_LABELS[row.reviewStatus]}
                      </span>
                    </span>
                    <span className="row-detail">{rowDetail(row)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}

export default Subidas
