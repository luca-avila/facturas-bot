import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
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

  const repoRoot = path.resolve(import.meta.dirname, '../../..');

  it.each([
    ['the repo itself', repoRoot],
    [
      'a folder the Vite dev server serves',
      path.join(repoRoot, 'frontend', 'public', 'uploads'),
    ],
    [
      'a path that climbs back into the repo',
      path.join(
        parent,
        '..',
        path.relative(path.dirname(parent), repoRoot),
        'uploads',
      ),
    ],
  ])('refuses an UPLOAD_DIR inside the repo: %s', async (_, dir) => {
    vi.stubEnv('UPLOAD_DIR', dir);
    await expect(createTestApp()).rejects.toThrow(/outside the repo/);
    expect(
      existsSync(path.join(repoRoot, 'frontend', 'public', 'uploads')),
    ).toBe(false);
  });

  it('refuses a symlink that points into the repo', async () => {
    const link = path.join(parent, 'link-into-repo');
    symlinkSync(path.join(repoRoot, 'frontend'), link);
    vi.stubEnv('UPLOAD_DIR', path.join(link, 'uploads'));
    try {
      await expect(createTestApp()).rejects.toThrow(/outside the repo/);
    } finally {
      rmSync(path.join(repoRoot, 'frontend', 'uploads'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('creates an absolute UPLOAD_DIR that only its owner can open', async () => {
    const dir = path.join(parent, 'nested', 'uploads');
    vi.stubEnv('UPLOAD_DIR', dir);
    const app = await createTestApp();
    await app.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
