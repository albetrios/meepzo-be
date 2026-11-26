# Decisions — feat-meta-connect-flow-2026-11-26-bqmw

Add-only: a changed mind is a new row. Kind: `RED` (answered by the user), `AMBER` (safe default, still open),
`SCOPE`. Coverage questions `Q1`–`Q8` ([coverage.md](coverage.md)).

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| C-D1 | Q1 — the callback's answer to Meta's cancel (`error=access_denied`) | 200 `outcome: cancelled` · 422 `provider_login_cancelled` | **200 with `outcome: cancelled`**: the state is spent, nothing saved — a cancel is the person's choice, not a client error (method→status policy: success is 200) | 2026-11-26 | user | RED |
| C-D2 | Q2 — a **reconnect** whose login shares no Instagram account | mark and keep · refuse and change nothing | **mark and keep**: the fresh token is stored, every account of that connection is marked not shared (the token check's `account_not_shared` stop), the outcome is answered; nothing deleted. A **first** connect sharing none saves nothing → `422 provider_no_accounts_shared` | 2026-11-26 | user | RED |
| C-D3 | Q3 — how long a connection with no picked account keeps its token | 24 h · 7 days · 30 days | **7 days**, then a background job revokes it and deletes its token | 2026-11-26 | user | RED |
| C-D4 | Q4 — picks over the plan limit | all-or-nothing · up to the limit | **all-or-nothing kept**; the `409 plan_account_limit` adds `plan_room` | 2026-11-26 | user | RED |
| C-D5 | Q5 — the name of the "what the login shared" read | `shared-assets` · `available-accounts` · `assigned-accounts` | `GET channel-connections/{channel_connection_id}/shared-assets` — "assets" holds a Page later (Pages-ready) | 2026-11-26 | Claude | AMBER |
| C-D6 | Q6 — where the linked Facebook Page id comes from | an Instagram-user field · the Page's `instagram_business_account` · `granular_scopes` target ids | no documented Instagram-user field under Unified Login ⚠️ — stays `null` until owner test O6 shows the source; the webhook watch (`is_messages_webhook_missing`) keeps detecting outcome 16 meanwhile | 2026-11-26 | Claude | AMBER |
| C-D7 | Q7 — capabilities as their own route or embedded in the account read | own route · embedded | own route `GET channel-accounts/{channel_account_id}/capabilities`: the account list (route 6) stays light; the screen reads capabilities for the account it shows | 2026-11-26 | Claude | AMBER |
| C-D8 | Q8 — the on-demand message-access re-check | `POST …/message-access-checks` · a `PATCH` field | `POST channel-accounts/{channel_account_id}/message-access-checks` (an action that calls Meta, `channel-account:manage`) | 2026-11-26 | Claude | AMBER |
| C-D9 | Step 5 — where the message-access re-check lives (supersedes C-D8's path) | `channel-accounts/{id}/…` · `instagram/accounts/{channel_account_id}/…` | `POST instagram/accounts/{channel_account_id}/message-access-checks`: the probe is Instagram-only, and Instagram-only routes already live there (`…/settings`, `…/media`, `…/stories`, `docs/routes.txt`) | 2026-11-26 | Claude | AMBER |
| C-D10 | Step 5 — the unpicked clean-up as its own job or in the token check | own scheduled job · the daily token check | the daily token check (reuse rule — it already visits every connection daily in the right scope) | 2026-11-26 | Claude | AMBER |
| C-D11 | Step 5 — route review sub-domain 1, Channel connection (CN1–CN10) | confirm · change | **confirmed as drafted** (rev 1) | 2026-11-26 | user | RED |
| C-D12 | Step 5 — route review sub-domain 2, Channel account (AC1–AC6, Pages sketch) | confirm · change | **confirmed as drafted** (rev 1) | 2026-11-26 | user | RED |
| C-D13 | Step 5 — add `linked_page_id` now (always `null`) or when its source is known | now · later | **later** (routes-final IG3): a column no code can fill is dead schema; a fix adds it with its writer after O6 (supersedes C-D6's "stays null") | 2026-11-26 | Claude | AMBER |
| C-D14 | Step 5 — route review sub-domain 3, Instagram account (IG1–IG5) | confirm · change | **confirmed as drafted** (rev 1); the route review is final | 2026-11-26 | user | RED |
| C-D15 | Step 7 — approve the plan (KICKOFF.md, ROUTE R1–R7, routes-final, requirements, stories, acceptance) | approve · change | **approved** — KICKOFF.md and `intake-files/` are frozen from here | 2026-11-26 | user | RED |
| C-D16 | Reframe after the merged "Column length Issue fix" (`f3ca17f`, merged `cc902a0`) — what the build rows must follow | as planned · adopt the merged rules | **adopt**: (1) every new migration timestamp is after `20261126150100`; (2) numeric Meta ids reuse `INSTAGRAM_ID_MAX_LENGTH` / `INSTAGRAM_ID_PATTERN` / `INSTAGRAM_ID_REGEX`, opaque ones `INSTAGRAM_OPAQUE_ID_MAX_LENGTH` with no format CHECK (`src/shared/constants/instagram.constants.ts`); (3) **every Meta value is bounded in code when read** (the `readBoundedText` pattern, `instagram-webhook-event-dispatch.util.ts`) — stored `null` or skipped with a warning when it does not fit — with the database CHECK as the backstop only: R1 `message_access` is our probe's own value (`on` · `off` · `unknown`), R2 `scopes` keeps at most 20 names each ≤ 100 characters and drops the rest with a warning, route 151's `username` is read bounded. No route, table or row of KICKOFF.md changes | 2026-11-26 | Claude | AMBER |

## Owner items (need the Meta dev app — not code)

| # | Test | Settles |
| --- | --- | --- |
| O1 | (fix iteration) `/me/permissions` vs `/debug_token` — and whether `granular_scopes` lists target ids per asset | DB-3, WC-4 |
| O6 | Where a Unified Login token reads an Instagram account's linked Facebook Page id | C-D6, DB-2, WC-3 |
