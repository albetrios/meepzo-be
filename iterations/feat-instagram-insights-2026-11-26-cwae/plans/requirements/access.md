# Requirements — access

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `access.insights-capability` | `instagram_manage_insights` optional; route 153 gains feature `insights`, refused `permission_not_granted` + `reconnect`; routes 185–188 answer empty with `insights_status` | B:26, B:30-31 | IN1, 2.5 |
| `access.analytics-read` | `instagram-account:read` reads 182–188 (Viewer included); no plan gate (N-D1) | B:35 (overridden by N-D1) | AN6, IN7, K5 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `access.insights-capability` | 11 capability features; three login permissions + optional `ads_read` | changed |
| `access.analytics-read` | — | new |
