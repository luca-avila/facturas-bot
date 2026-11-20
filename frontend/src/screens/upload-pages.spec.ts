import { describe, expect, it } from 'vitest'
import { canUpload, movePage, newPage, removePage, type UploadPage, withServerErrors } from './upload-pages'

function ready(name: string): UploadPage {
  return { ...newPage(name), state: 'ready', blob: new Blob(['x']), previewUrl: `blob:${name}` }
}

const names = (pages: UploadPage[]) => pages.map((page) => page.fileName)

describe('movePage', () => {
  const pages = [ready('a'), ready('b'), ready('c')]

  it('moves a page earlier and later', () => {
    expect(names(movePage(pages, 1, -1))).toEqual(['b', 'a', 'c'])
    expect(names(movePage(pages, 1, 1))).toEqual(['a', 'c', 'b'])
  })

  it('changes nothing for the first page moved earlier or the last moved later', () => {
    expect(names(movePage(pages, 0, -1))).toEqual(['a', 'b', 'c'])
    expect(names(movePage(pages, 2, 1))).toEqual(['a', 'b', 'c'])
  })
})

describe('removePage', () => {
  it('removes the page at the index', () => {
    expect(names(removePage([ready('a'), ready('b'), ready('c')], 1))).toEqual(['a', 'c'])
  })
})

describe('withServerErrors', () => {
  it('puts each error on the page sent at that index, and it stays with the page after a move', () => {
    const documentId = 'a1626f92-16b7-4ef8-a762-7bd31048aa4f'
    const sent = [ready('a'), ready('b'), ready('c')]
    const marked = withServerErrors(sent, [
      { page: 2, code: 'photo_in_other_document', documentId },
      { page: 0, code: 'photo_type_invalid', documentId: null },
    ])
    expect(marked.map((page) => [page.fileName, page.state, page.problem])).toEqual([
      ['a', 'problem', { kind: 'server', code: 'photo_type_invalid', documentId: null }],
      ['b', 'ready', null],
      ['c', 'problem', { kind: 'server', code: 'photo_in_other_document', documentId }],
    ])
    const moved = movePage(marked, 2, -1)
    expect(moved.map((page) => [page.fileName, page.problem?.kind ?? null])).toEqual([
      ['a', 'server'],
      ['c', 'server'],
      ['b', null],
    ])
  })
})

describe('canUpload', () => {
  it('is true for ready pages with no problem, up to 10', () => {
    expect(canUpload([ready('a')])).toBe(true)
    expect(canUpload(Array.from({ length: 10 }, (_, i) => ready(`p${i}`)))).toBe(true)
  })

  it('is false with no pages', () => {
    expect(canUpload([])).toBe(false)
  })

  it('is false with 11 pages', () => {
    expect(canUpload(Array.from({ length: 11 }, (_, i) => ready(`p${i}`)))).toBe(false)
  })

  it('is false while a page is being prepared', () => {
    expect(canUpload([ready('a'), newPage('b')])).toBe(false)
  })

  it('is false with a page marked by a problem', () => {
    const problem: UploadPage = { ...ready('b'), state: 'problem', problem: { kind: 'too_large' } }
    expect(canUpload([ready('a'), problem])).toBe(false)
  })

  it('is false with a ready page that still carries a problem', () => {
    const marked: UploadPage = { ...ready('b'), problem: { kind: 'format', format: 'HEIC' } }
    expect(canUpload([ready('a'), marked])).toBe(false)
  })
})

describe('newPage', () => {
  it('gives every page its own key', () => {
    expect(newPage('a').key).not.toBe(newPage('a').key)
  })
})
