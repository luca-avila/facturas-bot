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
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}', 'test/**/*.spec.ts'],
  },
})
