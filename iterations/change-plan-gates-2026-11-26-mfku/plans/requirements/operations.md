# Requirements — Operations — change-plan-gates-2026-11-26-mfku

Mode **initial** · Intake `brief` (hash `26273bac1cb0`) · 2026-11-26. Decisions are in [`../decisions.md`](../decisions.md); the agreed design is in [`../routes-final.md`](../routes-final.md).

| Id | Requirement | Kind | Source |
| --- | --- | --- | --- |
| `operations.entitlements-read-source` | The entitlements read reports each value's source (`override` / `plan` / `default`) beside today's features, limits, usage and overrides | CHANGED (additive) | BRIEF:L39, EN6 |
| `operations.entitlement-consume` | Counted limits (monthly DMs, accounts, seats) keep their counters and locks; each reads its ceiling from the module and refuses through its builder; billing owns no counter | CHANGED | BRIEF:L24, P8, P23 |
| `operations.entitlement-downgrade-rule` | A switch turned off stops new use, keeps what exists, and the run engine skips the step; a lowered cap or spent month stops new use until an upgrade or the reset | EXISTING (kept) | BRIEF:L94 |

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `operations.entitlements-read-source` | merged values, overrides listed apart | each value also names its source | EN6 |
| `operations.entitlement-consume` | each counter reads plan access itself and builds its own refusal | each reads `limit()` and refuses through the builder; locks unchanged | P23 |
