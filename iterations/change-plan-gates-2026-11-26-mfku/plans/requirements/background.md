# Requirements — Background — change-plan-gates-2026-11-26-mfku

Mode **initial** · Intake `brief` (hash `26273bac1cb0`) · 2026-11-26. Decisions are in [`../decisions.md`](../decisions.md); the agreed design is in [`../routes-final.md`](../routes-final.md).

| Id | Requirement | Kind | Source |
| --- | --- | --- | --- |
| `background.job-plan-gate-declaration` | Every job a registered queue runs declares its plan gate or `open` with a reason, in its queue's worker-registry entry; paid jobs meet their gate as today (send claim; a switch at start) | NEW | BRIEF:L31, P12, P33 |

The list of background work and its before → after: [`../worker-changes.md`](../worker-changes.md). Rules every
piece follows: no send gains a plan read (P12); a job reads plan access once per job through the module (K2).

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `background.job-plan-gate-declaration` | 12 paid jobs listed in a test helper; the rest undeclared | every job declares in its queue's registry entry | P33 |
