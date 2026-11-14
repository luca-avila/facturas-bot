import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { verifyPassword } from '../src/users/password.js';

const backendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const tsx = path.join(backendDir, 'node_modules', '.bin', 'tsx');
const cli = path.join(backendDir, 'scripts', 'users.ts');

interface Result {
  code: number | null;
  output: string;
}

/** Runs the script with `stdin` piped in. The worker's env points it at the test database. */
function users(args: string[], stdin: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [cli, ...args], {
      cwd: backendDir,
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(stdin);
  });
}

describe('users script', () => {
  const prisma = new PrismaService();
  const password = `pw-${randomUUID()}`;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const uniqueEmail = () => `ana-${randomUUID()}@example.com`;

  it('creates a user from the password on stdin, and never prints it', async () => {
    const email = uniqueEmail();
    const result = await users(
      ['create', '--email', email, '--name', 'Ana', '--role', 'admin'],
      `${password}\n`,
    );

    expect(result).toEqual({ code: 0, output: `Created ${email} (admin).\n` });
    expect(result.output).not.toContain(password);
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await verifyPassword(row.passwordHash, password)).toBe(true);
  });

  it('takes only the first line of stdin, without its line ending', async () => {
    const email = uniqueEmail();
    await users(
      ['create', '--email', email, '--name', 'Ana', '--role', 'staff'],
      `${password}\r\nextra\n`,
    );

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await verifyPassword(row.passwordHash, password)).toBe(true);
  });

  it('exits 1 with usage when --role is missing, and creates nothing', async () => {
    const email = uniqueEmail();
    const result = await users(
      ['create', '--email', email, '--name', 'Ana'],
      `${password}\n`,
    );

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Missing --role[\s\S]*Usage:/);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it.each([
    ['an unknown command', ['delete', '--email', 'ana@example.com']],
    [
      'an unknown flag',
      ['disable', '--email', 'ana@example.com', '--name', 'Ana'],
    ],
    ['no command', []],
  ])('exits 1 with usage on %s', async (_, args) => {
    const result = await users(args, '');
    expect(result.code).toBe(1);
    expect(result.output).toContain('Usage:');
  });

  it('exits 1 with the reason when the service refuses, without printing the password', async () => {
    const short = 'short-pw';
    const result = await users(
      ['create', '--email', uniqueEmail(), '--name', 'Ana', '--role', 'staff'],
      `${short}\n`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/at least 12/);
    expect(result.output).not.toContain(short);
  });

  it('resets the password and disables, reporting a second disable', async () => {
    const email = uniqueEmail();
    await users(
      ['create', '--email', email, '--name', 'Ana', '--role', 'staff'],
      `${password}\n`,
    );
    const newPassword = `new-${randomUUID()}`;

    const reset = await users(
      ['reset-password', '--email', email],
      `${newPassword}\n`,
    );
    expect(reset).toEqual({
      code: 0,
      output: `Reset the password for ${email}. Their sessions are signed out.\n`,
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await verifyPassword(row.passwordHash, newPassword)).toBe(true);

    expect(await users(['disable', '--email', email], '')).toEqual({
      code: 0,
      output: `Disabled ${email}. Their sessions are signed out.\n`,
    });
    expect((await users(['disable', '--email', email], '')).output).toMatch(
      /already disabled/,
    );
  });
});
