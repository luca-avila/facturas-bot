import { Injectable } from '@nestjs/common';
import { normalizeEmail } from '../users/email.js';
import { verifyPassword } from '../users/password.js';
import { UsersService } from '../users/users.service.js';
import { LoginAttempts } from './login-attempts.js';
import type { SessionUser } from './session.js';
import { SessionTokens } from './session-tokens.js';

export type SignInResult =
  | { kind: 'signed_in'; user: SessionUser; token: string }
  | { kind: 'invalid_credentials' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: SessionTokens,
    private readonly attempts: LoginAttempts,
  ) {}

  async signIn(rawEmail: string, password: string): Promise<SignInResult> {
    const email = normalizeEmail(rawEmail);

    // Before any await: this attempt counts as a failure until it succeeds.
    const retryAfterSeconds = this.attempts.begin(email);
    if (retryAfterSeconds !== null)
      return { kind: 'rate_limited', retryAfterSeconds };

    const user = await this.users.findByEmail(email);
    // Unknown emails still verify against a dummy hash, so timing doesn't reveal them.
    const passwordMatches = await verifyPassword(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !passwordMatches || user.disabledAt !== null)
      return { kind: 'invalid_credentials' };

    this.attempts.clear(email);

    const token = await this.tokens.issue({
      sub: user.id,
      passwordSetAt: user.passwordSetAt.getTime(),
    });
    return {
      kind: 'signed_in',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      token,
    };
  }
}
