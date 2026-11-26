# feat-meta-connect-flow-2026-11-26-bqmw — as built

Baseline: none · KICKOFF.md approved 2026-11-26 (C-D15) · reframed by C-D16 (merged Meta id rules, `cc902a0`)

## Rows

| # | Planned | Actually built | Difference | Why | Decision | Commit | Reviewed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `app.instagram_accounts` + `message_access`, `message_access_checked_at` (DB-1, routes-final § 3.3) | `message_access varchar(10) NOT NULL DEFAULT 'unknown'` + `chk_instagram_accounts_message_access` (`NOT VALID` → validated) and `message_access_checked_at timestamptz NULL` — migration `20261126160000_app_instagram_accounts_message_access.sql`; Drizzle schema; the three values in one shared list `INSTAGRAM_MESSAGE_ACCESS_STATES` (`src/shared/constants/instagram.constants.ts`), from which the Meta client's `InstagramMessageAccess` type now derives; DB diagram regenerated; overview note. Test: repository db unit › "starts every account at message access unknown, never checked, and refuses a value outside the three (R1, IG1)" | One shared value list instead of a column-only enum; migration prefix `…160000` | Reuse rule: the probe's type and the column read one list; C-D16 (after `20261126150100`) | C-D16 | 6986ebd | 2026-11-26 · user · 6986ebd |
| R2 | `app.channel_accounts` + `scopes`, `scopes_read_at` (DB-3, routes-final § 2.3) | `scopes text[] NULL` + `chk_channel_accounts_scopes` (`NULL` or ≤ 20 names; `NOT VALID` → validated) and `scopes_read_at timestamptz NULL` — migration `20261126160100_app_channel_accounts_scopes.sql`; Drizzle schema; DB diagram. **One cap constant** `META_PERMISSION_NAMES_MAX = 20` (`channel-connection.constants.ts`) now read by both `scopes` CHECKs and both existing writers (the callback, the token check) instead of four bare `20`s. Test: channel-account integration › "starts with no account scopes (the connection stands) and refuses more than 20 names" | The bare `20` in the connection's CHECK and two writers replaced by the constant | Reuse rule — the new column made it a fourth copy; behaviour unchanged | C-D16 | — | — |

Verification (R1): `pnpm db:migrate:lint` 0 violations (163 files); `pnpm db:migrate` applied; `pnpm vitest run` instagram-account + schema-RLS parity — 31 files, 389 tests; `pnpm test:rls-role:changed` — 44 files, 631 tests; `pnpm validate`, `pnpm tsdoc:check` clean.

Verification (R2): `pnpm db:migrate:lint` 0 violations (164 files); `pnpm db:migrate` applied; `pnpm vitest run` channel-account + channel-connection + schema-RLS parity — 30 files, 448 tests; `pnpm test:rls-role:changed` — 44 files, 632 tests; `pnpm validate`, `pnpm tsdoc:check` clean.

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
