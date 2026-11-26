# DB changes — fix-meta-unified-login-2026-11-26-ceuy

| Table | Before | After | Row |
| --- | --- | --- | --- |
| `app.channel_connections` | — | `provider_user_id text NULL` — the Meta system user id (`GET /me` `id`) of the connection's token; written on every connect and reconnect; internal (not serialized) | F3 |
