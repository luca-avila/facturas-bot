import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library unmounts after each test by itself only with Vitest globals,
// which this repo doesn't use. Registered after test/setup.ts, so it runs
// first, and anything logged while unmounting still fails the test.
afterEach(cleanup)
