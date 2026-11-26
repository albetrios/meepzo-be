# Requirements — Quality — change-plan-gates-2026-11-26-mfku

Mode **initial** · Intake `brief` (hash `26273bac1cb0`) · 2026-11-26. Decisions are in [`../decisions.md`](../decisions.md); the agreed design is in [`../routes-final.md`](../routes-final.md).

| Id | Requirement | Kind | Source |
| --- | --- | --- | --- |
| `quality.entitlement-key-registry` | One typed registry: 11 switches (built from the plan's existing key list), 2 limits, seats; each with kind, product, default, overridable; an unknown key fails to compile | NEW | BRIEF:L14, P21, EN1 |
| `quality.entitlement-single-read` | One plan read per request or job, no cache (BL2); callers pass the snapshot | CHANGED | BRIEF:L86, P24 |
| `quality.plan-refusal-shape` | Every plan refusal comes from one builder; statuses unchanged; `feature` + `upgrade_required`; the month refusal gains `limit`, `used`, `resets_on`; no plan id | CHANGED | BRIEF:L33, P6, P7 |
| `quality.plan-gate-coverage-test` | The coverage test reads the live route and job declarations; the hand-kept model is deleted | CHANGED | BRIEF:L36, RG6, JG4 |
| `quality.no-direct-plan-reads` | A policy test fails on any plan-access read outside subscription and entitlement; no plan names in feature code | NEW | BRIEF:L41, L98, ENC7 |
| `quality.product-first-defaults` | Generous launch defaults: read-only off by default, Free with segments and broadcasts | CHANGED | BRIEF:L97, P5, P13 |
| `quality.read-only-flag-default` | `LAPSED_PLAN_READ_ONLY_ENABLED` defaults to `false`; template, catalog and docs agree | CHANGED | P5 |
| `quality.plan-gates-docs` | A "plan gates" pattern in the system narratives; the refusal doc; the stale flow line fixed; the frontend route map | CHANGED | BRIEF:L126, P9 |
| `quality.gates-green` | `pnpm ci:local`, `pnpm test:rls-role` and the SonarQube gate green; `pnpm iteration:freeze-check` passes before the PR | EXISTING | BRIEF:L127 |

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `quality.entitlement-single-read` | go-live reads plan access 3 times | once | P24, RG5 |
| `quality.plan-refusal-shape` | 5 places build plan refusals; the month refusal carries no numbers | one builder; the month refusal carries `limit`, `used`, `resets_on` | P6, EN5 |
| `quality.read-only-flag-default` | default `true`; two docs already say `false` | default `false` everywhere | P5 |
