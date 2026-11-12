import { defineConfig } from 'prisma/config';
import { loadRootEnv } from './src/env.js';

loadRootEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly instead of the strict `env()` helper, so `prisma generate`
  // (and so `npm ci`) works without a database URL.
  datasource: { url: process.env.DATABASE_URL },
});
