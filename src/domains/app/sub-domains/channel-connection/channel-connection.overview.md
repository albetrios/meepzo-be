`src/domains/app/sub-domains/channel-connection/`

# Channel connection

Parent: [App](../../app.overview.md)

## Purpose

One provider login of an organization for one business — for Meta, Unified Login: one connection per business
portfolio for Instagram, Facebook and ads (routes-final § 1 of `iterations/feat-instagram-dm-sending-2026-11-23-oxak/`,
MC1–MC19). It lands in rows: ROUTE row R2 built the Meta adapter, the one-use login state and Meta's usage kept per
connection; ROUTE row R3 adds the tables `app.channel_connections` and `app.channel_connection_tokens`, the routes
(start, callback, pick, list, one, disconnect, reconnect) and the token path.

## Layout

- `channel-connection-meta/` — the Meta provider adapter (no table, no route): the one Meta client, the login address
  and code exchange, the usage headers, the error map and the two signature checks
  ([channel-connection-meta.overview.md](channel-connection-meta/channel-connection-meta.overview.md)).
- `channel-connection-state.ts` — the one-use login state of routes 1 and 40 (minted) and route 2 (read and deleted):
  32 random bytes, base64url, 10 minutes in Redis (`app:channel-connect-state:<state>`, MC4, P26), through the
  one-use helper the OAuth sign-in shares (`src/infrastructure/cache/redis-one-use-value.util.ts`, MCC3). A missing,
  used, expired, another user's, organization's or provider's state → `400 channel_connect_state_invalid`.
- `channel-connection-usage.types.ts` — the usage ports: `ChannelConnectionUsageStore` (Postgres, built in R3 on the
  connection — per connection, asset and type, S13) and `MetaAppUsageStore` (the app-level usage once, on
  `sending_states`, R18).
- `channel-connection-usage.service.ts` — `readConnectionUsage` (the pace before a Meta call: the strictest matching
  entry — slow at 80 %, wait at 95 % until Meta's time or 15 minutes) and `buildUsageRecorder` (what the Meta client
  calls with each answer's usage: the store write in its own unit, then the cache tombstone).
- `channel-connection-usage.cache.ts` — the Redis copy `app:meta_usage:<organization public id>:<connection public
  id>` (≤ 60 s, tombstoned after each write, fail open to Postgres — be-read-cache-guard, P5, P32).

## Rules

- **Postgres holds the usage, Redis copies it** (P32): the cache key is built from the verified organization scope
  and a connection read inside it, never from a request parameter.
- **Nothing calls Meta inside a database context** — read, close the unit of work, call Meta, write in a new one.
- **No usage is kept until R3** wires a store: the service is built over a store, and no caller passes a recorder yet.
