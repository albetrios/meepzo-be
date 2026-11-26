# meepzo API — plan gates, final design part by part

Started from `feat/instagram-automation` at `165297b` (2026-11-26). The shape is
[`routes-final-template.md`](../../../docs/design-workflow/process/routes-final-template.md). This iteration
adds no route and no table, so most parts are about **who answers a plan question and where it's declared**.
Parts 3 and 6 are cross-cutting: they touch every write route and every paid job rather than one
sub-domain folder, and they keep the twelve sections anyway.

### File header — legend

Paths are under `/api/v1`; `{x_id}` is a public id. **Gate** is the permission or role the caller needs.
**Plan gate** is the declaration this iteration adds (`read_only`, `feature:<key>`, `limit:<key>`, or
`open:<reason>`). **Idem** `req` means the `X-Idempotency-Key` header is required. Decisions `P<n>` are in
[`decisions.md`](decisions.md); findings `R<n>` are in [`coverage.md`](coverage.md).

### File header — parts (in build order)

Each part builds on the ones above it.

| # | Part | Folder (`src/…`) | Paths | Routes | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Entitlement module | `domains/billing/sub-domains/entitlement/` | `billing/entitlements`, `billing/entitlement-overrides` | 4 (1 changed) | subscription, plan | **rev 1 — awaiting your OK** |
| 2 | Plan data (Free) | `domains/billing/sub-domains/plan/` | none | 0 | 1 | draft |
| 3 | Route plan-gate declaration and the one guard | shared middleware + every `*.routes.ts` | every write | 128 declared | 1 | draft |
| 4 | App gate users | `domains/app/sub-domains/{automation, broadcast, broadcast-segment, channel-account, channel-connection, instagram-account-settings, instagram-sending}/` | 13 gated app writes | 13 | 1, 3 | draft |
| 5 | Seats | `domains/tenancy/sub-domains/membership/` | 3 membership writes | 3 | 1, 3 | draft |
| 6 | Paid-job declarations | queue worker registry + the 12 paid jobs | none | 0 | 1, 4 | draft |

Total: **0 routes added or removed.** 1 route changes its output (the entitlements read gains a source per
value); 16 plan-gated writes answer one refusal shape; all 128 writes declare a plan gate.

### File header — code layout and tables without routes

No new table. The two data changes are the Free plan row (part 2) and the override table's allowed key list,
which is derived from the registry and holds the same 13 keys (part 1).

| Part | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `billing.organization_entitlement_overrides` | `entitlement/` (exists) | the entitlement service (super-admin routes) |
| 2 | `billing.plans` (Free row) | `plan/` (exists) | a billing migration plus the plan seed |

### File header — rules for every part

| # | Rule |
| --- | --- |
| K1 | **Behaviour identical** except where a decision says otherwise: P5 (read-only flag default `false`), P13 (Free gets segments and broadcasts), P6 (the month refusal gains numbers). Every status, path, permission and hook position stays. |
| K2 | **One plan read per request or job** (BL2, no cache). A caller resolves once and passes the snapshot to every gate inside the same unit of work. |
| K3 | **Only the entitlement module reads plan access.** Every other domain asks it: a snapshot, a switch, a limit, or a refusal. A policy test enforces this (part 1, ENC7). |
| K4 | **Counted limits stay with their counters.** The month counter (app), the account lock (app) and the seat lock (tenancy) keep their locking logic unchanged (P8); they read the ceiling through the module and refuse through its builder. |
| K5 | **Keys stay bare** (P17). Each registry entry records its product (`instagram` or `core`). |

### File header — connections

```text
1) WHO ASKS WHOM                                  A ──► B = A calls B's service

   app (automation, broadcast, segment, channel account/connection,
        Instagram settings, Instagram sending, run engine) ──► 1 ENTITLEMENT
   tenancy (membership seats) ─────────────────────────────► 1 ENTITLEMENT
   auth (me context) ──────────────────────────────────────► 1 ENTITLEMENT
   3 ROUTE GUARD (every write) ────────────────────────────► 1 ENTITLEMENT
   1 ENTITLEMENT ──► subscription (plan access, the one SQL read) ──► plan, overrides

2) WHAT ONE ACTION SETS OFF

   a write route ──► 3 guard reads its declaration ──► 1 resolve once ──► can / limit ──► refusal or pass
   a send claim ──► app month counter (locks, P8) ──► 1 limit ──► 1 refusal on the cap
   an override set ──► 1 entitlement service ──► PLAN_STATE_CHANGED (as today) ──► app plan-change job [worker]
```

---

## 1. Entitlement module — rev 1 (2026-11-26) — no nested sub-domains; awaiting your OK

Code: the existing **`entitlement` sub-domain folder**, `billing/sub-domains/entitlement/`. Built in the oxak
iteration's lane B: the override table, the super-admin override routes and the entitlements read.

1.1 Decisions · 1.2 Open questions · 1.3 Tables and relations · 1.4 Permissions · 1.5 Common to every route ·
1.6 Objects returned · 1.7 Routes · 1.8 Request details · 1.9 Errors · 1.10 Rules worth knowing ·
1.11 Code changes · 1.12 Nested sub-domains.

The one place that answers plan questions: a typed key registry, a resolved snapshot per organization,
switch and limit reads, and the one refusal builder. Reads `BRIEF.md` items 1, 2, 5, 7, 8 and decisions
P1, P5–P8, P17–P21. Route numbers run 1–4.

### 1.1 Decisions

| # | Decision |
| --- | --- |
| EN1 | **The key registry is one typed list in this folder.** Today: two hand lists of override keys here (`ENTITLEMENT_OVERRIDE_KEYS`, `ENTITLEMENT_OVERRIDE_LIMIT_KEYS`), the plan's switch list in `plan/` (`PLAN_FEATURE_KEYS`), seats only in the subscription service. After: each entry has `key`, `kind` (`switch` · `cap` · `metered`), `product` (`instagram` · `core`), `default` (P19) and `overridable`. The **switch entries are built from the plan's existing `PLAN_FEATURE_KEYS`** (reused, not copied), the 2 limits and seats are added here, and the two override lists become **derived** from `overridable`. Keys stay bare (P17). Entries: 11 switches (`instagram`, default off, overridable), `message_month_limit` (metered, `instagram`, overridable), `channel_accounts_max` (cap, `instagram`, overridable), `seats` (cap, `core`, **not** overridable, P18). |
| EN2 | **`resolve` returns a snapshot with a source per key.** Today: `getPlanAccess` (subscription) does one SQL read and lays active overrides on the plan, with no record of where a value came from. After: `EntitlementService.resolve({ organizationPublicId })` calls it once and returns the snapshot: `state`, `graceEndsAt`, `trialEndsAt`, `plan`, and per key `{ value, source }`, where `source` is `override` · `plan` · `default` (P19: the registry default fills a key the plan row lacks). Seats read the plan's included seats into the same snapshot (no extra read: the plan row is already in the one statement). |
| EN3 | **`can` and `limit` are pure reads of a snapshot**, not new database reads: `can({ snapshot, key })` → boolean, `limit({ snapshot, key })` → number or unlimited. A caller that checks several gates resolves once and passes the snapshot (K2). Other option: a request-scoped memo (async context) so callers pass only the organization; it's hidden state, and workers would need their own scope. |
| EN4 | **No `consume` in billing** *(pending your answer, 1.2 Q-EN1)*. Counted limits stay with their counters (K4): the send claim's month guard, the account lock and the seat lock keep their locking code unchanged (P8) and read their ceiling with `limit()`. Billing exposes no counter. Other option: billing defines a `consume` port that app and tenancy register late (the seat sync already uses that shape). It's one more indirection for the same locks. |
| EN5 | **One refusal builder**, `buildPlanRefusal({ reason, … })` in this folder, the only producer of plan refusals. Reasons and statuses stay as built: `organization_read_only` 403 (`grace_ends_at`, `upgrade_required`), `plan_lacks_feature` 403 (`feature`, `upgrade_required`), `plan_account_limit` 409, `seat_limit_reached` 409, `message_month_limit_reached` 409 (`limit`, `used`, and for the month `resets_on`, P6). No plan id (P7). The fields stay within the shared error field list (oxak P269). |
| EN6 | **The entitlements read adds `sources`** (route 1): a map from key to `override` · `plan` · `default`, beside today's `features`, `limits` and `overrides`. Additive: nothing existing moves. |
| EN7 | **Only this module reads plan access.** `getPlanAccess` stays in subscription (it owns the SQL), but outside subscription only this service calls it. The 11 callers in app, auth and billing move to `resolve` / `can` / `limit` / `buildPlanRefusal`; the Stripe webhook passes its transaction's repository through `resolve`. A policy test fails on any other caller (K3). |

### 1.2 Open questions

| # | Question | Recommendation | Other option |
| --- | --- | --- | --- |
| Q-EN1 | Does billing own a `consume()` for counted limits? (EN4) | **No:** each counter's owner keeps its locks and reads `limit()` | a `consume` port in billing that app and tenancy register |
| Q-EN2 | How do callers avoid a second plan read? (EN3) | **Pass the snapshot** explicitly | a request-scoped memo |

### 1.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `billing.organization_entitlement_overrides` | one live value per organization and key, with expiry and reason | allowed keys = the registry's `overridable` entries, the same 13 bare keys, so **no migration**; unique live key per organization; RLS on (as built) |

```text
tenancy.organizations
   └──< billing.organization_entitlement_overrides     laid over the plan on every resolve
billing.subscriptions ──> billing.plans                 the plan's switches, limits, included seats
```

No other part points at this table.

### 1.4 Permissions

| Code / role | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `subscription:read` | the entitlements read | 1 | as today |
| `super_admin` role (MFA-verified session, no step-up, oxak P370) | list, set and remove overrides | 2, 3, 4 | platform super-admins |

### 1.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/billing` |
| Auth | `Authorization: Bearer`; the active organization comes from the token (route 1); routes 2–4 are platform super-admin |
| Writes | no idempotency key required on these routes (as today, `docs/routes.txt` column I) |
| Success | `200` with `{ data, meta }`; `DELETE` → `204` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }`, unchanged |

### 1.6 Objects returned

| Object | Change |
| --- | --- |
| Entitlements | adds `sources: { <key>: "override" \| "plan" \| "default" }` (EN6) |
| Entitlement override | unchanged |
| Plan refusal (error body) | one builder (EN5); for the month cap the body gains `limit`, `used`, `resets_on` (P6) |

### 1.7 Routes

| # | Method | Path | Purpose | Gate | Plan gate | Idem |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/billing/entitlements` | The organization's switches, limits, usage and now each value's source **(changed output)** | `subscription:read` | — (read) | |
| 2 | GET | `/billing/entitlement-overrides` | List overrides | `super_admin` | — (read) | |
| 3 | POST | `/billing/entitlement-overrides` | Set an override (keys from the registry, same 13) | `super_admin` | `open: platform staff, not a customer plan` | |
| 4 | DELETE | `/billing/entitlement-overrides/{entitlement_override_id}` | Remove an override | `super_admin` | `open: platform staff, not a customer plan` | |

### 1.8 Request details

Route 3's `key` accepts exactly the registry's overridable keys (the same 13 as today); `value` is a boolean
for a switch and a whole number (or unlimited) for a limit, as today. No other input changes.

### 1.9 Errors

Unchanged for routes 1–4. The refusal builder (EN5) is used by parts 3–5, and its statuses are listed there.

### 1.10 Rules worth knowing

- Every value reported is the one gates use: route 1 serializes the same snapshot `resolve` returns.
- An expired override is ignored at read time (as built); its source falls back to `plan` or `default`.
- Setting or removing an override still emits the plan-state change event after commit (as built).

### 1.11 Code changes

| # | Change |
| --- | --- |
| ENC1 | EN1: the registry (built from `PLAN_FEATURE_KEYS`, plus the 2 limits and seats); the two override key lists derived from it; the override table's allowed-key check keeps the same list (no migration) |
| ENC2 | EN2: `resolve` with per-key source and the registry default; seats in the snapshot |
| ENC3 | EN3: `can` and `limit` as pure snapshot reads |
| ENC4 | EN5: `buildPlanRefusal`, one per reason, statuses as built; the month refusal's `limit` / `used` / `resets_on` (P6); the API refusal doc (`docs/reference/api/response-codes.md`) |
| ENC5 | EN6: the entitlements serializer gains `sources`; OpenAPI response schema and its locale copy |
| ENC6 | EN7: callers in auth (me context) and billing (Stripe webhook, subscription's plan-state emit) move to `resolve` |
| ENC7 | EN7, K3: policy test "no `getPlanAccess` outside subscription and entitlement" |
| ENC8 | Tests: unit for merge order (override → plan → default), expiry, registry default, the derived override lists, and the refusal shapes; one-read assertion for `resolve`; route 1 integration for `sources`. TSDoc with `@remarks` on the service; `entitlement.overview.md` |

### 1.12 Nested sub-domains

None.

---

## 2. Plan data (Free) — draft

## 3. Route plan-gate declaration and the one guard — draft

## 4. App gate users — draft

## 5. Seats — draft

## 6. Paid-job declarations — draft
