import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserInputError } from './user-input.error.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  const prisma = new PrismaService();
  const users = new UsersService(prisma);
  const password = 'correct horse battery';

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const uniqueEmail = () => `ana-${randomUUID()}@example.com`;

  describe('create', () => {
    it('stores the normalized email, the trimmed name, the role and an argon2id hash', async () => {
      const email = uniqueEmail();
      await users.create({
        email: `  ${email.toUpperCase()} `,
        name: '  Ana  ',
        role: 'admin',
        password,
      });

      const row = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(row.name).toBe('Ana');
      expect(row.role).toBe('admin');
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(password);
      expect(row.disabledAt).toBeNull();
    });

    it('sets password_set_at from the app clock', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-11-10T12:00:00.123Z');
      const user = await users.create({
        email: uniqueEmail(),
        name: 'Ana',
        role: 'staff',
        password,
      });
      expect(user.passwordSetAt.toISOString()).toBe('2026-11-10T12:00:00.123Z');
    });

    it('refuses an email that already exists in other casing, and keeps one row', async () => {
      const email = uniqueEmail();
      await users.create({ email, name: 'Ana', role: 'staff', password });

      await expect(
        users.create({
          email: email.toUpperCase(),
          name: 'Otra Ana',
          role: 'staff',
          password,
        }),
      ).rejects.toThrow(/already exists/);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('refuses an existing email even when that user is disabled', async () => {
      const email = uniqueEmail();
      await users.create({ email, name: 'Ana', role: 'staff', password });
      await users.disable(email);

      await expect(
        users.create({ email, name: 'Ana', role: 'staff', password }),
      ).rejects.toThrow(UserInputError);
    });

    it('refuses an 11-character password and writes nothing', async () => {
      const email = uniqueEmail();
      await expect(
        users.create({
          email,
          name: 'Ana',
          role: 'staff',
          password: 'a'.repeat(11),
        }),
      ).rejects.toThrow(/at least 12/);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('accepts a 12-character password', async () => {
      const email = uniqueEmail();
      await users.create({
        email,
        name: 'Ana',
        role: 'staff',
        password: 'a'.repeat(12),
      });
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('counts the password length in code points', async () => {
      // 11 emoji are 22 UTF-16 units, but only 11 characters.
      await expect(
        users.create({
          email: uniqueEmail(),
          name: 'Ana',
          role: 'staff',
          password: '😀'.repeat(11),
        }),
      ).rejects.toThrow(/at least 12/);
    });

    it.each([
      ['an email without @', { email: 'ana.example.com' }],
      ['an email with two @', { email: 'ana@@example.com' }],
      ['an email with nothing before @', { email: '@example.com' }],
      ['an email with a space inside', { email: 'ana maria@example.com' }],
      ['an empty name', { name: '   ' }],
      ['an unknown role', { role: 'owner' }],
    ])('refuses %s', async (_, override) => {
      const email = uniqueEmail();
      await expect(
        users.create({
          email,
          name: 'Ana',
          role: 'staff',
          password,
          ...override,
        }),
      ).rejects.toThrow(UserInputError);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });
  });

  describe('resetPassword', () => {
    it('sets a new hash and moves password_set_at', async () => {
      const email = uniqueEmail();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-11-10T12:00:00Z');
      const before = await users.create({
        email,
        name: 'Ana',
        role: 'staff',
        password,
      });
      vi.setSystemTime('2026-11-11T12:00:00Z');

      await users.resetPassword(email, 'another long password');

      const after = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.passwordSetAt.toISOString()).toBe(
        '2026-11-11T12:00:00.000Z',
      );
    });

    it('refuses an unknown email', async () => {
      await expect(
        users.resetPassword(uniqueEmail(), 'another long password'),
      ).rejects.toThrow(/no user/);
    });

    it('refuses a disabled user and leaves the hash alone', async () => {
      const email = uniqueEmail();
      const created = await users.create({
        email,
        name: 'Ana',
        role: 'staff',
        password,
      });
      await users.disable(email);

      await expect(
        users.resetPassword(email, 'another long password'),
      ).rejects.toThrow(/disabled/);
      const row = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(row.passwordHash).toBe(created.passwordHash);
    });

    it('refuses a short password', async () => {
      const email = uniqueEmail();
      await users.create({ email, name: 'Ana', role: 'staff', password });
      await expect(users.resetPassword(email, 'short')).rejects.toThrow(
        /at least 12/,
      );
    });
  });

  describe('disable', () => {
    it('sets disabled_at from the app clock', async () => {
      const email = uniqueEmail();
      await users.create({ email, name: 'Ana', role: 'staff', password });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-11-12T08:00:00Z');

      expect(await users.disable(email)).toEqual({ alreadyDisabled: false });
      const row = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(row.disabledAt?.toISOString()).toBe('2026-11-12T08:00:00.000Z');
    });

    it('refuses an unknown email', async () => {
      await expect(users.disable(uniqueEmail())).rejects.toThrow(/no user/);
    });

    it('keeps the first disabled_at when disabling twice, and reports it', async () => {
      const email = uniqueEmail();
      await users.create({ email, name: 'Ana', role: 'staff', password });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-11-12T08:00:00Z');
      await users.disable(email);
      vi.setSystemTime('2026-11-13T08:00:00Z');

      expect(await users.disable(email)).toEqual({ alreadyDisabled: true });
      const row = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(row.disabledAt?.toISOString()).toBe('2026-11-12T08:00:00.000Z');
    });
  });

  describe('findById', () => {
    it('returns null for an id that is not a UUID', async () => {
      expect(await users.findById('not-a-uuid')).toBeNull();
    });
  });
});
