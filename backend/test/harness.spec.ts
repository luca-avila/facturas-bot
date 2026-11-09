import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { loadRootEnv } from '../src/env.js';

describe('Postgres test harness', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it('runs a query against a real Postgres', async () => {
    const rows = await prisma.$queryRaw<{ answer: number }[]>`SELECT 1 + 1 AS answer`;
    expect(rows).toEqual([{ answer: 2 }]);
  });

  it('connects to the _test database, not the one in .env', async () => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    const name = rows[0].name;
    expect(name).toMatch(/_test$/);

    // The worker env already points at the test database, so loading .env
    // again must not switch it back to the dev one.
    loadRootEnv();
    expect(new URL(process.env.DATABASE_URL ?? '').pathname).toBe(`/${name}`);
  });

  it('migrated the database before the tests ran', async () => {
    const rows = await prisma.$queryRaw<{ table: string | null }[]>`
      SELECT to_regclass('_prisma_migrations')::text AS table`;
    expect(rows).toEqual([{ table: '_prisma_migrations' }]);
  });

  it('runs with the process in UTC', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });
});
