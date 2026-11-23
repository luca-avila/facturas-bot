import { describe, expect, it, vi } from 'vitest'
import { type Encode, preparePhoto, scaledSize } from './photos'

const SEVEN_MIB = 7 * 1024 * 1024

function file(name: string, type: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type })
}

const failing: Encode = () => Promise.reject(new Error('No canvas here.'))

describe('preparePhoto', () => {
  it('compresses once to 2200 px at quality 0.85, and returns the result', async () => {
    const original = file('IMG_1.jpg', 'image/jpeg', 5_000_000)
    const compressed = new Blob([new Uint8Array(800_000)], { type: 'image/jpeg' })
    const encode = vi.fn<Encode>(() => Promise.resolve(compressed))
    const prepared = await preparePhoto(original, encode)
    expect(encode.mock.calls).toEqual([[original, 2200, 0.85]])
    expect(prepared).toEqual({ ok: true, blob: compressed })
  })

  it('refuses a compressed result over 7 MiB', async () => {
    const encode: Encode = () => Promise.resolve(new Blob([new Uint8Array(SEVEN_MIB + 1)], { type: 'image/jpeg' }))
    expect(await preparePhoto(file('IMG_1.jpg', 'image/jpeg'), encode)).toEqual({ ok: false, problem: 'too_large' })
  })

  describe('when the browser can’t compress', () => {
    it('sends a JPEG of exactly 7 MiB as it is', async () => {
      const original = file('IMG_1.jpg', 'image/jpeg', SEVEN_MIB)
      const prepared = await preparePhoto(original, failing)
      expect(prepared).toEqual({ ok: true, blob: original })
    })

    it('refuses a JPEG one byte larger', async () => {
      const original = file('IMG_1.jpg', 'image/jpeg', SEVEN_MIB + 1)
      expect(await preparePhoto(original, failing)).toEqual({ ok: false, problem: 'too_large' })
    })

    it.each([
      ['a PNG', file('scan.png', 'image/png')],
      ['a WebP', file('scan.webp', 'image/webp')],
    ])('sends %s as it is', async (_, original) => {
      expect(await preparePhoto(original, failing)).toEqual({ ok: true, blob: original })
    })

    it.each([
      ['a HEIC photo', file('IMG_1.HEIC', 'image/heic'), 'HEIC'],
      ['a PDF with no type', file('scan.pdf', ''), 'PDF'],
      ['a file without an extension', file('foto', ''), null],
    ])('refuses %s by its format', async (_, original, format) => {
      expect(await preparePhoto(original, failing)).toEqual({ ok: false, problem: 'format', format })
    })
  })
})

describe('scaledSize', () => {
  it.each([
    [4000, 3000, 2200, 1650],
    [3000, 4000, 1650, 2200],
    [4033, 3025, 2200, 1650],
    [900, 1600, 900, 1600],
    [2200, 1000, 2200, 1000],
    [1, 5000, 1, 2200],
  ])('scales %i×%i to %i×%i', (width, height, scaledWidth, scaledHeight) => {
    expect(scaledSize(width, height, 2200)).toEqual({ width: scaledWidth, height: scaledHeight })
  })

  it('throws on a zero size', () => {
    expect(() => scaledSize(0, 100, 2200)).toThrow()
  })
})
