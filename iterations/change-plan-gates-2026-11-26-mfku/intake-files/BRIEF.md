# Brief — Declare every plan gate once in one billing entitlements module that every route and job enforces

<!--
Source: the plan-gates proposal (Plan-Gates-Proposal.md, kept beside this brief), written at the
close of feat-instagram-dm-sending-2026-11-23-oxak. Names below were checked against the code on
2026-11-26; where the proposal and the code differ, the code is named and the difference noted.
-->

## What changes

Backend only; no screen changes. Behaviour stays identical until the limits move (phase 4) and
the refusal body gains fields (additive).

1. **Key registry**: one typed list of entitlement keys, each with its kind (feature switch,
   resource cap, metered usage, value setting), its type and its global default. Keys are
   namespaced by product (`instagram.monthly_dms`, `instagram.accounts`, `core.seats`, …). It
   replaces the scattered constants, including `ENTITLEMENT_OVERRIDE_KEYS` /
   `ENTITLEMENT_OVERRIDE_LIMIT_KEYS` in `entitlement.constants.ts`.
2. **One module**: the existing `billing/sub-domains/entitlement/` (lane B) becomes the single
   entitlements module: `resolve(organization)`, `can(organization, featureKey)`,
   `limit(organization, limitKey)`, `consume(organization, limitKey, amount, idempotencyKey)`,
   `refusal(...)`.
   - `resolve` wraps today's `getPlanAccess` and merges the per-organization overrides: override,
     then plan value, then global default. It stays **one uncached database read** (BL2).
   - `consume` is an atomic increment-and-check. Monthly DMs keep today's counter and lane C's hard
     month cap. Instagram accounts keep their row lock. An idempotency key stops a retry counting
     twice.
3. **Route declarations**: every write route carries `config.planGate`, one of `read_only`,
   `feature:<key>`, `limit:<key>` or `open:<reason>`. One global preHandler reads it and calls the
   module. It replaces the hand-added `createAppPlanAccessPreHandler` (`src/domains/app/app-plan-access.ts`).
4. **Job gates**: each paid job's registry entry declares its gate the same way, and the worker
   calls `can` / `consume` at its claim point.
5. **One refusal shape**: built only by the module. It carries `reason`, the feature or limit key,
   `limit`, `used`, `resets_at` / `grace_ends_at` and an upgrade hint, extending lane B's refusal
   contract additively.
6. **Coverage test**: reads `config.planGate` from the registered routes and the job registry, and
   fails on any undeclared write. It replaces the hand-kept `src/tests/helpers/route-plan-gate-model.ts`
   used by `src/tests/global/plan-gate-coverage.global.test.ts`.
7. **Entitlements GET**: `GET /api/v1/billing/entitlements` serializes `resolve(organization)`, adds
   usage, and shows the source of each value (`plan`, `override` or `default`).
8. **Clean-up and policy**: no feature calls `getPlanAccess` (today 13 source files) or
   `checkFeature` (today `channel-account.service.ts`) directly; a policy test bans
   `getPlanAccess` outside the entitlements module.

Proposed phases, one commit each: 1 module plus registry · 2 route declarations plus one
preHandler · 3 feature gates · 4 limits · 5 jobs · 6 clean-up · 7 docs. Phases 3 and 5 may run in
parallel. Phase 4 runs alone.

## Why

Plan logic is spread across services, a hand-added preHandler and a hand-kept test model.
Each new plan, override or gate means hunting through the code, and a forgotten gate is caught
only if someone updates the model by hand. With one module and declarations:

- plans become data (plan rows plus overrides), so pricing changes need no code change;
- features know only a key, not a plan name;
- refusals have one body shape, so the frontend shows the right upsell and support can see why;
- the coverage test makes a missing gate impossible to merge;
- "this organization gets more" is one override row.

It's for engineers adding gated features, support and super-admins setting overrides, and the
frontend rendering locked or upsell states. A second product later only adds its keys.

## Affected screens, entities and routes

- Screens: none (backend only; the frontend route map hands over the extended refusal and
  entitlements GET shapes).
- Entities: `entitlement_override` (existing, lane B; its key list moves into the registry), plan,
  subscription (read through `getPlanAccess`), the monthly DM usage counter and the Instagram
  account rows (lock kept). No new table is expected; planning confirms this.
- Routes:
  - `GET /api/v1/billing/entitlements`: response extended with usage and per-value source.
  - `GET|POST /api/v1/billing/entitlement-overrides`,
    `DELETE /api/v1/billing/entitlement-overrides/:entitlement_override_id`: key validation reads
    the registry.
  - Every write route (about 126): gains a `config.planGate` declaration, with no path, method,
    status or permission change.

## Rules

- **Gate order is unchanged** (CA11/P61): channel → permission → plan → not offered. The
  preHandler runs after the permission gate, and `can()` keeps "not offered" after the plan check.
  AC-2.8 stays the guard.
- **The read-only guard runs before the idempotency claim**, at the same hook position as today;
  the existing order test stays.
- **BL2: no plan cache**. `resolve` is one uncached read per request or job, memoized for that
  request or job only. A seconds-long cache cleared on `PLAN_STATE_CHANGED` is out of scope unless
  load data asks for it.
- **Merge order**: per-organization override (unexpired) → plan value → global default.
- **Unknown keys fail at compile time** (typed registry); key validation for override writes
  reads the same registry.
- **Month-cap concurrency** keeps lane C's exact logic inside `consume('instagram.monthly_dms')`,
  and the account row lock stays inside the accounts cap check.
- **Downgrade rule per kind**: a switch turned off means items stay saved but stop running; a cap
  lowered means the owner picks what stays, or the oldest stay; metered usage stops until the reset
  or an upgrade.
- **Product-first defaults**: generous Free values; `LAPSED_PLAN_READ_ONLY_ENABLED=false` at launch.
- **No plan names in feature code**; features ask by key only.
- Rate limits (Meta hourly pacing, request rates) stay operational and outside plans.

**Open decisions for planning** (proposal's recommendation in brackets):

1. Module location: [extend the existing `billing/sub-domains/entitlement/`; the proposal's
   "new sub-domain" now exists from lane B].
2. Starting keys: [few: `instagram.monthly_dms`, `instagram.accounts`, `core.seats`,
   `instagram.email_step`, `instagram.phone_step`, `instagram.segments`, `instagram.broadcasts`,
   `instagram.past_comments`; a key is added only when it needs to vary].
3. Upgrade hint shape: [feature key only, no suggested plan id, while product-first].
4. Key namespacing, and whether existing override rows need a key migration
   (`monthly_dms` → `instagram.monthly_dms`): [namespace now; migrate any stored keys in the
   same iteration].

## Acceptance criteria

- [ ] Every write route declares `config.planGate`, and the coverage test fails on any undeclared write route.
- [ ] Every paid job declares a gate in the job registry, and the coverage test fails on any undeclared paid job.
- [ ] `src/tests/helpers/route-plan-gate-model.ts` is deleted; the coverage test reads the live declarations.
- [ ] No source file outside the entitlements module calls `getPlanAccess` or `checkFeature`, or reads plan rows directly; a policy test enforces this.
- [ ] Every plan refusal comes out in the one body shape built by the module, asserted in the integration tests.
- [ ] Changing a limit for an organization is one override row, with no code change.
- [ ] `GET /api/v1/billing/entitlements` returns each key's value, its source (`plan` / `override` / `default`) and usage for counted keys.
- [ ] Unit tests cover the merge order (override → plan → default), override expiry, and the typed key registry.
- [ ] The month-cap concurrency DB tests and AC-22.4 pass unchanged, and so do the account-race tests.
- [ ] The gate-order guard (AC-2.8) and the read-only-before-idempotency order test pass unchanged.
- [ ] `resolve` does one database read per request or job (asserted), with no cross-request cache.
- [ ] `src/PATTERNS.md` has a "plan gates" pattern; the API refusal doc and the frontend route map describe the shapes.
- [ ] `pnpm ci:local`, `pnpm test:rls-role` and the SonarQube gate are green.

## Out of scope

- A separate shared entitlements service or package, cross-product bundles and pricing tables, and a generic admin UI for keys; these wait until a second product exists.
- Moving usage counters to a shared store.
- Any entitlements cache (BL2 stays).
- Rate limits as plan features.
- Price or plan changes, and new paid tiers.
- meepzo-fe changes (handed over through the frontend route map only).
