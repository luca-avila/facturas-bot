import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSession, signIn, signOut } from './api'

const ana = { name: 'Ana', email: 'ana@example.com' }

function respond(status: number, body?: unknown) {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function failToConnect() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signIn', () => {
  it('posts the email and password as JSON to /api/auth/login', async () => {
    const fetch = respond(200, ana)
    await signIn('ana@example.com', 'a long password')

    expect(fetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'a long password' }),
    })
  })

  it('gives the user on 200', async () => {
    respond(200, ana)
    expect(await signIn('ana@example.com', 'x')).toEqual({ ok: true, user: ana })
  })

  it.each([
    [401, 'invalid_credentials'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
  ])('maps %i to %s', async (status, error) => {
    respond(status)
    expect(await signIn('ana@example.com', 'x')).toEqual({ ok: false, error })
  })

  it('gives unavailable when fetch rejects', async () => {
    failToConnect()
    expect(await signIn('ana@example.com', 'x')).toEqual({ ok: false, error: 'unavailable' })
  })

  it('gives unavailable when a 200 body is not a user', async () => {
    respond(200, { hello: 'world' })
    expect(await signIn('ana@example.com', 'x')).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('getSession', () => {
  it('gives the user on 200', async () => {
    const fetch = respond(200, ana)
    expect(await getSession()).toEqual(ana)
    expect(fetch).toHaveBeenCalledWith('/api/auth/me')
  })

  it('gives null on 401', async () => {
    respond(401)
    expect(await getSession()).toBeNull()
  })

  it('gives null when fetch rejects', async () => {
    failToConnect()
    expect(await getSession()).toBeNull()
  })
})

describe('signOut', () => {
  it('posts to /api/auth/logout', async () => {
    const fetch = respond(204)
    await signOut()
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
  })

  it('resolves even when fetch rejects', async () => {
    failToConnect()
    await expect(signOut()).resolves.toBeUndefined()
  })
})
