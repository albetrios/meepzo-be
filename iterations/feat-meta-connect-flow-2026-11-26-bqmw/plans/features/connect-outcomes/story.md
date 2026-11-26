# Feature 1 — connect outcomes

**As** an owner or admin connecting Instagram, **I want** the login's return to tell me exactly what happened and what
to do next, **so that** a half-working connect never leaves me guessing.

Requirements: `connect.cancel`, `connect.outcome`, `connect.missing-permissions-named`, `connect.business-mismatch-named`,
`connect.no-accounts-shared`, `connect.unshared-marked`, `connect.plan-room`, `connect.options`, `background.unpicked-cleanup`.

## Acceptance criteria

- AC-1.1 — A cancel with this caller's state answers `200` `outcome: cancelled`, spends the state, saves nothing, calls no Meta; a bad state is still `400 channel_connect_state_invalid`; both or neither of `code` / `error` is `400`.
- AC-1.2 — Every callback success carries `outcome` (`connected` · `reconnected` · `no_accounts_shared`).
- AC-1.3 — A missing required permission answers `422 provider_permissions_missing` naming exactly the missing ones; nothing saved.
- AC-1.4 — A reconnect into another portfolio answers `409 channel_connection_business_mismatch` naming the expected business.
- AC-1.5 — A first connect sharing no Instagram account answers `422 provider_no_accounts_shared` and saves nothing; a reconnect sharing none keeps the token, marks that connection's accounts not shared and answers `outcome: no_accounts_shared`.
- AC-1.6 — An account missing from a complete assigned list is marked not shared by the callback; an incomplete list marks nothing.
- AC-1.7 — Picks over the plan limit answer `409 plan_account_limit` with `plan_room`; nothing is saved.
- AC-1.8 — Route 152 answers the four preconditions for an owner, a viewer (`can_manage: false`) and an unconfigured Meta (`is_configured: false`, never `503`).
- AC-1.9 — A connection with no account is kept at 6 days and revoked with its token deleted at 8 days; a connection with an account is never revoked by this rule.
