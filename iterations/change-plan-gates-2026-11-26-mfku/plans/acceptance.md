# Acceptance — change-plan-gates-2026-11-26-mfku

Brief mode: each criterion traces to `intake-files/BRIEF.md` or a decision. Result and Evidence are filled at Close.

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-1 Every write route declares `config.planGate`; the coverage test fails on an undeclared one | BRIEF:L115 | | |
| AC-2 Every job declares a plan gate in its queue's worker-registry entry; the coverage test fails on an undeclared one | BRIEF:L116, P33 | | |
| AC-3 `src/tests/helpers/route-plan-gate-model.ts` is deleted; the coverage test reads the live declarations | BRIEF:L117 | | |
| AC-4 No source file outside subscription and entitlement reads plan access, and no feature names a plan; a policy test enforces it | BRIEF:L118 | | |
| AC-5 Every plan refusal comes from the one builder, with every status as before; integration tests assert the bodies | BRIEF:L119 | | |
| AC-6 Changing a switch or one of the 2 limits for an organization is one override row; seats are not overridable | BRIEF:L120, P18 | | |
| AC-7 `GET /api/v1/billing/entitlements` returns each value with its source (`override` / `plan` / `default`) and usage for counted keys | BRIEF:L121 | | |
| AC-8 Unit tests cover the merge order, override expiry, the registry default and the typed registry | BRIEF:L122 | | |
| AC-9 The month-cap DB tests, AC-22.4, the account-race tests and the seat lock-order test pass unchanged | BRIEF:L123 | | |
| AC-10 AC-2.8 passes unchanged; the new order test (plan guard → permission → idempotency claim) passes before and after the guard moves | BRIEF:L124, R2 | | |
| AC-11 `resolve` does one database read per request or job (asserted); no cross-request cache | BRIEF:L125 | | |
| AC-12 `src/PATTERNS.md` has a "plan gates" pattern; the refusal doc and the frontend route map describe the shapes; `src/FLOWS.md:336` is corrected | BRIEF:L126, P9 | | |
| AC-13 `pnpm ci:local`, `pnpm test:rls-role` and the SonarQube gate are green; `pnpm iteration:freeze-check` passes after the freeze | BRIEF:L127 | | |
| AC-14 `LAPSED_PLAN_READ_ONLY_ENABLED` defaults to `false` in the schema, `.env.example` and the env catalog | P5 | | |
| AC-15 A Free organization can create and send broadcasts and save segments; an override turning a switch off still refuses with `403 plan_lacks_feature` | P13, P27, PL4 | | |
