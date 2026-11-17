import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { listSuppliers, type ApiResult, type SupplierList, type SupplierListRow, type SupplierSort } from '../accounts-api'
import { formatCredit, formatMoney } from '../format'
import { SUPPLIER_SORT_LABELS } from '../labels'
import { rememberResumenSearch } from './resumen-search'

const SORTS = Object.keys(SUPPLIER_SORT_LABELS) as SupplierSort[]

function readSort(value: string | null): SupplierSort {
  return SORTS.find((sort) => sort === value) ?? 'overdue'
}

/** The second line of a row: what's overdue, not due and in credit, or "Al día". */
function rowDetail(row: SupplierListRow): string {
  if (row.overdue === '0.00' && row.notDue === '0.00' && row.credit === '0.00') return 'Al día'
  const parts = [`Vencido ${formatMoney(row.overdue)}`, `Sin vencer ${formatMoney(row.notDue)}`]
  if (row.credit !== '0.00') parts.push(`Crédito ${formatCredit(row.credit)}`)
  return parts.join(' · ')
}

interface Loaded {
  key: string
  result: ApiResult<SupplierList>
}

function Resumen() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const sort = readSort(params.get('orden'))
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${q}\n${sort}\n${attempt}`

  useEffect(() => {
    rememberResumenSearch(params.toString())
  }, [params])

  useEffect(() => {
    // Only the latest response is applied.
    let current = true
    void listSuppliers({ q, sort }).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [q, sort, key])

  // From the latest params, so a quick second change doesn't undo the first.
  function update(next: { q?: string; orden?: SupplierSort }) {
    setParams(
      (prev) => {
        const search = new URLSearchParams()
        const nextQ = next.q ?? prev.get('q') ?? ''
        if (nextQ !== '') search.set('q', nextQ)
        search.set('orden', next.orden ?? readSort(prev.get('orden')))
        return search
      },
      { replace: true },
    )
  }

  const result = loaded?.key === key ? loaded.result : null

  return (
    <section className="screen">
      <h1>Resumen</h1>

      {result?.ok && <SummaryCard totals={result.value.totals} />}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Buscar proveedor"
          aria-label="Buscar proveedor"
          value={q}
          onChange={(event) => update({ q: event.target.value })}
        />
        <select aria-label="Ordenar" value={sort} onChange={(event) => update({ orden: readSort(event.target.value) })}>
          {SORTS.map((option) => (
            <option key={option} value={option}>
              {SUPPLIER_SORT_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      {result === null && <p className="muted">Cargando…</p>}

      {result !== null && !result.ok && (
        <div className="empty">
          <p className="empty-title">No pudimos cargar el resumen.</p>
          <p className="muted">Revisá la conexión.</p>
          <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {result?.ok && result.value.suppliers.length === 0 && (
        <div className="empty">
          {q.trim() === '' ? (
            <p className="empty-title">Todavía no hay proveedores.</p>
          ) : (
            <>
              <p className="empty-title">No hay proveedores que coincidan con “{q}”.</p>
              <p className="muted">Buscá por el nombre que usan ustedes o por la razón social.</p>
            </>
          )}
        </div>
      )}

      {result?.ok && result.value.suppliers.length > 0 && (
        <ul className="list">
          {result.value.suppliers.map((row) => (
            <li key={row.id}>
              <Link className="row" to={`/proveedores/${row.id}`}>
                <span className="row-main">
                  <span className="row-title">{row.name}</span>
                  <span className="row-amount">{formatMoney(row.balance)}</span>
                </span>
                <span className="row-detail">{rowDetail(row)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link className="button" to="/proveedores/nuevo">
        + Proveedor nuevo
      </Link>
    </section>
  )
}

function SummaryCard({ totals }: { totals: SupplierList['totals'] }) {
  return (
    <div className="card summary">
      <p className="summary-label">Total a pagar</p>
      <p className="summary-total">{formatMoney(totals.balance)}</p>
      <dl className="figures">
        <div>
          <dt>Vencido</dt>
          <dd>{formatMoney(totals.overdue)}</dd>
        </div>
        <div>
          <dt>Sin vencer</dt>
          <dd>{formatMoney(totals.notDue)}</dd>
        </div>
        <div>
          <dt>Crédito</dt>
          <dd>{formatCredit(totals.credit)}</dd>
        </div>
      </dl>
    </div>
  )
}

export default Resumen
