`src/domains/app/sub-domains/channel-connection/`

# Channel connection

Parent: [App](../../app.overview.md)

## Purpose

One provider login of an organization for one business — for Meta, Unified Login: one connection per business
portfolio for Instagram, Facebook and ads (routes-final § 1 of `iterations/feat-instagram-dm-sending-2026-11-23-oxak/`,
MC1–MC19). It lands in rows: ROUTE row R2 built the Meta adapter, the one-use login state and Meta's usage kept per
connection; ROUTE row R3 added the tables `app.channel_connections`, `app.channel_connection_tokens` and
`app.channel_connection_usages`, routes 1–5, 40 and 42 (start, callback, reconnect, pick, list, one, disconnect
business) and the token path. The ad picker (routes 15, 41) lands at R4, Meta's callbacks (16–17) at R9, the daily
token check at R51.

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
  `ChannelConnectionLanePort` (sub-domain 6's lane service, wired at R18) and a trial pick through
  `ChannelConnectionTrialPort` (R24, not wired yet).
- `channel-connection.{controller,routes,dto,validator,serializer,constants,types}.ts`,
  `channel-connection-error.util.ts` — the route layer and its reasons (`provider_code_invalid`,
  `provider_permissions_missing`, `channel_connection_business_mismatch`, `plan_account_limit`,
  `channel_connection_not_connected`, `channel_connection_not_found`).
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
  S13) and `MetaAppUsageStore` (the app-level usage once, on `app.sending_states` — sub-domain 6's
  `SendingStateService`, wired at R18).
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
- **A reconnect moves accounts** (MC6): every not-revoked account of the organization the business still assigns is
  attached to the connection and goes `connected`; a connection a move left without accounts is revoked with its token.
