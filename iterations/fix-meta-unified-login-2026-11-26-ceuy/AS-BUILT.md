# fix-meta-unified-login-2026-11-26-ceuy — as built

Baseline: none · KICKOFF.md go given 2026-11-26 (lite)

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | `readMetaGrantedPermissions` falls back to `/debug_token` when `/me/permissions` is empty or refused; both unreadable → outage | As planned in `meta-graph.client.ts`: `/me/permissions` first; on an empty granted list, a `refused` answer, or an `auth` answer other than code 190 → `GET /debug_token?input_token&access_token=<app id>\|<app secret>` (`data.scopes`, de-duplicated); a 190, throttle or outage of the first read is rethrown; a 503 `instagram_not_configured` of the second is rethrown; neither naming a permission → warn `meta_graph.permissions_unreadable` (codes only) and a malformed-answer `outage`. Both callers (callback `readLogin`, token check `recordPermissionMissing`) unchanged. Fixture `debug-token.success` + contract test; 4 client unit tests; overview updated | The `/debug_token` call carries the customer token in the query (`input_token`), the one exception to "token only in `Authorization`" (MC2) | Meta documents `debug_token` only with query parameters; the outbound layer never logs a full URL and both names hold `token`, so `redactSensitiveUrl` and the log redactor hide them (pinned by the contract test). The warn log's field is `fallbackRead`, not `debugTokenRead` — the redactor hides any key holding `token` | F-D3, F-D4 | 4e19043 | 2026-11-26 · user · 4e19043 |
| F2 | Email question, phone question and invalid-email reply sent as plain text; `user_email` / `user_phone_number` leave `InstagramQuickReply`; keep the refused-quick-reply fallback (F-D5) | The three go as `{ text }` (`question(text)` → `fixed`); `InstagramQuickReply.content_type` is `'text'` only. **The fallback path is removed**: `plainTextFallback` (composer type), `sendWithFallback` (send-compose service), `MetaGraphApiError.isQuickReplyRefused` and its subcode constant. The 2534015 answer is now a plain `refused`. Parsers unchanged (typed text already read). Tests: composer, slow-lane (one plain send), error util, client, contract (a `text` quick reply in the shape test; 2534015 kept as a plain refusal). Overviews and parser comments updated | Planned to keep the fallback; removed it | Only the email/phone buttons ever set a fallback (2534015 is their refusal), so after the change it was dead code; the reuse rule forbids leaving it | F-D9 (supersedes F-D5) | ed312b9 | 2026-11-26 · user · ed312b9 |
| F3 | `app.channel_connections.provider_user_id text NULL` from the `/me` `id`, same call, written on connect and reconnect, not serialized | `provider_user_id varchar(64) NULL` + `chk_channel_connections_provider_user_id` (NULL or digits; added `NOT VALID`, then validated) — migration `20261126130100_app_channel_connections_provider_user_id.sql`. `readMetaClientBusinessId` → **`readMetaBusinessIdentity`** returning `{ clientBusinessId, providerUserId }` from the same `/me?fields=client_business_id` answer (no extra call; a non-digit or missing `id` → `null`). `upsertConnected` writes it in both the insert and the reconnect update. Not in the serializer. Tests: 2 client unit, contract (fixture's `id`), integration (connect 20001 → reconnect 20002, one row, never in the answer); FLOWS.md and the overview updated | `varchar(64)` with a digits CHECK instead of `text`; the read renamed; migration prefix set by hand | The table's other Meta id (`client_business_id`) is `varchar(64)` + digits CHECK; the old name said only half of what it now returns; `db:migrate:new` stamped a wall-clock prefix that sorted before the newest migration (`…130000`), so it was renamed to `…130100` | — | e7ed05e | 2026-11-26 · user · e7ed05e |
| F4 | A connect whose exchange names an end logs warn `app.channel_connection.token_dated` (config id, no token); setup doc says what it means | `finishLogin`, after the commit and the account set-ups: `logDatedToken` warns `app.channel_connection.token_dated` with `requestId`, `configId` (the state's, P356), `organizationPublicId`, `channelConnectionPublicId`, `expiresAt` (ISO). Integration: the P355 test asserts one warning with the start's config and no token; the never-ending test asserts none. `docs/integrations/credentials-and-env.md` step 3 explains the warning and the fix | The end is logged as `expiresAt`, not `tokenExpiresAt`; logged only after a successful commit | A key holding `token` is redacted by the logger; a refused connect saved nothing, so there is no connection to flag | F-D2 | f8fde0b | 2026-11-26 · user · f8fde0b |

Verification (F1): `pnpm vitest run` channel-connection unit + integration (connection, token check) + client unit — 15 files, 181 tests pass; `pnpm test:contract` — 11 files, 94 tests pass; `pnpm validate` clean; `pnpm tsdoc:check` 0/0.

Verification (F2): `pnpm vitest run` instagram-sending, channel-connection-meta, automation-run, comment-to-DM e2e — 63 files, 569 tests pass (after removing two leftover flag assertions); `pnpm test:contract` 94 pass; `pnpm typecheck`, `pnpm validate`, `pnpm tsdoc:check` clean.

Verification (F3): `pnpm db:migrate:lint` 0 violations (159 files); `pnpm db:migrate` applied; `pnpm vitest run` channel-connection — 22 files, 361 tests; `pnpm test:contract` 94; `schema-rls-parity.global.test.ts` 5; `pnpm test:rls-role:changed` — 44 files, 631 tests as `meepzo_be_app`; `pnpm validate`, `pnpm tsdoc:check` clean.

Verification (F4): `channel-connection.integration.test.ts` — 26 tests pass; `pnpm typecheck`, `pnpm validate`, `pnpm tsdoc:check` clean.

## Close review (one independent review agent over `git diff 2e6e65b..HEAD -- src migrations docs`, user's choice of the cheaper review)

No critical or major finding. Five minor ones, each checked against the code and fixed:

| # | Finding | Fix | Proof |
| --- | --- | --- | --- |
| 1 | F1 regression: a login declining every permission answered "restart" (outage) instead of `422 provider_permissions_missing` | `/me/permissions` naming only declined permissions is an answer (`[]`); only an **empty** list falls back; a valid `/debug_token` answer with `scopes: []` is an answer too | client unit › "answers [] without /debug_token when /me/permissions names only declined permissions (review 1)", "takes a valid /debug_token answer with no scopes as nothing granted (review 1)" |
| 2 | F3: a reconnect without a usable `/me` id overwrote a known `provider_user_id` with NULL | the upsert's update sets `COALESCE(EXCLUDED.provider_user_id, provider_user_id)` | integration › the F3 test's third reconnect (`systemUserId: null`) keeps `20002` |
| 3 | F1: `/debug_token` scopes trusted when `is_valid: false` or for another `app_id` | either → no answer (`null`) → the outage | client unit › "never trusts the scopes of an invalid token or of another app (review 3)"; the contract test answers with this environment's `app_id` |
| 4 | F1: the fallback required all four Meta settings via `readMetaAppSettings` | reads only `META_APP_ID` + `readMetaAppSecret()` | client unit › "reads /debug_token with only the app id and secret set … (review 4)" |
| 5 | Reuse rule: a third copy of the digits-only id pattern | one `META_NUMERIC_ID_PATTERN` in `src/shared/constants/instagram.constants.ts`; `INSTAGRAM_WEBHOOK_USER_ID_PATTERN` and the contact service's private copy removed, both callers and the client read it | typecheck; contact + webhook suites pass |

Also: F4's call pushed `finishLogin` to 101 lines (Biome `noExcessiveLinesPerFunction`, a warning) — the `null` check moved into `logDatedToken`.

Verification (close): `pnpm vitest run` channel-connection, contact, instagram-webhook — 59 files, 1,024 tests; `pnpm test:contract` 94; `pnpm lint`, `pnpm typecheck`, `pnpm validate`, `pnpm tsdoc:check`, `pnpm routes:catalog:check` clean.

## Revisions to upcoming rows

- none

## Summary

- Planned, not built: — (C5 moved to `feat-meta-connect-flow-2026-11-26-bqmw` by F-D7; C6 is owner test O2)
- Built, not planned: the removal of the refused-quick-reply fallback (F-D9); the shared `META_NUMERIC_ID_PATTERN` and the five review fixes (Close review)
- Follow-ups: owner tests O1–O5 (`plans/decisions.md`) — O1 decides whether the `/debug_token` fallback is ever reached; the connect-flow iteration designs the frontend answer for missing permissions and unreadable permissions

## Standing deviations

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Customer token in a URL | MC2: a customer token travels only in `Authorization` | `/debug_token` (the permission read's fallback) carries it as `input_token`, redacted in every log | fix-meta-unified-login-2026-11-26-ceuy | F-D4 |
