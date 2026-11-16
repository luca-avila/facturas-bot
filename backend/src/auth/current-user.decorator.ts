import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionRequest, SessionUser } from './session.js';

/** The signed-in person, set by `SessionGuard`. Use it for the acting user. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): SessionUser => {
    const user = context
      .switchToHttp()
      .getRequest<SessionRequest>().sessionUser;
    if (!user)
      throw new Error('@CurrentUser() used on a route without a session.');
    return user;
  },
);
