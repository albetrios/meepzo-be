# Feature 3 — account capabilities

**As** a team member, **I want** to see what each connected account can do and what blocks the rest, with the fix,
**so that** I fix the right thing (reconnect, upgrade, turn on messages access).

Requirements: `accounts.capabilities`, `accounts.permission-named`, `accounts.per-account-scopes`, `background.per-account-scopes-refresh`,
`data.channel-accounts-scopes`.

## Acceptance criteria

- AC-3.1 — Route 153 answers every feature of the account's channel with `is_allowed`, or `reason`, `permission`, `plan_switch` and `fix`, from the same check a feature use runs.
- AC-3.2 — Route 153 lists the account's blockers (connection error, not shared, login expired, messages access off, plan stop, webhook missing, paused), each with `since` and `fix`.
- AC-3.3 — Every `409 permission_not_granted` names the Meta `permission`.
- AC-3.4 — With account scopes stored, one account of a connection can be refused a feature another is allowed; with them `null`, the connection's scopes stand (`scopes_source`).
- AC-3.5 — Route 153 is readable by a viewer and `404` for another organization's account.
