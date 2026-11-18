// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { clockBans, moneyBanRules, moneyBans } from '../eslint-bans.mjs';

const off = (/** @type {string[]} */ rules) =>
  Object.fromEntries(rules.map((rule) => [rule, 'off']));

// Only src/applications/ writes `applications` (invariants 2–6). The rule is
// no-restricted-syntax, which already carries the clock selectors, and ESLint
// replaces a rule's options instead of merging them, so each file gets the
// rule built from the groups that apply to it.
const APPLICATIONS_MESSAGE = 'Only src/applications/ writes applications (invariants 2–6).';
const WRITE_SQL = String.raw`/\b(insert\s+into|update|delete\s+from|truncate(\s+table)?)\s+"?applications\b/i`;
const applicationWriteSelectors = [
  // The Prisma delegate, as `.application` and as `['application']`.
  { selector: "MemberExpression[property.name='application']", message: APPLICATIONS_MESSAGE },
  { selector: "MemberExpression[property.value='application']", message: APPLICATIONS_MESSAGE },
  // Nested writes through the relation fields.
  { selector: 'Property[key.name=/^applications(Received|Given)$/]', message: APPLICATIONS_MESSAGE },
  // Raw SQL, in template and string literals.
  { selector: `TemplateElement[value.raw=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
  { selector: `Literal[value=${WRITE_SQL}]`, message: APPLICATIONS_MESSAGE },
];
const clockSelectors = clockBans['no-restricted-syntax'].slice(1);
const restrictedSyntax = (/** @type {unknown[][]} */ ...groups) => ({
  'no-restricted-syntax': ['error', ...groups.flat()],
});

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
      ...restrictedSyntax(clockSelectors, applicationWriteSelectors),
    },
  },
  // The single exception for each money and clock ban. Spec files get none.
  { files: ['src/common/money.ts'], rules: off(moneyBanRules) },
  { files: ['src/common/clock.ts'], rules: restrictedSyntax(applicationWriteSelectors) },
  // The applications service writes them, and specs build states it would refuse.
  {
    files: ['src/applications/**/*.ts', '**/*.spec.ts'],
    rules: restrictedSyntax(clockSelectors),
  },
);
