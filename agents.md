# Agents guide

Orientation for coding agents working in this repo.

## Where things live

- `system-design.md`: data model, extraction pipeline and validation rules. Source of truth for how the system works.
- `README.md`: product overview, stack and setup.
- `one-way-doors.md`: changes that need a thorough human review.
- `codingStandards.md`: code review rules, and the checks the project scaffold must add.
- `plans/`: implementation plans, one per feature.
- `memory.md`: inbox of review fixes for the weekly retro.
- `samples/`: real supplier documents for testing extraction. Gitignored, so it may not exist in your checkout.
- `backend/` (NestJS) and `frontend/` (React + Vite). Each has `npm run lint`, `npm run typecheck` and `npm test`.
- `backend/src/common/`: `money.ts` (`Money`, the only place for amounts), `clock.ts` (`today()` in Buenos Aires, the only place that reads the clock) and `cuit.ts` (`isValidCuit`).
- `backend/test/test-cuits.ts`: `TEST_CUITS`, invented CUITs. Every CUIT in a test or fixture must come from there: the CUIT check (part of backend `npm run lint`, and in CI) fails on any other valid one. It also fails on any file that isn't UTF-8 text, such as an image, a PDF, a spreadsheet or UTF-16, unless `UNSCANNED_FILES` in `backend/scripts/check-cuits.ts` lists it.
- Backend tests run against a real Postgres. Start it first with `docker compose up -d db`.

## Rules that are easy to miss

- **The repo is public.** Never copy real supplier names, CUITs, amounts or anything else from `samples/` into a committed file, including tests and fixtures. Use invented data.
- **Spanish UI, English code.** Everything the user sees is in Spanish. Code, identifiers and docs are in English.
- **Tests compute hashes, never write them out.** The CUIT check reads about 1 in 250 sha256 hex digests as a valid CUIT, and stays strict on purpose. Compute each hash at run time from the bytes the test uses.
- **Money is never a float.** Use `numeric` in the database and a decimal type in code.
