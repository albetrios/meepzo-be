# Decisions — feat-instagram-inbox-2026-11-26-bcar

Add-only. Kind: `RED` (answered by the user), `AMBER` (safe default, still open), `SCOPE`. Questions `Q1`–`Q8` ([coverage.md](coverage.md)).

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| I-D1 | Q1 — where the inbox tables live and their names | `contact_threads` family · conversations family | **Instagram-prefixed conversations family** in `app`: `app.instagram_conversations` (one per contact), `app.instagram_conversation_messages` (split by month), `app.instagram_conversation_notes` — "all Instagram tables carry the `instagram_` prefix" (your call, over the parent-prefix default). Routes under `/social/instagram/conversations/…`; path ids `{instagram_conversation_id}`, `{instagram_conversation_message_id}`, `{instagram_conversation_note_id}`. The `channel` column is dropped (the table names the channel; Messenger would get its own tables, as `instagram_messages` does) | 2026-11-26 | user | RED |
| I-D2 | Q1 follow-up — saved replies | Instagram-only · shared | `app.saved_replies` stays **shared** across channels (plain text, like contacts — P48); routes `/saved-replies` | 2026-11-26 | Claude | AMBER |
| I-D3 | Q2 — what a hand-off pauses and when it ends | all bot DMs 24 h · all bot DMs 6 h · default reply only | **every automation DM to that contact on that account waits** while the conversation is taken (by a member, or by "Instagram app" on an echo our app did not send); it ends on release, close, or **24 hours with no team message** | 2026-11-26 | user | RED |
| I-D4 | Q3 — permission codes | new inbox codes · reuse contact codes | **reuse contact codes**: `contact:read` reads conversations, messages, notes, saved replies; `contact:update` replies, takes, releases, assigns, changes state, writes notes and saved replies | 2026-11-26 | user | RED |
| I-D5 | Q4 — how long DM text is kept | 6 · 12 · 24 months | **12 months**: monthly parts older than that are dropped by the partition upkeep; deleting a contact erases at once | 2026-11-26 | user | RED |
| I-D6 | Q5 — Meta's data-deletion request | erase conversations · keep D22 | **erase that account's conversations, messages, notes and copied files**; contacts themselves stay (launch D22 holds for contacts — superseded for conversations only) | 2026-11-26 | user | RED |
| I-D7 | Q6 — files in DMs | copy · link only | **copy into our storage** by a background job (a new upload purpose, a server-side download of Meta's file) | 2026-11-26 | user | RED |
| I-D8 | Q7 — updates without a reload | polling · SSE | **polling first**: `GET /social/instagram/conversations/changes?since=`; SSE may come later without a data change | 2026-11-26 | user | RED |
| I-D9 | Q8 — how team replies are sent | widen `instagram_messages` · separate path | **stored only as conversation messages (source `team`) and sent directly in the request** — no lane, no pacing, no minute/day counts (your call: "replace it with conversation messages, send directly") | 2026-11-26 | user | RED |
| I-D10 | Q8 follow-up — the direct send's guards and the monthly limit | count · don't count · fast ticket | **guards**: the 24-hour window; the account's hard stops (`login_expired`, `access_off`, `account_not_shared`); Meta's usage at `META_USAGE_WAIT_PERCENT` refuses with the wait time; `X-Idempotency-Key`. Saved `sending` → Meta called after commit → `sent` / `failed`; a stuck `sending` repaired by the existing sweep; the echo matched by Meta's message id (never shown twice, never an "Instagram app" hand-off). **Team replies do not count** against the plan's monthly message limit (it limits automated DMs). The user sent a naming message instead of answering — default kept, open | 2026-11-26 | Claude | AMBER |
| I-D11 | Backfill of conversations before the connect | backfill · start empty | start empty at the connect; a later backfill reads Meta's conversations edge once its limits are tested | 2026-11-26 | Claude | AMBER |
| I-D12 | The Human agent window | a column · derived | derived from `contact_activities.last_direct_message_received_at` with a window kind (24 h now, 7 days after the Human agent tag's App Review) — no column | 2026-11-26 | Claude | AMBER |
| I-D13 | Keep or replace `app.instagram_messages` next to conversation messages | team replies only · replace it | **keep both, rename** `app.instagram_messages` → **`app.instagram_automation_messages`** (your call): it stays the paced sender's ledger (lanes, claims, retries, plan counts, no text, ~30 days); conversation messages hold the history. Note: it also holds broadcast sends — the name is kept as chosen unless changed | 2026-11-26 | user | RED |

## Owner items (need the Meta dev app)

| # | Test | Settles |
| --- | --- | --- |
| I1 | Typing indicator, `mark_seen`, sending a reaction and `reply_to` under Unified Login | RC typing / reactions / reply-to |
| I2 | Meta's attachment URL lifetime and download from the server (`lookaside.fbsbx.com`) | WC-6 |
