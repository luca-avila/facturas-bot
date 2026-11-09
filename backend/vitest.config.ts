import { defineConfig } from 'vitest/config';
import { loadRootEnv } from './src/env.js';
import { testDatabaseUrl } from './test/test-database.js';

loadRootEnv();

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
    globalSetup: ['./test/global-setup.ts'],
    env: {
      // Workers only ever see the test database, never the dev one.
      DATABASE_URL: testDatabaseUrl(process.env.DATABASE_URL),
      // A time-zone bug can't hide behind a machine already in Buenos Aires.
      TZ: 'UTC',
    },
  },
});
