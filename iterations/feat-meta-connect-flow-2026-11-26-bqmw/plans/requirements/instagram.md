# Requirements — Instagram account (sub-domain 3, routes-final § 3)

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `instagram.message-access-stored` | The set-up probe stores `message_access` and its check time | brief:L85 | IG1 |
| `instagram.message-access-recheck` | Route 154 runs the probe now (at most once a minute per account), stores it, ends or starts the `access_off` stop | brief:L69 | IG2 |
| `instagram.message-access-shown` | Routes 6, 7 show `instagram.message_access` | brief:L107 | IG4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `instagram.message-access-stored` | logged only | stored |
| `instagram.message-access-recheck` | no route; the stop retests on its own timer | route 154 |
| `instagram.message-access-shown` | not shown | shown |

Deferred: the linked Facebook Page id (brief:L87) — C-D13, after owner test O6.
