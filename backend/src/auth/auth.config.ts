import { Injectable } from '@nestjs/common';

const MIN_SECRET_LENGTH = 32;

/**
 * Read from `process.env` when the app is created, not when this file is
 * imported, so a missing secret stops the backend from starting.
 */
@Injectable()
export class AuthConfig {
  readonly jwtSecret: Uint8Array;
  /** Only local development (`start:dev`, `start:debug`) drops `Secure`. */
  readonly secureCookie: boolean;

  constructor() {
    const secret = process.env.JWT_SECRET ?? '';
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. ` +
          'Generate one with `openssl rand -base64 48` and put it in .env.',
      );
    }
    this.jwtSecret = new TextEncoder().encode(secret);
    this.secureCookie = process.env.NODE_ENV !== 'development';
  }
}
