// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { clockBans, moneyBanRules, moneyBans } from '../eslint-bans.mjs';

const off = (/** @type {string[]} */ rules) =>
  Object.fromEntries(rules.map((rule) => [rule, 'off']));

// Each table that agents.md gives one writer is banned everywhere else, with
// the claim as the message, so a new writer has to change the claim with the
// code. The rule is no-restricted-syntax, which already carries the clock
// selectors, and ESLint replaces a rule's options instead of merging them, so
// each file gets the rule built from the groups that apply to it.

const INSERT_SQL = String.raw`insert\s+into`;
const CHANGE_SQL = String.raw`update|delete\s+from|truncate(\s+table)?`;
/** Raw SQL that runs one of `verbs` on one of `tables`, with or without a schema. */
const writeSql = (/** @type {string} */ verbs, /** @type {string} */ tables) =>
  String.raw`/\b(${verbs})\s+("?\w+"?\s*\.\s*)?"?(${tables})\b/i`;
const WRITE_METHODS = '/^(create|update|upsert|delete)/';

/**
 * Writes through the Prisma delegates, as `tx.documentImage.create(…)`, nested
 * writes through the relation fields, as `images: { create: … }`, and raw SQL.
 * Reads through the same delegates and fields stay allowed.
 */
function writeSelectors(
  /** @type {string} */ message,
  /** @type {{ delegates: string, relations: string, methods: string, sql: string }} */ table,
) {
  return [
    {
      selector: `MemberExpression[object.property.name=/^(${table.delegates})$/][property.name=${table.methods}]`,
      message,
    },
    {
      selector: `Property[key.name=/^(${table.relations})$/] > ObjectExpression > Property[key.name=${table.methods}]`,
      message,
    },
    { selector: `TemplateElement[value.raw=${table.sql}]`, message },
    { selector: `Literal[value=${table.sql}]`, message },
  ];
}

const documentImageWriteSelectors = writeSelectors('Only src/uploads/ writes document_images (UploadsService).', {
  delegates: 'documentImage',
  relations: 'images',
  methods: WRITE_METHODS,
  sql: writeSql(`${INSERT_SQL}|${CHANGE_SQL}`, 'document_images'),
});
const extractionJobCreateSelectors = writeSelectors(
  'Only src/uploads/ and src/documents/ create extraction_jobs (an upload, and DocumentsService.retry).',
  { delegates: 'extractionJob', relations: 'extractionJobs', methods: '/^create/', sql: writeSql(INSERT_SQL, 'extraction_jobs') },
);
const extractionJobChangeSelectors = writeSelectors(
  'Only src/extraction/ updates or deletes extraction_jobs (the worker).',
  {
    delegates: 'extractionJob',
    relations: 'extractionJobs',
    methods: '/^(update|upsert|delete)/',
    sql: writeSql(CHANGE_SQL, 'extraction_jobs'),
  },
);
const lineAndTaxWriteSelectors = writeSelectors(
  'Only src/extraction/ writes document_lines and document_taxes (the worker).',
  {
    delegates: 'documentLine|documentTax',
    relations: 'lines|taxes',
    methods: WRITE_METHODS,
    sql: writeSql(`${INSERT_SQL}|${CHANGE_SQL}`, 'document_lines|document_taxes'),
  },
);

// `applications` bans its delegate outright, reads included, since every read
// goes through BalancesService or raw SQL (invariants 2–6).
const APPLICATIONS_MESSAGE = 'Only src/applications/ writes applications (invariants 2–6).';
const WRITE_SQL = writeSql(`${INSERT_SQL}|${CHANGE_SQL}`, 'applications');
const applicationWriteSelectors = [
  // The Prisma delegate, as `.application` and as `['application']`.
  { selector: "MemberExpression[property.name='application']", message: APPLICATIONS_MESSAGE },
  { selector: "MemberExpression[property.value='application']", message: APPLICATIONS_MESSAGE },
  // The delegate destructured, as `{ application }`, renamed, or in a parameter.
  { selector: "ObjectPattern > Property[key.name='application']", message: APPLICATIONS_MESSAGE },
  { selector: "ObjectPattern > Property[key.value='application']", message: APPLICATIONS_MESSAGE },
  // Nested writes through the relation fields.
  { selector: 'Property[key.name=/^applications(Received|Given)$/]', message: APPLICATIONS_MESSAGE },
  // Raw SQL, in template and string literals, with or without a schema.
  { selector: `TemplateElement[value.raw=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
  { selector: `Literal[value=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
];
const clockSelectors = clockBans['no-restricted-syntax'].slice(1);
const restrictedSyntax = (/** @type {unknown[][]} */ ...groups) => ({
  'no-restricted-syntax': ['error', ...groups.flat()],
});

/** Each table's writers, the directories that may write it. */
const writeBans = [
  { owners: ['src/applications/'], selectors: applicationWriteSelectors },
  { owners: ['src/uploads/'], selectors: documentImageWriteSelectors },
  { owners: ['src/uploads/', 'src/documents/'], selectors: extractionJobCreateSelectors },
  { owners: ['src/extraction/'], selectors: extractionJobChangeSelectors },
  { owners: ['src/extraction/'], selectors: lineAndTaxWriteSelectors },
];
const allWriteSelectors = writeBans.map((ban) => ban.selectors);
const ownerDirs = [...new Set(writeBans.flatMap((ban) => ban.owners))];
const writeSelectorsOutside = (/** @type {string} */ dir) =>
  writeBans.filter((ban) => !ban.owners.includes(dir)).map((ban) => ban.selectors);

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'src/generated/'] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    rules: {
      ...moneyBans,
      ...restrictedSyntax(clockSelectors, ...allWriteSelectors),
    },
  },
  // The single exception for each money and clock ban. Spec files get none.
  { files: ['src/common/money.ts'], rules: off(moneyBanRules) },
  { files: ['src/common/clock.ts'], rules: restrictedSyntax(...allWriteSelectors) },
  // Each writer directory may write its own tables and no other.
  ...ownerDirs.map((dir) => ({
    files: [`${dir}**/*.ts`],
    rules: restrictedSyntax(clockSelectors, ...writeSelectorsOutside(dir)),
  })),
  // Specs write any table, to build states the services would refuse. Last,
  // so it wins over the writer directories for the specs inside them.
  { files: ['**/*.spec.ts'], rules: restrictedSyntax(clockSelectors) },
);
