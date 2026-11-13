import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TEST_CUITS } from '../test/test-cuits.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(backendDir, 'node_modules', '.bin', 'tsx');
const cli = path.join(backendDir, 'scripts', 'check-cuits.ts');

// Built at runtime so this file never holds an off-allowlist literal.
const OFF_ALLOWLIST = ['30', '00000005', '8'].join('');

// Inside a git hook, GIT_DIR and GIT_INDEX_FILE point at the real repo, and
// the commands below would follow them there.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

describe('check-cuits CLI', () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(path.join(tmpdir(), 'cuit-check-'));
    await git('init', '-q');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]) {
    return promisify(execFile)('git', args, { cwd: repo, env });
  }

  function write(file: string, content: string | Buffer) {
    writeFileSync(path.join(repo, file), content);
  }

  async function check(): Promise<{ code: number; output: string }> {
    try {
      const { stdout, stderr } = await promisify(execFile)(tsx, [cli], { cwd: repo, env });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, output: stdout + stderr };
    }
  }

  it('fails on a tracked file with an off-allowlist CUIT, naming file and line', async () => {
    write('notes.md', `intro\nproveedor ${OFF_ALLOWLIST}\n`);
    await git('add', 'notes.md');

    const { code, output } = await check();
    expect(code).toBe(1);
    expect(output).toContain('notes.md:2:');
    expect(output).not.toContain(OFF_ALLOWLIST);
  });

  it('fails on an untracked file that is not ignored', async () => {
    write('draft.txt', `cuit ${OFF_ALLOWLIST.slice(0, 2)}-${OFF_ALLOWLIST.slice(2, 10)}-${OFF_ALLOWLIST.slice(10)}`);

    const { code, output } = await check();
    expect(code).toBe(1);
    expect(output).toContain('draft.txt:1:');
    expect(output).not.toContain(OFF_ALLOWLIST);
  });

  it('ignores a gitignored file', async () => {
    write('.gitignore', 'secret.txt\n');
    write('secret.txt', OFF_ALLOWLIST);

    const { code } = await check();
    expect(code).toBe(0);
  });

  it('passes on allowlisted CUITs and wrong check digits', async () => {
    write('fixtures.ts', `${TEST_CUITS.join('\n')}\n30000000016\n30-00000001-6\n`);
    await git('add', 'fixtures.ts');

    const { code, output } = await check();
    expect(code).toBe(0);
    expect(output).toContain('CUIT check passed');
  });

  it('does not crash on a non-UTF-8 file or a tracked file deleted from disk', async () => {
    write('image.bin', Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x31]));
    write('gone.txt', 'soon deleted');
    await git('add', 'image.bin', 'gone.txt');
    unlinkSync(path.join(repo, 'gone.txt'));

    const { code, output } = await check();
    expect(code).toBe(0);
    expect(output).toContain('CUIT check passed');
  });

  it('still finds a CUIT in a non-UTF-8 file', async () => {
    write('legacy.txt', Buffer.concat([Buffer.from([0xff, 0xfe, 0x20]), Buffer.from(OFF_ALLOWLIST)]));
    await git('add', 'legacy.txt');

    const { code, output } = await check();
    expect(code).toBe(1);
    expect(output).toContain('legacy.txt:1:');
    expect(output).not.toContain(OFF_ALLOWLIST);
  });
});
