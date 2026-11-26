# Acceptance — fix-meta-unified-login-2026-11-26-ceuy

Filled at Close: Result `pass` (Evidence: test file › test name), `partial`, `open` or `deferred`.

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AF-1 — `/me/permissions` answering an empty list → the granted permissions come from `/debug_token`'s `scopes` | KICKOFF F1 | open | |
| AF-2 — `/me/permissions` refused (Meta code 100) → `/debug_token` is read; a code-190 refusal is rethrown, never masked | KICKOFF F1 | open | |
| AF-3 — both unreadable → the callback answers today's outage error and saves nothing; the URL with the app token is redacted in every log | KICKOFF F1, F-D3 | open | |
| AF-4 — an email question, a phone question and the invalid-email reply are sent as `{ text }` with no `quick_replies` | KICKOFF F2 | open | |
| AF-5 — a typed email or phone answer still completes the question (unchanged parsers) | KICKOFF F2 | open | |
| AF-6 — a connect stores `provider_user_id` from the `/me` `id`; a reconnect updates it; no extra Meta call | KICKOFF F3 | open | |
| AF-7 — the migration is additive (nullable column), RLS unchanged | KICKOFF F3 | open | |
| AF-8 — an exchange with `expires_in` logs `app.channel_connection.token_dated` with the config id and no token; one without logs nothing | KICKOFF F4 | open | |
