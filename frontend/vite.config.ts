import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // One origin for the browser, so CORS stays off. `--host` isn't set here:
    // use `npm run dev -- --host` to reach the dev server from a phone.
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    // Any test that logs console.error fails (test/setup.ts). Screen tests,
    // `*.spec.tsx`, render in jsdom and stub `fetch` (src/screens/screen-test.tsx).
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
          setupFiles: ['test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'screens',
          environment: 'jsdom',
          include: ['src/**/*.spec.tsx'],
          setupFiles: ['test/setup.ts', 'test/dom-setup.ts'],
          unstubGlobals: true,
        },
      },
    ],
  },
})
