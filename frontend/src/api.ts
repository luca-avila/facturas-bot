export interface SessionUser {
  name: string
  email: string
}

export type SignInError = 'invalid_credentials' | 'rate_limited' | 'unavailable'

export type SignInResult = { ok: true; user: SessionUser } | { ok: false; error: SignInError }

function toSessionUser(body: unknown): SessionUser | null {
  if (typeof body !== 'object' || body === null) return null
  const { name, email } = body as Record<string, unknown>
  return typeof name === 'string' && typeof email === 'string' ? { name, email } : null
}

/** The signed-in user, or null when there's no session or the server can't be reached. */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const res = await fetch('/api/auth/me')
    if (!res.ok) return null
    return toSessionUser(await res.json())
  } catch {
    return null
  }
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  let res: Response
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  if (res.status === 401) return { ok: false, error: 'invalid_credentials' }
  if (res.status === 429) return { ok: false, error: 'rate_limited' }
  if (res.status !== 200) return { ok: false, error: 'unavailable' }
  try {
    const user = toSessionUser(await res.json())
    return user ? { ok: true, user } : { ok: false, error: 'unavailable' }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

/** Deletes the session cookie on this device. The caller shows the sign-in screen whatever happens. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // Nothing to do: the screen goes back to sign-in anyway.
  }
}
