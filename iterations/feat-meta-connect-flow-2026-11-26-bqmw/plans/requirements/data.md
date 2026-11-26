# Requirements — data ([db-changes.md](../db-changes.md))

| Identifier | Requirement | db-changes |
| --- | --- | --- |
| `data.channel-accounts-scopes` | `app.channel_accounts.scopes` (nullable list, ≤ 20) and `scopes_read_at` | [DB-3](../db-changes.md#stage-1--changed-tables) |
| `data.instagram-message-access` | `app.instagram_accounts.message_access` (`on` · `off` · `unknown`, default `unknown`) and `message_access_checked_at` | [DB-1](../db-changes.md#stage-1--changed-tables) |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `data.channel-accounts-scopes` | no column | two nullable columns |
| `data.instagram-message-access` | no column | two columns, default `unknown` |
