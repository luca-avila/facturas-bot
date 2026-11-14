import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  sessionCookie,
  sessionCookieLine,
  setCookies,
  type TestUser,
} from '../../test/app.js';
import { UsersService } from '../users/users.service.js';

const DAY = 24 * 60 * 60 * 1000;
const T = new Date('2026-11-10T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);

describe('auth', () => {
  let app: NestExpressApplication;
  let users: UsersService;

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) =>
    http().post('/api/auth/login').send({ email, password });
  const me = (session: string | undefined) =>
    http()
      .get('/api/auth/me')
      .set('Cookie', `session=${session ?? ''}`);

  async function signIn(user: TestUser): Promise<string> {
    const res = await login(user.email, user.password).expect(200);
    const session = sessionCookie(res);
    if (!session) throw new Error('Sign-in set no session cookie.');
    return session;
  }

  function fakeDate(instant: Date) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
  }

  describe('sign-in', () => {
    it('returns her name and email and sets a session cookie', async () => {
      const ana = await createUser(app, { name: 'Ana' });
      const res = await login(ana.email, ana.password).expect(200);
      expect(res.body).toEqual({ name: 'Ana', email: ana.email });
      expect(sessionCookie(res)).toBeDefined();
    });

    it('accepts the email with capitals and surrounding spaces', async () => {
      const ana = await createUser(app);
      await login(`  ${ana.email.toUpperCase()} `, ana.password).expect(200);
    });

    it('refuses a wrong password with 401 and no cookie', async () => {
      const ana = await createUser(app);
      const res = await login(ana.email, `${ana.password}x`).expect(401);
      expect(setCookies(res)).toEqual([]);
    });

    it('refuses an unknown email the same way', async () => {
      const res = await login(
        `nadie-${randomUUID()}@example.com`,
        'whatever password',
      ).expect(401);
      expect(setCookies(res)).toEqual([]);
    });

    it.each([
      ['a missing password', { email: 'ana@example.com' }],
      ['an empty password', { email: 'ana@example.com', password: '' }],
      ['a number as the email', { email: 42, password: 'whatever password' }],
    ])('rejects %s with 400', async (_, body) => {
      await http().post('/api/auth/login').send(body).expect(400);
    });

    it('rejects a form-encoded body with 400', async () => {
      const ana = await createUser(app);
      await http()
        .post('/api/auth/login')
        .type('form')
        .send({ email: ana.email, password: ana.password })
        .expect(400);
    });

    it('rejects a text/plain body with 400', async () => {
      const ana = await createUser(app);
      await http()
        .post('/api/auth/login')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ email: ana.email, password: ana.password }))
        .expect(400);
    });

    it('lets her read /api/auth/me afterwards', async () => {
      const ana = await createUser(app, { name: 'Ana María' });
      const res = await me(await signIn(ana)).expect(200);
      expect(res.body).toEqual({ name: 'Ana María', email: ana.email });
    });
  });

  describe('disabled users', () => {
    it("can't sign in with the right password, and get the same 401 as a wrong one", async () => {
      const ana = await createUser(app);
      const wrong = await login(ana.email, `${ana.password}x`).expect(401);
      await users.disable(ana.email);

      const res = await login(ana.email, ana.password).expect(401);
      expect(res.body).toEqual(wrong.body);
      expect(setCookies(res)).toEqual([]);
    });

    it('are signed out on their next request', async () => {
      const ana = await createUser(app);
      const session = await signIn(ana);
      await me(session).expect(200);

      await users.disable(ana.email);
      await me(session).expect(401);
    });
  });

  describe('password reset', () => {
    it('signs out the open session on its next request', async () => {
      const ana = await createUser(app);
      const session = await signIn(ana);

      await users.resetPassword(ana.email, 'a brand new password');
      await me(session).expect(401);
    });

    it('makes the old password fail and the new one work', async () => {
      const ana = await createUser(app);
      await users.resetPassword(ana.email, 'a brand new password');

      await login(ana.email, ana.password).expect(401);
      const session = await signIn({
        ...ana,
        password: 'a brand new password',
      });
      await me(session).expect(200);
    });

    it('rejects an earlier session even within the same second, while it is otherwise valid', async () => {
      const ana = await createUser(app);
      fakeDate(T);
      const before = await signIn(ana);
      fakeDate(at(400));
      await users.resetPassword(ana.email, 'a brand new password');
      const after = await signIn({ ...ana, password: 'a brand new password' });

      fakeDate(at(DAY));
      await me(before).expect(401);
      await me(after).expect(200);
    });
  });

  describe('cookie', () => {
    it('is HttpOnly, SameSite=Strict, Path=/api, Secure, with a 30-day Max-Age', async () => {
      const ana = await createUser(app);
      const line = sessionCookieLine(
        await login(ana.email, ana.password).expect(200),
      );
      const attributes = line?.split('; ').slice(1);
      expect(attributes).toEqual(
        expect.arrayContaining([
          'Max-Age=2592000',
          'Path=/api',
          'HttpOnly',
          'Secure',
          'SameSite=Strict',
        ]),
      );
    });

    it('is renewed on every authenticated request', async () => {
      const ana = await createUser(app);
      const res = await me(await signIn(ana)).expect(200);
      expect(sessionCookieLine(res)).toMatch(/Max-Age=2592000/);
    });
  });

  describe('sliding expiry', () => {
    it('rejects a session not used for exactly 30 days', async () => {
      const ana = await createUser(app);
      fakeDate(T);
      const session = await signIn(ana);

      fakeDate(at(30 * DAY));
      await me(session).expect(401);
    });

    it('accepts and renews a session used just before 30 days, and the renewal lasts', async () => {
      const ana = await createUser(app);
      fakeDate(T);
      const original = await signIn(ana);

      fakeDate(at(30 * DAY - 60 * 1000));
      const renewed = sessionCookie(await me(original).expect(200));
      expect(renewed).toBeDefined();

      fakeDate(at(59 * DAY));
      await me(renewed).expect(200);
      await me(original).expect(401);
    });
  });

  describe('bad tokens', () => {
    async function sign(
      secret: Uint8Array,
      sub: string,
      passwordSetAt: number,
      alg = 'HS256',
    ) {
      return new SignJWT({ passwordSetAt })
        .setProtectedHeader({ alg })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1d')
        .sign(secret);
    }

    const testSecret = () => new TextEncoder().encode(process.env.JWT_SECRET);

    it('rejects a tampered token', async () => {
      const ana = await createUser(app);
      const session = await signIn(ana);
      const [header, payload, signature] = session.split('.');
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      ) as object;
      const forged = Buffer.from(
        JSON.stringify({ ...claims, sub: randomUUID() }),
      ).toString('base64url');
      await me(`${header}.${forged}.${signature}`).expect(401);
      // A middle character: the last one carries padding bits that decoding
      // ignores, so changing it can leave the signature as it was.
      const changed = signature[10] === 'A' ? 'B' : 'A';
      const badSignature = `${signature.slice(0, 10)}${changed}${signature.slice(11)}`;
      await me(`${header}.${payload}.${badSignature}`).expect(401);
    });

    it('rejects a token signed with another secret', async () => {
      const ana = await createUser(app);
      const user = await users.findByEmail(ana.email);
      if (!user) throw new Error('missing user');
      const token = await sign(
        randomBytes(32),
        user.id,
        user.passwordSetAt.getTime(),
      );
      await me(token).expect(401);
    });

    it('accepts a token it signed itself, so the cases above fail for the right reason', async () => {
      const ana = await createUser(app);
      const user = await users.findByEmail(ana.email);
      if (!user) throw new Error('missing user');
      await me(
        await sign(testSecret(), user.id, user.passwordSetAt.getTime()),
      ).expect(200);
    });

    it.each([
      ['a user id that does not exist', randomUUID()],
      ['a sub that is not a UUID', 'not-a-uuid'],
    ])('rejects a valid token for %s with 401, not 500', async (_, sub) => {
      await me(await sign(testSecret(), sub, T.getTime())).expect(401);
    });

    it('rejects a token signed with the right secret but another algorithm', async () => {
      const ana = await createUser(app);
      const user = await users.findByEmail(ana.email);
      if (!user) throw new Error('missing user');
      const token = await sign(
        testSecret(),
        user.id,
        user.passwordSetAt.getTime(),
        'HS512',
      );
      await me(token).expect(401);
    });

    it('rejects a token signed with alg none', async () => {
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const ana = await createUser(app);
      const user = await users.findByEmail(ana.email);
      if (!user) throw new Error('missing user');
      const exp = Math.floor(T.getTime() / 1000) + 10 * 365 * 86400;
      const token = `${encode({ alg: 'none' })}.${encode({ sub: user.id, passwordSetAt: user.passwordSetAt.getTime(), exp })}.`;
      await me(token).expect(401);
    });
  });

  describe('sign-out', () => {
    it('returns 204 with exactly one session cookie, which expires it', async () => {
      const ana = await createUser(app);
      const res = await http()
        .post('/api/auth/logout')
        .set('Cookie', `session=${await signIn(ana)}`)
        .expect(204);

      const cookies = setCookies(res).filter((line) =>
        line.startsWith('session='),
      );
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^session=;/);
      expect(cookies[0]).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      expect(cookies[0]).toMatch(/Path=\/api/);
    });

    it('returns 401 without a session', async () => {
      await http().post('/api/auth/logout').expect(401);
    });
  });
});

describe('auth in local development', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('sets the same cookie without Secure', async () => {
    const ana = await createUser(app);
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ana.email, password: ana.password })
      .expect(200);
    const attributes = sessionCookieLine(res)?.split('; ').slice(1);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'Max-Age=2592000',
        'Path=/api',
        'HttpOnly',
        'SameSite=Strict',
      ]),
    );
    expect(attributes).not.toContain('Secure');
  });
});

describe('startup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['without JWT_SECRET', undefined],
    ['with a JWT_SECRET under 32 characters', 'x'.repeat(31)],
  ])('fails %s, saying how to generate one', async (_, secret) => {
    vi.stubEnv('JWT_SECRET', secret);
    await expect(createTestApp()).rejects.toThrow(/openssl rand -base64 48/);
  });
});
