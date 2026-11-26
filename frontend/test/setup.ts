import { format } from 'node:util'
import { afterEach, beforeEach, vi } from 'vitest'

// A test that logs console.error fails once it ends, with what was logged.
// React reports duplicate keys, updates outside act() and render errors there,
// and jsdom reports what it can't do.
let logged: string[] = []
let restore = () => {}

beforeEach(() => {
  logged = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(format(...args))
  })
  restore = () => spy.mockRestore()
})

afterEach(() => {
  restore()
  if (logged.length > 0) {
    throw new Error(`console.error was called:\n${logged.join('\n')}`)
  }
})
