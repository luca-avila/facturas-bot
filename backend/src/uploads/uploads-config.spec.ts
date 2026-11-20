import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp } from '../../test/app.js';

describe('startup', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'facturas-config-'));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it.each([
    ['without UPLOAD_DIR', undefined],
    ['with an empty UPLOAD_DIR', ''],
    ['with a relative UPLOAD_DIR', 'uploads'],
  ])('fails %s, naming it', async (_, dir) => {
    vi.stubEnv('UPLOAD_DIR', dir);
    await expect(createTestApp()).rejects.toThrow(
      /UPLOAD_DIR must be set to an absolute path/,
    );
  });

  it('creates an absolute UPLOAD_DIR that only its owner can open', async () => {
    const dir = path.join(parent, 'nested', 'uploads');
    vi.stubEnv('UPLOAD_DIR', dir);
    const app = await createTestApp();
    await app.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
