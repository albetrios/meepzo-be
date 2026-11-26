# Database changes — feat-meta-connect-flow-2026-11-26-bqmw

| Field | Value |
| --- | --- |
| Iteration | `feat-meta-connect-flow-2026-11-26-bqmw` |
| Mode | initial (Baseline none) |
| Intake mode | brief (from scratch) |
| Intake hash | `f1ff32a8eb81` |
| Date | 2026-11-26 |
| Stage | Step 4 — C-D3 (no column: 7 days from `connected_at`), C-D6 (Page id `null` until O6) |

WHAT must be true, never HOW: logical types only. No new table — three tables gain facts the frontend needs.

```mermaid
erDiagram
  channel_connections ||--o{ channel_accounts : "has"
  channel_accounts ||--|| instagram_accounts : "Instagram part"
  channel_accounts {
    list scopes "NEW DB-3 - per-account permissions, empty = the connection's stand"
    timestamp scopes_read_at "NEW DB-3"
  }
  instagram_accounts {
    text message_access "NEW DB-1 - on / off / unknown"
    timestamp message_access_checked_at "NEW DB-1"
  }
```

## Stage 1 — CHANGED tables

| # | Table | Before | After | Brief |
| --- | --- | --- | --- | --- |
| DB-1 | `app.instagram_accounts` (**built R1**: `message_access`, `message_access_checked_at`) | the "Allow access to messages" probe result is logged only | `message_access` (`on` · `off` · `unknown`, default `unknown`) and `message_access_checked_at` (nullable), written by the set-up probe and by an on-demand re-check | brief:L85 |
| DB-2 | `app.instagram_accounts` | linked Page not read | **deferred** — `linked_page_id` is added by a later fix once owner test O6 names its source (routes-final IG3: no dead column) | brief:L87 |
| DB-3 | `app.channel_accounts` (**built R2**: `scopes`, `scopes_read_at`) | permissions only on the connection (`scopes`) | `scopes` (list of permission names, nullable — `null` means the connection's scopes stand) and `scopes_read_at`; filled from `/debug_token` `granular_scopes` once owner test O1 passes; at most 20 names, like the connection's (routes-final AC5) | brief:L89 |

No change: `app.channel_connections` — a connection left with no account is found by its accounts (none not-revoked) and
its `connected_at`; no new column — the clean-up's 7 days ([C-D3](decisions.md)) count from `connected_at`.
