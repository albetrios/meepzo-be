`src/domains/billing/sub-domains/entitlement/`

# Entitlement

Parent: [billing](../../billing.overview.md)

## Purpose

The one place that answers plan questions (change-plan-gates part 1, EN1–EN6): a typed key registry, a resolved snapshot per organization, switch and limit reads of it, and the one plan refusal builder — plus the per-organization overrides below. Other domains move onto it in later rows of that iteration (EN7); until then their existing plan reads keep working unchanged.

- **The key registry** (`ENTITLEMENT_REGISTRY` in `entitlement.constants.ts`, EN1): every gated key, bare (P17), each with its `kind` (`switch` · `cap` · `metered`), `product` (`instagram` · `core`), registry `default` and `overridable`. The 11 switches are built from the plan's `PLAN_FEATURE_KEYS` (off by default, overridable); `message_month_limit` (metered) and `channel_accounts_max` (cap) have **no default** (P36) and are overridable; `seats` is a `core` cap, unlimited by default and **not** overridable (P18). `ENTITLEMENT_OVERRIDE_KEYS` and `ENTITLEMENT_OVERRIDE_LIMIT_KEYS` are derived from the `overridable` entries — the same 13 keys in the same order, pinned by a unit test, so the override table's check needs no migration.
- **The registry default** (`parsePlanFeaturesWithDefaults` in `entitlement-registry.util.ts`, P19): a feature switch a plan row lacks reads off before the strict parse, in both plan reads; anything else missing still throws (BL12, P36).
- **`resolve`** (`EntitlementService.resolve({ organizationPublicId })`, EN2): exactly one plan read (`SubscriptionService.getPlanAccess`, no cache, no memo — BL2) built into a snapshot by the pure `buildEntitlementSnapshot` (`entitlement-snapshot.util.ts`): `state`, `graceEndsAt`, `trialEndsAt`, `plan` and every registry key's `{ value, source }` — `override` (an active override set it) → `plan` (the row carried it) → `default` (the registry default filled it). Seats come from the same read's included seats. With no plan in the catalog every key reads its registry default (limits `null`).
- **`can` / `limit`** (EN3): pure reads of a snapshot — a switch on or off, a ceiling or `null` (unlimited). A caller with several gates resolves once and passes the snapshot on (P24, K2); counters keep their own locks and read only the ceiling (P23).
- **`buildPlanRefusal`** (`entitlement-refusal.util.ts`, EN5): one error per reason, bodies as built — `organization_read_only` 403, `plan_lacks_feature` 403, `plan_account_limit` 409, `seat_limit_reached` 409, `message_month_limit_reached` 409 (now with `limit`, `used`, `resets_on`, P6); never a plan id (P7).
- **Plan-gate declarations and the one guard** (`entitlement-plan-guard.util.ts`, change-plan-gates RG1–RG5, P29): `PlanGate` / `PlanGateDeclaration` (`entitlement.types.ts`) type `config.planGate` on every write route; `PLAN_GATE_OPEN_REASON` (`entitlement.constants.ts`) holds the shared one-line open reasons. `createPlanReadOnlyGuard` resolves once and refuses `read_only` with `buildPlanRefusal`, else leaves the snapshot on `request.entitlementSnapshot` (P24); `createPlanGuardRouteHook` — registered once in `src/routes.ts` — puts it first on every route declaring `read_only` (go-live and broadcast send), before the permission check and the idempotency claim (P4). `feature:` / `limit:` gates are enforced where used, not by the guard.
- **`GET /billing/entitlements`** serializes the snapshot `resolve` returns and adds `sources` (EN6): every registry key → `override` · `plan` · `default`, beside the unchanged fields.

## Overrides

Per-organization exceptions to the plan (plan-gating close, P270): a global admin turns a plan feature switch on or off, or raises or lowers a plan limit (`message_month_limit`, `channel_accounts_max`) for one organization, optionally until a date, with a reason. The plan entitlement (`resolvePlanAccess` in `subscription/`) lays the overrides in force over the plan's typed features, so every gate, `/auth/me/context` and the app's plan reads see them at once.

## Key invariants

- **One plan read per resolve (BL2):** `resolve` calls `getPlanAccess` once; a unit test pins it. The snapshot keeps the `PlanAccess` it was built from.
- **One read (BL2):** the overrides are read in the plan entitlement's one query (`SubscriptionRepository.findPlanAccessSubject`, a `jsonb_agg` sub-select) — never a second read path. Expired ones are read too and dropped at the entitlement's clock (`applyEntitlementOverrides`).
- **Strictly typed (BL12):** `key` ∈ `ENTITLEMENT_OVERRIDE_KEYS` (the registry's overridable keys: the plan feature keys + the two limits; `chk_organization_entitlement_overrides_key` pins the same list); a feature's `value` is a boolean, a limit's an integer within the plan schema's own bounds. The merged features are parsed again by `planFeaturesSchema`; a stored row the merge cannot type throws.
- **Override, not state:** an override changes features only — never `state`, its dates or `is_plan_choice_required` — and lays over whichever plan applies (Free included, e.g. after a paid plan lapsed).
- **One live row per organization and key** (partial unique index); a set replaces it in place; a remove soft-deletes it.
- **Global admin only:** `GET` / `POST /api/v1/billing/entitlement-overrides`, `DELETE …/{entitlement_override_id}` behind `requireRole(SUPER_ADMIN)`; the target organization travels as `organization_id` (query or body) — never as the active organization. Writes run under `PRINCIPAL_SCOPE.VERIFIED` for the target organization; the remove finds it through the `SECURITY DEFINER` resolver `billing.resolve_organization_public_id_for_entitlement_override`.
- **Audited:** `billing.entitlement_override.set` / `.remove` (WARNING) in the target organization's log, with the key, the value before and after, the end and the reason.
- **Announced:** when a set or remove moves the features, `subscription.plan_state_changed` is emitted (`upgraded` or `moved_down`, BL8) so the app stops or frees accounts and steps as for a plan change.

## Failure modes

- Unknown organization → `404`; unknown or removed override → `404 entitlement_override_not_found`.
- A value of the wrong type or out of bounds, an unknown key, a past `expires_at` → `400`.
- Two sets of a new key racing → `409 entitlement_override_conflict`.
- A non-admin caller → `403`.
