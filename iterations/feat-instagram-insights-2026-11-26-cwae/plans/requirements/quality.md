# Requirements — quality

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `quality.reads-never-call-meta` | no route calls Meta | B:32, B:46 | K1 |
| `quality.pre-aggregated` | our numbers read day counts only — no scan on page open | B:33 | K2 |
| `quality.tenant-isolation` | new tables `instagram_` prefixed, FORCE RLS on `organization_id` | B:36 | K3 |
| `quality.insights-retention` | day counts, snapshots and story insights kept 13 months by the shared upkeep | B:36 | AN5, IN6 |
| `quality.meta-usage` | the daily job respects Meta usage and the circuit; never on screen open | B:46 | IN2 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `quality.reads-never-call-meta` | — | new |
| `quality.pre-aggregated` | — | new |
| `quality.tenant-isolation` | — | new |
| `quality.insights-retention` | — | new |
| `quality.meta-usage` | — | new |
