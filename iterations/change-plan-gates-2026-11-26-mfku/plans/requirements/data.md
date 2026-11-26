# Requirements — Data — change-plan-gates-2026-11-26-mfku

Mode **initial** · Intake `brief` (hash `26273bac1cb0`) · 2026-11-26. Decisions are in [`../decisions.md`](../decisions.md); the agreed design is in [`../routes-final.md`](../routes-final.md).

| Id | Requirement | Kind | Source |
| --- | --- | --- | --- |
| `data.entitlement-merge-order` | A plan answer is the active override's value if there is one, else the plan's value, else the key's registry default; an expired override counts as absent | CHANGED | BRIEF:L89, P19 |
| `data.entitlement-key-namespacing` | Keys stay bare (`email_ask`, `message_month_limit`); each registry entry records its product (`instagram` or `core`), which isn't stored | NEW (registry attribute) | BRIEF:L109, P17 |
| `data.entitlement-override-row` | Changing a switch or one of the 2 limits for one organization is one override row; seats aren't overridable | EXISTING (kept) | BRIEF:L120, P18 |
| `data.free-plan-segments-broadcasts` | Free (and the 3 switched-off plans that share its values) has `broadcasts` and `segments` on, in a fresh database and an existing one alike | CHANGED | P13, P27 |

Tables and diagrams: [`../db-changes.md`](../db-changes.md) (override allowed keys, Stage 1; Free plan data, Stage 2).

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `data.entitlement-merge-order` | override → plan; a key a plan row lacks fails its strict read | override → plan → registry default; the source is reported | P19 |
| `data.free-plan-segments-broadcasts` | Free has every PRO switch off, including `broadcasts` and `segments` | Free (and Starter, Growth, Pro) have those two on | P13, P27 |
