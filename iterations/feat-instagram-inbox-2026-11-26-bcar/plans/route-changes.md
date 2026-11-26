# Route changes — feat-instagram-inbox-2026-11-26-bcar

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-inbox-2026-11-26-bcar` |
| Mode | initial (Baseline none) |
| Intake mode | brief — from scratch |
| Intake hash | `1082fd1734e6` |
| Date | 2026-11-26 |
| Stage | Step 5 — sub-domain 1 final (I-D15); sub-domain 2 drafted with route numbers 155–169 (`routes-final.md` § 2) |

Proposals under `/api/v1/app`. Gates reuse the contact codes ([I-D4](decisions.md)): `contact:read` · `contact:update`. Instagram-only routes live under `/social/instagram/…` ([I-D1](decisions.md)).

| Change | Count |
| --- | --- |
| NEW | 15 |
| CHANGED | 1 |
| **Total** | **16** (RC-17 folded into RC-6) |

| # | Change | Method + path | Gate | What must be true | Brief |
| --- | --- | --- | --- | --- | --- |
| RC-1 | NEW (route 155) | `GET /social/instagram/conversations` | `contact:read` | the inbox list: keyset by last message; filters `state`, `assignee` (`me` · `none` · a member), `is_unread`, `is_window_closing`, `channel_account_id`, `tag`, `q` (username) | 14 |
| RC-2 | NEW (route 156) | `GET /social/instagram/conversations/counts` | `contact:read` | unread / mine / unassigned counts for the badges | 14 |
| RC-3 | NEW (route 158, 159) | `GET` and `PATCH /social/instagram/conversations/{instagram_conversation_id}` | `contact:read` · `contact:update` | one thread; change `state`, `assignee`, `snoozed_until` (`expected_updated_at`) | 14 |
| RC-4 | NEW (route 160, 161) | `POST /social/instagram/conversations/{instagram_conversation_id}/take` · `/release` | `contact:update` | take = assign to me and pause the bot; release resumes it | 4 |
| RC-5 | NEW (route 164) | `GET /social/instagram/conversations/{instagram_conversation_id}/messages` | `contact:read` | keyset, newest first, every source, with the window's end | 1, 2 |
| RC-6 | NEW (route 165) | `POST /social/instagram/conversations/{instagram_conversation_id}/messages` | `contact:update` | a team reply (text or an upload, `reply_to` optional) **sent directly** with the guards of [I-D10](decisions.md); outside the window `409 window_closed` with the end time; `X-Idempotency-Key` | 3 |
| RC-7 | NEW (route 162) | `POST /social/instagram/conversations/{instagram_conversation_id}/read` | `contact:read` | mark read up to a message; the unread count follows | 7 |
| RC-8 | NEW (route 163) | `POST /social/instagram/conversations/{instagram_conversation_id}/typing` | `contact:update` | the typing indicator ⚠️ | 16 |
| RC-9 | NEW (route 167, 168) | `GET` and `POST /social/instagram/conversations/{instagram_conversation_id}/notes` | `contact:read` · `contact:update` | internal notes | 15 |
| RC-10 | NEW (route 169) | `DELETE /social/instagram/conversations/{instagram_conversation_id}/notes/{instagram_conversation_note_id}` | `contact:update` (author) | remove a note | 15 |
| RC-11 | NEW | `GET` and `POST /saved-replies` | `contact:read` · `contact:update` | the organization's saved replies | 15 |
| RC-12 | NEW | `PATCH` and `DELETE /saved-replies/{saved_reply_id}` | `contact:update` | change or remove | 15 |
| RC-13 | NEW (route 166) | `POST /social/instagram/conversations/{instagram_conversation_id}/messages/{instagram_conversation_message_id}/reactions` | `contact:update` | react to her message ⚠️ | 16 |
| RC-14 | CHANGED (route 19) | `GET /contacts/{contact_id}` | contact:read | + `instagram_conversation` summary (id, state, assignee, unread) | 11 |
| RC-15 | NEW (route 12) | the organization's `mark_seen` setting | `contact:update` | an Instagram account setting `is_mark_seen_on_open_enabled` on route 12, behind the plan feature `mark_seen` (routes-final CV8) | 16 |
| RC-16 | NEW (route 157) | `GET /social/instagram/conversations/changes?since=` (polling, [I-D8](decisions.md)) | `contact:read` | new messages, unread counts, thread changes without a reload | 12 |
| RC-17 | — | team-reply send path | — | folded into RC-6 (direct send, [I-D9](decisions.md)) | 3 |
