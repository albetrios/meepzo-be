---
name: be-kickoff-iteration
description: >
  Implement an approved iteration: confirm which iteration to kick off (Step 0), pass the intake gate
  (iteration:intake --check — stop on failure), set it implementing, then follow KICKOFF.md's ROUTE
  one row at a time — do → verify (by Intake mode) → write the AS-BUILT.md row and Standing
  deviations → check the impact on upcoming rows → stop for the user's review → next (rows run on,
  or in parallel lanes, only under a /goal or the user's go) — and close with the gates, plans/acceptance.md and Status done. Use when the user says 'kickoff', 'kickoff
  iteration <name>', 'kickoff <iteration>' or 'start implementing <iteration>'. Requires README
  Status approved, or a lite fix (Process lite) in planning once the user gave the go.
indexNote: implement an approved iteration — follow the KICKOFF.md ROUTE row by row, record AS-BUILT.md, stop for review after each row unless a /goal or the user's go is set
trigger: iterations/*/AS-BUILT.md
triggerNote: Iteration implementation — one ROUTE row at a time (parallel lanes only under a /goal or the user's go); every row's technical decisions go into AS-BUILT.md
---

# Kickoff an iteration (implement `KICKOFF.md`, one ROUTE row at a time)

The second half of the iteration workflow. **`be-iteration-planning` wrote and the user approved
`KICKOFF.md`; this skill implements it.** It follows the ROUTE ledger row by row, records what was
actually built in `iterations/<iteration>/AS-BUILT.md`, and stops for the user's review after every
row — unless a `/goal` or the user's go is set (Step 0, Parallel lanes). It never pushes, opens a PR
or merges unless the user asks: then it pushes last, once, after the full gates (Parallel lanes rule 12).

The whole flow: [`docs/design-workflow/process/README.md`](../../../docs/design-workflow/process/README.md).
The iteration rules: [`iterations/README.md`](../../../iterations/README.md).

## The plan proposes; agent-os decides — remember this on every row

The plan (`KICKOFF.md`, `plans/routes-final.md`, `db-changes.md`, `route-changes.md`, `worker-changes.md`)
states requirements and proposals — the route review in full design detail, the rest in logical terms. **The backend's agent-os — its skills, rules and agents
under `agent-os/` — is the expert.** Whenever the plan and agent-os disagree, or anything is unclear,
follow agent-os. That covers the skills each row runs — the
schema chain (`be-schema-generator`, `be-sql-design-guard`, `be-db-migration-maintainer`,
`be-rls-tenant-isolation-guard`), the route chain (`be-api-contract-guard`, `be-route-schema-doc-guard`,
`be-route-catalog`, `be-seed-maintainer`), `be-workers-events`, and the repository's rules. They decide
the physical design and may change plan details on the way: names, types, indexes, constraints, tenant
rules, paths, statuses, idempotency, job names. Follow them, never the plan's wording, wherever they
differ; record each difference in the row's `AS-BUILT.md` entry and sync the change files (Each ROUTE
row › Record). Only a scope change — a row added or removed, an acceptance changed, the order changed
— stops for the user. **When `plans/routes-final.md` exists, ditto (below) wins** for everything it
states; this paragraph then covers only what it leaves open.

**With a route review it is ditto.** When the plan has `plans/routes-final.md`, the agent-os checks already
shaped it, so each row builds its sub-domain **exactly as written** — names, routes, gates, statuses, errors,
codes, folders. Where a skill, rule or gate still cannot build something as written, **stop and ask** —
under a `/goal` too; the agreed change goes into `routes-final.md` first, then into the build — never a
silent difference. Only what the review leaves open is decided on the way and recorded in `AS-BUILT.md`.

## Step 0 — Confirm the iteration, then stop until confirmed

Run `pnpm iteration:list` and show:

| Iteration | Type | Baseline | Status | Eligible | Why |
| --- | --- | --- | --- | --- | --- |

- Eligible = Status `approved`, not yet `implementing`, and Baseline `none` or an iteration that is
  `done` / `frozen` — or a **lite** fix (README Process `lite`) in `planning` whose `KICKOFF.md` the
  user gave the go on (be-iteration-planning › Lite mode).
- Recommend the earliest-opened eligible iteration (the launch always comes first). If the user
  named one, check it against the rule.
- Always ask with **AskUserQuestion** — never pick silently.

Once confirmed, **the gate**:

```bash
pnpm iteration:intake <iteration> --check
```

**Gate rule:** if it exits non-zero, stop now — write nothing, change no status, ask nothing else;
print the command's output and end the turn. The intake has to be fixed (and the plan re-approved
if it changed) before any build. A lite fix with no drop placed (Drop placed `—`) has no intake to
gate — the gate would only say "no intake yet" — so it is skipped; with a drop it runs.

When it passes: `pnpm iteration:status <iteration> implementing` (a lite fix moves there straight
from `planning`), and start `AS-BUILT.md` from the
shape below, dated today, with the Baseline's Standing deviations copied in as the starting list
(empty for an initial iteration).

**Offer the goal.** Show the user one `/goal` line they can set to let the build run on without a
stop after every row (Claude Code keeps working until its condition holds). Its condition is this
iteration's Close, named concretely:

```text
/goal iteration <iteration> is done: every KICKOFF.md ROUTE row done (or deferred with my OK) with
its AS-BUILT.md row; the Close gates green (pnpm validate, pnpm ci:local, pnpm test:rls-role,
pnpm sonar:scan); no open critical or major pre-merge finding; plans/acceptance.md has a Result and
Evidence for every item; pnpm iteration:frontend-map <iteration> --check passes; Status done.
Stop and ask on a scope change, a RED question or a conflict with plans/routes-final.md.
```

Setting it is the user's choice — never set it yourself. Under a goal: a row ends with its
`AS-BUILT.md` row and a one-line report instead of a stop, its `Reviewed` cell stays `—` until
Close, and rows may run in parallel lanes (Parallel lanes). Open points:

- A point `plans/routes-final.md` or the PRD left open → take the recommendation, log it in
  `plans/decisions.md` as AMBER, sourced `user /goal <date>`, and continue.
- A conflict with what `plans/routes-final.md` states exactly (ditto) → stop and ask.
- A scope change or a RED question → stop and ask — a goal never widens the scope.

## Before the first row — read

- `KICKOFF.md` (the plan and its ROUTE) and every file under `plans/` — for each row, its sub-domain's
  section in `plans/routes-final.md` is the spec and its code changes the checklist.
- The repository's conventions: `CLAUDE.md`, the skill index
  (`agent-os/skills/be-skill-index/SKILL.md`), the existing domains under `src/domains/`, the
  permission model (`src/domains/tenancy/sub-domains/permission/authorization.service.ts` and the
  seeded catalog in `src/domains/tenancy/seed/tenancy.seed.ts`), the public-id prefixes
  (`src/shared/utils/identity/public-id.util.ts`) and `docs/reference/`.
- `KICKOFF.md` section 8 — the Baseline's Standing deviations this change touches.

## The ROUTE — its shape

**Initial** (Baseline `none`):

1. **Schema first** — tables in dependency order. Each NEW table's design is approved through the
   staged-build prompt's Stage 1, then its schema and migration land.
2. **Features** — each table's code: data access, service, handlers, routes, permissions, i18n,
   seed, tests.
3. **Background work** — jobs, notifications, events.
4. **Flows** — cross-table rules and end-to-end tests.
5. **Acceptance** — `plans/acceptance.md`.

**Incremental:** schema changes first — new tables and `ALTER` migrations from the diff, never an
edit to a migration merged to `main` (an unmerged one may change in place with a recorded decision —
[`migrations.md` › Since the first release](../../../docs/reference/data/migrations.md#since-the-first-release)) → changed features → changed background work → affected flows,
re-running the existing end-to-end tests for everything touched.

**Drivers:**

| Work item | Driver |
| --- | --- |
| NEW table | the staged-build prompt (`docs/getting-started/staged-build-prompt.md`) — paste the ROUTE row, its requirements and its story above it |
| CHANGE table, flow, background work | `/be-build-requirement` in its **from an approved KICKOFF row** mode (`agent-os/commands/be-build-requirement.md`): the row is the approved draft — no draft review, no per-row `/be-pre-merge-review` (it runs at Close), no report bundle |

Each driver runs the matching skill chain (schema-change, route-change, worker-change or new-domain
— `agent-os/skills/chains.json`).

## Each ROUTE row — do → verify → record → check impact → stop

Before marking a row in progress, check its dependencies are done, compare existing code with
the approved module specification, identify unresolved decisions, and select the affected tests.
Use the [document ownership and row execution guidance](../../../docs/design-workflow/process/README.md#document-ownership--write-once-reference-elsewhere)
for what each record owns. Keep the approved row order and scope; a preflight finding does not
authorize changing either.

1. **Do** — mark the row `in progress` in `KICKOFF.md` and build it through its driver.
2. **Verify** — the row's acceptance, its tests (`pnpm test:select --run`; for a NEW table the
   staged-build prompt's Stage 3 has run them — read its Stage 4 test run), `pnpm validate` — by
   the README's Intake mode:
   `full` / `overlay` → the acceptance traced to the PRD; `brief` → the `BRIEF.md` acceptance
   criteria the row covers, and the parts it touches still match the carried-forward PRD and
   `schema-routes.md` except where the brief changes them. MODE incremental, every mode: re-run the
   existing end-to-end tests for everything touched. Against the plan's own files: what the row built matches its sub-domain's
   section in `plans/routes-final.md`, every route matches its proposal in `plans/route-changes.md`, every table it built matches
   `plans/db-changes.md` (`pnpm db:viewer` — the built table now stands where the plan drew it), and
   every piece of background work it built matches `plans/worker-changes.md` (now with its real queue
   and job names); any difference goes into the AS-BUILT row.
3. **Record** — add the row to `AS-BUILT.md`:

   | # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
   | --- | --- | --- | --- | --- | --- | --- | --- |

   Every technical decision the row made (table and column design, endpoints, permission codes,
   queue names) is recorded here or referenced from its approved specification or decision.
   Do not copy an unchanged module specification. Record verification commands, outcomes and
   acceptance references once in this row or an adjacent verification section; `plans/acceptance.md`
   links to that evidence. Where the build now differs from the drop on purpose, add a **Standing
   deviation** (item · design says · built as · since iteration · decision); where this row resolves
   one, remove it.

   Then **sync the plan with what was built**, so the three change files end as the true record:
   `plans/db-changes.md` — the table's final `domain.table` on its label and its final field names
   (still logical types; the physical types live in the schema code the DB Viewer draws);
   `plans/route-changes.md` and `plans/worker-changes.md` — a `Built` column (added on the first
   row) with the final method + path, or the final job, and the commit. Keep these updates concise:
   link to the AS-BUILT row for evidence and deviation explanations rather than repeating them.
   `KICKOFF.md` stays frozen
   apart from its ROUTE Status column.
4. **Check the impact on upcoming rows.**
   - Small and inside the row → record it in `AS-BUILT.md` and continue.
   - **Scope** — a row added or removed, an acceptance changed, the order changed → **stop and ask**
     (AskUserQuestion). Record the decision in `plans/decisions.md` (Kind `SCOPE`) and in
     `AS-BUILT.md` › Revisions to upcoming rows (the revised row text), and mark the affected
     `KICKOFF.md` row "revised → AS-BUILT #n". Never rewrite `KICKOFF.md` otherwise — it is frozen.
5. **Stop** — mark the row `done`, show the user what was built and the AS-BUILT row, and wait for
   their review before the next row (under a `/goal` or the user's go, a one-line report instead — Step 0, Parallel lanes). Use the review summary from the linked row execution guidance:
   changes and contracts, verification evidence, deviations or blockers, impact, and the next row.
   **This review is the row's review of record:** on the user's OK, fill the row's `Reviewed` cell
   (date · who · the commit reviewed). A change they ask for is made, verified and shown again
   before the cell is filled.

## Parallel lanes — only under a `/goal` or the user's delegation

Without a `/goal` or the user's explicit go to build without stops, rows run one at a time as above.
Under one, rows whose dependencies are done may be built **in parallel lanes**: the same steps per row
(do → verify → record → check impact), a one-line report instead of the stop, review at Close. Order and
scope never change — a lane only runs a row early when everything it depends on is done.

**Setup.** The main checkout (the iteration branch) is lane A: it merges and closes. Each other lane is a
`git worktree` on its own branch, with its own test databases, its own Redis DB and its own range of
decision numbers. Every test run **and every `git commit`** (the pre-commit hook runs database tests)
goes through **`pnpm test:lane`** (`tooling/vitest/run-in-lane.ts`): it gives the worktree its own test
databases and Redis database (`TEST_DATABASE_NAME_SUFFIX` / `TEST_REDIS_DATABASE`, from the worktree's
folder name and position), and with `--serial` holds the one lock all worktrees share —
`pnpm test:lane --serial -- git commit -F <message file>`, `pnpm test:lane -- pnpm vitest run <files>`.
Read-only helpers (audits, docs comparisons, reviewers) run beside the builders and need no lock.

| # | Rule | Why |
| --- | --- | --- |
| 1 | A worker commits only on its own lane's branch and never checks out or resets another lane's. | Lanes never overwrite each other. |
| 2 | Workers get separate scopes — never the same file. | Merges stay mechanical. |
| 3 | Take the next free decision number in the lane's range, checked across all branches (`git log --all -p -- '*decisions.md'`). | Decision rows never clash. |
| 4 | Never `git stash pop` / `drop` a stash you did not create; prefer not stashing. | The stash is shared by every worktree. |
| 5 | Cap test workers (`--maxWorkers=2`) while several lanes share the machine. | The machine stays responsive. |
| 6 | Verify a row with its narrow set — its sub-domain's unit, integration and e2e tests and `src/tests/global`, plus `src/tests/security/rls` and the permission matrix when it touched tables, routes or permissions. This replaces `pnpm test:select --run` per row; the full suites run at Close. | Lock waits stay short. |
| 7 | A row is done only after its final code state was re-run; every report says so. | No "done" without proof. |
| 8 | `pnpm docs:all` before committing a route, schema or merge change. | Stale generated specs block the commit. |
| 9 | A merge into lane A runs the static gates and the tests of the conflicted and changed files — re-run on lane A itself, not only in the lane — and logs every conflict (file · sides · resolution · risk) in `plans/merge-log.md`. | Lanes may use another database login than lane A; conflicts stay auditable. |
| 10 | An idle lane may merge lane A and another lane first, so lane A fast-forwards. | Lane A's merges stay small. |
| 11 | Never change lane A's working tree while a full gate runs on it. | The gate's result stays valid. |
| 12 | **Push last, once** — only when the user wants a push, and only after everything is complete: every lane merged, the records written, and the Close gates (Close) green on that exact commit (re-run after any later change or a killed run). Unpushed commits wait for it; a backup push earlier only when the user asks. | The pushed code is the tested, finished code. |
| 13 | A user request during the build: audit read-only first (code, third-party docs), show a gap table with a recommendation, ask once with every question batched, then build in separate lanes. | No rework on wrong guesses. |
| 14 | Before the freeze, write `plans/pending-and-deferred.md`: deferred work, open owner questions, deploy steps, sibling-repository work. | Nothing is lost at the freeze. |

Still in force in every lane: `--no-verify` is never used, a scope change stops and asks, and nothing is
pushed, opened as a PR or merged into `main` unless the user asks — merging a lane into the iteration
branch locally is part of the build.

## Close

- Run **the Close gates** (the one list — the `/goal` line and Parallel lanes rule 12 point here):
  `pnpm validate`, `pnpm ci:local` (its steps, the route and domain gates included, are
  `tooling/validate/gates.ts`), `pnpm test:rls-role` and `pnpm sonar:scan`.
- Run `/be-pre-merge-review`. A **critical** or **major** finding is fixed, or explicitly accepted by
  the user, before `done`; **minor** and **nit** findings are reported only.
- **The goal's condition.** When a `/goal` was set, check each of its criteria now, one line each
  with its evidence (the command and its result, or the file and section), before
  `pnpm iteration:status <iteration> done`. A criterion not met is work to finish, not a note; the
  goal is met only when every line is. The rows built under it are reviewed now (next item).
- **The per-row reviews are the review of record.** Every `AS-BUILT.md` row has its `Reviewed`
  cell; a row without one is reviewed now, before close. The PR's human review then covers what
  changed after each row's reviewed commit (and the close), not the rows again.
- Every ROUTE row is `done`, or `deferred` with the user's explicit OK.
- Fill `plans/acceptance.md` — a Result and Evidence for every item.
- Write the frontend's route map, `plans/frontend-route-map.md`: section 1 the contract changes, section 2
  each design operation (`intake-files/schema-routes.md` › Operations) → the route that serves it, section 4
  the design features dropped (to remove from the frontend) — by hand; section 3, every route, by
  `pnpm iteration:frontend-map <iteration>` (rerun after any route change; `--check` fails when stale).
- Finish `AS-BUILT.md` with its closing summary: planned but not built (deferred, user OK), built but
  not planned, follow-ups for the next iteration — and the **Standing deviations**: the complete list
  of where the code now differs from the drop (the Baseline's list, minus what this iteration
  resolved, plus its new ones). The next iteration plans against it.
- Run `pnpm iteration:status <iteration> done`. `pnpm iteration:status <iteration> frozen` goes in
  the last commit before the merge — PR CI's Iteration freeze lane (`pnpm iteration:freeze-check`)
  fails until it does.
- **Never push, open a PR or merge, unless the user asks:** then push last, once, after the full
  gates (Parallel lanes rule 12). The user raises PRs.

## AS-BUILT.md — the shape

```markdown
# <iteration> — as built

Baseline: <none | iteration> · KICKOFF.md approved <date>

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Revisions to upcoming rows

- #<n>: <the revised row text> — <decision link>

## Summary

- Planned, not built (deferred — user OK): …
- Built, not planned: …
- Follow-ups for the next iteration: …

## Standing deviations

The complete list of where the code differs from the drop — the Baseline's list (empty for an
initial iteration), minus what this iteration resolved, plus its new ones.

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
```

## Project conventions every row must keep (non-negotiable)

`CLAUDE.md` is the source of truth; these are what a row most often gets wrong:

- **Domain layout** — `src/domains/<domain>/sub-domains/<sub-domain>/`, prefixed sub-domain names,
  nested only when the child's lifecycle is the parent's
  (`docs/reference/architecture/domains-and-public-api-design.md`).
- **API contract** — snake_case route params and body keys, `generatePublicId` prefixes, 200 for
  every method except DELETE (204), the error codes in `docs/reference/api/response-codes.md`,
  `X-Idempotency-Key` on money and state writes.
- **Tenancy** — the active organization comes from the signed `org` claim; every tenant table is
  ENABLE + FORCE row-level security with an organization policy
  (`docs/reference/security/rls-architecture.md`).
- **Data lifecycle** — soft delete, revocation or immutable ledger
  (`docs/reference/data/data-lifecycle-deletion.md`); a migration merged to `main` is never edited —
  an unmerged one may change in place with a recorded decision (`docs/reference/data/migrations.md`
  › Since the first release).
- **Async** — services emit in-process events; durable work is a pull-based BullMQ worker carrying
  `organizationPublicId` (`docs/reference/runtime/workers-and-events.md`).
- **Copy** — every user-facing message is an i18n key.

## Failure modes this skill exists to prevent

| Failure | Prevention here |
| --- | --- |
| The wrong iteration implemented, or one on an unfinished Baseline | Step 0 eligibility + AskUserQuestion |
| A build on an incomplete or edited intake | Step 0 gate (`iteration:intake --check`) |
| A deliberate difference from the drop that nobody can find later | Standing deviations, carried forward |
| Rows built in a batch, reviewed too late | stop for review after every row (under a `/goal` or the user's go: every row reviewed at Close) |
| What was built drifts from the plan with no record | the AS-BUILT row per ROUTE row |
| A scope change slipped in silently | the impact check — scope changes stop and ask |
| The approved plan rewritten after the fact | `KICKOFF.md` frozen; revisions live in AS-BUILT |
| A merged migration edited for a CHANGE table | incremental route: new `ALTER` migrations; only an unmerged one changes in place, with a recorded decision |
| "Done" claimed with open rows | close: every row done or deferred with the user's OK |
| Parallel lanes wiping each other's tests or data | Parallel lanes: a worktree, databases and Redis DB per lane, one lock for tests and commits |
| Code pushed that was not the code tested | Parallel lanes rule 12: full gates on the exact commit before a push |

## Related

- **`be-iteration-planning`** — writes and gets approval for `KICKOFF.md`
- [`kickoff-iteration-prompt.md`](../../../docs/design-workflow/prompts/kickoff-iteration-prompt.md) — the paste prompt
- [`staged-build-prompt.md`](../../../docs/getting-started/staged-build-prompt.md) — the driver for NEW tables
- [`requirement-intake.md`](../../../docs/getting-started/requirement-intake.md) — `/be-build-requirement` and the requirement form
- [`iteration-guide.md`](../../../docs/design-workflow/process/iteration-guide.md) — every step with its questions
