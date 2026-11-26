# Requirements — privacy — sub-domain 2

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `privacy.erase` | contact erase, Meta data deletion and organization delete remove conversations, messages, notes, copied files | rule 6, AC 5, I-D6 | CV11 |
| `privacy.retention` | message parts older than 12 months are dropped | I-D5 | 2.B.3 |
| `privacy.no-text-in-logs` | message text never reaches a log or Sentry; every new table FORCE RLS | rule 6, AC 6 | K2, K3 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `privacy.erase` | no conversation data | erased on all three |
| `privacy.retention` | — | 12 months |
| `privacy.no-text-in-logs` | — | enforced |
