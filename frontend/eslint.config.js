// @ts-check
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { clockBans, moneyBans } from '../eslint-bans.mjs'

export default defineConfig(
  { ignores: ['dist/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['test/**/*.ts', '*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
  // The frontend has no Money or clock module, so the bans have no exceptions.
  { rules: { ...moneyBans, ...clockBans } },
)
