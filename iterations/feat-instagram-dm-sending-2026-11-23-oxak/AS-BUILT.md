# feat-instagram-dm-sending-2026-11-23-oxak — as built

Baseline: none (changes `launch-2026-11-20-ujai` in place, P29) · KICKOFF.md approved 2026-11-24 · kickoff started 2026-11-24

Run mode ([P102](plans/decisions.md)): the whole ROUTE R1–R63 without a per-row stop, at the owner's word. Each row ends
with its row below and a one-line report; the `Reviewed` cells stay `—` until the owner reviews at Close. Where agent-os
cannot build `plans/routes-final.md` exactly as written, the row follows agent-os, records the difference here and in
`plans/decisions.md` (AMBER, "user delegated 2026-11-24") and syncs `routes-final.md`; a scope change is parked as
`deferred` for the owner, never decided. Commits stay local (no push).

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 8.A Plans (BLC6) + BLC1 plans part + BLC2: the Flowdm rows, typed features one switch per feature, routes 100–101, the plan entitlement (BL2–BL4) | Migration `20261124060244_billing_flowdm_plans.sql` (billing, new): every row's `features` typed, `included_seats` null, Free/Creator/Studio active (Creator $29/$276, Studio $79/$756 placeholders), every other row off with Free's features, `features` default dropped, `chk_plans_features` (NOT VALID + VALIDATE, inside a NO FORCE/FORCE RLS bracket). `plan.constants.ts` (`PLAN_FEATURE_KEYS`, `PRO_PLAN_FEATURE_KEYS`), `planFeaturesSchema` + inferred `PlanFeatures` in `plan.types.ts`, `parsePlanRow` on every `PlanRepository` read, list cheapest first; `PlanOutput` + `price_yearly_per_month` (`yearlyPricePerMonth`), − `limits`; `plan_id` must be a `pln_` id (400); `DEFAULT_PLANS` = 3 plans + 3 off rows, `FREE/CREATOR/STUDIO_PLAN_FEATURES`, the seed parses before insert. `resolvePlanAccess` rewritten (Free never ends; dunning grace then `read_only`; cancelled paid → `read_only` at period end); `getPlanAccess` answers the entitlement (`state`, `graceEndsAt`, `trialEndsAt`, `plan`, `features`) from one query (+ the Free plan join); `PlanAccessOutput` + `trial_ends_at`; `NEW_ORGANIZATION_TRIAL_DAYS` and `holdsPaidEntitlement` removed; `BILLING_READ_ONLY_ENFORCED` default `true` (schema, `.env.example`, harness keeps `false`, env catalog). OpenAPI plan/plan-access schemas, FLOWS/OVERVIEW/POLICIES, overviews, frontend guide. Tests: `plan-features.unit` (new), plan service/serializer/repository-db/integration, entitlement + plan-access unit, auth me-context unit, `billing.test.ts` and `src/tests/integration/billing/plans` (400 for a non-`pln_` id), launch read-only suites | Feature keys fixed to 11 (BL12 had "…"); BL3's unnamed cases decided; the migration also handles rows other than Starter/Growth/Pro; RC-58 read as 8.A.9 (off row → 404); flag off still reads the plan (always one query); the `PLAN_FEATURE_KEYS` = `CHANNEL_FEATURES` test left to R5; launch read-only tests now lapse a paid plan | BL12 left the non-PRO keys open; BL3 named only the main states; the CHECK must validate on any environment; BL3 removes the 14-day trial the launch tests used | [P103](plans/decisions.md), [P104](plans/decisions.md), [P105](plans/decisions.md) | this row's commit | — |

## Kickoff choices

- P22 — public-id prefixes of the new tables: recorded per row as each table lands. R1: none new (`billing.plans` keeps `pln_`).
- R1 — `PLAN_FEATURE_KEYS` (P103): `email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `broadcasts`, `segments`, `past_comments`, `extra_delay` (PRO), `starter_questions`, `mark_seen`.
- worker-changes note 1 — the launch's "start the automations queued behind an email" kept unchanged.

## Revisions to upcoming rows

- R5: `CHANNEL_FEATURES` must name only `PLAN_FEATURE_KEYS` switches and add the unit test that the two sets agree (BL12); a new feature key is a new billing migration (P103).
- R24: `serializePlanAccess` adds `plan`, `features`, `is_plan_choice_required` (BL16, BLC13) — the entitlement already carries `plan` and `features`.

## Summary

- Planned, not built (deferred — user OK): …
- Built, not planned: …
- Follow-ups for the next iteration: …

## Standing deviations

The starting list is the launch's (`../launch-2026-11-20-ujai/AS-BUILT.md` › Standing deviations), as planned against in
KICKOFF.md section 8; this table is completed at Close — the launch's list, minus what this iteration resolved, plus its
new ones (the D58 file scan, P34, among them).

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Malware scan of message files | Scanned before use (plan D58) | Type and content checks only | feat-instagram-dm-sending-2026-11-23-oxak | [P34](plans/decisions.md) |
