import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { UsersService } from '../users/users.service.js';
import { AuthConfig } from './auth.config.js';
import { IS_PUBLIC } from './public.decorator.js';
import type { SessionRequest } from './session.js';
import { readSessionCookie, setSessionCookie } from './session-cookie.js';
import { SessionTokens } from './session-tokens.js';

/**
 * Global and default deny: every route needs a valid session unless it's
 * `@Public()`. It throws, because returning false would answer 403.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: SessionTokens,
    private readonly users: UsersService,
    private readonly config: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<SessionRequest>();
    const token = readSessionCookie(req);
    if (!token) throw new UnauthorizedException();

    const claims = await this.tokens.verify(token);
    if (!claims) throw new UnauthorizedException();

    const user = await this.users.findById(claims.sub);
    // A reset password or a disabled user revokes every earlier session.
    if (
      !user ||
      user.disabledAt !== null ||
      user.passwordSetAt.getTime() !== claims.passwordSetAt
    ) {
      throw new UnauthorizedException();
    }

    req.sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    const renewed = await this.tokens.issue(claims);
    setSessionCookie(
      http.getResponse<Response>(),
      renewed,
      this.config.secureCookie,
    );
    return true;
  }
}
