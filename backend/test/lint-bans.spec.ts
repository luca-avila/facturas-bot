import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: backendDir });

const BAN_RULES = new Set(['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax']);

/** Each ban rule's entries in the config `file` gets, without the severity. */
async function banEntries(file: string): Promise<Map<string, unknown[]>> {
  const config = (await eslint.calculateConfigForFile(path.join(backendDir, file))) as Linter.Config;
  const entries = new Map<string, unknown[]>();
  for (const rule of BAN_RULES) {
    const setting: unknown = config.rules?.[rule];
    entries.set(rule, Array.isArray(setting) ? setting.slice(1) : []);
  }
  return entries;
}

const linter = new Linter({ configType: 'flat' });

/**
 * Whether these ban entries catch `code`. Selectors and names need no types,
 * so this skips the typed program and takes a millisecond.
 */
function caught(entries: Map<string, unknown[]>, code: string): boolean {
  const rules: Linter.RulesRecord = {};
  for (const [rule, list] of entries) {
    rules[rule] = ['error', ...list] as Linter.RuleEntry;
  }
  const config: Linter.Config = { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules };
  const messages = linter.verify(code, config, 'case.ts');
  expect(messages.filter((m) => m.fatal)).toEqual([]);
  return messages.some((m) => m.ruleId !== null && BAN_RULES.has(m.ruleId));
}

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
const UPLOADS = 'src/uploads/uploads.service.ts';
const DOCUMENTS = 'src/documents/documents.service.ts';
const EXTRACTION = 'src/extraction/extraction-writer.ts';
const DUE_DATE = 'src/documents/due-date.ts';
const WRITERS = [APPLICATIONS, UPLOADS, DOCUMENTS, EXTRACTION, DUE_DATE];
/** A spec inside a writer directory, whose own config block it must override. */
const UPLOADS_SPEC = 'src/uploads/uploads.spec.ts';

const floatCode = {
  parseFloat: "export const x = parseFloat('1.5');\n",
  'Number.parseFloat': "export const x = Number.parseFloat('1.5');\n",
  'globalThis.parseFloat': "export const x = globalThis.parseFloat('1.5');\n",
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
  'a destructured { application }':
    'export const f = () => {\n  const { application } = tx;\n  return application.create({ data: {} });\n};\n',
  'a destructured { application: apps }':
    'export const f = () => {\n  const { application: apps } = tx;\n  return apps.create({ data: {} });\n};\n',
  "a destructured { 'application': apps }":
    "export const f = () => {\n  const { 'application': apps } = tx;\n  return apps.create({ data: {} });\n};\n",
  'a { application } parameter':
    'export const f = () => prisma.$transaction(({ application }) => application.create({ data: {} }));\n',
  'raw INSERT INTO public.applications':
    'export const f = () => tx.$executeRaw`INSERT INTO public.applications (amount) VALUES (${1})`;\n',
  'raw insert into "public"."applications"':
    "export const f = () => tx.$executeRawUnsafe('insert into \"public\".\"applications\" (amount) values (1)');\n",
  'raw UPDATE public.applications':
    'export const f = () => tx.$executeRaw`UPDATE public.applications SET amount = 1`;\n',
  'raw DELETE FROM "public".applications':
    "export const f = () => tx.$executeRawUnsafe('DELETE FROM \"public\".applications');\n",
};

const applicationReads = {
  'SELECT … FROM applications':
    'export const f = () => tx.$queryRaw`SELECT SUM(amount) FROM applications WHERE document_id = ${1}`;\n',
  '{ applications: rows }': 'export const f = (rows: unknown[]) => ({ applications: rows });\n',
  'SELECT … FROM public.applications':
    'export const f = () => tx.$queryRaw`SELECT SUM(amount) FROM public.applications WHERE document_id = ${1}`;\n',
  'SELECT … FROM "public"."applications"':
    "export const f = () => tx.$queryRawUnsafe('SELECT amount FROM \"public\".\"applications\"');\n",
  '{ application: rows }': 'export const f = (rows: unknown[]) => ({ application: rows });\n',
  'SELECT … FOR UPDATE OF applications':
    'export const f = () => tx.$queryRaw`SELECT id FROM applications WHERE document_id = ${1} FOR UPDATE OF applications`;\n',
};

const documentImageWrites = {
  'tx.documentImage.create(…)': 'export const f = () => tx.documentImage.create({ data: {} });\n',
  'a nested images: { create }':
    'export const f = () => tx.document.create({ data: { images: { create: [] } } });\n',
  'raw INSERT INTO document_images':
    'export const f = () => tx.$executeRaw`INSERT INTO document_images (position) VALUES (${1})`;\n',
  'raw delete from "document_images"':
    "export const f = () => tx.$executeRawUnsafe('delete from \"document_images\"');\n",
};

const extractionJobCreates = {
  'tx.extractionJob.create(…)': 'export const f = () => tx.extractionJob.create({ data: {} });\n',
  'a nested extractionJobs: { create }':
    'export const f = () => tx.document.update({ where: {}, data: { extractionJobs: { create: {} } } });\n',
  'raw INSERT INTO extraction_jobs':
    'export const f = () => tx.$executeRaw`INSERT INTO extraction_jobs (status) VALUES (${1})`;\n',
  'raw insert into public.extraction_jobs':
    "export const f = () => tx.$executeRawUnsafe('insert into public.extraction_jobs (status) values (1)');\n",
};

const extractionJobChanges = {
  'tx.extractionJob.update(…)': 'export const f = () => tx.extractionJob.update({ where: {}, data: {} });\n',
  'a nested extractionJobs: { updateMany }':
    'export const f = () => tx.document.update({ where: {}, data: { extractionJobs: { updateMany: {} } } });\n',
  'raw UPDATE extraction_jobs':
    'export const f = () => tx.$executeRaw`UPDATE extraction_jobs SET status = ${1}`;\n',
  'raw DELETE FROM extraction_jobs':
    "export const f = () => tx.$executeRawUnsafe('DELETE FROM extraction_jobs');\n",
};

const lineAndTaxWrites = {
  'tx.documentLine.createMany(…)': 'export const f = () => tx.documentLine.createMany({ data: [] });\n',
  'tx.documentTax.deleteMany(…)': 'export const f = () => tx.documentTax.deleteMany({ where: {} });\n',
  'a nested lines: { create }':
    'export const f = () => tx.document.update({ where: {}, data: { lines: { create: [] } } });\n',
  'a nested taxes: { deleteMany }':
    'export const f = () => tx.document.update({ where: {}, data: { taxes: { deleteMany: {} } } });\n',
  'raw INSERT INTO document_lines':
    'export const f = () => tx.$executeRaw`INSERT INTO document_lines (position) VALUES (${1})`;\n',
  'raw UPDATE "public".document_taxes':
    "export const f = () => tx.$executeRawUnsafe('UPDATE \"public\".document_taxes SET amount = 1');\n",
};

const dueDateComputations = {
  'dueDate: addDays(…)': 'export const f = (issueDate: string) => ({ dueDate: addDays(issueDate, 30) });\n',
};

/**
 * Each ban's error cases, and the files where they're allowed. due-date.ts is
 * in src/documents/, so it keeps that directory's exception too.
 */
const ownedBans = [
  { ban: 'document_images', owners: [UPLOADS], cases: documentImageWrites },
  { ban: 'extraction_jobs creates', owners: [UPLOADS, DOCUMENTS, DUE_DATE], cases: extractionJobCreates },
  { ban: 'extraction_jobs updates and deletes', owners: [EXTRACTION], cases: extractionJobChanges },
  { ban: 'document_lines and document_taxes', owners: [EXTRACTION], cases: lineAndTaxWrites },
  { ban: 'due dates (D4)', owners: [DUE_DATE], cases: dueDateComputations },
];

const allowedCode = {
  'addDays for something other than a due date':
    'export const f = (date: string) => ({ cutoff: addDays(date, -6) });\n',
  '{ dueDate: typedDueDate }': 'export const f = (typedDueDate: string) => ({ dueDate: typedDueDate });\n',
  'tx.documentImage.findMany(…)': 'export const f = () => tx.documentImage.findMany({ where: {} });\n',
  'tx.extractionJob.findFirst(…)': 'export const f = () => tx.extractionJob.findFirst({ where: {} });\n',
  'include: { images: { orderBy } }':
    "export const f = () => tx.document.findUnique({ where: {}, include: { images: { orderBy: { position: 'asc' } } } });\n",
  '_count: { select: { lines: true, taxes: true } }':
    'export const f = () => tx.document.findUnique({ where: {}, select: { _count: { select: { lines: true, taxes: true } } } });\n',
  '{ lines: [], taxes: [] }': 'export const f = () => ({ lines: [], taxes: [] });\n',
  'SELECT … FROM extraction_jobs … FOR UPDATE SKIP LOCKED':
    'export const f = () => tx.$queryRaw`SELECT id FROM extraction_jobs WHERE status = ${1} FOR UPDATE SKIP LOCKED`;\n',
  'SELECT … FROM document_images':
    "export const f = () => tx.$queryRawUnsafe('SELECT sha256 FROM document_images');\n",
  'raw UPDATE documents': 'export const f = () => tx.$executeRaw`UPDATE documents SET review_status = ${1}`;\n',
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
      expect(await banErrors(APPLICATIONS, applicationWrites['a destructured { application }'])).toEqual([]);
      expect(await banErrors(SPEC, applicationWrites['a destructured { application }'])).toEqual([]);
    });

    it('does not exempt clock.ts', async () => {
      expect(await banErrors(CLOCK, applicationWrites['tx.application.create(…)'])).not.toEqual([]);
    });

    it('keeps the clock ban in src/applications/, and the clock exception in clock.ts', async () => {
      expect(await banErrors(APPLICATIONS, clockCode['new Date()'])).not.toEqual([]);
      expect(await banErrors(CLOCK, clockCode['new Date()'])).toEqual([]);
    });
  });

  describe.each(ownedBans)('$ban', ({ owners, cases }) => {
    const others = [MAIN, CLOCK, ...WRITERS.filter((file) => !owners.includes(file))];

    it.each(Object.entries(cases))('%s is an error outside its writers', async (_, code) => {
      for (const file of others) {
        expect([file, await banErrors(file, code)]).toEqual([file, ['no-restricted-syntax']]);
      }
    });

    it.each(Object.entries(cases))('%s is allowed in its writers and in spec files', async (_, code) => {
      for (const file of [...owners, SPEC, UPLOADS_SPEC]) {
        expect([file, await banErrors(file, code)]).toEqual([file, []]);
      }
    });
  });

  describe('reads and other allowed code', () => {
    it.each(Object.entries(allowedCode))('%s is allowed anywhere', async (_, code) => {
      expect(await banErrors(MAIN, code)).toEqual([]);
    });

    it('keeps the clock ban in every writer directory', async () => {
      for (const file of WRITERS) {
        expect([file, await banErrors(file, clockCode['new Date()'])]).toEqual([file, ['no-restricted-syntax']]);
      }
    });
  });

  // An entry no case needs can be deleted, or broken, with every case still
  // passing. Each entry must be the only one that catches some error case.
  describe('coverage', () => {
    const errorCases = {
      ...floatCode,
      ...clockCode,
      ...applicationWrites,
      ...documentImageWrites,
      ...extractionJobCreates,
      ...extractionJobChanges,
      ...lineAndTaxWrites,
      ...dueDateComputations,
    };

    it('every ban entry outside the exceptions has an error case that needs it', async () => {
      const entries = await banEntries(MAIN);
      const missed = Object.entries(errorCases).filter(([, code]) => !caught(entries, code));
      expect(missed.map(([name]) => name)).toEqual([]);

      const unneeded: string[] = [];
      for (const [rule, list] of entries) {
        for (const entry of list) {
          const without = new Map(entries).set(rule, list.filter((other) => other !== entry));
          if (Object.values(errorCases).every((code) => caught(without, code))) {
            unneeded.push(`${rule}: ${JSON.stringify(entry)}`);
          }
        }
      }
      expect(unneeded).toEqual([]);
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
