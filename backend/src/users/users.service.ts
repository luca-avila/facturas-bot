import { Injectable } from '@nestjs/common';
import { now } from '../common/clock.js';
import { isUuid } from '../common/uuid.js';
import { Prisma, UserRole, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isValidEmail, normalizeEmail } from './email.js';
import { hashPassword, isLongEnough, MIN_PASSWORD_LENGTH } from './password.js';
import { UserInputError } from './user-input.error.js';

export interface CreateUserInput {
  email: string;
  name: string;
  role: string;
  password: string;
}

export interface DisableResult {
  /** True when the user was already disabled, so nothing changed. */
  alreadyDisabled: boolean;
}

function isUserRole(role: string): role is UserRole {
  return Object.values<string>(UserRole).includes(role);
}

function assertPasswordLength(password: string): void {
  if (!isLongEnough(password)) {
    throw new UserInputError(
      `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<User> {
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    if (!isValidEmail(email))
      throw new UserInputError(`"${email}" isn't a valid email.`);
    if (name === '') throw new UserInputError('The name is empty.');
    if (!isUserRole(input.role)) {
      throw new UserInputError(
        `The role must be one of: ${Object.values(UserRole).join(', ')}.`,
      );
    }
    assertPasswordLength(input.password);

    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.user.create({
        data: {
          email,
          name,
          role: input.role,
          passwordHash,
          passwordSetAt: now(),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new UserInputError(
          `A user with the email ${email} already exists.`,
        );
      }
      throw error;
    }
  }

  /** Sets a new password. Sessions issued before it stop working. */
  async resetPassword(email: string, password: string): Promise<void> {
    const normalized = normalizeEmail(email);
    assertPasswordLength(password);
    const passwordHash = await hashPassword(password);
    const { count } = await this.prisma.user.updateMany({
      where: { email: normalized, disabledAt: null },
      data: { passwordHash, passwordSetAt: now() },
    });
    if (count === 0) await this.throwMissingOrDisabled(normalized);
  }

  /** Disables the user, which also signs them out. Disabling twice keeps the first `disabled_at`. */
  async disable(email: string): Promise<DisableResult> {
    const normalized = normalizeEmail(email);
    const { count } = await this.prisma.user.updateMany({
      where: { email: normalized, disabledAt: null },
      data: { disabledAt: now() },
    });
    if (count === 1) return { alreadyDisabled: false };
    if (await this.findByEmail(normalized)) return { alreadyDisabled: true };
    throw new UserInputError(`There's no user with the email ${normalized}.`);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  /** Null for an id that isn't a UUID, so a bad id is "no user" and never a database error. */
  async findById(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    return this.prisma.user.findUnique({ where: { id } });
  }

  private async throwMissingOrDisabled(email: string): Promise<never> {
    const user = await this.findByEmail(email);
    if (user === null)
      throw new UserInputError(`There's no user with the email ${email}.`);
    throw new UserInputError(`${email} is disabled.`);
  }
}
