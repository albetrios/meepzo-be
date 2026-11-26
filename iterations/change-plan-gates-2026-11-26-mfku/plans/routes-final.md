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
| 1 | Entitlement module | `domains/billing/sub-domains/entitlement/` | `billing/entitlements`, `billing/entitlement-overrides` | 4 (1 changed) | subscription, plan | **final (rev 1, confirmed 2026-11-26)** |
| 2 | Plan data (Free) | `domains/billing/sub-domains/plan/` | none | 0 | 1 | **final (rev 1, confirmed 2026-11-26)** |
| 3 | Route plan-gate declaration and the one guard | `src/fastify.d.ts`, `src/routes.ts`, entitlement module, every `*.routes.ts` | every write | 128 declared | 1 | **rev 1 — awaiting your OK** |
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

## 1. Entitlement module — final (rev 1, confirmed 2026-11-26) — no nested sub-domains

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
| EN3 | **`can` and `limit` are pure reads of a snapshot** (P24), not new database reads: `can({ snapshot, key })` → boolean, `limit({ snapshot, key })` → number or unlimited. A caller that checks several gates resolves once and passes the snapshot (K2). Other option: a request-scoped memo (async context) so callers pass only the organization; it's hidden state, and workers would need their own scope. |
| EN4 | **No `consume` in billing** (P23). Counted limits stay with their counters (K4): the send claim's month guard, the account lock and the seat lock keep their locking code unchanged (P8) and read their ceiling with `limit()`. Billing exposes no counter. Other option: billing defines a `consume` port that app and tenancy register late (the seat sync already uses that shape). It's one more indirection for the same locks. |
| EN5 | **One refusal builder**, `buildPlanRefusal({ reason, … })` in this folder, the only producer of plan refusals. Reasons and statuses stay as built: `organization_read_only` 403 (`grace_ends_at`, `upgrade_required`), `plan_lacks_feature` 403 (`feature`, `upgrade_required`), `plan_account_limit` 409, `seat_limit_reached` 409, `message_month_limit_reached` 409 (`limit`, `used`, and for the month `resets_on`, P6). No plan id (P7). The fields stay within the shared error field list (oxak P269). |
| EN6 | **The entitlements read adds `sources`** (route 1): a map from key to `override` · `plan` · `default`, beside today's `features`, `limits` and `overrides`. Additive: nothing existing moves. |
| EN7 | **Only this module reads plan access.** `getPlanAccess` stays in subscription (it owns the SQL), but outside subscription only this service calls it. The 11 callers in app, auth and billing move to `resolve` / `can` / `limit` / `buildPlanRefusal`; the Stripe webhook passes its transaction's repository through `resolve`. A policy test fails on any other caller (K3). |

### 1.2 Open questions

None. Q-EN1 was answered by P23 (no `consume`; counter owners read `limit()`), and Q-EN2 by P24 (pass the snapshot).

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

## 2. Plan data (Free) — final (rev 1, confirmed 2026-11-26) — no nested sub-domains

Code: the existing **`plan` sub-domain folder**, `billing/sub-domains/plan/`: the plan catalog (its seed
constants) and the billing migrations that write the catalog rows.

2.1 Decisions · 2.2 Open questions · 2.3 Tables and relations · 2.4 Permissions · 2.5 Common to every route ·
2.6 Objects returned · 2.7 Routes · 2.8 Request details · 2.9 Errors · 2.10 Rules worth knowing ·
2.11 Code changes · 2.12 Nested sub-domains.

A data change only: Free turns its `broadcasts` and `segments` switches on (P13), which closes oxak pending #12
in favour of "on Free". No route and no code path changes; the gates of part 1 read the new values.

### 2.1 Decisions

| # | Decision |
| --- | --- |
| PL1 | **Free's `broadcasts` and `segments` switches turn on.** Today Free has every PRO switch off (`FREE_PLAN_FEATURES`, P83); the catalog rows were written once by migration `20261124060244_billing_flowdm_plans.sql`, and the seed inserts with `ON CONFLICT DO NOTHING`, so a seed change alone never reaches an existing database. After: **a new billing data migration** sets the two switches on in the stored rows, and the seed's Free constant says the same, so a fresh database and an existing one agree. "PRO" keeps meaning what it means elsewhere (the automation PRO parts, go-live); only Free's two values change. Free's month limit (1,000), accounts (1) and every other switch stay. |
| PL2 | **The switched-off rows follow Free** (P27). Today Starter, Growth and Pro (inactive, never offered, never deleted, P80) carry Free's features through the same constant. After: they keep carrying Free's features, so the migration updates all four rows. Other option: only the Free row changes, and the three off rows get their own constant with today's values. |
| PL3 | **No event and no follow-up job.** Today a plan change emits the plan-state event so app can stop or resume lanes. After: turning two switches **on** can't stop anything, and nothing was held for them (Free couldn't create a broadcast or a segment before), so the migration emits nothing; the next plan read (no cache, BL2) sees the new values. |
| PL4 | **The refusal path keeps a test.** Today the two "on Free" integration tests prove `403 plan_lacks_feature` by moving an organization to Free. After: they prove Free is **allowed**, and the refusal is proven on an organization whose switch is off through an **override row** (`broadcasts` = off, `segments` = off), which also exercises P19's override → plan order. |
| PL5 | **The frozen record isn't edited.** Oxak's AC-9.1 and P76 / BC3 answers stay as written in the frozen iteration. This iteration's decisions (P13) and its `AS-BUILT.md` › Standing deviations say Free now has both switches. |

### 2.2 Open questions

None. Q-PL1 (P22) was answered by P27: the off rows follow Free.

### 2.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `billing.plans` | the catalog: each plan's switches, limits and included seats | data change only (PL1, PL2); no column change; billing rows are never deleted (P80) |

```text
billing.plans ──< billing.subscriptions ──> tenancy.organizations
   └── Free: the fallback for an organization without a paid plan (resolve, part 1)
```

### 2.4 Permissions

None: no route.

### 2.5 Common to every route

n/a: no route.

### 2.6 Objects returned

None change shape. `GET /billing/plans` and `GET /billing/entitlements` report the new Free values.

### 2.7 Routes

None.

### 2.8 Request details

n/a.

### 2.9 Errors

A Free organization no longer gets `403 plan_lacks_feature` (`broadcasts` / `segments`) on the broadcast and
segment writes (route-changes RC-8 to RC-12). Every other error is unchanged.

### 2.10 Rules worth knowing

- Members are unlimited on every plan today: `included_seats` is empty everywhere (D55). This part doesn't change it (see P26).
- A fresh database (seed) and an existing one (migration) must hold the same catalog values; a unit test pins the seed constant to what the migration writes.

### 2.11 Code changes

| # | Change |
| --- | --- |
| PLC1 | PL1, PL2: a new billing data migration turning `broadcasts` and `segments` on for Free (and the three off rows, per Q-PL1), forward-only and idempotent |
| PLC2 | PL1: the seed's Free constant; its TSDoc (BL12 / P83 wording) |
| PLC3 | PL4: the two "on Free" integration tests flip to "allowed on Free"; the refusal cases move to an organization with an override turning the switch off |
| PLC4 | PL5: this iteration's `AS-BUILT.md` › Standing deviations notes Free's new values against oxak AC-9.1 / P76 / BC3 |

### 2.12 Nested sub-domains

None.

---

## 3. Route plan-gate declaration and the one guard — rev 1 (2026-11-26) — cross-cutting; awaiting your OK

Code: no single folder. The declaration type sits beside the other route-config fields (`src/fastify.d.ts`),
the guard is built by the entitlement module (part 1) and registered once in `src/routes.ts`, and each
`*.routes.ts` declares its writes' gates.

3.1 Decisions · 3.2 Open questions · 3.3 Tables and relations · 3.4 Permissions · 3.5 Common to every route ·
3.6 Objects returned · 3.7 Routes · 3.8 Request details · 3.9 Errors · 3.10 Rules worth knowing ·
3.11 Code changes · 3.12 Nested sub-domains.

Every write route says, where it's registered, which plan gate it meets or why it meets none. One guard
reads the declarations, and the coverage test reads the live routes instead of the hand-kept model.

### 3.1 Decisions

| # | Decision |
| --- | --- |
| RG1 | **The declaration is a typed field of the route config**, `planGate`, beside `idempotencyRequired`. Today the gates are written only in a test helper (`src/tests/helpers/route-plan-gate-model.ts`, 128 entries). After: `planGate` is either `{ gates: [...] }` or `{ open: '<one line>' }`, the shape the model already uses (reused). A gate is `read_only`, `feature:<switch key>` or `limit:<limit key>`, typed from the registry (part 1), so an unknown key fails to compile. The model's names map one to one: `read_only_guard` → `read_only`, `account_limit` → `limit:channel_accounts_max`, `seat_limit` → `limit:seats`, `month_limit` → `limit:message_month_limit`. |
| RG2 | **Shared open reasons move with it.** The model's reason constants (identity, user, paying, team, removing, draft, Meta callback, contact, account) move into the entitlement module beside the registry, so a route file and the coverage test cite the same words. |
| RG3 | **One guard, attached by one route hook.** Today `createAppPlanAccessPreHandler` (app) is built in `app.routes.ts` and hand-placed first on 2 routes. After: the entitlement module builds the guard, and `src/routes.ts` registers one route hook after the domain containers and before the domain route plugins. For every route declaring `read_only`, the hook puts the guard **first** in the route's pre-handlers, so the order stays authenticate → plan guard → role permission → idempotency claim (the idempotency plugin still appends its claim last) (P4). The app's hand-made guard and its wiring are removed. |
| RG4 | **The guard enforces `read_only` only** *(pending your answer, 3.2 Q-RG1)*. `feature:` and `limit:` declarations are recorded and checked by the coverage test, but enforced where they're used: services call `can()` / `limit()` (parts 4, 5), and counters keep their locks (P23). Those checks need the request body (which PRO parts a save turns on) or a transaction, and moving them ahead of the permission check or validation would change which error a caller sees (K1). Other option: the guard also enforces the unconditional switch gates (create broadcast, the 3 segment writes, past comments) before the permission check. |
| RG5 | **The guard hands its snapshot on** (P24). On a route the guard runs on, it resolves once and attaches the snapshot to the request; the controller passes it to the service, so go-live and broadcast send do one plan read (today the guard, the switch check and the month-limit read each read plan access). Routes without the guard resolve once in their service. |
| RG6 | **The coverage test reads the live routes.** Today it parses `docs/routes.txt` against the hand-kept model, and only the read-only check registers real routes. After: it builds the app with the existing test app builder, collects every route's `planGate` through a route hook, and fails on a write with no declaration, an empty or multi-line open reason, or a gate key not in the registry; the `read_only` set equals the routes the guard attached to. The route half of the hand-kept model is deleted (its job half moves in part 6). |
| RG7 | **The order test comes first** (R2, P4). Before anything moves, a test pins the pre-handler order on go-live and broadcast send: plan guard → role permission → idempotency claim. It passes on today's code and must still pass after RG3. |

### 3.2 Open questions

| # | Question | Recommendation | Other option |
| --- | --- | --- | --- |
| Q-RG1 | Does the one guard enforce more than `read_only`? (RG4) | **`read_only` only**; feature and limit gates are declared, and enforced where used | the guard also enforces the unconditional switch gates before the permission check, which changes which 403 a caller without permission sees |

### 3.3 Tables and relations

None: no table.

### 3.4 Permissions

None change. The guard sits before each route's own permission check, as today (P4).

### 3.5 Common to every route

| Item | Value |
| --- | --- |
| Declaration | every non-`GET` route carries `config.planGate` |
| Guard position | authenticate → plan guard (`read_only` routes only) → role permission → idempotency claim |
| Refusal | built by the entitlement module (part 1, EN5); statuses unchanged |

### 3.6 Objects returned

None change. The read-only refusal keeps `organization_read_only` 403 with `grace_ends_at` and `upgrade_required`.

### 3.7 Routes

The 16 plan-gated writes and their declarations (parts 4 and 5 hold their details):

| # | Method | Path | Plan gate |
| --- | --- | --- | --- |
| 1 | PATCH | `/app/automations/{automation_id}` | `feature:` the 5 automation PRO switches (`email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`) |
| 2 | POST | `/app/automations/{automation_id}/backfills` | `feature:past_comments` |
| 3 | POST | `/app/automations/{automation_id}/failed-messages/retry` | `limit:message_month_limit` |
| 4 | POST | `/app/automations/{automation_id}/go-live` | `read_only`, the 5 PRO switches, `feature:starter_questions`, `limit:message_month_limit` |
| 5 | POST | `/app/broadcasts` | `feature:broadcasts` |
| 6 | POST | `/app/broadcasts/{broadcast_id}/send` | `read_only`, `feature:broadcasts`, `limit:message_month_limit` |
| 7 | POST | `/app/segments` | `feature:segments` |
| 8 | PATCH | `/app/segments/{segment_id}` | `feature:segments` |
| 9 | POST | `/app/segments/audience-count` | `feature:segments` |
| 10 | POST | `/app/contacts/{contact_id}/failed-messages/retry` | `limit:message_month_limit` |
| 11 | POST | `/app/social/channel-accounts/{channel_account_id}/activate` | `limit:channel_accounts_max` |
| 12 | POST | `/app/social/channel-connections/{channel_connection_id}/accounts` | `limit:channel_accounts_max` |
| 13 | PATCH | `/app/social/instagram/accounts/{channel_account_id}/settings` | `feature:extra_delay`, `feature:mark_seen` |
| 14 | POST | `/tenancy/organization/memberships` | `limit:seats` |
| 15 | PATCH | `/tenancy/organization/memberships/{membership_id}` | `limit:seats` |
| 16 | POST | `/tenancy/organization/memberships/{membership_id}/restore` | `limit:seats` |

The other **112 writes declare `open`**, with the model's reasons carried over unchanged: identity 27,
removing 15, user 14, team 14, paying 7, account 4, draft 3, Meta callback 3, contact 3, and 22 with their own
one-line reason. Total **128**.

### 3.8 Request details

None change.

### 3.9 Errors

Unchanged: `403 organization_read_only` on routes 4 and 6 when the organization is read-only (only with
`LAPSED_PLAN_READ_ONLY_ENABLED` on, P5), now built by the entitlement module's refusal builder.

### 3.10 Rules worth knowing

- A new write route can't merge without a `planGate`: the coverage test fails.
- A refused write holds no idempotency key: the guard runs before the claim (as today).
- `open` is a decision, not a gap: its one-line reason says why no plan gate applies.

### 3.11 Code changes

| # | Change |
| --- | --- |
| RGC1 | RG7: the pre-handler order test for go-live and broadcast send, **written first** |
| RGC2 | RG1: `planGate` on the route-config type, typed from the registry |
| RGC3 | RG2: the shared open reasons move into the entitlement module |
| RGC4 | RG1: `planGate` on all 128 write routes across every `*.routes.ts` (one commit per domain), carried over from the model |
| RGC5 | RG3, RG5: the guard factory in the entitlement module; one route hook in `src/routes.ts`; the snapshot on the request; the app's hand-made guard (`app-plan-access.ts`) and its wiring in `app.routes.ts`, `automation.routes.ts` and `broadcast.routes.ts` removed |
| RGC6 | RG6: the coverage test reads live declarations; the route half of `route-plan-gate-model.ts` deleted |
| RGC7 | Docs: `src/PATTERNS.md` "plan gates" pattern; `src/FLOWS.md:336` corrected (P9); TSDoc on the guard and the type |

### 3.12 Nested sub-domains

None.

---

## 4. App gate users — draft

## 5. Seats — draft

## 6. Paid-job declarations — draft
