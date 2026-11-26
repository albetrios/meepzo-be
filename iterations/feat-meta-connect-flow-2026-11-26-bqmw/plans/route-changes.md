# Route changes — feat-meta-connect-flow-2026-11-26-bqmw

| Field | Value |
| --- | --- |
| Iteration | `feat-meta-connect-flow-2026-11-26-bqmw` |
| Mode | initial (Baseline none) |
| Intake mode | brief — from scratch |
| Intake hash | `f1ff32a8eb81` |
| Date | 2026-11-26 |
| Stage | Step 5 — sub-domains 1, 2 final (C-D11, C-D12); sub-domain 3 drafted (rev 1) |

Every route is a **proposal** — what must be true; the built truth is `docs/routes.txt`. Paths are under
`/api/v1/app/social/`. Permission codes keep today's split: `channel-account:manage` writes, `channel-account:read` reads.

| Change | Count |
| --- | --- |
| NEW | 4 |
| CHANGED | 6 |
| **Total** | **10** |

| # | Change | Method + path | Gate | What must be true | Brief |
| --- | --- | --- | --- | --- | --- |
| RC-1 | CHANGED | `POST channel-connections/{provider}/callback` (2) | manage | accepts Meta's cancel (`error`, `error_reason`, `error_description`) instead of `code`; spends the state; saves nothing; answers `200` with `outcome: cancelled` ([C-D1](decisions.md)) | L44 |
| RC-2 | CHANGED | same (2) | manage | `422 provider_permissions_missing` names `missing_permissions`; `409 channel_connection_business_mismatch` names the expected `client_business_id` | L46, L64 |
| RC-3 | CHANGED | same (2) | manage | a login sharing no Instagram account saves nothing → `422 provider_no_accounts_shared` (a **reconnect** sharing none stores the token, marks that connection's accounts not shared and answers the outcome — [C-D2](decisions.md)); accounts of this business no longer assigned are marked as the token check marks them | L52, L61 |
| RC-4 | CHANGED | `POST channel-connections/{channel_connection_id}/accounts` (3) | manage | the plan-limit refusal stays all-or-nothing and carries `plan_room` ([C-D4](decisions.md)) | L58 |
| RC-5 | NEW | (route 151) `GET channel-connections/{channel_connection_id}/shared-assets` ([C-D5](decisions.md)) | read | re-reads what the login shared from Meta (never cached): each asset with `channel`, `provider_account_id`, username, pick state (`free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more`) and the plan room; Meta down → `503` | L54, L61, L94 |
| RC-6 | NEW | (route 153) `GET channel-accounts/{channel_account_id}/capabilities` ([C-D7](decisions.md)) | read | every capability of the account's channel: `allowed`, or the first blocking reason (`permission_not_granted` + permission name · `plan_lacks_feature` · `message_access_off` · `messages_webhook_missing` · `meta_test_required`) and its fix (`reconnect` · `upgrade` · `turn_on_message_access` · `reconnect_with_page`) | L48, L95 |
| RC-7 | CHANGED | `GET channel-accounts[/{channel_account_id}]` (6, 7) | read | `instagram.message_access` `{ status, checked_at }` added (`linked_page_id` deferred — routes-final IG3) | L85, L87 |
| RC-8 | NEW | (route 154) `POST instagram/accounts/{channel_account_id}/message-access-checks` ([C-D9](decisions.md) — Instagram-only routes live under `/instagram/accounts/…`) | `instagram-account:manage` | runs the probe now, stores DB-1, answers the result; lifts or keeps the `access_off` stop | L69 |
| RC-9 | CHANGED | every route refusing `409 permission_not_granted` | — | the error also names `permission` (Meta's permission), beside `feature` | L49 |
| RC-10 | NEW | (route 152) `GET channel-connections/{provider}/connect-options` | read | whether connecting is possible now: `is_configured`, `is_page_login_offered`, `can_manage` (the caller's role), `plan_room` | L13, L96 |

Built: RC-1–RC-5 and RC-10 in ROUTE R3; RC-6 and RC-9 in ROUTE R4; RC-7 and RC-8 in ROUTE R5 (see `AS-BUILT.md`).

Pages-ready (brief:L78): RC-5 and RC-6 name the `channel` of every asset; the route review carries a written Pages
sketch showing `facebook_page` arriving as one more `channel` value with no route change.
