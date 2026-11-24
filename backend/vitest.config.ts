import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { loadRootEnv } from './src/env.js';
import { testDatabaseUrl } from './test/test-database.js';
import { RESTAURANT_TEST_CUIT } from './test/test-cuits.js';

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
    // Replaces fetch with one that throws.
    setupFiles: ['./test/no-network.ts'],
    // Sign-in, user and script tests hash with argon2 at its real cost, while
    // the other spec files run in parallel. Under that load one test can take
    // over 8 s, past the 5 s default.
    testTimeout: 20_000,
    env: {
      // Workers only ever see the test database, never the dev one.
      DATABASE_URL: testDatabaseUrl(process.env.DATABASE_URL),
      // A time-zone bug can't hide behind a machine already in Buenos Aires.
      TZ: 'UTC',
      // A fresh secret per run, so no secret is ever written down.
      JWT_SECRET: randomBytes(32).toString('base64url'),
      // A fresh directory per run, outside the repo.
      UPLOAD_DIR: path.join(
        os.tmpdir(),
        `facturas-test-uploads-${randomBytes(6).toString('hex')}`,
      ),
      // loadRootEnv() above loads the real .env: these win over its values.
      ANTHROPIC_API_KEY: 'test-key-not-valid',
      LLM_MODEL: 'claude-haiku-5-5',
      RESTAURANT_CUIT: RESTAURANT_TEST_CUIT,
    },
  },
});
