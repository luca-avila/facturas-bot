import { useEffect, useState } from 'react'
import { previewSplit, type ApiResult, type FieldError, type Split, type SplitRow, type SplitSource } from '../accounts-api'
import { formatAmountInput, parseAmountInput } from '../format'

interface Loaded {
  key: string
  result: ApiResult<Split>
}

export interface SplitState {
  /** The latest preview that came back, possibly for an earlier edit while `pending`. */
  split: Split | null
  /** True while the preview for what's typed now hasn't come back. */
  pending: boolean
  /** The latest preview failed to load. */
  failed: boolean
  /** The person changed a row since the suggestion. */
  edited: boolean
  /** What the row's input shows. */
  text: (documentId: string) => string
  setText: (documentId: string, text: string) => void
  /** The row's input can't be read as an amount, so no preview is sent. */
  invalid: (documentId: string) => boolean
  anyInvalid: boolean
  /** Errors from the last save, until the next edit. */
  saveErrors: FieldError[]
  setSaveErrors: (errors: FieldError[]) => void
  /** Back to the suggestion. */
  reset: () => void
  /** Sends the preview again, such as after a refused save. */
  refresh: () => void
  /** The rows to save: the latest preview's amounts. Only valid when nothing is pending. */
  rows: () => SplitRow[]
}

/**
 * The split for `source`, as the backend previews it. Every change sends a
 * preview with every row's canonical amount, and only the latest response
 * is applied. The frontend never adds or compares amounts (D1). `initial`
 * is the suggestion, when the caller already loaded it.
 */
export function useSplit(source: SplitSource, initial: Split | null = null): SplitState {
  const sourceKey = JSON.stringify(source)
  /** Null while showing the suggestion, otherwise every row's typed text. */
  const [typed, setTyped] = useState<Record<string, string> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saveErrors, setSaveErrors] = useState<FieldError[]>([])

  const parsed: Record<string, string | null> = {}
  for (const [id, text] of Object.entries(typed ?? {})) parsed[id] = parseAmountInput(text)
  const anyInvalid = Object.values(parsed).some((amount) => amount === null)
  const applications: SplitRow[] | null =
    typed === null ? null : Object.entries(parsed).map(([documentId, amount]) => ({ documentId, amount: amount ?? '' }))
  const key = anyInvalid ? null : `${sourceKey}\n${JSON.stringify(applications)}\n${attempt}`
  const initialKey = `${sourceKey}\nnull\n0`

  const [loaded, setLoaded] = useState<Loaded | null>(
    initial === null ? null : { key: initialKey, result: { ok: true, value: initial } },
  )

  const applicationsJson = JSON.stringify(applications)
  useEffect(() => {
    if (key === null || (initial !== null && key === initialKey)) return
    let current = true
    const request = {
      source: JSON.parse(sourceKey) as SplitSource,
      applications: JSON.parse(applicationsJson) as SplitRow[] | null,
    }
    void previewSplit(request).then((result) => {
      if (current) setLoaded({ key, result })
    })
    return () => {
      current = false
    }
  }, [key, initialKey, initial, sourceKey, applicationsJson])

  const result = loaded?.result ?? null
  const split = result?.ok ? result.value : null

  return {
    split,
    pending: key === null || loaded?.key !== key,
    failed: result !== null && !result.ok && loaded?.key === key,
    edited: typed !== null,
    text: (id) => typed?.[id] ?? formatAmountInput(split?.rows.find((row) => row.documentId === id)?.amount ?? '0.00'),
    setText: (id, text) => {
      setSaveErrors([])
      setTyped((prev) => {
        const next: Record<string, string> = {}
        for (const row of split?.rows ?? []) next[row.documentId] = prev?.[row.documentId] ?? formatAmountInput(row.amount)
        return { ...prev, ...next, [id]: text }
      })
    },
    invalid: (id) => parsed[id] === null,
    anyInvalid,
    saveErrors,
    setSaveErrors,
    reset: () => {
      setSaveErrors([])
      setTyped(null)
      // A new key, so the suggestion is asked for again instead of matching `initial`.
      setAttempt((n) => n + 1)
    },
    refresh: () => setAttempt((n) => n + 1),
    rows: () => split?.rows.map((row) => ({ documentId: row.documentId, amount: row.amount })) ?? [],
  }
}

/** The errors that don't belong to a row, for the caller to show above its button. */
export function splitFormErrors(state: SplitState): FieldError[] {
  const errors = [...(state.split?.errors ?? []), ...state.saveErrors]
  return errors.filter((e) => !e.field.startsWith('applications.') && e.code !== 'exceeds_source')
}
