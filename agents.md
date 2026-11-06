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

`backend/` and `frontend/` don't exist yet.

## Rules that are easy to miss

- **The repo is public.** Never copy real supplier names, CUITs, amounts or anything else from `samples/` into a committed file, including tests and fixtures. Use invented data.
- **Spanish UI, English code.** Everything the user sees is in Spanish. Code, identifiers and docs are in English.
- **Money is never a float.** Use `numeric` in the database and a decimal type in code.
