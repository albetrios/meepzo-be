# Requirements — operations

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `operations.comment-list` | route 175: every comment on the account’s posts and reels, newest first; filters post and answered; the automation’s answer beside it | B:5-6, B:22, B:42 | IC1, IC2, 1.8 |
| `operations.comment-moderation` | routes 176–179: reply publicly, hide, unhide, delete — Meta first, then our row | B:7-8, B:44 | IC3, IC4 |
| `operations.mention-list` | route 180: the stored mentions, newest first, by source | B:9, B:22, B:45 | IM1, IM2 |
| `operations.tagged-media` | route 181: posts the account is tagged in, read live from Meta | B:11, B:46 | IM6 |
| `operations.mention-trigger` | a 16th trigger type `mention` on routes 28 / 30, optional `sources` | B:10, B:22, B:45 | IM3, IM4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `operations.comment-list` | — | new |
| `operations.comment-moderation` | — | new |
| `operations.mention-list` | — | new |
| `operations.tagged-media` | — | new |
| `operations.mention-trigger` | — | new |
