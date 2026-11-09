# Slice 1a: Scaffold

> First half of slice 1 in [`mvp-slices.md`](../mvp-slices.md#1-skeleton-and-accounts). Run it with `/feature` and this file's path. [1b](1b-accounts.md) starts once this is merged.

**Goal.** `backend/` and `frontend/` exist, their checks pass, and the tooling catches the risks the coding standards list for the scaffold before any feature code lands.

This is the only slice that isn't end to end, because there's no feature yet. It's tested by hand through the checks.

**Why it's separate.** The checks gate in `/feature` runs `lint`, `typecheck` and `test`, so they have to exist and pass before a feature can go through it. Keeping the configs and lockfiles out of 1b also leaves the authentication diff small enough for a thorough human review.

**Design.**
- [Tech stack](../../README.md#tech-stack)
- [To automate in the project scaffold](../../codingStandards.md#to-automate-in-the-project-scaffold)
- Money and timestamps in [Data model](../../system-design.md#data-model)

**Schema.** None. Prisma is set up with no models.

**Rules.**
- Now:
  - `backend/` is NestJS and `frontend/` is React with Vite, both in TypeScript. Each has `lint`, `typecheck` and `test` scripts.
  - A `Money` type based on a decimal. ESLint bans `parseFloat` and `toFixed` outside it, since a lint rule can't tell an amount from any other number.
  - A `clock.ts` that gives today in `America/Argentina/Buenos_Aires`. ESLint bans `new Date()` everywhere else.
  - A CUIT check that runs in CI and locally. It fails when a tracked file holds a valid CUIT, with or without dashes, that isn't on the allowlist of test CUITs. The test CUITs are invented.
  - A Postgres test harness: backend tests run against a real Postgres, never mocks, starting from a migrated empty database.
  - Each check that now exists deletes its row from the scaffold table in `codingStandards.md`: money as a float, today in the wrong time zone, and real data in the public repo. The real-Postgres row stays until the money invariants have tests in slices 2 and 3.
- Later:
  - `users` and sign-in in 1b.
  - Exhaustive Spanish labels in slice 2, and the import rule for `applications` in slice 3.
  - Slice 2 validates supplier CUITs. It reuses the check-digit function from the CUIT check, so there's one implementation.

**Acceptance.**
1. In `backend/` and `frontend/`, `npm run lint`, `npm run typecheck` and `npm test` pass.
2. Add `parseFloat(...)` or `new Date()` to any file other than `clock.ts`. Lint fails.
3. Write a valid CUIT that isn't on the allowlist in any tracked file. The CUIT check fails. One from the allowlist passes, and so do 11 digits with a wrong check digit.
4. Stop Postgres. The backend tests fail instead of passing.
5. Both apps start locally.

**Tests.**
- `clock.ts` returns the Buenos Aires date just after midnight UTC: at 00:30 UTC it's still the previous day.
- `Money` adds cents exactly, and reads and writes the string Postgres returns for `numeric(14,2)` without losing precision.
- The CUIT check flags a valid CUIT off the allowlist, with and without dashes, and lets through an allowlisted one and a wrong check digit.
- The harness runs a query against a real Postgres.

**Out.** `users`, sign-in and every screen (1b), and Docker Compose for production, HTTPS and deployment (slice 8).

**Doors.** Two-way: tooling and empty apps, with no data and no authentication.
