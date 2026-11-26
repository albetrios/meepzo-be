# Requirements — conversation — sub-domain 2.A

| Identifier | Requirement | Source | Route review |
| --- | --- | --- | --- |
| `conversation.created-once` | one conversation per contact, created by its first message in the same transaction | rule 11 | CV2 |
| `conversation.list` | route 155 lists with filters and keyset paging | rule 14 | 2.A |
| `conversation.counts` | route 156 answers unread / mine / unassigned / waiting-on-us | rule 14 | 2.A |
| `conversation.changes-polling` | route 157 answers changes since a cursor; a stale cursor asks for a full reload | rule 12, I-D8 | CV7 |
| `conversation.state-and-assignment` | route 159 changes state, holder, snooze with `expected_updated_at` | rule 14 | 2.A |
| `conversation.take-release` | routes 160, 161 take and release; a reply to an unassigned conversation assigns it | rule 4 | CV4, CV6 |
| `conversation.mark-read` | route 162 marks read; sends `mark_seen` when the account setting is on | rule 16 | CV8 |
| `conversation.typing` | route 163 sends the typing indicator inside the window | rule 16 | 2.A |

## Before → after

| Identifier | Before | After |
| --- | --- | --- |
| `conversation.created-once` | — | created lazily |
| `conversation.list` | — | new |
| `conversation.counts` | — | new |
| `conversation.changes-polling` | — | new |
| `conversation.state-and-assignment` | — | new |
| `conversation.take-release` | — | new |
| `conversation.mark-read` | — | new |
| `conversation.typing` | — | new ⚠️ I1 |
