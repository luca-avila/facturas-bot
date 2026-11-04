---
name: feature
description: Run one feature through the plan → implement → review pipeline using subagents. Only when the user invokes /feature.
disable-model-invocation: true
argument-hint: [feature description]
---

# Orchestrator

You run one feature through the pipeline below by spawning subagents and passing data between them. You don't plan, write code, or review yourself. The user sits at the end of the pipe and only gets pulled in at the gates marked **STOP**.

## Feature
$ARGUMENTS

## Rules
- **Pass data through files and raw outputs.** Don't paraphrase one agent's output for the next one.
- **Keep the reviewer's context clean.** Never pass it the implementer's summary, its reasoning, or your opinion of the change. It gets the plan path and the diff command, nothing else.
- **Don't do the agents' work.** Don't edit code or fix failures yourself. Send them back to the right agent.
- **Deterministic checks are not optional.** Never skip, disable, or work around lint, typecheck, or tests.
- Keep updates to the user to one line per phase.

## Pipeline

### 0. Setup
- Pick a short kebab-case slug for the feature.
- Check that the working tree is clean and you're on `main`, then create the branch `feat/<slug>`.
- If the tree isn't clean: **STOP** and ask the user what to do.

### 1. Plan
Spawn the `planner` subagent with the feature description and the path `plans/<slug>.md`.
- If it returns questions instead of a plan: **STOP**, relay the questions verbatim, then re-run the planner with the answers.
- If the plan's `## Doors` section has any one-way door: **STOP**. Show the user that section and the plan path, and wait for approval. If they ask for changes, re-run the planner with them.
- If every door is two-way: continue without asking.

### 2. Implement
Spawn the `implementer` subagent with the plan path.
- If it returns a question about the plan: **STOP** and relay it verbatim.

### 3. Checks gate
Run the checks yourself, in backend and frontend: `npm run lint`, `npm run typecheck`, `npm test`.
- If anything fails, spawn the `implementer` again with the plan path and the raw failing output. At most 2 retries.
- If it still fails: **STOP** and show the user the raw failure.

### 4. Review
Spawn a fresh `reviewer` subagent with only the plan path and the instruction to review `git diff main...HEAD`.

### 5. Final gate
Run the checks again.
- If the reviewer's fixes broke something, send the raw output back to the `reviewer`. One retry.
- If it still fails: **STOP** and show the user the raw failure.

### 6. Hand-off
Don't push or merge. Give the user:
- The branch name
- A 3–5 line summary of what changed, based on the plan's goal and the commit log
- The reviewer's merge danger section, verbatim
- Out-of-scope issues the implementer reported
- If the door is one-way, a reminder that it needs a thorough human review before merging
