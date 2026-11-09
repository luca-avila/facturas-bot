import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { loadRootEnv } from '../src/env.js';
import { databaseName, isTestDatabaseName, testDatabaseUrl } from './test-database.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs once per `npm test`: recreates the test database from scratch and
 * migrates it. Any failure (Postgres down, no DATABASE_URL, a broken
 * migration) fails the whole run. There is no "skip without a database" path.
 */
export default async function setup(): Promise<void> {
  loadRootEnv();
  const url = testDatabaseUrl(process.env.DATABASE_URL);
  const name = databaseName(url);
  if (!isTestDatabaseName(name)) {
    throw new Error(`Refusing to recreate "${name}": its name doesn't end in _test.`);
  }

  await recreateDatabase(url, name);
  await migrate(url);
}

async function recreateDatabase(url: string, name: string): Promise<void> {
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: maintenanceUrl.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Can't reach Postgres for the tests. Is it running? Start it with \`docker compose up -d db\`.`,
      { cause: error },
    );
  }
  try {
    const identifier = client.escapeIdentifier(name);
    await client.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${identifier}`);
  } finally {
    await client.end();
  }
}

async function migrate(url: string): Promise<void> {
  const prisma = path.join(backendDir, 'node_modules', '.bin', 'prisma');
  try {
    await promisify(execFile)(prisma, ['migrate', 'deploy'], {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (error) {
    const output = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(`prisma migrate deploy failed on the test database.\n${output}`, {
      cause: error,
    });
  }
}
