# Requirements — quality

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `quality.comment-writes-paced` | every Meta write gated like an automation’s: usage gate, circuit, `190` breaks the connection, `503 instagram_unavailable` — nothing changes unless Meta answered | B:32 | K4, IC3 |
| `quality.tenant-isolation` | new tables `instagram_` prefixed, FORCE RLS on `organization_id`, Meta ids bounded | B:34-35 | K3, K5 |
| `quality.mention-privacy` | comment and mention text never in a log; nobody contacted without a live automation | B:36-37 | K2, IM4 |
| `quality.comment-retention` | comments and mentions kept 90 days, monthly parts dropped by the shared upkeep; the contact erase empties text and names | B:38 | IC5, IM5 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `quality.comment-writes-paced` | — | new |
| `quality.tenant-isolation` | — | new |
| `quality.mention-privacy` | — | new |
| `quality.comment-retention` | — | new |
