import { testDatabaseUrl } from './test-database.js';

// The harness drops the database this URL names, so these cases guard the dev one.
describe('testDatabaseUrl', () => {
  it('adds _test to the database name and keeps the rest of the URL', () => {
    expect(testDatabaseUrl('postgresql://u:p@db.local:5433/facturas?sslmode=disable')).toBe(
      'postgresql://u:p@db.local:5433/facturas_test?sslmode=disable',
    );
  });

  it('keeps a name that already ends in _test', () => {
    const url = 'postgresql://u:p@localhost:5432/facturas_test';
    expect(testDatabaseUrl(url)).toBe(url);
  });

  it.each([undefined, ''])('points to .env.example when DATABASE_URL is %j', (value) => {
    expect(() => testDatabaseUrl(value)).toThrow(/\.env\.example/);
  });

  it('rejects a URL with no database name', () => {
    expect(() => testDatabaseUrl('postgresql://u:p@localhost:5432/')).toThrow(/no database name/);
  });
});
