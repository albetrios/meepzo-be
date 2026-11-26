# fix-meta-unified-login-2026-11-26-ceuy — as built

Baseline: none · KICKOFF.md go given 2026-11-26 (lite)

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | `readMetaGrantedPermissions` falls back to `/debug_token` when `/me/permissions` is empty or refused; both unreadable → outage | As planned in `meta-graph.client.ts`: `/me/permissions` first; on an empty granted list, a `refused` answer, or an `auth` answer other than code 190 → `GET /debug_token?input_token&access_token=<app id>\|<app secret>` (`data.scopes`, de-duplicated); a 190, throttle or outage of the first read is rethrown; a 503 `instagram_not_configured` of the second is rethrown; neither naming a permission → warn `meta_graph.permissions_unreadable` (codes only) and a malformed-answer `outage`. Both callers (callback `readLogin`, token check `recordPermissionMissing`) unchanged. Fixture `debug-token.success` + contract test; 4 client unit tests; overview updated | The `/debug_token` call carries the customer token in the query (`input_token`), the one exception to "token only in `Authorization`" (MC2) | Meta documents `debug_token` only with query parameters; the outbound layer never logs a full URL and both names hold `token`, so `redactSensitiveUrl` and the log redactor hide them (pinned by the contract test). The warn log's field is `fallbackRead`, not `debugTokenRead` — the redactor hides any key holding `token` | F-D3, F-D4 | — | — |

Verification (F1): `pnpm vitest run` channel-connection unit + integration (connection, token check) + client unit — 15 files, 181 tests pass; `pnpm test:contract` — 11 files, 94 tests pass; `pnpm validate` clean; `pnpm tsdoc:check` 0/0.

## Revisions to upcoming rows

- none

## Summary

- Planned, not built: —
- Built, not planned: —
- Follow-ups: owner tests O1–O5 (`plans/decisions.md`)

## Standing deviations

| Item | Design says | Built as | Since iteration | Decision |
| --- | --- | --- | --- | --- |
| Customer token in a URL | MC2: a customer token travels only in `Authorization` | `/debug_token` (the permission read's fallback) carries it as `input_token`, redacted in every log | fix-meta-unified-login-2026-11-26-ceuy | F-D4 |
