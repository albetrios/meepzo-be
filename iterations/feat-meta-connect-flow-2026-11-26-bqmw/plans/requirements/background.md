# Requirements — background work ([worker-changes.md](../worker-changes.md))

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `background.unpicked-cleanup` | The daily token check revokes a `connected` connection with no not-revoked account older than 7 days and deletes its token | brief:L54, L104, C-D3, C-D10 | CN9 |
| `background.per-account-scopes-refresh` | The daily token check fills `channel_accounts.scopes` from `/debug_token` `granular_scopes` once owner test O1 passes | brief:L89 | CN10, AC5 |
| `background.message-access-probe` | The account set-up job's probe also stores its answer | brief:L85 | IG1 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `background.unpicked-cleanup` | an unpicked connection keeps its token forever | revoked after 7 days |
| `background.per-account-scopes-refresh` | — | filled behind O1 |
| `background.message-access-probe` | logged | stored |
