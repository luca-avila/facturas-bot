# Slice 1b: Accounts

> Second half of slice 1 in [`mvp-slices.md`](../mvp-slices.md#1-skeleton-and-accounts). It needs [1a](1a-scaffold.md) merged. Run it with `/feature` and this file's path.

**Before running.** Answer [question 15](../mvp-slices.md#open-questions), session length, and write it in Rules. Otherwise the planner returns it as a question.

**Goal.** A person created by the script signs in from their phone and sees an empty Spanish shell. Nothing else answers without a session.

**Design.** [Decision 5](../../system-design.md#decisions), accounts and sessions in [Operations](../../system-design.md#operations), and `users` in [Data model](../../system-design.md#data-model).

**Schema.** `users`, all columns. There's no sessions table: the design revokes sessions through `password_set_at` and `disabled_at` instead.

**Rules.**
- Now:
  - `npm run user:create`, `user:reset-password` and `user:disable` run from the backend. Users are disabled, never deleted.
  - Emails are unique, and a disabled user can't sign in.
  - Every API endpoint requires a session unless it's explicitly public, and sign-in is the only public one.
  - Every request rejects disabled users and sessions issued before `password_set_at`.
  - Login is rate limited, and the session lives in an `httpOnly` cookie.
  - Session length: **pending, question 15**.
  - `role` is stored but not enforced.
  - Sign-in, the rate-limit message and the shell are in Spanish. The shell shows the user's name.
- Later:
  - `audit_log` arrives in slice 2, with the first financial write.
  - HTTPS arrives in slice 8. Until then the phone signs in over the local network, so the cookie can only drop `Secure` in local development.

**Acceptance.**
1. Run `npm run user:create` and sign in from the phone. The shell shows my name.
2. Enter a wrong password several times. The Spanish rate-limit message appears.
3. Run `user:reset-password` from another terminal. The open session is signed out on its next request. `user:disable` does the same, and that user can't sign in again.
4. Any API call without the cookie returns 401.

**Tests.**
- Sign-in succeeds and fails as expected.
- A disabled user is rejected at sign-in and on a live session.
- A session older than `password_set_at` is rejected.
- Login is rate limited.
- The cookie is `httpOnly`.
- Every route except sign-in returns 401 without a session.

**Out.** Financial data, HTTPS and deployment (slice 8), role enforcement, sign-up and email.

**Doors.** One-way: authentication. It goes first so every later endpoint starts out behind it and never has to be retrofitted. This diff only holds authentication, so it's the one to review thoroughly.
