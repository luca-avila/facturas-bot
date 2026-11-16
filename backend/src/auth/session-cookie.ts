import type { CookieOptions, Request, Response } from 'express';
import { SESSION_LIFETIME_SECONDS } from './session.js';

export const SESSION_COOKIE = 'session';

function options(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', path: '/api', secure };
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function setSessionCookie(
  res: Response,
  token: string,
  secure: boolean,
): void {
  res.cookie(SESSION_COOKIE, token, {
    ...options(secure),
    maxAge: SESSION_LIFETIME_SECONDS * 1000,
  });
}

/**
 * Expires the cookie. Any `session` cookie already queued on the response
 * (the guard's renewal) is removed first, so the response carries only this one.
 */
export function clearSessionCookie(res: Response, secure: boolean): void {
  const queued = res.getHeader('Set-Cookie');
  if (Array.isArray(queued)) {
    const others = queued.filter(
      (cookie) => !cookie.startsWith(`${SESSION_COOKIE}=`),
    );
    res.setHeader('Set-Cookie', others);
  } else if (
    typeof queued === 'string' &&
    queued.startsWith(`${SESSION_COOKIE}=`)
  ) {
    res.removeHeader('Set-Cookie');
  }
  res.clearCookie(SESSION_COOKIE, options(secure));
}
