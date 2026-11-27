# Acceptance — feat-instagram-inbox-2026-11-26-bcar

Filled at Close: `pass` (test file › test name, or a command), `partial`, `open` or `deferred`.

## Feature acceptance criteria

| Item | Source | Result | Evidence |
| --- | --- | --- | --- |
| AC-7.1 — `app.instagram_outgoing_messages` exists with every part, key, check and policy; `app.in… | features/automation-messages-rename | open | |
| AC-7.2 — The sending, broadcast, channel-account and webhook suites pass unchanged in behaviour; `i… | features/automation-messages-rename | open | |
| AC-1.1 — A contact's first message creates exactly one conversation; a second never creates another… | features/conversation-inbox | open | |
| AC-1.2 — Route 155 filters by state, holder (`me` · `none` · a member), unread, window closing, acc… | features/conversation-inbox | open | |
| AC-1.3 — Route 156's counts are right after a new message, a read, a take and a release. | features/conversation-inbox | open | |
| AC-1.4 — Route 157 returns every conversation changed since the cursor; a cursor older than 24 hour… | features/conversation-inbox | open | |
| AC-1.5 — Route 159 changes state, holder and snooze; a stale `expected_updated_at` is `409 record_c… | features/conversation-inbox | open | |
| AC-1.6 — Route 162 marks read and sends `mark_seen` only when the account's `is_mark_seen_on_open_e… | features/conversation-inbox | open | |
| AC-1.7 — Route 163 sends typing inside the window and answers `409 instagram_conversation_window_cl… | features/conversation-inbox | open | |
| AC-1.8 — Notes (167–169): added, listed, deleted by the author; another member's note needs `contac… | features/conversation-inbox | open | |
| AC-2.1 — Every inbound kind the classifier knows appears once, in Meta's order, with `sender_type:… | features/conversation-messages | open | |
| AC-2.2 — Every automation and broadcast send appears with its text, automation or broadcast and sta… | features/conversation-messages | open | |
| AC-2.3 — A team reply inside the window is sent directly and stored `sent` with Meta's id; outside… | features/conversation-messages | open | |
| AC-2.4 — A team reply interrupted before Meta answered is settled by the repair sweep. | features/conversation-messages | open | |
| AC-2.5 — An edit replaces the text and marks it edited; an unsent message's text and copied files a… | features/conversation-messages | open | |
| AC-2.6 — A read receipt sets `seen_at` on our messages up to it. | features/conversation-messages | open | |
| AC-2.7 — An inbound file is copied into uploads and served from the copy; until then Meta's link is… | features/conversation-messages | open | |
| AC-2.8 — Route 166 reacts and unreacts inside the window. | features/conversation-messages | open | |
| AC-3.1 — While a conversation is taken, every automation DM to that contact on that account waits (… | features/hand-off | open | |
| AC-3.2 — Release, close, or 24 hours without a team message ends the hold; 23 hours does not. | features/hand-off | open | |
| AC-3.3 — An echo our app did not send takes the conversation as `instagram_app`; an echo of a team… | features/hand-off | open | |
| AC-3.4 — Taking a conversation another member holds is `409 instagram_conversation_taken`; replying… | features/hand-off | open | |
| AC-4.1 — Routes 170–174 add, list, read, change and delete; a title taken (any case) is `409 saved_… | features/saved-replies | open | |
| AC-4.2 — Route 165 with `saved_reply_id` fills `{first_name}` / `{username}` and counts the use; an… | features/saved-replies | open | |
| AC-5.1 — A new DM notifies the holder, else every `contact:update` holder, per their in-app and ema… | features/notifications | open | |
| AC-5.2 — A conversation waiting on us with under 2 hours of window left notifies its holder once. | features/notifications | open | |
| AC-6.1 — Erasing a contact, Meta's data deletion for the account and the organization delete remove… | features/privacy | open | |
| AC-6.2 — Message parts older than 12 months are dropped by the upkeep. | features/privacy | open | |
| AC-6.3 — No message text appears in any log line of the tested flows; the three new tenant tables p… | features/privacy | open | |

## Brief acceptance lines

| Item | Source | Proved by | Result |
| --- | --- | --- | --- |
| BRIEF-1 — every inbound kind once, in order | brief AC 1 | AC-2.1 | open |
| BRIEF-2 — our sends with text and result, echo not twice | brief AC 2 | AC-2.2 | open |
| BRIEF-3 — team reply inside the window, refused outside | brief AC 3 | AC-2.3 | open |
| BRIEF-4 — taking pauses the automations | brief AC 4 | AC-3.1, AC-3.2 | open |
| BRIEF-5 — erase removes conversations | brief AC 5 | AC-6.1 | open |
| BRIEF-6 — no text in logs; FORCE RLS | brief AC 6 | AC-6.3 | open |
| BRIEF-7 — keyset lists; unread right | brief AC 7 | AC-1.2, AC-1.3 | open |
| BRIEF-8 — an Instagram-app reply takes the conversation | brief AC 8 | AC-3.3 | open |
| BRIEF-9 — assign, states, snooze, notes, saved replies audited | brief AC 9 | AC-1.5, AC-1.8, AC-4.1 | open |
| BRIEF-10 — unsent text gone; edit shows latest | brief AC 10 | AC-2.5 | open |
| BRIEF-11 — updates without a reload | brief AC 11 | AC-1.4 (polling) | open |
| BRIEF-12 — notifications respect preferences | brief AC 12 | AC-5.1, AC-5.2 | open |
