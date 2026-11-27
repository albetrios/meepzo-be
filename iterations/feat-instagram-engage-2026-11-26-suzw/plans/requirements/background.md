# Requirements — background work

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `background.comment-store` | the webhook comment processing stores every comment once, matched or not (WC-1) | B:42-43 | IC1 |
| `background.mention-store` | a mention event is stored once and starts a live `mention` automation once (WC-3) | B:9-10 | IM1–IM4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `background.comment-store` | a comment stored only per matching automation (comment log) | changed |
| `background.mention-store` | — | new |
