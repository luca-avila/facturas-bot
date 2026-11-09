const TEST_SUFFIX = '_test';

/**
 * Derives the test database URL from `DATABASE_URL`: same server, database
 * name plus `_test`. A name that already ends in `_test` is used as is.
 */
export function testDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root, then run `docker compose up -d db`.',
    );
  }
  const url = new URL(databaseUrl);
  const name = databaseName(url.toString());
  if (!name) {
    throw new Error('DATABASE_URL has no database name.');
  }
  url.pathname = `/${name.endsWith(TEST_SUFFIX) ? name : name + TEST_SUFFIX}`;
  return url.toString();
}

export function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

export function isTestDatabaseName(name: string): boolean {
  return name.endsWith(TEST_SUFFIX);
}
