# Requirements — data

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `data.instagram-comment` | `app.instagram_comments` — [db-changes § instagram_comment](../db-changes.md#instagram_comment) | B:23-24 | 1.3 |
| `data.instagram-mention` | `app.instagram_mentions` — [db-changes § instagram_mention](../db-changes.md#instagram_mention) | B:23-24 | 2.3 |
| `data.comment-delete` | a deleted comment is soft-gone (`deleted_at` after Meta confirms) | B:32-33 | IC4 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `data.instagram-comment` | — | new |
| `data.instagram-mention` | — | new |
| `data.comment-delete` | — | new |
