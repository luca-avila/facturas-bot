import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Response } from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { UsersService } from '../src/users/users.service.js';

/** The real app, wired like `main.ts`. Each spec file builds its own, so in-memory state doesn't leak between files. */
export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

/** Every `Set-Cookie` line of the response. */
export function setCookies(res: Response): string[] {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

/** The `session` cookie line, or undefined. */
export function sessionCookieLine(res: Response): string | undefined {
  return setCookies(res).find((line) => line.startsWith('session='));
}

/**
 * The `session` cookie value. Supertest's agent won't send a `Secure` cookie
 * over HTTP, so tests send `Cookie: session=<value>` themselves.
 */
export function sessionCookie(res: Response): string | undefined {
  return (
    sessionCookieLine(res)?.split(';')[0].slice('session='.length) || undefined
  );
}

export interface TestUser {
  email: string;
  name: string;
  password: string;
}

/** A new user with a unique email, so tests running in parallel never share one. */
export async function createUser(
  app: NestExpressApplication,
  overrides: Partial<TestUser> = {},
): Promise<TestUser> {
  const user = {
    email: `ana-${randomUUID()}@example.com`,
    name: 'Ana',
    password: `pw-${randomUUID()}`,
    ...overrides,
  };
  await app.get(UsersService).create({ ...user, role: 'staff' });
  return user;
}
