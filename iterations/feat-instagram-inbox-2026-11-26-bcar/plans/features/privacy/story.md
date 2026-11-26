# Feature 6 — privacy

**As** the business, **I want** DM text kept only as long as needed and erased when asked, **so that** we meet Meta's and the person's expectations.

Requirements: `privacy.erase`, `privacy.retention`, `privacy.no-text-in-logs`.

## Acceptance criteria

- AC-6.1 — Erasing a contact, Meta's data deletion for the account and the organization delete remove conversations, messages, notes and copied files.
- AC-6.2 — Message parts older than 12 months are dropped by the upkeep.
- AC-6.3 — No message text appears in any log line of the tested flows; the three new tenant tables pass the RLS matrix as `meepzo_be_app`.
