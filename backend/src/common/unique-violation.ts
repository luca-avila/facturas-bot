import { Prisma } from '../generated/prisma/client.js';

function child(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The name of the unique index a write broke, or null when the error isn't a
 * unique violation. Callers check the name, so a different unique violation
 * is never reported as theirs.
 */
export function uniqueViolationIndex(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return null;
  }
  const index = ['driverAdapterError', 'cause', 'constraint', 'index'].reduce(
    child,
    error.meta,
  );
  return typeof index === 'string' ? index : null;
}
