# KICKOFF — fix-meta-unified-login-2026-11-26-ceuy

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | fix-meta-unified-login-2026-11-26-ceuy |
| Process | lite (one plan step, one go) |
| Baseline | none |
| Source | the 2026-11-26 review of the Unified Login guide against the code and Meta's docs (issues C1–C6) |
| Branch | feat/instagram-automation |

## 2. Goal and scope

Close the review's code findings without changing any route's contract:

- **C1** — every connect reads the granted permissions from `GET /me/permissions`, which Meta does not
  document for a Business Integration System User token; an empty or refused answer fails every connect.
- **C2** — Meta disabled the `user_email` / `user_phone_number` quick replies for Instagram messaging on
  5 Oct 2026 (all versions); every email or phone question now spends a refused call before its text fallback.
- **C3** — the system user id `/me` answers (the guide's `app_scoped_id`) is thrown away; store it.
- **C4** — the configuration must issue never-ending tokens (owner decision P359, already in
  `docs/integrations/credentials-and-env.md`); flag a dated token at connect so a drifted configuration is seen
  on day one, not 7 days before it ends.

Out of scope (see [decisions](plans/decisions.md)): C5 (a login sharing no account) moves to
`feat-meta-connect-flow-2026-11-26-bqmw`, which designs every connect outcome for the frontend; C6 (the
"Allow access to messages" probe) and the C1/C3 Meta answers need a real dev-app test — owner items.

## 3. ROUTE

| Row | What | Kind | Depends on | Build with | Proves | Status |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | C1 — `readMetaGrantedPermissions` reads `/me/permissions`; an empty list or a `refused` answer falls back to `GET /debug_token?input_token=…` with the app token (`<app id>\|<app secret>`, `scopes`); both unreadable → the `outage` error it throws today (no route change). Both callers (callback, token check) get it unchanged | client | — | `/be-build-requirement` | AF-1, AF-2, AF-3 | done |
| F2 | C2 — the email question, phone question and invalid-email reply are sent as plain text; `user_email` / `user_phone_number` leave `InstagramQuickReply`; the typed-answer parsers stay (they already read `text`) | sending | — | `/be-build-requirement` | AF-4, AF-5 | done |
| F3 | C3 — `app.channel_connections.provider_user_id text NULL` (the `/me` `id`, read in the same `client_business_id` call, no extra Meta call), written on every connect and reconnect; not serialized | schema + client | — | `/be-schema-complete` | AF-6, AF-7 | planned |
| F4 | C4 — a connect whose exchange names an end (`expires_in`) logs `app.channel_connection.token_dated` (warn, config id, no token) and the setup doc says what it means | service + docs | — | `/be-build-requirement` | AF-8 | planned |

Close: `pnpm validate`, the touched suites, `pnpm test:rls-role:changed`, `pnpm tsdoc:check`, `pnpm routes:catalog:check`.
