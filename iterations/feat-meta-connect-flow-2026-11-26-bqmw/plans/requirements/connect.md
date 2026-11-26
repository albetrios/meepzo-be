# Requirements — connect (sub-domain 1, routes-final § 1)

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `connect.cancel` | A Meta cancel (`error`, `error_reason`, `error_description`) spends the caller's state, saves nothing, calls no Meta, answers `200` `outcome: cancelled` | brief:L44, C-D1 | CN1 |
| `connect.outcome` | Every callback success names its `outcome`: `connected` · `reconnected` · `cancelled` · `no_accounts_shared` | brief:L15 | CN2 |
| `connect.missing-permissions-named` | `422 provider_permissions_missing` carries `missing_permissions` | brief:L46 | CN3 |
| `connect.business-mismatch-named` | `409 channel_connection_business_mismatch` carries `expected_client_business_id` | brief:L64 | CN3 |
| `connect.no-accounts-shared` | A first connect sharing no Instagram account saves nothing → `422 provider_no_accounts_shared`; a reconnect sharing none keeps the token, marks that connection's accounts not shared, answers `outcome: no_accounts_shared` | brief:L52, C-D2 | CN4 |
| `connect.unshared-marked` | The callback marks accounts missing from a complete assigned list as not shared (the token check's rule); new ones are listed `free` | brief:L61 | CN5 |
| `connect.plan-room` | The `409 plan_account_limit` stays all-or-nothing and carries `plan_room` | brief:L58, C-D4 | CN6 |
| `connect.shared-assets` | Route 151 re-reads what the login shares, each asset with `channel` and `state` (`free` · `connected_here` · `connected_elsewhere` · `not_shared_any_more`), `plan_room`, `is_complete` | brief:L54, L94, C-D5 | CN7 |
| `connect.options` | Route 152 answers `is_configured`, `is_page_login_offered`, `can_manage`, `plan_room`; never `503` | brief:L13, L96 | CN8 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `connect.cancel` | a cancel body is a `400`; the state lives 10 minutes | spent, `200 cancelled` |
| `connect.outcome` | no outcome field | `outcome` on every success |
| `connect.missing-permissions-named` | bare `422` | names the permissions |
| `connect.business-mismatch-named` | bare `409` | names the expected business |
| `connect.no-accounts-shared` | connection + token saved, `200 accounts: []` | first: `422`, nothing saved · reconnect: marked |
| `connect.unshared-marked` | only the daily token check marks | the callback marks too |
| `connect.plan-room` | `limit`, `used`, `upgrade_required` | + `plan_room` |
| `connect.shared-assets` | no re-read route | route 151 |
| `connect.options` | none | route 152 |
