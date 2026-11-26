# Feature 2 — shared assets picker

**As** an owner or admin, **I want** to reopen the account picker later and see what my business portfolio shares now,
**so that** I can add accounts without logging in to Meta again.

Requirements: `connect.shared-assets`, `accounts.pages-ready`.

## Acceptance criteria

- AC-2.1 — Route 151 lists every shared asset with `channel`, `provider_account_id`, `username` and `state` (`free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more`), plus `plan_room` and `is_complete`.
- AC-2.2 — Route 151 re-reads Meta every time (never cached); Meta down → `503`, a 190 breaks the connection; a revoked or another organization's connection → `404`, a broken one → `409 channel_connection_not_connected`.
- AC-2.3 — A viewer can read route 151; the Pages sketch in routes-final § 2.10 shows no route of this iteration changing for `facebook_page`.
