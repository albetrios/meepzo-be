`src/domains/billing/sub-domains/entitlement/`

# Entitlement

Parent: [billing](../../billing.overview.md)

## Purpose

Per-organization exceptions to the plan (plan-gating close, P270): a global admin turns a plan feature switch on or off, or raises or lowers a plan limit (`message_month_limit`, `channel_accounts_max`) for one organization, optionally until a date, with a reason. The plan entitlement (`resolvePlanAccess` in `subscription/`) lays the overrides in force over the plan's typed features, so every gate, `/auth/me/context` and the app's plan reads see them at once.

## Key invariants

- **One read (BL2):** the overrides are read in the plan entitlement's one query (`SubscriptionRepository.findPlanAccessSubject`, a `jsonb_agg` sub-select) — never a second read path. Expired ones are read too and dropped at the entitlement's clock (`applyEntitlementOverrides`).
- **Strictly typed (BL12):** `key` ∈ `ENTITLEMENT_OVERRIDE_KEYS` (the plan feature keys + the two limits; `chk_organization_entitlement_overrides_key` pins the same list); a feature's `value` is a boolean, a limit's an integer within the plan schema's own bounds. The merged features are parsed again by `planFeaturesSchema`; a stored row the merge cannot type throws.
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
