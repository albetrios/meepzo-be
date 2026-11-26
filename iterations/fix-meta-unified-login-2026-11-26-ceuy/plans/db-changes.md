# DB changes — fix-meta-unified-login-2026-11-26-ceuy

| Table | Before | After | Row | Built |
| --- | --- | --- | --- | --- |
| `app.channel_connections` | — | `provider_user_id text NULL` — the Meta system user id (`GET /me` `id`) of the connection's token; written on every connect and reconnect; internal (not serialized) | F3 | `app.channel_connections.provider_user_id` (varchar 64, digits CHECK) — migration `20261126130100_app_channel_connections_provider_user_id.sql`, [AS-BUILT F3](../AS-BUILT.md) |
