# Requirements — background work

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `background.insight-snapshot` | a daily snapshot after the organization’s day ends: the account + N-D5’s posts; a Meta-down day is a gap | B:32 | IN2 |
| `background.day-count-increment` | each source commit raises its day count once | B:33 | AN1 |
| `background.day-count-fill` | a one-time fill of the day counts from what is stored | N-D4 | AN4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `background.insight-snapshot` | — | new |
| `background.day-count-increment` | source commits write only their own rows | changed |
| `background.day-count-fill` | — | new |
