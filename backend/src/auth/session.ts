import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client.js';

/** The signed-in person, as `@CurrentUser()` returns it. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** A request that passed `SessionGuard`. */
export type SessionRequest = Request & { sessionUser?: SessionUser };

/** A session lasts this long without use. Each authenticated request renews it. */
export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
