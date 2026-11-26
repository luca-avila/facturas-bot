/**
 * Creates, resets and disables accounts. There's no sign-up page, so this is
 * the only way in. Run through the npm scripts:
 *
 *   npm run user:create -- --email ana@example.com --name Ana --role admin
 *   npm run user:reset-password -- --email ana@example.com
 *   npm run user:disable -- --email ana@example.com
 *
 * Or in production (compiled):
 *
 *   npm run user:create:prod -- --email ana@example.com --name Ana --role admin
 *   npm run user:reset-password:prod -- --email ana@example.com
 *   npm run user:disable:prod -- --email ana@example.com
 *
 * On a terminal the password is asked twice with hidden input. Otherwise it's
 * the first line of stdin. It's never printed.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { read } from 'read';
import { loadRootEnv } from '../env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeEmail } from './email.js';
import { UserInputError } from './user-input.error.js';
import { UsersService } from './users.service.js';

const USAGE = [
  'Usage:',
  '  npm run user:create -- --email <email> --name <name> --role <admin|staff>',
  '  npm run user:reset-password -- --email <email>',
  '  npm run user:disable -- --email <email>',
].join('\n');

const COMMANDS = {
  create: ['email', 'name', 'role'],
  'reset-password': ['email'],
  disable: ['email'],
} as const satisfies Record<string, readonly string[]>;

type Command = keyof typeof COMMANDS;

class UsageError extends Error {}

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

/** Parses `<command> --flag value ...`. Every flag the command takes is required, and no other is allowed. */
function parseCommand(argv: string[]): {
  command: Command;
  flags: Record<string, string>;
} {
  const [command, ...rest] = argv;
  if (!isCommand(command))
    throw new UsageError(`Unknown command: ${command ?? '(none)'}`);
  const names = COMMANDS[command];
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(
        names.map((name) => [name, { type: 'string' as const }]),
      ),
    }));
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const flags: Record<string, string> = {};
  for (const name of names) {
    const value = values[name];
    if (typeof value !== 'string') throw new UsageError(`Missing --${name}`);
    flags[name] = value;
  }
  return { command, flags };
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await read({
      prompt: 'Password: ',
      silent: true,
      replace: '',
    });
    const second = await read({
      prompt: 'Repeat password: ',
      silent: true,
      replace: '',
    });
    // Hidden input doesn't echo the Enter, so end the prompt line here.
    process.stdout.write('\n');
    if (first !== second) throw new UserInputError("Passwords don't match.");
    return first;
  }
  return readFirstLine();
}

/** The first line of stdin without its line ending. Nothing else is trimmed. */
async function readFirstLine(): Promise<string> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
  } finally {
    lines.close();
  }
  throw new UserInputError('No password on stdin.');
}

async function run(
  command: Command,
  flags: Record<string, string>,
  users: UsersService,
) {
  switch (command) {
    case 'create': {
      const password = await readPassword();
      const user = await users.create({
        email: flags.email,
        name: flags.name,
        role: flags.role,
        password,
      });
      return `Created ${user.email} (${user.role}).`;
    }
    case 'reset-password': {
      const password = await readPassword();
      await users.resetPassword(flags.email, password);
      return `Reset the password for ${normalizeEmail(flags.email)}. Their sessions are signed out.`;
    }
    case 'disable': {
      const { alreadyDisabled } = await users.disable(flags.email);
      const email = normalizeEmail(flags.email);
      return alreadyDisabled
        ? `${email} was already disabled. Nothing changed.`
        : `Disabled ${email}. Their sessions are signed out.`;
    }
  }
}

export async function runUsersCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 1;
  }

  loadRootEnv();
  const prisma = new PrismaService();
  try {
    console.log(
      await run(parsed.command, parsed.flags, new UsersService(prisma)),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof UserInputError)) throw error;
    console.error(error.message);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}
