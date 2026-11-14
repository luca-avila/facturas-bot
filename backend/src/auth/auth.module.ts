import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersModule } from '../users/users.module.js';
import { AuthConfig } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginAttempts } from './login-attempts.js';
import { SessionGuard } from './session.guard.js';
import { SessionTokens } from './session-tokens.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthConfig,
    SessionTokens,
    AuthService,
    LoginAttempts,
    // Every route of every module, now and in later slices.
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AuthModule {}
