# Worker changes — change-plan-gates-2026-11-26-mfku

Mode **initial** (Baseline `none`, Intake mode `brief`) · Intake hash `26273bac1cb0` · updated 2026-11-26 (route review final: P12, P13, P33).

**No new background work and no change in when anything runs.** Each piece of paid background work
declares the plan gate it meets, next to where it's registered; a test fails on an undeclared one
(BRIEF:L31, BRIEF:L116). Each piece meets its gate as today: the send claim through the account's
stored plan stop, or a live switch check for past comments and segment counts. No send gains a plan
read (P12). On Free, a segment's background count now runs, because Free's segments switch is on (P13).

| Change | Count |
| --- | --- |
| NEW | 0 |
| CHANGED (declaration; behaviour as today) | 7 groups (12 paid jobs + every other job, declared open) |
| REMOVED | 0 |

| # | Change | Background work | When it runs | What it touches | On failure | Who is told | Requirement | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WC-1 | CHANGED: declares the send claim (month limit, accounts) | send a waiting message on an account's lane (slow and fast lanes) | each lane turn | message, month count | as today: retried; never counted twice | nobody (the plan stop shows on the account) | `background.job-plan-gate-declaration` | BRIEF:L31 |
| WC-2 | CHANGED: declares the send claim | put a failed message back to waiting | a member retries failed messages | message | as today | nobody | `background.job-plan-gate-declaration` | BRIEF:L31 |
| WC-3 | CHANGED: declares the send claim | take in Instagram events (messages, Live, comments, tags, missed-comment check) and start runs | each event or check | run, message | as today: the plan is met at the send claim, not at intake | nobody | `background.job-plan-gate-declaration` | BRIEF:L31 |
| WC-4 | CHANGED: declares the send claim | build a broadcast's audience; repair a missed scheduled start | a broadcast is sent or its start is due | broadcast, message | as today | nobody | `background.job-plan-gate-declaration` | BRIEF:L31 |
| WC-5 | CHANGED: declares the past-comments switch; the check asks the module | read an automation's past comments | a member starts it | run | as today: refused when the switch is off | nobody | `background.job-plan-gate-declaration`, `access.entitlement-module-single-entry` | BRIEF:L31 |
| WC-6 | CHANGED: declares the segments switch; the check asks the module | count a segment's audience in the background | a segment is saved | segment | as today: skipped when the switch is off; on Free it now runs (P13) | nobody | `background.job-plan-gate-declaration` | BRIEF:L31 |

| WC-7 | CHANGED: declares `open` with a reason (P33) | every other job: the plan-change follow-up, the month wake-up, repairing plan stops, the plan-state check ("enforces a plan, does no paid work"), clean-ups, reads and notices | as today | as today | as today | as today | `background.job-plan-gate-declaration` | P33 |

Every job a registered queue runs declares, so the coverage test fails on a forgotten one (P33).

## Before → after

| # | Background work | What changes | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| WC-1–WC-7 | every job | where the gate is declared | 12 paid jobs in a hand-kept test helper; other jobs undeclared | every job declares in its queue's worker-registry entry, read by the coverage test | BRIEF:L31, L116, P33 |
| WC-5, WC-6 | past comments read, segment count | who answers the switch | the piece reads the plan directly | the piece asks the module (`can`) | BRIEF:L41 |

## Built

| # | Built as | Commit | AS-BUILT |
| --- | --- | --- | --- |
| WC-1–WC-4 | `SEND_CLAIM_PLAN_GATE` on the 10 send-claim jobs (`instagram-send-lane-turn`, `instagram-send-fast-message`, `retry-failed`, `intake-messages`, `intake-live`, `intake-comments`, `intake-tag-events`, `missed-comment-check`, `broadcast-audience`, `repair-broadcast-start`) | `d5a07bc` | row 8 |
| WC-5 | `automation-backfill-read` → `feature:past_comments`; checks through `can()` | `d5a07bc`, `fbb87ce` | rows 6, 8 |
| WC-6 | `segment-count` → `feature:segments`; checks through `can()` | `d5a07bc`, `fbb87ce` | rows 6, 8 |
| WC-7 | the other 80 jobs `open` (`JOB_PLAN_GATE_OPEN_REASON`) in `worker-registration.registry.ts` › `jobPlanGates` | `d5a07bc` | row 8 |
