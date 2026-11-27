# Feature 7 — the sender's ledger renamed

**As** a developer, **I want** the ledger named for what it holds, **so that** the conversation history and the send ledger are never confused.

Requirements: `rename.automation-messages`.

## Acceptance criteria

- AC-7.1 — `app.instagram_outgoing_messages` exists with every part, key, check and policy; `app.instagram_messages` does not.
- AC-7.2 — The sending, broadcast, channel-account and webhook suites pass unchanged in behaviour; `igm_` ids still resolve.
