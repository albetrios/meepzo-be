# Feature 1 — the inbox

**As** a team member, **I want** one list of every Instagram conversation with what needs me, **so that** no customer waits unseen.

Requirements: `conversation.created-once`, `conversation.list`, `conversation.counts`, `conversation.changes-polling`, `conversation.state-and-assignment`, `conversation.mark-read`, `conversation.typing`, `note.notes`, `data.instagram-conversations`, `data.instagram-conversation-notes`, `data.mark-seen-on-open-setting`.

## Acceptance criteria

- AC-1.1 — A contact's first message creates exactly one conversation; a second never creates another.
- AC-1.2 — Route 155 filters by state, holder (`me` · `none` · a member), unread, window closing, account, tag and username, keyset-paged newest first.
- AC-1.3 — Route 156's counts are right after a new message, a read, a take and a release.
- AC-1.4 — Route 157 returns every conversation changed since the cursor; a cursor older than 24 hours answers `is_full_reload_needed`.
- AC-1.5 — Route 159 changes state, holder and snooze; a stale `expected_updated_at` is `409 record_changed`; a snoozed conversation reopens at its time or on a new message.
- AC-1.6 — Route 162 marks read and sends `mark_seen` only when the account's `is_mark_seen_on_open_enabled` is on and the plan allows it.
- AC-1.7 — Route 163 sends typing inside the window and answers `409 instagram_conversation_window_closed` outside it.
- AC-1.8 — Notes (167–169): added, listed, deleted by the author; another member's note needs `contact:delete` (`403` otherwise).
