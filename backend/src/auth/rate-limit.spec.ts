import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  sessionCookie,
  setCookies,
} from '../../test/app.js';
import { UsersService } from '../users/users.service.js';

const MINUTE = 60 * 1000;
const T = new Date('2026-11-10T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);

describe('sign-in rate limit', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const login = (email: string, password: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });

  async function fail(email: string, times: number) {
    for (let i = 0; i < times; i++)
      await login(email, 'not the password').expect(401);
  }

  function fakeDate(instant: Date) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
  }

  it('answers 429 with Retry-After after five failures, even to the right password', async () => {
    const ana = await createUser(app);
    fakeDate(T);
    await fail(ana.email, 5);

    fakeDate(at(MINUTE));
    const wrong = await login(ana.email, 'not the password').expect(429);
    expect(wrong.headers['retry-after']).toBe(String(14 * 60));

    const right = await login(ana.email, ana.password).expect(429);
    expect(right.headers['retry-after']).toBe(String(14 * 60));
    expect(setCookies(right)).toEqual([]);
  });

  it('lets only five of many parallel wrong passwords be checked', async () => {
    const ana = await createUser(app);
    const statuses = (
      await Promise.all(
        Array.from({ length: 20 }, () => login(ana.email, 'not the password')),
      )
    ).map((res) => res.status);

    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  });

  it('rounds Retry-After up to whole seconds', async () => {
    const ana = await createUser(app);
    fakeDate(T);
    await fail(ana.email, 5);

    fakeDate(at(15 * MINUTE - 1500));
    expect(
      (await login(ana.email, ana.password).expect(429)).headers['retry-after'],
    ).toBe('2');
  });

  it('lets Beto sign in while Ana is blocked', async () => {
    const ana = await createUser(app);
    const beto = await createUser(app, { name: 'Beto' });
    await fail(ana.email, 5);

    await login(ana.email, ana.password).expect(429);
    await login(beto.email, beto.password).expect(200);
  });

  it('lets the right password in again fifteen minutes after the first failure', async () => {
    const ana = await createUser(app);
    fakeDate(T);
    await fail(ana.email, 1);
    fakeDate(at(10 * MINUTE));
    await fail(ana.email, 4);

    fakeDate(at(15 * MINUTE - 1000));
    await login(ana.email, ana.password).expect(429);
    fakeDate(at(15 * MINUTE));
    const res = await login(ana.email, ana.password).expect(200);
    expect(sessionCookie(res)).toBeDefined();
  });

  it('counts failures per normalized email', async () => {
    const ana = await createUser(app);
    const [local, domain] = ana.email.split('@');
    await fail(`${local.toUpperCase()}@${domain.toUpperCase()}`, 3);
    await fail(` ${ana.email}`, 2);

    await login(ana.email, ana.password).expect(429);
  });

  it("blocks an unknown email too, so being blocked doesn't reveal an account", async () => {
    const email = `nadie-${randomUUID()}@example.com`;
    await fail(email, 5);
    await login(email, 'not the password').expect(429);
  });

  it('resets the count after a successful sign-in', async () => {
    const ana = await createUser(app);
    await fail(ana.email, 4);
    await login(ana.email, ana.password).expect(200);
    await fail(ana.email, 4);

    await login(ana.email, ana.password).expect(200);
  });

  it("doesn't count requests rejected with 400", async () => {
    const ana = await createUser(app);
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: ana.email })
        .expect(400);
    }
    await login(ana.email, ana.password).expect(200);
  });

  it('counts a disabled user signing in as a failure', async () => {
    const ana = await createUser(app);
    await fail(ana.email, 4);
    await app.get(UsersService).disable(ana.email);

    await login(ana.email, ana.password).expect(401);
    await login(ana.email, ana.password).expect(429);
  });
});
