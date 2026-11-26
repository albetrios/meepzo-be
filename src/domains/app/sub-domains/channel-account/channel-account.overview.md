`src/domains/app/sub-domains/channel-account/`

# Channel account

Parent: [App](../../app.overview.md)

## Purpose

The common part of every connected inbox, whatever its channel — an Instagram professional account now, a Facebook
Page later (routes-final § 1B of `iterations/feat-instagram-dm-sending-2026-11-23-oxak/`, CA1–CA11). ROUTE row R5 built
the table `app.channel_accounts` (public id prefix `cha`, P22), routes 6–11, the capability list and the one feature
check, and the channel connection's account port over it. The Instagram-only part (user id, profile, settings, posts)
is `app.instagram_accounts`, a 1:1 extension through its `channel_account_id` (sub-domain 2, reshaped at R6 — its `instagram` object, 2.A.6, is serialized there).

## Routes (under `/api/v1/app`)

| # | Method | Path | Gate | Idem |
| --- | --- | --- | --- | --- |
| 6 | GET | `/social/channel-accounts` | `channel-account:read` | — |
| 7 | GET | `/social/channel-accounts/{channel_account_id}` | `channel-account:read` | — |
| 153 | GET | `/social/channel-accounts/{channel_account_id}/capabilities` — every feature through the one check, and the stored blockers (feat-meta-connect-flow) | `channel-account:read` | — |
| 8 | DELETE | `/social/channel-accounts/{channel_account_id}` | `channel-account:manage` | — |
| 9 | POST | `/social/channel-accounts/{channel_account_id}/pause` | `channel-account:manage` | — |
| 10 | POST | `/social/channel-accounts/{channel_account_id}/resume` | `channel-account:manage` | — |
| 11 | POST | `/social/channel-accounts/{channel_account_id}/activate` | `channel-account:manage` | req |

Team organizations only: a write on a personal one is `422`, a read `404 team_organization_required`. Another
organization's or a revoked account is `404 channel_account_not_found`. Routes 7 and 8 replace the launch's singular
`GET` / `DELETE /social/instagram/account` (CA2).

## Layout

- `channel-account.schema.ts` — `app.channel_accounts`: the connection it came through, `provider_account_id` (the
  Instagram user id, one not-revoked row per provider account across organizations — CAQ1), the status
  (`connected` · `error` · `revoked`), the owner's pause, the team's suspend, the plan stop (`plan_stop_reason` +
  `plan_stopped_at`, P99) and the automation switch. FORCE RLS, the retention sweep arm in `USING`.
- `channel-account.repository.ts` — the SQL: the pick's upsert (a revoked row comes back), the reads, the reconnect's
  move, pause / resume, the plan stop, the account-limit lock it shares with the pick (MC7).
- `channel-account.service.ts` — routes 6–11; `markAccountBroken` and `markAccountsOfConnectionBroken` (CA4, MC11);
  `canChannelAccountUseFeature` / `listChannelAccountFeatureProblems` (CA11); and `ChannelConnectionAccountPort`
  (the connection's pick, reconnect, revoke and webhook steps). The lane steps of routes 8–11 and of the break go
  through `ChannelAccountLanePort` (sub-domain 6's `InstagramSendLaneService`, R18) and the stop an activated account
  takes through `ChannelAccountPlanStopPort` (`plan_limit` from sub-domain 6's month count, R18; `plan_ended`, R24);
  `countActiveAccounts` and `findLiveInstagramAccount` serve sub-domain 6's routes 64 and 63.
  `applyOrganizationPlanStops` (R52, WC-37, WC-38) puts every account's plan stop in line with the plan under the
  account-limit lock — the pick of who stays is `channel-account-plan-stop.util.ts` (`pickChannelAccountsInPlan`:
  the kept, then the accounts in the plan, oldest first, then on a move up the `plan_downgrade` ones); while the plan
  has ended nothing is trimmed. The repository's `listOrganizationsHoldingPlanStop` (retention handle,
  `createRetentionChannelAccountRepository`) is the repair duties' cross-organization read.
- `channel-account-capabilities.constants.ts` — `CHANNEL_CAPABILITIES` (per channel: ways to start, steps, message
  kinds, features), `CHANNEL_FEATURES` (each feature's permission, plan switch and Meta test — the plan switches are
  exactly billing's `PLAN_FEATURE_KEYS`, a unit test pins it). `APP_UNTESTED_META_FEATURES` lives in sub-domain 6's
  sending settings file (`../instagram-sending/instagram-sending.constants.ts`, P4).
- `channel-account.{controller,routes,dto,validator,serializer,constants,types}.ts`, `channel-account-error.util.ts` —
  the route layer, the audit entries (`app.channel_account.disconnect` / `.pause` / `.resume` / `.activate`, with the
  old and new value) and the reasons (`channel_account_not_found`, `channel_account_already_active`, the feature
  check's four with the statuses of P61).
- `seed/` — one connected Instagram channel account per demo team organization, before its Instagram extension.

## Rules

- **The status of record is here** (CA4): since ROUTE row R6 `app.instagram_accounts` holds no status, public id or
  connection column; the Instagram extension is written only through `InstagramAccountExtensionService` (2.A.10) — this
  service never writes its table, and the guarded break and the revokes move `app.channel_accounts` alone.
- **No Meta call inside a database context** (1B.10): route 8 reads, closes, unsubscribes (best effort), then writes;
  the connection's token goes only with its last not-revoked account (CA8).
- **Route 11 counts under the organization lock** (CA9): at the plan's `channel_accounts_max` the named
  `stop_channel_account_id` takes `plan_downgrade` in the same commit; `X-Idempotency-Key` replays the swap.
- **The feature check reads Postgres and constants only** — the channel, the connection's `scopes`, the plan's switch
  (`getPlanAccess`) and the untested list, in that order of refusal.
