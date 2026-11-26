# feat-meta-connect-flow-2026-11-26-bqmw — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (C-D15) · reframed by C-D16 (merged Meta id rules, `cc902a0`)

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `app.instagram_accounts` + `message_access`, `message_access_checked_at` (DB-1, routes-final § 3.3) | `message_access varchar(10) NOT NULL DEFAULT 'unknown'` + `chk_instagram_accounts_message_access` (`NOT VALID` → validated) and `message_access_checked_at timestamptz NULL` — migration `20261126160000_app_instagram_accounts_message_access.sql`; Drizzle schema; the three values in one shared list `INSTAGRAM_MESSAGE_ACCESS_STATES` (`src/shared/constants/instagram.constants.ts`), from which the Meta client's `InstagramMessageAccess` type now derives; DB diagram regenerated; overview note. Test: repository db unit › "starts every account at message access unknown, never checked, and refuses a value outside the three (R1, IG1)" | One shared value list instead of a column-only enum; migration prefix `…160000` | Reuse rule: the probe's type and the column read one list; C-D16 (after `20261126150100`) | C-D16 | 6986ebd | 2026-11-26 · user · 6986ebd |
| R2 | `app.channel_accounts` + `scopes`, `scopes_read_at` (DB-3, routes-final § 2.3) | `scopes text[] NULL` + `chk_channel_accounts_scopes` (`NULL` or ≤ 20 names; `NOT VALID` → validated) and `scopes_read_at timestamptz NULL` — migration `20261126160100_app_channel_accounts_scopes.sql`; Drizzle schema; DB diagram. **One cap constant** `META_PERMISSION_NAMES_MAX = 20` (`channel-connection.constants.ts`) now read by both `scopes` CHECKs and both existing writers (the callback, the token check) instead of four bare `20`s. Test: channel-account integration › "starts with no account scopes (the connection stands) and refuses more than 20 names" | The bare `20` in the connection's CHECK and two writers replaced by the constant | Reuse rule — the new column made it a fourth copy; behaviour unchanged | C-D16 | 3445a59 | — |
| R3 | 1 Channel connection — routes-final § 1 (CN1–CN8; CNC1–CNC6, CNC8): callback outcomes, routes 151, 152, plan room | **Callback (route 2):** body is `{code, state}` **or** Meta's cancel `{state, error, error_reason?, error_description?}` (a `z.union` of two strict objects — both at once is `400`); a cancel spends the state, saves nothing, writes no audit and answers `200 {outcome: 'cancelled'}`; every answer carries `outcome` (`connected` · `reconnected` · `no_accounts_shared` · `cancelled`) and `marked_not_shared_account_ids`. `finishLogin` split into `assertLoginAcceptable` (business mismatch → `409` + `expected_client_business_id`; missing permissions → `422` + `missing_permissions`; a **first** connect sharing none → `422 provider_no_accounts_shared`) and `commitLogin` (one unit: upsert, token, end the login stops; when Meta's list is complete, this connection's accounts not listed any more are marked broken with stop `account_not_shared`). **Route 3:** `409 plan_account_limit` adds `plan_room`. **Route 151** `GET …/{channel_connection_id}/shared-assets` (`channel-account:read`, team-only): re-reads Meta each call, each asset `free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more`, `meta: {is_complete, plan_room}`; Meta's `190` breaks the connection. **Route 152** `GET …/{provider}/connect-options` (`channel-account:read`, team-only): `is_configured`, `is_page_login_offered`, `can_manage`, `plan_room`, never `503`. Shared: error-field registry `APP_ERROR_FIELD_KINDS` gains `missing_permissions` (`string_list`), `expected_client_business_id` (`string`), `plan_room` (`plan_room`) + error-handler kind checks + OpenAPI error fields; i18n `providerNoAccountsShared` (en, es); response-codes.md; OpenAPI response map; route catalogs (`docs/routes.txt` 209, success statuses, organization scope, authorization model + attack-test mapping); overview table. Tests: channel-connection integration › "every connect outcome (feat-meta-connect-flow R3)" (cancel, both bodies 400, outcomes, first-connect none 422, reconnect none, marks only the unshared, shared-asset states, 190 breaks, connect options owner / viewer / unconfigured) + the error-field assertions + BOLA (shared-assets of another organization → 404); validator unit (cancel); error util unit; app wiring unit | Three new error-field kinds in the pinned registry (not in the plan); `finishLogin` split in two; the username in route 151 is passed through from Meta, not bounded (never stored); route 152 reads `can_manage` in the controller through `hasOrganizationPermission` | The registry is the only way to put a named field on an error body; Biome's 100-line function limit; C-D16 bounds only stored Meta values | C-D1, C-D2, C-D4, C-D5, C-D16 | (this commit) | — |

Verification (R1): `pnpm db:migrate:lint` 0 violations (163 files); `pnpm db:migrate` applied; `pnpm vitest run` instagram-account + schema-RLS parity — 31 files, 389 tests; `pnpm test:rls-role:changed` — 44 files, 631 tests; `pnpm validate`, `pnpm tsdoc:check` clean.

Verification (R2): `pnpm db:migrate:lint` 0 violations (164 files); `pnpm db:migrate` applied; `pnpm vitest run` channel-account + channel-connection + schema-RLS parity — 30 files, 448 tests; `pnpm test:rls-role:changed` — 44 files, 632 tests; `pnpm validate`, `pnpm tsdoc:check` clean.

Verification (R3): `pnpm vitest run` channel-connection + `src/tests/global` — 59 files, 538 tests; app route smoke 58; permission-route matrix 228; `pnpm test:rls-role:changed` — 44 files (the two smoke failures it found — the success-status catalog — fixed, smoke rerun 58/58); route validators (success statuses, organization scope, http coverage, schema docs, param schemas, access diff) pass; `pnpm validate`, `pnpm tsdoc:check`, `pnpm docs:check` clean.

## Revisions to upcoming rows

- none

## Summary

- Planned, not built: —
- Built, not planned: —
- Follow-ups for the next iteration: —

## Standing deviations

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Customer token in a URL | MC2: a customer token travels only in `Authorization` | `/debug_token` carries it as `input_token`, redacted in every log | fix-meta-unified-login-2026-11-26-ceuy | F-D4 |
