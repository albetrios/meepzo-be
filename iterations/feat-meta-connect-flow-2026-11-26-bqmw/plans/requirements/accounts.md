# Requirements — accounts (sub-domain 2, routes-final § 2)

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `accounts.capabilities` | Route 153 runs every feature through the one feature check and lists account blockers from stored states, each with its fix | brief:L48, L95, C-D7 | AC1–AC3 |
| `accounts.permission-named` | `409 permission_not_granted` carries `permission` | brief:L49 | AC4 |
| `accounts.per-account-scopes` | The feature check reads `account.scopes ?? connection.scopes` | brief:L89 | AC5 |
| `accounts.pages-ready` | Every asset carries `channel`; the Pages sketch needs no route change | brief:L78, L110 | AC6 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `accounts.capabilities` | the check runs only on use | route 153 lists every feature and blocker |
| `accounts.permission-named` | `feature` only | + `permission` |
| `accounts.per-account-scopes` | the connection's scopes for every account | the account's when known |
| `accounts.pages-ready` | `channel` on accounts, value `instagram` | unchanged contract, written sketch |
