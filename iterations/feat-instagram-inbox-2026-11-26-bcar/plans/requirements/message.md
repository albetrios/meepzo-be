# Requirements — message — sub-domain 2.B

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `message.inbound-once` | every inbound DM kind is written once per Meta id by the intake's event transaction | rule 1, AC 1 | K1, CV2 |
| `message.outbound-captured` | automation and broadcast sends are written by the one result save with their text | rule 2, AC 2 | K1 |
| `message.team-reply-direct` | route 165 sends directly with the window, stops, usage and idempotency guards; `sending` → `sent` / `failed`; not counted in the month limit | rule 3, AC 3, I-D9, I-D10 | CV5 |
| `message.echo-matched` | echoes of our sends are matched by Meta's id, never stored twice | rule 2 | 2.10 |
| `message.edit-unsent` | an edit replaces the text; unsent erases text and copied files | rule 17, AC 10 | 2.B.1 |
| `message.read-receipts` | `messaging_seen` subscribed; `seen_at` set on our messages | rule 16 | CV9 |
| `message.reactions` | route 166 reacts / unreacts; inbound reactions are messages of kind `reaction` | rule 16 | 2.B |
| `message.files-copied` | inbound files are copied into uploads by a job; Meta's link shown until then | rule 7, I-D7 | 2.B.10 |
| `message.sender-type-kind` | every message has `sender_type` and `kind` with its links | I-D14 | 2.B.3 |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `message.inbound-once` | text kept 8 days in webhook events only | a conversation message, 12 months |
| `message.outbound-captured` | no text stored | text stored |
| `message.team-reply-direct` | no team send | direct send |
| `message.echo-matched` | echo dropped / owner_message | matched |
| `message.edit-unsent` | both skipped | stored as described |
| `message.read-receipts` | not subscribed | stored |
| `message.reactions` | — | new ⚠️ I1 |
| `message.files-copied` | — | copied |
| `message.sender-type-kind` | — | new |
