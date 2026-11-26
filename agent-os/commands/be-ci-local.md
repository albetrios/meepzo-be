---
description: Run the full PR gate (pnpm ci:local) and summarize failures with fixes
argument-hint: (no arguments)
allowed-tools: Bash(pnpm ci:local*), Bash(pnpm validate*), Bash(pnpm routes*), Bash(pnpm test*)
---

Run `pnpm ci:local` — the PR gate: every `pnpm ci:quality` step, then the build and the full
test suite. The step list is `tooling/validate/gates.ts` (one source; `pnpm health` reads it too).

For each failing step:

- Name the step and the root cause.
- Apply the minimal in-scope fix (run the matching skill from
  `agent-os/skills/be-skill-index/SKILL.md` if one applies).
- Re-run.

Summarize what passed and anything still failing that needs a human decision.
