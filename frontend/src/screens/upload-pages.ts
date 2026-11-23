// The page list of *Subir*, as pure functions over an array.

import type { FieldErrorCode, PageError } from '../accounts-api'
import { MAX_PAGES } from '../photos'

export type PageProblem =
  | { kind: 'format'; format: string | null }
  | { kind: 'too_large' }
  | { kind: 'server'; code: FieldErrorCode; documentId: string | null }

export interface UploadPage {
  key: number
  fileName: string
  state: 'preparing' | 'ready' | 'problem'
  blob: Blob | null
  previewUrl: string | null
  problem: PageProblem | null
}

// Not `crypto.randomUUID()`: the phone reaches the dev server over plain
// HTTP, which isn't a secure context, so it's undefined there.
let nextKey = 1

/** A page for a picked file, before it's prepared. */
export function newPage(fileName: string): UploadPage {
  return { key: nextKey++, fileName, state: 'preparing', blob: null, previewUrl: null, problem: null }
}

/** Moves the page at `index` by `delta`. Nothing happens at either end. */
export function movePage(pages: UploadPage[], index: number, delta: -1 | 1): UploadPage[] {
  const target = index + delta
  if (index < 0 || index >= pages.length || target < 0 || target >= pages.length) return pages
  const moved = [...pages]
  ;[moved[index], moved[target]] = [moved[target], moved[index]]
  return moved
}

export function removePage(pages: UploadPage[], index: number): UploadPage[] {
  return pages.filter((_, i) => i !== index)
}

/**
 * The pages as they were sent, each error on the page at its index. The
 * problem then moves with its page.
 */
export function withServerErrors(sent: UploadPage[], errors: PageError[]): UploadPage[] {
  const problems = new Map<number, PageProblem>()
  for (const error of errors) {
    problems.set(error.page, { kind: 'server', code: error.code, documentId: error.documentId })
  }
  return sent.map((page, i) => {
    const problem = problems.get(i)
    return problem === undefined ? page : { ...page, state: 'problem', problem }
  })
}

/** From 1 to `MAX_PAGES` pages, every one ready, with no problem. */
export function canUpload(pages: UploadPage[]): boolean {
  return (
    pages.length >= 1 &&
    pages.length <= MAX_PAGES &&
    pages.every((page) => page.state === 'ready' && page.problem === null)
  )
}
