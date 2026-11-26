# Route changes — feat-instagram-inbox-2026-11-26-bcar

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-inbox-2026-11-26-bcar` |
| Mode | initial (Baseline none) |
| Intake mode | brief — from scratch |
| Intake hash | `1082fd1734e6` |
| Date | 2026-11-26 |
| Stage | Steps 1–3 draft — gates pending Q3, the stream pending Q7 |

Proposals under `/api/v1/app`. Gates shown as `read` / `reply` / `manage` until Q3 names the codes.

| Change | Count |
| --- | --- |
| NEW | 16 |
| CHANGED | 1 |
| **Total** | **17** |

| # | Change | Method + path | Gate | What must be true | Brief |
| --- | --- | --- | --- | --- | --- |
| RC-1 | NEW | `GET /contact-threads` | read | the inbox list: keyset by last message; filters `state`, `assignee` (`me` · `none` · a member), `is_unread`, `is_window_closing`, `channel_account_id`, `tag`, `q` (username) | 14 |
| RC-2 | NEW | `GET /contact-threads/counts` | read | unread / mine / unassigned counts for the badges | 14 |
| RC-3 | NEW | `GET` and `PATCH /contacts/{contact_id}/thread` | read · manage | one thread; change `state`, `assignee`, `snoozed_until` (`expected_updated_at`) | 14 |
| RC-4 | NEW | `POST /contacts/{contact_id}/thread/take` · `/release` | reply | take = assign to me and pause the bot; release resumes it | 4 |
| RC-5 | NEW | `GET /contacts/{contact_id}/thread/messages` | read | keyset, newest first, every source, with the window's end | 1, 2 |
| RC-6 | NEW | `POST /contacts/{contact_id}/thread/messages` | reply | a team reply (text or an upload, `reply_to` optional) through the paced sender; outside the window `409 window_closed` with the end time; `X-Idempotency-Key` | 3 |
| RC-7 | NEW | `POST /contacts/{contact_id}/thread/read` | read | mark read up to a message; the unread count follows | 7 |
| RC-8 | NEW | `POST /contacts/{contact_id}/thread/typing` | reply | the typing indicator ⚠️ | 16 |
| RC-9 | NEW | `GET` and `POST /contacts/{contact_id}/thread/notes` | read · reply | internal notes | 15 |
| RC-10 | NEW | `DELETE /contacts/{contact_id}/thread/notes/{contact_thread_note_id}` | reply (author) | remove a note | 15 |
| RC-11 | NEW | `GET` and `POST /saved-replies` | read · manage | the organization's saved replies | 15 |
| RC-12 | NEW | `PATCH` and `DELETE /saved-replies/{saved_reply_id}` | manage | change or remove | 15 |
| RC-13 | NEW | `POST /contacts/{contact_id}/thread/messages/{contact_thread_message_id}/reactions` | reply | react to her message ⚠️ | 16 |
| RC-14 | CHANGED | `GET /contacts/{contact_id}` | contact:read | + `thread` summary (state, assignee, unread) | 11 |
| RC-15 | NEW | the organization's `mark_seen` setting | manage | reuses the plan feature `mark_seen` (R5); where it is set — the plan decides | 16 |
| RC-16 | NEW | `GET /inbox/events` (SSE) **or** `GET /contact-threads/changes?since=` (polling) | read | new messages, unread counts, thread changes without a reload | 12 |
| RC-17 | NEW | team-reply send path | — | pending Q8 | 3 |
