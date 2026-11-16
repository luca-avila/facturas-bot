import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

describe('users table', () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function insertRaw(email: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO users (email, name, password_hash, password_set_at, role)
      VALUES (${email}, 'Ana', 'not-a-real-hash', now(), 'staff')`;
  }

  it('accepts a normalized email', async () => {
    await expect(
      insertRaw(`ana-${randomUUID()}@example.com`),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['capitals', `Ana-${randomUUID()}@example.com`],
    ['surrounding spaces', ` ana-${randomUUID()}@example.com `],
  ])('refuses an email with %s, even from raw SQL', async (_, email) => {
    await expect(insertRaw(email)).rejects.toThrow(/users_email_normalized/);
    const rows = await prisma.user.count({ where: { email } });
    expect(rows).toBe(0);
  });
});
