import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  listErrorDocuments,
  type ApiResult,
  type ErrorDocumentList,
  type ErrorDocumentRow,
  type ErrorSummary,
} from '../accounts-api'
import { documentTitle, formatDate, formatMoney } from '../format'
import { ISSUE_MESSAGES } from '../labels'

interface Loaded {
  key: number
  result: ApiResult<ErrorDocumentList>
}

/** "2 documentos · $ 152.300,00 fuera del saldo", with no amount part for 0.00. */
function countLine(summary: ErrorSummary): string {
  const documents = summary.count === 1 ? '1 documento' : `${summary.count} documentos`
  return summary.amount === '0.00' ? documents : `${documents} · ${formatMoney(summary.amount)} fuera del saldo`
}

function supplierLine(row: ErrorDocumentRow): string {
  if (row.supplier !== null) return row.supplier.name
  return row.issues.includes('supplier_unresolved') ? 'Proveedor sin identificar' : 'Sin datos'
}

function detailLine(row: ErrorDocumentRow): string {
  const title = row.type === null ? null : documentTitle({ type: row.type, letter: row.letter, number: row.number })
  return [title, formatDate(row.createdOn), `Subido por ${row.createdByName}`]
    .filter((part) => part !== null)
    .join(' · ')
}

/** *A resolver* (6b, 6c): the documents in Error, which don't count in any balance. */
function AResolver() {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let current = true
    void listErrorDocuments().then((result) => {
      if (current) setLoaded({ key: attempt, result })
    })
    return () => {
      current = false
    }
  }, [attempt])

  const result = loaded?.key === attempt ? loaded.result : null

  return (
    <section className="screen">
      <h1>A resolver</h1>

      {result === null && <p className="muted">Cargando…</p>}

      {result !== null && !result.ok && (
        <div className="empty">
          <p className="empty-title">No pudimos cargar los documentos con error.</p>
          <p className="muted">Revisá la conexión.</p>
          <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {result?.ok && result.value.documents.length === 0 && (
        <div className="empty">
          <p className="empty-title">No hay nada para resolver.</p>
          <p className="muted">Todos los documentos cuentan en el saldo.</p>
        </div>
      )}

      {result?.ok && result.value.documents.length > 0 && (
        <>
          <p className="muted">{countLine(result.value.summary)}</p>
          <ul className="list">
            {result.value.documents.map((row) => (
              <li key={row.id}>
                <Link className="row" to={`/documentos/${row.id}`} state={{ from: 'a-resolver' }}>
                  <span className="row-main">
                    <span className="row-title">{supplierLine(row)}</span>
                    <span className="row-amount">{row.total === null ? 'sin total' : formatMoney(row.total)}</span>
                  </span>
                  <span className="row-detail">{detailLine(row)}</span>
                  {row.issues.map((code) => (
                    <span key={code} className="row-issue">
                      {ISSUE_MESSAGES[code]}
                    </span>
                  ))}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export default AResolver
