# Requirements — Access — change-plan-gates-2026-11-26-mfku

Mode **initial** · Intake `brief` (hash `26273bac1cb0`) · 2026-11-26. Decisions are in [`../decisions.md`](../decisions.md); the agreed design is in [`../routes-final.md`](../routes-final.md).

| Id | Requirement | Kind | Source |
| --- | --- | --- | --- |
| `access.entitlement-module-single-entry` | Every plan question (a snapshot, a switch, a limit, a refusal) is answered by the billing entitlement module; nothing else reads plan access | CHANGED | BRIEF:L19, P1, K3 |
| `access.route-plan-gate-declaration` | Every write route declares its plan gate (`read_only`, `feature:<key>`, `limit:<key>`) or `open` with a one-line reason | NEW | BRIEF:L28, RG1 |
| `access.route-plan-gate-enforcement` | One guard, attached by one route hook, enforces `read_only`; feature and limit gates are enforced where used | CHANGED | BRIEF:L29, P29 |
| `access.read-only-before-idempotency` | The order stays authenticate → plan guard → role permission → idempotency claim, pinned by a test written first | CHANGED (test NEW) | BRIEF:L84, P4, R2 |
| `access.feature-gate-order` | The channel feature check keeps its order (channel → Meta permission → plan → not offered); its plan step asks the module | EXISTING (kept) | BRIEF:L81, P20 |

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `access.entitlement-module-single-entry` | 11 source files read plan access directly | only the entitlement module does; a policy test enforces it | P1, K3 |
| `access.route-plan-gate-enforcement` | a hand-made guard wired by hand on 2 routes | one guard attached by a route hook from the declarations | RG3 |
| `access.read-only-before-idempotency` | the order is documented, not tested | a test pins it before anything moves | R2, RG7 |
