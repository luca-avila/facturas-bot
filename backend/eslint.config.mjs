// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { clockBanRules, clockBans, moneyBanRules, moneyBans } from '../eslint-bans.mjs';

const off = (/** @type {string[]} */ rules) =>
  Object.fromEntries(rules.map((rule) => [rule, 'off']));

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
  { rules: { ...moneyBans, ...clockBans } },
  // The single exception for each ban. Spec files get none.
  { files: ['src/common/money.ts'], rules: off(moneyBanRules) },
  { files: ['src/common/clock.ts'], rules: off(clockBanRules) },
);
