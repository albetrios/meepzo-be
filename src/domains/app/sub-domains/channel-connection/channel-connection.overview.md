`src/domains/app/sub-domains/channel-connection/`

# Channel connection

Parent: [App](../../app.overview.md)

## Purpose

One provider login of an organization for one business — for Meta, Unified Login: one connection per business
portfolio for Instagram, Facebook and ads (routes-final § 1 of `iterations/feat-instagram-dm-sending-2026-11-23-oxak/`,
MC1–MC19). It lands in rows: ROUTE row R2 built the Meta adapter, the one-use login state and Meta's usage kept per
connection; ROUTE row R3 added the tables `app.channel_connections`, `app.channel_connection_tokens` and
`app.channel_connection_usages`, routes 1–5, 40 and 42 (start, callback, reconnect, pick, list, one, disconnect
business) and the token path; ROUTE row R4 the ad picker (routes 41 and 15) and the connection's break on Meta's 190
(MC11); ROUTE row R9 moved Meta's two callbacks here (routes 16–17, P46) with the account-then-business match (P56).
The daily token check lands at R51.

## Routes (under `/api/v1/app`)

| # | Method | Path | Gate | Idem |
| --- | --- | --- | --- | --- |
| 1 | POST | `/social/channel-connections/{provider}/start` | `channel-account:manage` | — |
| 2 | POST | `/social/channel-connections/{provider}/callback` | `channel-account:manage` | req |
| 40 | POST | `/social/channel-connections/{channel_connection_id}/reconnect` | `channel-account:manage` | — |
| 3 | POST | `/social/channel-connections/{channel_connection_id}/accounts` | `channel-account:manage` | req |
| 4 | GET | `/social/channel-connections` | `channel-account:read` | — |
| 42 | GET | `/social/channel-connections/{channel_connection_id}` | `channel-account:read` | — |
| 5 | DELETE | `/social/channel-connections/{channel_connection_id}` | `channel-account:manage` | — |
| 41 | GET | `/social/channel-connections/{channel_connection_id}/ad-accounts` | `channel-account:read` | — |
| 15 | GET | `/social/channel-connections/{channel_connection_id}/ads?ad_account_id=…` | `channel-account:read` | — |
| 16 | POST | `/social/channel-connections/{provider}/deauthorize` | PUBLIC (Meta's `signed_request`) | — |
| 17 | POST | `/social/channel-connections/{provider}/data-deletion` | PUBLIC (Meta's `signed_request`) | — |

`{provider}` and `{channel_connection_id}` share the segment after `channel-connections/`; the next segment tells them
apart (MCC10). Team organizations only: a write on a personal one is `422`, a read `404 team_organization_required`.

## Layout

- `channel-connection.schema.ts`, `channel-connection-token.schema.ts`, `channel-connection-usage.schema.ts` — the
  three tables (public id prefix `chc`, P22): one connection per organization, provider and business (a revoked one
  reused); its token, ciphertext only (`system_user` for Meta, never ending; `oauth_user` with an encrypted refresh
  token for a later provider, MC18); Meta's usage per connection, asset and type (S13, P107). FORCE RLS; the
  connection has the retention sweep arm in `USING`, the token and the usage the organization arm only (MC9).
- `channel-connection.repository.ts` / `channel-connection-token.repository.ts` /
  `channel-connection-usage.repository.ts` — the SQL; only the token repository reads the token table, and only the
  token service and the worker paths use it (`channel-connection-token-isolation.policy.unit.test.ts`).
- `channel-connection-token.service.ts` — store, read and, with the connection, revoke the token (CA8: the account
  service revokes a connection with its last account).
- `channel-connection.service.ts` — the routes' service. The accounts are reached through
  `ChannelConnectionAccountPort` (`channel-connection.types.ts`) — implemented by the channel account service over
  `app.channel_accounts` and its Instagram extension since ROUTE row R5 (P111, P116); the lane steps through
  `ChannelConnectionLanePort` (R18) and a trial pick through `ChannelConnectionTrialPort` (R24), both not wired yet.
- `channel-connection.{controller,routes,dto,validator,serializer,constants,types}.ts`,
  `channel-connection-error.util.ts` — the route layer and its reasons (`provider_code_invalid`,
  `provider_permissions_missing`, `channel_connection_business_mismatch`, `plan_account_limit`,
  `channel_connection_not_connected`, `channel_connection_not_found`, `ad_account_not_found`).
- `channel-connection-meta-callback.{routes,controller,service,dto,serializer,constants,types}.ts`,
  `channel-connection-meta-callback-ingress.plugin.ts`, `channel-connection-meta-callback-confirmation-code.util.ts` —
  Meta's deauthorize (16) and data deletion (17), PUBLIC (MC14–MC16; moved from the launch's
  `instagram-account-meta-callback/`): their own encapsulated plugin with the only body parser
  (`application/x-www-form-urlencoded`, 16 KB, one `signed_request` field) and a `preValidation` hook verifying it with
  `META_APP_SECRET` (`400 instagram_signed_request_invalid`, `503 instagram_not_configured`). The service tries the id
  as an account id — `app.resolve_organization_public_ids_for_provider_account` — then, when none, as a business id —
  `app.resolve_organization_public_ids_for_provider_business` (P56); per organization, in its `VERIFIED` scope (ledgered
  in `verified-scope-usage.policy.unit.test.ts`), `InstagramAccountErasureService.eraseForMeta` disconnects every
  account reached as route 8 does (CA8: the connection's token goes with its last account), and on 17 erases the
  profiles and stored posts; a business connection left with no account is revoked with its token. An account or
  connection connected after Meta's `issued_at` is left alone (D53). Always `200` once verified; route 17 answers Meta's
  `{ url, confirmation_code }` outside the envelope (the code an HMAC of the signed request — the same request, the same
  code). An unmatched id is logged at error level (`app.channel_connection.meta_callback.unmatched`) and goes to
  `ChannelConnectionMetaCallbackTeamAlertPort` — the team email, wired at ROUTE row R53. Audit
  `app.channel_connection.deauthorize` / `.data_deletion` (WARNING, anonymous, `source = 'meta'`, `match`).
- `seed/` — one Meta connection with a fake encrypted token per demo team organization.
- `channel-connection-meta/` — the Meta provider adapter (no table, no route): the one Meta client, the login address
  and code exchange, the usage headers, the error map and the two signature checks
  ([channel-connection-meta.overview.md](channel-connection-meta/channel-connection-meta.overview.md)).
- `channel-connection-state.ts` — the one-use login state of routes 1 and 40 (minted) and route 2 (read and deleted):
  32 random bytes, base64url, 10 minutes in Redis (`app:channel-connect-state:<state>`, MC4, P26), through the
  one-use helper the OAuth sign-in shares (`src/infrastructure/cache/redis-one-use-value.util.ts`, MCC3). A missing,
  used, expired, another user's, organization's or provider's state → `400 channel_connect_state_invalid`.
- `channel-connection-usage.types.ts` — the usage ports: `ChannelConnectionUsageStore` (Postgres —
  `createChannelConnectionUsagePostgresStore` over `app.channel_connection_usages`, per connection, asset and type,
  S13) and `MetaAppUsageStore` (the app-level usage once, on `sending_states`, R18).
- `channel-connection-usage.service.ts` — `readConnectionUsage` (the pace before a Meta call: the strictest matching
  entry — slow at 80 %, wait at 95 % until Meta's time or 15 minutes) and `buildUsageRecorder` (what the Meta client
  calls with each answer's usage: the store write in its own unit, then the cache tombstone).
- `channel-connection-usage.cache.ts` — the Redis copy `app:meta_usage:<organization public id>:<connection public
  id>` (≤ 60 s, tombstoned after each write, fail open to Postgres — be-read-cache-guard, P5, P32).

## Rules

- **Postgres holds the usage, Redis copies it** (P32): the cache key is built from the verified organization scope
  and a connection read inside it, never from a request parameter.
- **Nothing calls Meta inside a database context** — read, close the unit of work, call Meta, write in a new one.
- **The pick passes the connection's usage recorder** to its Meta calls (MC19); the callback's reads run before the
  connection exists and keep none. The lanes read `readConnectionUsage` from R20 / R42.
- **The plan's limit under the organization lock** (MC7): the pick takes `pg_advisory_xact_lock` on the organization
  (`RESOURCE_QUOTA_LOCK_NAMESPACE.CHANNEL_ACCOUNT_LIMIT`), counts the not-revoked accounts and connects the picks in
  one commit — over `channel_accounts_max` is `409 plan_account_limit`, nothing saved.
- **The ad picker reads live, one ad account at a time** (MC13, P57): route 41 lists the ad accounts the login
  reaches (Meta's first 100), route 15 one ad account's ads (`ad_account_id` required, checked against route 41's list
  → `404 ad_account_not_found`; Meta's `limit` / `after` passed through) with the channel account each ad runs as;
  nothing is stored. Without `ads_read` both answer `data: []` and `meta.ad_access = 'missing'` — never an error.
- **Meta's 190 breaks the connection** (MC11): `ChannelConnectionService.markConnectionBroken` — one guarded
  `connected → error` on the connection (`last_check_error`, Meta's codes only) and, in the same commit, every
  `connected` account of it → `error` through the account port, one reconnect notice each. Routes 15 and 41 call it
  today; the daily token check (R51) and the senders (R20) call the same. Only code 190 breaks: a permission code on
  an ad read means the ad access is missing.
- **A reconnect moves accounts** (MC6): every not-revoked account of the organization the business still assigns is
  attached to the connection and goes `connected`; a connection a move left without accounts is revoked with its token.
