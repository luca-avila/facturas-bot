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
const APPLICATIONS = 'src/applications/applications.service.ts';

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

const applicationWrites = {
  'tx.application.create(…)': 'export const f = () => tx.application.create({ data: {} });\n',
  "tx['application']": "export const f = () => tx['application'];\n",
  'a nested applicationsReceived write':
    'export const f = () => tx.document.update({ where: {}, data: { applicationsReceived: { create: [] } } });\n',
  'raw INSERT INTO applications':
    'export const f = () => tx.$executeRaw`INSERT INTO applications (amount) VALUES (${1})`;\n',
  'raw insert into "applications"':
    "export const f = () => tx.$executeRawUnsafe('insert into \"applications\" (amount) values (1)');\n",
  'raw UPDATE applications': 'export const f = () => tx.$executeRaw`UPDATE applications SET amount = 1`;\n',
  'raw DELETE FROM applications':
    "export const f = () => tx.$executeRawUnsafe('DELETE FROM applications');\n",
};

const applicationReads = {
  'SELECT … FROM applications':
    'export const f = () => tx.$queryRaw`SELECT SUM(amount) FROM applications WHERE document_id = ${1}`;\n',
  '{ applications: rows }': 'export const f = (rows: unknown[]) => ({ applications: rows });\n',
};

describe('backend lint bans', () => {
  // The first typed lint builds the whole TypeScript program. Under the load of
  // the other spec files (argon2 hashing) that alone can pass the 5 s test timeout.
  beforeAll(async () => {
    await banErrors(MAIN, 'export {};\n');
  }, 60_000);

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

  describe('applications', () => {
    it.each(Object.entries(applicationWrites))('%s is an error outside src/applications/', async (_, code) => {
      expect(await banErrors(MAIN, code)).toEqual(['no-restricted-syntax']);
    });

    it.each(Object.entries(applicationReads))('%s is allowed anywhere', async (_, code) => {
      expect(await banErrors(MAIN, code)).toEqual([]);
    });

    it('allows tx.application.create(…) in src/applications/ and in spec files', async () => {
      expect(await banErrors(APPLICATIONS, applicationWrites['tx.application.create(…)'])).toEqual([]);
      expect(await banErrors(SPEC, applicationWrites['tx.application.create(…)'])).toEqual([]);
    });

    it('does not exempt clock.ts', async () => {
      expect(await banErrors(CLOCK, applicationWrites['tx.application.create(…)'])).not.toEqual([]);
    });

    it('keeps the clock ban in src/applications/, and the clock exception in clock.ts', async () => {
      expect(await banErrors(APPLICATIONS, clockCode['new Date()'])).not.toEqual([]);
      expect(await banErrors(CLOCK, clockCode['new Date()'])).toEqual([]);
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
