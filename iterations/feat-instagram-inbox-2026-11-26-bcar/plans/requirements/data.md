# Requirements — data — db-changes

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `data.instagram-conversations` | `app.instagram_conversations` | rule 11 | 2.A.3 |
| `data.instagram-conversation-messages` | `app.instagram_conversation_messages` (monthly) | rule 11 | 2.B.3 |
| `data.instagram-conversation-notes` | `app.instagram_conversation_notes` | rule 15 | 2.C.3 |
| `data.saved-replies` | `app.saved_replies` | rule 15 | 3.3 |
| `data.mark-seen-on-open-setting` | `instagram_account_settings.is_mark_seen_on_open_enabled` | rule 16 | CV8 |
| `data.upload-purpose` | an upload purpose for copied Instagram DM files | I-D7 | CVC8 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `data.instagram-conversations` | — | new table |
| `data.instagram-conversation-messages` | — | new table |
| `data.instagram-conversation-notes` | — | new table |
| `data.saved-replies` | — | new table |
| `data.mark-seen-on-open-setting` | — | new column |
| `data.upload-purpose` | — | new value |
