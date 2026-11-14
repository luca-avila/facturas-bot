import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';
import type { SessionUser } from './session.js';
import { clearSessionCookie, setSessionCookie } from './session-cookie.js';

interface ProfileResponse {
  name: string;
  email: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function parseCredentials(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null)
    throw new BadRequestException();
  const { email, password } = body as Record<string, unknown>;
  if (!isNonEmptyString(email) || !isNonEmptyString(password))
    throw new BadRequestException();
  return { email, password };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AuthConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProfileResponse> {
    const { email, password } = parseCredentials(body);
    const result = await this.auth.signIn(email, password);
    if (result.kind === 'rate_limited') {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (result.kind === 'invalid_credentials') {
      throw new UnauthorizedException();
    }
    setSessionCookie(res, result.token, this.config.secureCookie);
    return { name: result.user.name, email: result.user.email };
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser): ProfileResponse {
    return { name: user.name, email: user.email };
  }

  /** Deletes the cookie on this device. Other sessions stay valid. */
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    clearSessionCookie(res, this.config.secureCookie);
  }
}
