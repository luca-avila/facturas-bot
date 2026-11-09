import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: backendDir });

const BAN_RULES = new Set(['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax']);

/**
 * Lints `code` as if it were the content of `file`, with the real config.
 * Typed linting needs a path the TypeScript project knows, so `file` exists.
 */
async function banErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(backendDir, file) });
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  return result.messages
    .filter((m) => m.severity === 2 && m.ruleId !== null && BAN_RULES.has(m.ruleId))
    .map((m) => m.ruleId ?? '');
}

const MAIN = 'src/main.ts';
const MONEY = 'src/common/money.ts';
const CLOCK = 'src/common/clock.ts';
const SPEC = 'src/common/clock.spec.ts';

const floatCode = {
  parseFloat: "export const x = parseFloat('1.5');\n",
  'Number.parseFloat': "export const x = Number.parseFloat('1.5');\n",
  toFixed: 'export const f = (x: number) => x.toFixed(2);\n',
};

const clockCode = {
  'new Date()': 'export const d = new Date();\n',
  'Date()': 'export const d = Date();\n',
  'Date.now()': 'export const d = Date.now();\n',
};

describe('backend lint bans', () => {
  describe('money', () => {
    it.each(Object.entries(floatCode))('%s is an error outside money.ts', async (_, code) => {
      expect(await banErrors(MAIN, code)).not.toEqual([]);
    });

    it.each(Object.entries(floatCode))('%s is allowed in money.ts', async (_, code) => {
      expect(await banErrors(MONEY, code)).toEqual([]);
    });
  });

  describe('clock', () => {
    it.each(Object.entries(clockCode))('%s is an error outside clock.ts', async (_, code) => {
      expect(await banErrors(MAIN, code)).not.toEqual([]);
    });

    it.each(Object.entries(clockCode))('%s is allowed in clock.ts', async (_, code) => {
      expect(await banErrors(CLOCK, code)).toEqual([]);
    });

    it('allows new Date(value) anywhere, since it does not read the clock', async () => {
      const code = "export const d = new Date('2026-11-09');\n";
      expect(await banErrors(MAIN, code)).toEqual([]);
      expect(await banErrors(SPEC, code)).toEqual([]);
    });
  });

  describe('exceptions', () => {
    it('money.ts may not read the clock', async () => {
      expect(await banErrors(MONEY, clockCode['new Date()'])).not.toEqual([]);
    });

    it('clock.ts may not use parseFloat', async () => {
      expect(await banErrors(CLOCK, floatCode.parseFloat)).not.toEqual([]);
    });

    it('spec files are not exempt', async () => {
      expect(await banErrors(SPEC, clockCode['new Date()'])).not.toEqual([]);
    });
  });
});
