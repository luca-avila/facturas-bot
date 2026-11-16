import { Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { now } from '../common/clock.js';
import { AuthConfig } from './auth.config.js';
import { SESSION_LIFETIME_SECONDS } from './session.js';

export interface SessionClaims {
  /** The user id. */
  sub: string;
  /** The user's `password_set_at` when the session was issued, in epoch milliseconds. */
  passwordSetAt: number;
}

const ALGORITHM = 'HS256';

/** Session tokens: a JWT signed with `JWT_SECRET`, expiring 30 days after it was issued. */
@Injectable()
export class SessionTokens {
  constructor(private readonly config: AuthConfig) {}

  issue(claims: SessionClaims): Promise<string> {
    const issuedAt = Math.floor(now().getTime() / 1000);
    return new SignJWT({ passwordSetAt: claims.passwordSetAt })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(claims.sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + SESSION_LIFETIME_SECONDS)
      .sign(this.config.jwtSecret);
  }

  /** The claims of a valid token, or null for one that's tampered, expired, malformed or signed with another secret. */
  async verify(token: string): Promise<SessionClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.config.jwtSecret, {
        algorithms: [ALGORITHM],
        currentDate: now(),
      });
      const { sub, passwordSetAt } = payload;
      if (typeof sub !== 'string' || typeof passwordSetAt !== 'number')
        return null;
      return { sub, passwordSetAt };
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
  }
}
