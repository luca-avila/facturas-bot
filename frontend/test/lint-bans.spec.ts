import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: frontendDir })

const BAN_RULES = new Set(['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'])

/** Lints `code` as the content of `src/main.tsx`, with the real config. */
async function banErrors(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(frontendDir, 'src', 'main.tsx'),
  })
  expect(result.messages.filter((m) => m.fatal)).toEqual([])
  return result.messages
    .filter((m) => m.severity === 2 && m.ruleId !== null && BAN_RULES.has(m.ruleId))
    .map((m) => m.ruleId ?? '')
}

describe('frontend lint bans', () => {
  it.each([
    ['parseFloat', "export const x = parseFloat('1.5')\n"],
    ['toFixed', 'export const f = (x: number) => x.toFixed(2)\n'],
    ['new Date()', 'export const d = new Date()\n'],
    ['Date.now()', 'export const d = Date.now()\n'],
  ])('%s is an error', async (_, code) => {
    expect(await banErrors(code)).not.toEqual([])
  })

  it('allows new Date(value)', async () => {
    expect(await banErrors("export const d = new Date('2026-11-09')\n")).toEqual([])
  })
})
