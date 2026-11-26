# Route changes — change-plan-gates-2026-11-26-mfku

Mode **initial** (Baseline `none`, Intake mode `brief`) · Intake hash `26273bac1cb0` · updated 2026-11-26 (Steps 1–3).

**No route is added or removed, and no path, method, status or permission changes.** What changes:
the entitlements read gains the source of each value, the override routes take their keys from the one
registry, and the 16 plan-gated writes answer a refusal in the one body shape. All 128 write routes gain
an internal plan-gate declaration, which isn't visible on the wire. Paths are proposals; the built truth
is `docs/routes.txt`.

| Area | NEW | CHANGED (on the wire) | REMOVED | Write routes declared |
| --- | --- | --- | --- | --- |
| Billing: entitlements | 0 | 3 | 0 | 2 |
| App: automations | 0 | 4 | 0 | 9 |
| App: broadcasts and segments | 0 | 5 | 0 | 9 |
| App: contacts | 0 | 1 | 0 | 4 |
| App: social accounts | 0 | 3 | 0 | 13 |
| Tenancy: memberships | 0 | 3 | 0 | 6 |
| Every other write (auth, user, notify, upload, mcp, ops, rest of billing and tenancy) | 0 | 0 | 0 | 85 |
| **Total** | **0** | **19** | **0** | **128** |

## Billing: entitlements

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-1 | CHANGED: output gains each value's source; key spelling *pending Q4* | GET | `/api/v1/billing/entitlements` | subscription · read | readEntitlements | BRIEF:L39, BRIEF:L121 |
| RC-2 | CHANGED: output key spelling *pending Q4* | GET | `/api/v1/billing/entitlement-overrides` | super_admin | listEntitlementOverrides | BRIEF:L109 |
| RC-3 | CHANGED: input key checked against the one registry; seat key *pending Q5*; spelling *pending Q4* | POST | `/api/v1/billing/entitlement-overrides` | super_admin | setEntitlementOverride | BRIEF:L90, BRIEF:L120 |

`DELETE /api/v1/billing/entitlement-overrides/{entitlement_override_id}` is unchanged (by id).

## App: automations

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-4 | CHANGED: refusal body (PRO switches) | PATCH | `/api/v1/app/automations/{automation_id}` | as today | updateAutomation | BRIEF:L33 |
| RC-5 | CHANGED: refusal body (past comments) | POST | `/api/v1/app/automations/{automation_id}/backfills` | as today | startPastComments | BRIEF:L33 |
| RC-6 | CHANGED: refusal body (month limit) | POST | `/api/v1/app/automations/{automation_id}/failed-messages/retry` | as today | retryAutomationFailed | BRIEF:L33 |
| RC-7 | CHANGED: refusal body (read-only, PRO switches, starter questions, month limit); guard position *pending Q6* | POST | `/api/v1/app/automations/{automation_id}/go-live` | as today | goLive | BRIEF:L29, BRIEF:L33 |

## App: broadcasts and segments

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-8 | CHANGED: refusal body (broadcasts) | POST | `/api/v1/app/broadcasts` | as today | createBroadcast | BRIEF:L33 |
| RC-9 | CHANGED: refusal body (read-only, broadcasts, month limit); guard position *pending Q6* | POST | `/api/v1/app/broadcasts/{broadcast_id}/send` | as today | sendBroadcast | BRIEF:L29, BRIEF:L33 |
| RC-10 | CHANGED: refusal body (segments) | POST | `/api/v1/app/segments` | as today | createSegment | BRIEF:L33 |
| RC-11 | CHANGED: refusal body (segments) | PATCH | `/api/v1/app/segments/{segment_id}` | as today | updateSegment | BRIEF:L33 |
| RC-12 | CHANGED: refusal body (segments) | POST | `/api/v1/app/segments/audience-count` | as today | countSegmentAudience | BRIEF:L33 |

## App: contacts

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-13 | CHANGED: refusal body (month limit) | POST | `/api/v1/app/contacts/{contact_id}/failed-messages/retry` | as today | retryContactFailed | BRIEF:L33 |

## App: social accounts

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-14 | CHANGED: refusal body (accounts cap) | POST | `/api/v1/app/social/channel-accounts/{channel_account_id}/activate` | as today | activateChannelAccount | BRIEF:L33 |
| RC-15 | CHANGED: refusal body (accounts cap) | POST | `/api/v1/app/social/channel-connections/{channel_connection_id}/accounts` | as today | pickConnectionAccounts | BRIEF:L33 |
| RC-16 | CHANGED: refusal body (extra delay, mark seen) | PATCH | `/api/v1/app/social/instagram/accounts/{channel_account_id}/settings` | as today | updateInstagramSettings | BRIEF:L33 |

## Tenancy: memberships

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-17 | CHANGED: refusal body (seats); seat override *pending Q5* | POST | `/api/v1/tenancy/organization/memberships` | as today | addMembership | BRIEF:L33, BRIEF:L120 |
| RC-18 | CHANGED: refusal body (seats); seat override *pending Q5* | PATCH | `/api/v1/tenancy/organization/memberships/{membership_id}` | as today | updateMembership | BRIEF:L33 |
| RC-19 | CHANGED: refusal body (seats); seat override *pending Q5* | POST | `/api/v1/tenancy/organization/memberships/{membership_id}/restore` | as today | restoreMembership | BRIEF:L33 |

## Every write route: the declaration

| # | Change | Routes | Wire change | Source |
| --- | --- | --- | --- | --- |
| RC-20 | CHANGED (internal): each of the 128 write routes declares its plan gate (read-only, a feature, a limit, or open with a one-line reason), and the coverage test reads the declarations instead of a hand-kept list | all 128 writes in `docs/routes.txt` | none | BRIEF:L28, BRIEF:L36 |

## Before → after

| # | Route | What changes | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| RC-1 | `GET /api/v1/billing/entitlements` | output | each feature and limit as one merged value; overrides listed apart | each value also says where it came from: the plan, an override, or the default | BRIEF:L39 |
| RC-2 | `GET /api/v1/billing/entitlement-overrides` | output | bare keys (`email_ask`) | *pending Q4*: namespaced keys, or unchanged | BRIEF:L109 |
| RC-3 | `POST /api/v1/billing/entitlement-overrides` | input | 13 keys from two hand lists | the keys of the one registry; a seat key *pending Q5*; spelling *pending Q4* | BRIEF:L90, L120 |
| RC-4–RC-19 | the 16 plan-gated writes | refusal body | each gate builds its own body (`organization_read_only` with grace end and upgrade flag; `plan_lacks_feature` with the feature; `plan_account_limit`, `seat_limit_reached`, `message_month_limit_reached` with their own fields) | one shape from the module: reason, the feature or limit key, limit, used, reset or grace end, upgrade hint (*Q9*); every status unchanged | BRIEF:L33 |
| RC-7, RC-9 | go-live, broadcast send | guard position | the read-only check runs before the permission check | *pending Q6*: kept, or after the permission check | BRIEF:L81, R9 |
| RC-20 | every write | declaration | 16 routes listed by hand in a test helper; 2 carry the guard by hand | every route declares its gate where it's registered; one guard reads the declaration | BRIEF:L28-L30 |
