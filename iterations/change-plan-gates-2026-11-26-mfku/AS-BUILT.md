# change-plan-gates-2026-11-26-mfku — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (P35) · kickoff 2026-11-26

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | The pre-handler order test for go-live and broadcast send, written first (routes-final §3 RGC1; R2, P4) | Two integration cases beside each route's read-only test: `broadcast.integration.test.ts` › a read-only plan › *checks the plan first, then the permission, then the idempotency key*; `automation.integration.test.ts` › a read-only plan › *checks the plan before the permission on go-live*. They pin the order by which refusal wins: read-only + a viewer → `403 organization_read_only` (plan before permission); writable + a viewer with no key → permission 403, not `422` (permission before the claim); read-only + owner with no key → `403 organization_read_only`, not `422` (plan before the claim). | **Behavioural, not structural.** The plan said "pins the pre-handler order"; the permission pre-handler is an anonymous function, so a structural test can't recognise it, and an error response releases the idempotency key (`idempotency.middleware.ts` onSend/onResponse), so "the refused write holds no key" can't be told apart by outcome. The order is proven by which refusal wins. go-live takes an optional key, so its claim position is proven on broadcast send only. | A behavioural test survives row 5's rewiring unchanged, which is the point of writing it first. | P4, R2 | `63a97c1` | 2026-11-26 · Nikunj Mavani · `63a97c1` |
| 2 | Entitlement module: registry, `resolve` with sources, `can` / `limit`, `buildPlanRefusal`, `sources` on the read (§1 ENC1–ENC5, ENC8) | Registry in `entitlement.constants.ts` (11 switches built from `PLAN_FEATURE_KEYS`, the 2 limits, `seats`; typed `EntitlementSwitchKey` / `EntitlementLimitKey` / `EntitlementKey`); the two override lists derived from it, same 13 keys and order (unit-pinned; no migration). `entitlement-registry.util.ts` fills a missing switch with off before the strict parse and records `defaultedKeys`, threaded through `PlanAccess` and the one SQL read. `EntitlementService.resolve` (one `getPlanAccess`, test-asserted) returns `{ value, source }` per key. `can` / `limit` in `entitlement-snapshot.util.ts`. `buildPlanRefusal` in `entitlement-refusal.util.ts`, one case per reason, bodies identical to today's (no caller switched yet). `GET /billing/entitlements` built from `resolve`, adds `sources`; OpenAPI schema and example updated. | (a) The default also applies in the plan listing (P37). (b) `resets_on` needed a new `date` field kind in `APP_ERROR_FIELD_KINDS`, accepted by the error handler and the OpenAPI error schema. (c) The override lists are typed as a non-empty list of the key union rather than a fixed tuple (values unchanged). (d) The month refusal carries no `upgrade_required` (P38). | (a) P19's purpose; (b) the shared error-field allowlist (oxak P269) only had number, text and boolean kinds; (c) derived from the registry; (d) ditto EN5. | P17–P19, P21, P23, P24, P36–P39 | `3d96cf3` | — |
| 4 | Read-only flag default `false` (P5) | `LAPSED_PLAN_READ_ONLY_ENABLED` → `booleanString('false')` with its Category-A comment rewritten; `.env.example` `false` (with how to turn it on); `docs/reference/env-catalog.md` regenerated (`pnpm env:catalog`, check in sync); `src/OVERVIEW.md` and `subscription.overview.md` say off by default. | None in scope. be-env-schema-add was checked first: its "production-safe default" rule plus a production `.refine` applies to **security** flags; this one is billing policy (its schema comment classes it Category-A, no refine pins it), so `false` loosens no security guard and the skill doesn't refuse it (P5's stop condition not met). | The owner's product-first choice (P5); `docs/deployment/launch-checklist.md` and `environment-variables.md` already said `false`. | P5 | `af9f0ad` | — |
### Row 1 verification

- New cases on today's code: 2 passed (`pnpm test:lane -- pnpm vitest run <both files> -t change-plan-gates`).
- Mutation check: the permission check moved before the plan guard on both routes → both cases **fail** (2 failed); files restored with `git checkout`, diff clean.
- Both full files: 46 passed. `pnpm validate`: green (after formatting). Pre-commit guard: green.
- Acceptance: AC-10 (order part) — the cases must still pass after row 5.

### Rows 2 and 4 verification

- Row 2 (agent-built, re-checked here): entitlement tests 10 files / 75 passed (re-run); agent's runs: billing + touched 103 files / 836 passed; all unit 840 files / 7822 passed, 1 skipped; `src/tests/global` 37 / 163 passed; `pnpm validate`, `tsdoc:check` 0/0, `docs:all`, pre-commit 24/24 green.
- Row 4: `src/tests/unit/config`, the no-`NODE_ENV`-branching global test and the plan-access unit test: 8 files / 237 passed; `pnpm env:catalog:check` in sync; pre-commit 24/24 green.

## Revisions to upcoming rows

None yet.

## Summary

Written at Close.

## Standing deviations

Baseline `none`, so the starting list is empty. KICKOFF.md § 8 carries in the frozen
`feat-instagram-dm-sending-2026-11-23-oxak` deviations this change touches; the two kept ones are restated here
(P9). The two it resolves (Free's segments and broadcasts, P13; the read-only flag default, P5) are removed when
rows 3 and 4 land.

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Read-only plan | go-live, broadcast send and turning a PRO part on answer `organization_read_only` | the read-only guard is on go-live and broadcast send; turning a PRO part on answers `plan_lacks_feature` | feat-instagram-dm-sending-2026-11-23-oxak | P9 |
| A picture with text | counts as 2 DMs | counts as 1 | feat-instagram-dm-sending-2026-11-23-oxak | oxak P412 |
