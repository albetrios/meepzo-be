# Plan gates — entitlements module proposal

> Received 2026-11-26 as the source of `BRIEF.md`. Kept as written; tables were re-set as Markdown.
> It was written from session context only, without checking the code; `BRIEF.md` records where the code differs.

This is a proposal from this session's context only. I didn't check the code here, and line numbers may have shifted after lanes B and C. It's sized for a follow-up iteration, after the current work is merged and pushed.

## Goal

Each gate is declared once, and every route and job is enforced by one shared module. Gate keys are typed, refusals have one body shape, and a test reads the declarations directly, so no gate can be forgotten. Behaviour stays identical, and generous limits stay on for the product-first launch.

## Target design

```
             ┌───────────────── entitlements module (billing) ─────────────────┐
key registry │ ENTITLEMENT_KEYS: features (bool) + limits (number) + defaults   │
             │ resolve(org)  = plan defaults ← per-organization overrides       │
             │                 ← global defaults, one read (BL2)                 │
             │ can(org, featureKey)          → boolean                          │
             │ limit(org, limitKey)          → number | unlimited               │
             │ consume(org, limitKey, n, key)→ ok | refused  (atomic, idempotent)│
             │ refusal(...)                  → one error body shape             │
             └──────────────────────────────────────────────────────────────────┘
                     ▲                         ▲                        ▲
 routes: config.planGate ─► one preHandler   workers: job registry gate   services: can()/consume()
```

## Pieces

| # | Piece | What it does |
| --- | --- | --- |
| 1 | Key registry | One typed list such as email_step, segments, broadcasts, monthly_dms, instagram_accounts, seats, each with its type and global default. It replaces the scattered constants. |
| 2 | resolve(org) | Wraps today's getPlanAccess and merges lane B's overrides. It stays the single database read and is not cached (BL2). |
| 3 | can / limit | Thin reads on top of resolve. |
| 4 | consume | Atomic increment-and-check. Monthly DMs keep the current counter and lane C's hard cap; accounts keep their row lock. An idempotency key stops a retry counting twice. |
| 5 | Route declaration | Every write route carries config.planGate: read_only, feature:<key>, limit:<key>, or open:<reason>. |
| 6 | One preHandler | Reads config.planGate and calls the module. It replaces the hand-added createAppPlanAccessPreHandler. |
| 7 | Job gate | Each paid job's registry entry declares its gate the same way, and the worker calls can / consume at its claim. |
| 8 | One refusal shape | Built only by the module: reason, feature / limit, used, resets_at / grace_ends_at, upgrade hint. This extends lane B's refusal contract. |
| 9 | Coverage test | Reads config.planGate from the registered routes and the job registry, and fails on any undeclared write. It replaces the hand-kept route-plan-gate-model.ts. |
| 10 | Entitlements GET | Serializes resolve(org), adds usage, and shows where each value comes from (plan or override). |

## Phases, one commit each, with no behaviour change until phase 5

| Phase | Work | Tests | Size (estimate) |
| --- | --- | --- | --- |
| 0. Prerequisites | Merge and push the current work (lanes B and C, then the final full check). Freeze. | — | (current session) |
| 1. Module plus key registry | Create billing/sub-domains/entitlement/ (or extend subscription) with the registry, resolve (wrapping getPlanAccess plus overrides), can, limit, and the refusal builder. Nothing calls it yet. | Unit tests: merge order (override, then plan, then default), expiry, unknown key fails at compile time | M (~0.5 day) |
| 2. Route declarations plus one preHandler | Add config.planGate to every write route, using lane C's model file as the source for which gate each route has. Register one global preHandler. The two read-only routes move to it; other gates are declare-only for now (they enforce inside the service as today). | The new coverage test reads config.planGate; the read-only route tests still pass | M (~0.5–1 day, about 126 routes, mostly open:<reason>) |
| 3. Move feature gates over | Replace checkFeature and the automation feature checks with entitlements.can(), and refusals with entitlements.refusal(). | The existing integration tests unchanged, plus body-shape assertions | S–M |
| 4. Move limits over | Make accounts, seats and monthly DMs go through limit() / consume(), keeping the account row lock and lane C's month-cap logic inside consume. | The concurrency tests for the month cap and account race run unchanged | M (highest-risk phase) |
| 5. Jobs | Declare a gate in the job registry, and have workers call the module at the claim point. | Job coverage test, worker DB tests | S–M |
| 6. Clean-up | Delete the old direct getPlanAccess calls from features, route-plan-gate-model.ts, and the duplicated constants. Add a lint or policy test: "no getPlanAccess outside the entitlements module". | Policy test plus the full suites | S |
| 7. Docs and records | src/PATTERNS.md gets a "plan gates" pattern, plus the API refusal doc, the iteration's AS-BUILT and decisions, and the frontend map (entitlements GET shape). | Docs gates | S |

Total: about 3–4 working days of focused work (estimate), including full checks after phases 4 and 6.

## Order and parallel work

```
Phase 1 ─► Phase 2 ─► (3 ∥ 5) ─► Phase 4 ─► Phase 6 ─► Phase 7
```

Phases 3 and 5 can run as two workers on separate files. Phase 4 runs alone, because it touches the send gate and the account repository, which are the riskiest code.

## Risks and how to keep them small

| Risk | Mitigation |
| --- | --- |
| Changing the gate order (CA11/P61: channel → permission → plan → not offered) | The preHandler runs after the permission gate, and can() keeps "not offered" after the plan. AC-2.8 stays as the guard. |
| Month-cap concurrency regressing | consume('monthly_dms') wraps lane C's exact logic; its 5 DB tests and AC-22.4 run unchanged. |
| The read-only guard must run before the idempotency claim | Register the hook at the same position; the existing test checks the order. |
| Over 100 route edits make merges painful | Do phase 2 in one short-lived branch, by domain, with routes defaulting to open:<reason> from lane C's model. |
| BL2 "no plan cache" | resolve stays one uncached read. If needed later, add a seconds-long cache cleared on PLAN_STATE_CHANGED. |

## Decisions you'd need to make first

- Module location: a new billing sub-domain entitlement, or inside subscription. I recommend a new sub-domain: it's cleaner.
- Starting keys: keep them few. I recommend monthly_dms, instagram_accounts, seats, email_step, phone_step, segments, broadcasts, past_comments. A key is only added when you need to vary it.
- Refusal upgrade hint shape: a feature key only, or a suggested plan id. I recommend the feature key only while you're product-first.
- Product-first defaults: generous Free values, and LAPSED_PLAN_READ_ONLY_ENABLED=false at launch.
- When to run it: right after this session's push, as a change-plan-gates-<date> iteration through /be-iteration.

## Done when

- Every write route and paid job declares a gate, and the test fails on any undeclared one.
- No feature calls getPlanAccess or reads plan rows directly; a policy test enforces it.
- Every refusal comes out in the one body shape.
- Changing a limit for an organization is one override row, with no code change.
- ci:local, test:rls-role and Sonar are green.

## Read-cost techniques

| Technique | What it does | When |
| --- | --- | --- |
| One read per request or job | Read plan access once at the start of the request or job and reuse it for every gate inside it (request-scoped memo) | Always: costs nothing, removes repeat reads |
| Atomic consume for limits | Increment-and-check in one Postgres statement at the point of use; no separate read | Always, for counted limits |
| Short cache plus invalidation | Cache the resolved entitlements for a few seconds and clear them on the plan-change event (PLAN_STATE_CHANGED) | Only if load measurements show plan reads are a hotspot |
| Frontend reads a cached copy | The UI uses the entitlements GET to show locked or upsell states; the server still checks for real on the action | Always: the UI is a hint, the server decides |

## Across products

A common pattern pays off once you have more than one product. Make the pattern common now, but don't build a shared platform until a second product actually exists.

Why a common pattern pays off across products:

- One mental model: every product asks can / limit / consume with typed keys, so engineers, tests and the frontend all work the same way.
- One billing brain: a customer's plan, trial, grace, read-only and overrides are decided once, even if they use three products.
- Bundles become data: "Plan Pro = Instagram 5,000 DMs + Product B feature X" is a config change, not code in each product.
- Reused safety nets: the same refusal shape, coverage test, audit trail and override table for every product.
- The frontend renders any product's locked or upsell states from one entitlements GET.

How to set it up so it grows well:

| Do now (cheap) | Wait until product 2 exists |
| --- | --- |
| Namespace keys by product: instagram.monthly_dms, instagram.accounts, core.seats | A separate shared entitlements service or package |
| Keep the module in billing, with no Instagram logic inside it | Cross-product bundles and pricing tables |
| Give products their own keys, with the billing core owning resolution, overrides and refusals | A generic admin UI for every product's keys |
| Keep the same refusal shape and coverage test pattern | Moving usage counters to a shared store |

## Entitlement kinds

Almost every SaaS product gates with the same few kinds of entitlement, so one common module that supports these kinds covers any future product. Only the keys differ per product.

| Kind | What it is | How it's checked | Instagram example | Typical other-product example |
| --- | --- | --- | --- | --- |
| Feature switch | On or off per plan | can(org, key) → yes/no | email step, phone step, segments, broadcasts | API access, SSO, custom domain |
| Resource cap | How many of a thing may exist at once; it doesn't reset | Count what exists at create time, under a lock | Instagram accounts per organization | projects, seats, workspaces |
| Metered usage | How much may be used per period; resets on a cycle | consume(org, key, n): atomic increment-and-check, reset by period, idempotent per unit | DMs per month (organization's time zone) | emails/month, API calls/month, AI credits |
| Value setting | A number that shapes behaviour, not a counter | limit(org, key) read and applied | (none today) | data retention days, file size max, history depth |
| Rate limit | Speed protection per minute or hour | Redis or the queue; usually operational, not a plan rule | Meta hourly send pacing, webhook ingest | requests/minute |

What every product needs from the common module:

- A key registry with each key's kind, type and default, namespaced (instagram.monthly_dms, core.seats).
- One resolution that merges global default, plan value and per-organization override.
- The three calls: can, limit and consume (plus a cap check, which is limit + count under a lock).
- One refusal shape carrying reason, key, limit, used, resets_at and an upgrade hint.
- The same downgrade rule per kind:
  - a switch going off means existing items stay saved but stop running;
  - a cap going down means the owner picks what stays, or the oldest stay;
  - metered usage stops until the reset or an upgrade.
- The same coverage test and audit trail.

A new product then only adds its keys and calls the same three functions at its own action points. The plan, override, trial, grace and refusal machinery is shared. Rate limits are usually kept out of plans, as operational protection, unless you sell "higher throughput" as a plan feature.

## Why gates, not plan logic in features

Avoid plan logic mixed into the code:

```
if (organization.plan === 'pro' || organization.plan === 'team') { sendBroadcast() }   // ✗ plan names inside features
```

Every new plan, rename, override or bundle then means hunting through the code. Tests multiply, and the frontend drifts out of sync.

Use one gate call per action instead:

```
if (!(await entitlements.can(org, 'instagram.broadcasts'))) throw entitlements.refusal(...)   // ✓ the feature asks the gate
await entitlements.consume(org, 'instagram.monthly_dms', 1, messageKey)                        // ✓ counted atomically
```

Or, for routes, a declaration: `config: { planGate: 'feature:instagram.broadcasts' }`.

Why gates win:

- Plans become data. Which plan has what lives in one place: the plan rows plus overrides. No code changes when pricing changes.
- Features stay plan-agnostic. They only know a key, so the same code works for Free-generous now and paid tiers later, and for any future product.
- One refusal shape and one audit trail. The frontend shows the right upsell and support can see why something was refused.
- Nothing gets forgotten. The coverage test fails on any write route or job without a declared gate.
- Overrides just work. "This organization gets unlimited" is a row, not a branch in the code.

Your repo is already mostly like this. Features call the central plan-access read, not plan names, and lane C's gate model lists every write route. The entitlements-module plan finishes the job with one API, route declarations and a policy test banning direct plan checks. It's next iteration's work.
