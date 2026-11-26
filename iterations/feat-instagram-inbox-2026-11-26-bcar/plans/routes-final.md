# Meepzo API — Instagram inbox, final routes, sub-domain by sub-domain

**Route review final — 2026-11-26.** Every sub-domain is confirmed; the frontend may kick off on these routes.

Started from branch `feat/instagram-automation` at `8f36d39`. Every decision reads **today → after** (`SD/` =
`src/domains/app/sub-domains/`). Sources: [`coverage.md`](coverage.md), [`decisions.md`](decisions.md) (I-D1–I-D14),
[`route-changes.md`](route-changes.md), [`db-changes.md`](db-changes.md), [`worker-changes.md`](worker-changes.md).

## File header — legend

Paths are under `/api/v1/app`; `{x_id}` is a public id; **Gate** is the permission the caller needs (contact codes,
[I-D4](decisions.md)); **Idem** `req` = `X-Idempotency-Key` required. New route numbers continue from **155**
(the connect flow ended at 154).

## File header — sub-domains (in build order)

| # | Sub-domain | Folder (`SD/…`) | Paths | Routes | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Instagram automation message (rename) | `instagram-sending/instagram-message/` → `instagram-sending/instagram-automation-message/` | none | 0 | — | **final (rev 1, confirmed 2026-11-26)** |
| 2 | Instagram conversation | `instagram-conversation/` (new) with nested `instagram-conversation-message/`, `instagram-conversation-note/` | `/social/instagram/conversations…` | 15 new (155–169), 2 changed (12, contact read) | 1, contacts, upload | **final (rev 1, confirmed 2026-11-26)** |
| 3 | Saved reply | `saved-reply/` (new, shared across channels — [I-D2](decisions.md)) | `/saved-replies…` | 5 new (170–174) | — | **final (rev 1, confirmed 2026-11-26)** |

## File header — code layout and tables without routes

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.instagram_automation_messages` (renamed) | `instagram-sending/instagram-automation-message/` | the paced sender (unchanged) |
| 2 | `app.instagram_conversation_messages` | `instagram-conversation/instagram-conversation-message/` | the webhook intake (inbound), the result save (automation / broadcast), the team-reply route |

## File header — rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **One write path per message source** (brief rule 11): inbound by the intake's event transaction, automation / broadcast by the sender's one result save, `team_member` by its route — never a second writer. |
| K2 | **Message text never reaches a log or Sentry** — only public ids, kinds and Meta codes. |
| K3 | **Every new tenant table** has FORCE RLS with USING and WITH CHECK on `organization_id`, the retention-sweep arm where the upkeep drops parts. |

---

## 1. Instagram automation message (rename) — final (rev 1, confirmed 2026-11-26) — no routes

Code: `SD/instagram-sending/instagram-message/` — the paced sender's ledger (one row per automation or broadcast DM;
no text; split by ISO week; ~30 days) and its nested send attempts. This sub-domain only **renames** it
([I-D13](decisions.md)); behaviour, columns and routes are unchanged.

### 1.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| AM1 | **Table** `app.instagram_messages` → **`app.instagram_automation_messages`**, by one migration: the parent, its weekly parts and the DEFAULT part, its keys, checks, indexes and RLS policy names (`…_instagram_messages_…` → `…_instagram_automation_messages_…`), the composite foreign keys that point at it (`broadcast_id` link, send attempts), and the partition upkeep's CASE entry (`migrations/20261125190000_app_partition_upkeep.sql:95`). Expand-only is not possible for a rename: it runs in one transaction, and the release that ships it is the first to read the new name (the previous release stops before the migration — the deploy order the migration runner already enforces). |
| AM2 | **Code follows the table** (the repo's naming rule — a sub-domain is named for its table; reuse rule — never old and new side by side): the folder `instagram-message/` → `instagram-automation-message/`, files `instagram-message.*` → `instagram-automation-message.*`, the Drizzle table export, `InstagramMessageService` / `Repository` / types → `InstagramAutomationMessage…`, the FORCE-RLS list (`src/infrastructure/database/utils/force-rls-tables.constants.ts:42`), the partition upkeep spec (`src/domains/app/workers/app-partition-upkeep.constants.ts`), the RLS test matrix. Other option: rename the table only and keep the code names — rejected, the names would disagree for good. |
| AM3 | **What does not change**: the public id prefix `igm_` (ids already handed out stay valid), the routes that read it (24–26, 36–37 — failed-message summaries and retries), every behaviour. The nested `instagram_send_attempts` keeps its name (it is the attempt of a send, not of an automation). |
| AM4 | **Name note** — the table also holds broadcast sends ([I-D13](decisions.md)); the TSDoc and the overview say so on the first line. |

### 1.2 Open questions

None.

### 1.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_messages` → `app.instagram_automation_messages` | renamed with every dependent name; columns unchanged |

### 1.4 Permissions

No change — the routes reading it keep their gates.

### 1.5 Common to every route

n/a — no routes.

### 1.6 Objects returned

No change (the `igm_` ids and response shapes stay).

### 1.7 Routes

None added or changed.

### 1.8 Request details

n/a.

### 1.9 Errors

n/a.

### 1.10 Rules worth knowing

- A conversation message of an automation or broadcast (sub-domain 2) links its ledger row by `instagram_automation_message_id`.

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| AMC1 | AM1: one migration renaming the table, parts, constraints, indexes, policy, foreign keys and the upkeep entry; `pnpm db:migrate:lint`; the restore smoke unaffected |
| AMC2 | AM2: folder, files, identifiers, the FORCE-RLS list, the upkeep spec, the public-id registry comment, overviews (`instagram-sending.overview.md`, `instagram-message.overview.md` → renamed), `src/domains/CLAUDE.md`'s domain map, docs mentioning the table |
| AMC3 | Tests: the whole instagram-sending, broadcast, channel-account and webhook suites pass unchanged in behaviour; the RLS matrix and the FORCE-RLS policy test name the new table; `pnpm test:rls-role:changed` |

### 1.12 Nested sub-domains

`instagram-send-attempt` (schema and repository inside the folder) — moves with the folder; its table name is unchanged.

---

## 2. Instagram conversation — final (rev 1, confirmed 2026-11-26) — nested sub-domains 2.A–2.C

Code: `SD/instagram-conversation/` (new) — the conversation at the folder root (2.A), `instagram-conversation-message/`
(2.B), `instagram-conversation-note/` (2.C). One conversation per contact (a contact is already per organization,
Instagram account and person); every message both ways for 12 months; the team reads, takes, replies and notes.
Route numbers 155–169.

2.1 Decisions · 2.2 Open questions · 2.3 Tables · 2.4 Permissions · 2.5 Common · 2.6 Objects · 2.7 Routes · 2.8 Request
details · 2.9 Errors · 2.10 Rules · 2.11 Code changes · 2.12 Nested sub-domains — then 2.A, 2.B, 2.C.

### 2.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| CV1 | **Folder and names** ([I-D1](decisions.md)): `SD/instagram-conversation/`; tables `app.instagram_conversations`, `app.instagram_conversation_messages`, `app.instagram_conversation_notes`; public-id prefixes `igcv`, `igcm`, `igcn`; path ids `{instagram_conversation_id}`, `{instagram_conversation_message_id}`, `{instagram_conversation_note_id}` registered in `PARAM_NAME_TO_ENTITY` (`src/shared/utils/identity/public-id.util.ts`). |
| CV2 | **Created lazily, once**: the first message of a contact (inbound, or the first automation / broadcast send) creates its conversation in the same transaction (an upsert on the 1:1 key). Conversations start empty at the connect ([I-D11](decisions.md)). |
| CV3 | **Gates reuse the contact codes** ([I-D4](decisions.md)): `contact:read` reads everything here; `contact:update` takes, releases, assigns, changes state, replies, types, reacts, writes notes; deleting someone else's note needs `contact:delete`. |
| CV4 | **Hand-off** ([I-D3](decisions.md)): a conversation taken by a member — or by "Instagram app" when an echo our app did not send arrives — holds **every automation DM** to that contact on that account: the send gate answers a new hold reason `conversation_taken`, so the message **waits** (it is not skipped; the existing 7-day expiry still applies). Release, close, or **24 hours** with no `team_member` message ends it (`INSTAGRAM_CONVERSATION_IDLE_RELEASE_HOURS = 24`). Today: only the default reply is suppressed for 6 h (`automation-run-matching.util.ts:451`) — that rule is kept for an untaken conversation. |
| CV5 | **Team replies are sent directly** ([I-D9](decisions.md), [I-D10](decisions.md)) by route 165 — not through `app.instagram_automation_messages` or a lane: the 24-hour window, the account's hard stops, Meta's usage at `META_USAGE_WAIT_PERCENT`, `X-Idempotency-Key`; saved `sending`, Meta called after the commit, then `sent` / `failed`; not counted in the month limit. |
| CV6 | **Replying assigns**: a reply to an unassigned conversation assigns it to the replier (a take); a reply to one another member holds is allowed and leaves the holder. Other option: refuse replies to someone else's conversation — rejected, it blocks cover. |
| CV7 | **Polling** ([I-D8](decisions.md)), route 157: `since` is an opaque cursor (time + id); the answer lists changed conversations (summary) and `next_since`; a cursor older than 24 hours answers `meta.is_full_reload_needed: true` instead of a list. |
| CV8 | **Mark seen on open** (rule 16): a new Instagram account setting `is_mark_seen_on_open_enabled` beside today's `is_mark_seen_after_reply_enabled` (`instagram-account-settings.schema.ts:63`), behind the same plan feature `mark_seen` and its Meta test; route 162 (mark read) sends Meta's `mark_seen` when it is on. ⚠️ owner test I1. |
| CV9 | **Read receipts**: `messaging_seen` joins `INSTAGRAM_WEBHOOK_SUBSCRIBED_FIELDS`; the intake sets `seen_at` on our outbound messages up to the receipt (today a receipt is never saved). Existing accounts are re-subscribed by the account set-up job on its next run. |
| CV10 | **Notifications** (rule 15): two new kinds through `notifyOrganizationKind` — `instagram_conversation_new_message` (to the holder, else members with `contact:update`) and `instagram_conversation_window_closing` (to the holder, under 2 hours left, waiting on us) — each obeying member preferences (in-app and email). |
| CV11 | **Erase** ([I-D6](decisions.md)): a `ContactErasureStep` deletes the contact's conversation, messages, notes and copied files; Meta's data deletion erases the account's conversations the same way; the organization delete cascades. |

### 2.2 Open questions

None RED. Owner tests: I1 (typing, `mark_seen`, reactions, `reply_to`), I2 (downloading Meta's files).

### 2.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_conversations` | one per contact: state, holder, unread, last message, response times | unique `(organization_id, contact_id)`; FORCE RLS |
| `app.instagram_conversation_messages` | every message both ways | split by month of `sent_at`, kept 12 months; once per Meta id |
| `app.instagram_conversation_notes` | internal notes | soft delete |

```text
app.contacts ──1:1── app.instagram_conversations ──┬──< app.instagram_conversation_messages (monthly)
                                                   │        └──> app.instagram_automation_messages (copy of the id)
                                                   │        └──> upload (copied file)
                                                   └──< app.instagram_conversation_notes ──> tenancy.memberships (author)
app.instagram_conversations ──> tenancy.memberships (holder)
```

### 2.4 Permissions

| Code | Allows | Routes |
| --- | --- | --- |
| `contact:read` | list, counts, changes, one conversation, messages, notes, mark read | 155–158, 162, 164, 167 |
| `contact:update` | change, take, release, typing, reply, react, add a note, delete own note | 159–161, 163, 165, 166, 168, 169 |
| `contact:delete` | delete another member's note | 169 |

### 2.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app/social/instagram/conversations` |
| Writes | `X-Idempotency-Key` on 165 (reply) and 168 (note); take / release / read / typing / react are safe to repeat — none |
| Success | `200` `{ data, meta }`; `DELETE` → `204` |
| Lists | keyset `limit` (1–100) + `after` |

### 2.6 Objects returned

| Object | Where |
| --- | --- |
| Instagram conversation, conversation summary, counts, changes | 2.A.6 |
| Instagram conversation message | 2.B.6 |
| Instagram conversation note | 2.C.6 |

### 2.7 Routes

| # | Method | Path (under `/social/instagram/conversations`) | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 155 | GET | `` (root) | The inbox list | `contact:read` | |
| 156 | GET | `/counts` | Badge counts | `contact:read` | |
| 157 | GET | `/changes` | What changed since a cursor (polling) | `contact:read` | |
| 158 | GET | `/{instagram_conversation_id}` | One conversation | `contact:read` | |
| 159 | PATCH | `/{instagram_conversation_id}` | State, holder, snooze | `contact:update` | |
| 160 | POST | `/{instagram_conversation_id}/take` | Take it (bot waits) | `contact:update` | |
| 161 | POST | `/{instagram_conversation_id}/release` | Release it (bot resumes) | `contact:update` | |
| 162 | POST | `/{instagram_conversation_id}/read` | Mark read (and `mark_seen` when on) | `contact:read` | |
| 163 | POST | `/{instagram_conversation_id}/typing` | Typing indicator ⚠️ | `contact:update` | |
| 164 | GET | `/{instagram_conversation_id}/messages` | Messages, newest first | `contact:read` | |
| 165 | POST | `/{instagram_conversation_id}/messages` | Team reply, sent directly | `contact:update` | req |
| 166 | POST | `/{instagram_conversation_id}/messages/{instagram_conversation_message_id}/reactions` | React or unreact ⚠️ | `contact:update` | |
| 167 | GET | `/{instagram_conversation_id}/notes` | Notes | `contact:read` | |
| 168 | POST | `/{instagram_conversation_id}/notes` | Add a note | `contact:update` | req |
| 169 | DELETE | `/{instagram_conversation_id}/notes/{instagram_conversation_note_id}` | Remove a note | `contact:update` (own) · `contact:delete` | |
| 12 | PATCH | `/social/instagram/accounts/{channel_account_id}/settings` | **+ `is_mark_seen_on_open_enabled` (changed)** | `instagram-account:manage` | |
| 19 | GET | `/contacts/{contact_id}` | **+ `instagram_conversation` summary (changed)** | `contact:read` | |

### 2.8 Request details

In 2.A.8, 2.B.8, 2.C.8.

### 2.9 Errors

Every route: `404` · `instagram_conversation_not_found` (another organization's, or the contact erased). Each route's own in 2.A.9–2.C.9.

### 2.10 Rules worth knowing

- One write path per source (K1): inbound — the intake's event transaction; automation / broadcast — the sender's one result save (which now receives the text it sent); `team_member` — route 165.
- An echo of a team reply or of an automation send is matched by Meta's message id and never stored twice nor read as an Instagram-app reply.
- The 24-hour window is read from `contact_activities.last_direct_message_received_at` (`isInstagramChatWindowOpen`, 23 h 45 m), never stored ([I-D12](decisions.md)).

### 2.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| CVC1 | CV1: folder, three schemas, migrations (monthly parts via `app.fn_create_monthly_partitions`, the upkeep CASE entry with 12 months), FORCE-RLS list, public-id entities and prefixes, param registry |
| CVC2 | CV2, K1: the intake writes inbound messages in its event transaction (dispatch gains `mid`, attachments, `reply_to`); the sender's call answers what it sent and the result save writes the automation / broadcast message |
| CVC3 | CV4: the send gate's `conversation_taken` hold; the idle-release sweep (24 h); the Instagram-app echo takes the conversation |
| CVC4 | CV5, CV6: route 165's direct send with its guards, the repair of a stuck `sending`, auto-assign on reply |
| CVC5 | CV7: route 157 and its cursor |
| CVC6 | CV8, CV9: the settings field and route 12; `messaging_seen` subscribed and stored |
| CVC7 | CV10: two notification kinds, their window-closing sweep, copy in every locale |
| CVC8 | CV11: the contact erasure step; Meta's data deletion erases conversations; the copy job (WC-6) and its upload purpose |
| CVC9 | Tests: every route's errors (2.A.9–2.C.9); intake once-per-id, edits, unsent, receipts; hand-off hold and 24 h release; direct send guards (window, stop, usage, idempotency); echo matching; erase (contact, Meta, organization); RLS matrix for the three tables; `pnpm test:rls-role:changed` |

### 2.12 Nested sub-domains

| Nested sub-domain | Folder (`SD/instagram-conversation/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 2.A Instagram conversation | folder root | `app.instagram_conversations` | 155–163 | final |
| 2.B Instagram conversation message | `instagram-conversation-message/` | `app.instagram_conversation_messages` | 164–166 | final |
| 2.C Instagram conversation note | `instagram-conversation-note/` | `app.instagram_conversation_notes` | 167–169 | final |

### 2.A Instagram conversation — folder root — final (rev 1, confirmed 2026-11-26)

#### 2.A.1 Decisions

CV1–CV8 apply. List sort: `last_message_at` desc, then id.

#### 2.A.2 Open questions

None.

#### 2.A.3 Tables and relations

`app.instagram_conversations` — standard columns (`id`, `public_id`, `organization_id`, `created_at`, `updated_at`) plus:
`channel_account_id` (copy), `contact_id` (unique per organization, → contacts `ON DELETE CASCADE`), `state` (`open` ·
`waiting_on_us` · `waiting_on_contact` · `closed`), `taken_by` (`team_member` · `instagram_app`, nullable),
`taken_by_membership_id` (→ memberships, cleared when the member leaves), `taken_at`, `last_team_message_at`,
`snoozed_until`, `unread_count` (≥ 0), `last_read_at`, `last_message_at`, `last_message_sender_type`,
`last_message_preview` (≤ 200 characters), `first_response_at`, `last_response_at`, `meta_conversation_id` (nullable).
Checks: state and `taken_by` lists; `taken_by` and its member agree (`instagram_app` → no member). Indexes: the list
keyset `(organization_id, last_message_at desc, id desc)`; partial `(organization_id, taken_by_membership_id)` where taken;
partial `(organization_id, last_message_at)` where `unread_count > 0`; the idle sweep `(last_team_message_at)` where taken.
FORCE RLS (K3).

#### 2.A.4 Permissions

As 2.4 for routes 155–163.

#### 2.A.5 Common to every route

As 2.5.

#### 2.A.6 Objects returned

| Object | Fields |
| --- | --- |
| Conversation | `id`, `contact` (`id`, `username`, `full_name`, `profile_picture_url`), `channel_account_id`, `state`, `taken_by`, `taken_by_member_id`, `taken_at`, `snoozed_until`, `unread_count`, `last_message` (`sender_type`, `kind`, `preview`, `at`), `window` (`is_open`, `ends_at`, `kind`: `standard`), `first_response_at`, `last_response_at`, `updated_at` |
| Counts | `{ unread, mine, unassigned, waiting_on_us }` |
| Changes | `data: [conversation summaries]`, `meta: { next_since, is_full_reload_needed }` |

#### 2.A.7 Routes (155–163)

As 2.7.

#### 2.A.8 Request details

| Route | Body / query |
| --- | --- |
| 155 | `state`, `assignee` (`me` · `none` · a member id), `is_unread`, `is_window_closing`, `channel_account_id`, `tag`, `q` (username, 2–64), `limit`, `after` |
| 157 | `since*` (the last `next_since`) |
| 159 | `state`, `taken_by_member_id` (assign / unassign with `null`), `snoozed_until` (future, ≤ 30 days, or `null`), `expected_updated_at` |
| 162 | `up_to_message_id` (optional; default the newest) |
| 160, 161, 163 | none |

#### 2.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 159 | `400` · `invalid_field` | bad state, past or too-far snooze, a member not of this organization |
| 159 | `409` · `record_changed` | stale `expected_updated_at` |
| 160 | `409` · `instagram_conversation_taken` | another member holds it (take is not a steal; assign through 159) |
| 161 | `409` · `instagram_conversation_not_taken` | nobody holds it |
| 162 | `404` · `instagram_conversation_message_not_found` | `up_to_message_id` not of this conversation |
| 163 | `409` · `instagram_conversation_window_closed` (+ `window_ends_at`) | outside the window |
| 157 | `400` · `invalid_field` | a malformed cursor |

#### 2.A.10 Rules worth knowing

- `waiting_on_us` is set by an inbound message, `waiting_on_contact` by a team reply; `closed` and snooze are the team's.
- A snoozed conversation reopens at its time (WC-10); a new inbound message reopens it at once.

#### 2.A.11 Code changes

CVC1, CVC3, CVC5, CVC6, CVC7 for this table and routes 155–163.

### 2.B Instagram conversation message — `instagram-conversation-message/` — final (rev 1, confirmed 2026-11-26)

#### 2.B.1 Decisions

CV2, CV5, CV6, CV9, [I-D14](decisions.md) (sender type and kind). Unsent: the text and copied files are erased, `is_unsent`
kept; an edit replaces the text and sets `is_edited`, `edited_at`.

#### 2.B.2 Open questions

None.

#### 2.B.3 Tables and relations

`app.instagram_conversation_messages` — split by month of `sent_at`, primary key `(id, sent_at)`; `public_id`,
`organization_id`, `instagram_conversation_id`, `channel_account_id` and `contact_id` (copies), `sender_type`, `kind`,
`text` (≤ 2,200 characters, nullable), `attachments` (list ≤ 10 of `{ type, upload_id, meta_url, meta_url_expires_at }`),
`reply_to_meta_message_id`, `reaction` (`{ emoji, target_meta_message_id }` for a reaction), `meta_message_id`
(nullable until a team reply is sent), `automation_id`, `automation_run_id`, `broadcast_id`,
`instagram_automation_message_id` (copies, no reference — the ledger is split by week), `sent_by_membership_id`,
`send_status` (`sending` · `sent` · `failed`, team replies only), `failure_reason`, `is_edited`, `edited_at`, `is_unsent`,
`seen_at`, `sent_at`, `created_at`. Checks: `sender_type` and `kind` lists; `send_status` only for `team_member`;
`sent_by_membership_id` exactly for `team_member`. Indexes: the thread keyset `(instagram_conversation_id, sent_at desc, id
desc)`; unique `(channel_account_id, meta_message_id, sent_at)` where `meta_message_id` is set; the repair
`(send_status, created_at)` where `sending`. FORCE RLS with the retention-sweep arm (the upkeep drops parts after 12 months).

#### 2.B.4 Permissions

As 2.4 for routes 164–166.

#### 2.B.5 Common to every route

As 2.5; route 165 needs `X-Idempotency-Key`.

#### 2.B.6 Objects returned

Message: `id`, `sender_type`, `kind`, `text`, `attachments` (`type`, `url` — a short-lived download link to the copy, or
Meta's link while it lives), `reply_to_message_id`, `reaction`, `automation` (`id`, `name`) or `broadcast` (`id`, `name`)
or `sent_by` (`member_id`, `name`), `send_status`, `failure_reason`, `is_edited`, `is_unsent`, `seen_at`, `sent_at`.

#### 2.B.7 Routes (164–166)

As 2.7.

#### 2.B.8 Request details

| Route | Body / query |
| --- | --- |
| 164 | `limit`, `after`, `kind` (optional filter), `sender_type` (optional filter) |
| 165 | `text` (1–1,000 UTF-8 bytes) and/or `upload_id` (a usable `message-media` upload), `reply_to_message_id` (optional ⚠️), `saved_reply_id` (optional, for counting use) |
| 166 | `emoji` (Meta's allowed set) or `action: "unreact"` |

#### 2.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 165 | `400` · `invalid_field` | neither text nor file, text too long, an unusable upload |
| 165 | `409` · `instagram_conversation_window_closed` (+ `window_ends_at`) | outside the 24-hour window |
| 165 | `409` · `instagram_account_sending_stopped` (+ `stop_reason`) | `login_expired`, `access_off`, `account_not_shared` |
| 165 | `429` · `meta_usage_wait` (+ `Retry-After`) | Meta's usage at the wait percent |
| 165 | `503` · `instagram_unavailable` | Meta down — the message is saved `failed` and can be sent again with a new key |
| 165 | `422` · idempotency key missing or reused | as every `req` route |
| 166 | `404` · `instagram_conversation_message_not_found` · `409` · `instagram_conversation_window_closed` | |

#### 2.B.10 Rules worth knowing

- A team reply is `sending` until Meta answers; a crash in between is settled by the repair sweep from Meta's answer or
  marked `failed`.
- Files: inbound ones are copied by a job (WC-6) — until then (and if the copy fails) Meta's link is shown while it lives.

#### 2.B.11 Code changes

CVC2, CVC4, CVC8 for this table and routes 164–166.

### 2.C Instagram conversation note — `instagram-conversation-note/` — final (rev 1, confirmed 2026-11-26)

#### 2.C.1 Decisions

CV3. Notes are never sent and never shown to the contact.

#### 2.C.2 Open questions

None.

#### 2.C.3 Tables and relations

`app.instagram_conversation_notes` — standard columns plus `instagram_conversation_id` (→ conversations `ON DELETE
CASCADE`), `author_membership_id` (→ memberships, kept as history when the member leaves), `text` (1–2,000), `deleted_at`.
Index: `(instagram_conversation_id, created_at desc, id desc)` where not deleted. FORCE RLS.

#### 2.C.4 Permissions

As 2.4 for routes 167–169.

#### 2.C.5 Common to every route

As 2.5; route 168 needs `X-Idempotency-Key`.

#### 2.C.6 Objects returned

Note: `id`, `text`, `author` (`member_id`, `name`), `created_at`.

#### 2.C.7 Routes (167–169)

As 2.7.

#### 2.C.8 Request details

168: `text*` (1–2,000). 167: `limit`, `after`.

#### 2.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 168 | `400` · `invalid_field` | empty or too long |
| 169 | `404` · `instagram_conversation_note_not_found` | not this conversation's, or deleted |
| 169 | `403` · `instagram_conversation_note_not_author` | another member's note without `contact:delete` |

#### 2.C.10 Rules worth knowing

- Adding, deleting and the hand-off actions are audited (`recordScopedAuditEvent`, resource `instagram_conversation`).

#### 2.C.11 Code changes

CVC1 (table), CVC9 (tests) for routes 167–169.

---

## 3. Saved reply — final (rev 1, confirmed 2026-11-26) — no nested sub-domains

Code: `SD/saved-reply/` (new). The organization's reusable reply texts, shared across channels ([I-D2](decisions.md)):
the reply box (route 165) inserts one. Route numbers 170–174.

### 3.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| SR1 | **Folder and names**: `SD/saved-reply/`; table `app.saved_replies` (no channel prefix — shared, like contacts, [I-D2](decisions.md)); prefix `svr`; path id `{saved_reply_id}`. |
| SR2 | **Gates** ([I-D4](decisions.md)): `contact:read` lists and reads; `contact:update` adds, changes and deletes — a saved reply is part of answering contacts. |
| SR3 | **Title unique among live rows, any case**, within the organization — the reply box picks by title. |
| SR4 | **Use is counted**: route 165 with `saved_reply_id` adds one to `use_count` and sets `last_used_at` in the reply's transaction; the list can sort by most used. |
| SR5 | **Hard delete** — nothing points at a saved reply (route 165 stores the text it sent, not the reply); a deleted one simply stops being offered. Other option: soft delete with restore — rejected, nothing to restore into. |
| SR6 | **Placeholders**: the text may hold `{first_name}` and `{username}`, filled from the contact at send time by the existing `{name}` filler of the composer. |

### 3.2 Open questions

None.

### 3.3 Tables and relations

`app.saved_replies` — standard columns (`id`, `public_id`, `organization_id`, `created_at`, `updated_at`,
`created_by_user_id`, `updated_by_user_id`) plus `title` (1–100), `text` (1–1,000 UTF-8 bytes), `use_count` (≥ 0),
`last_used_at`. Unique `(organization_id, lower(title))`; list indexes `(organization_id, use_count desc, id)` and
`(organization_id, lower(title), id)`. FORCE RLS (K3). A per-organization row cap (e.g. 500) through the shared row-cap
policy.

```text
tenancy.organizations ──< app.saved_replies          (read by route 165 when a reply names one)
```

### 3.4 Permissions

| Code | Allows | Routes |
| --- | --- | --- |
| `contact:read` | list, read | 170, 172 |
| `contact:update` | add, change, delete | 171, 173, 174 |

### 3.5 Common to every route

Base `/api/v1/app`; `POST` needs `X-Idempotency-Key`; `PATCH` takes `expected_updated_at`; `DELETE` → `204`.

### 3.6 Objects returned

Saved reply: `id`, `title`, `text`, `use_count`, `last_used_at`, `created_at`, `updated_at`.

### 3.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 170 | GET | `/saved-replies` | List — `q` (title), sort `title` or `use_count` | `contact:read` | |
| 171 | POST | `/saved-replies` | Add one | `contact:update` | req |
| 172 | GET | `/saved-replies/{saved_reply_id}` | One | `contact:read` | |
| 173 | PATCH | `/saved-replies/{saved_reply_id}` | Change | `contact:update` | |
| 174 | DELETE | `/saved-replies/{saved_reply_id}` | Delete | `contact:update` | |

### 3.8 Request details

171: `title*` (1–100), `text*` (1–1,000 bytes). 173: `title`, `text`, `expected_updated_at`. 170: `q` (1–100), `sort`
(`title` · `use_count`), `order`, `limit`, `after`.

### 3.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 171, 173 | `400` · `invalid_field` | empty or too long |
| 171, 173 | `409` · `saved_reply_title_taken` | another live reply has the title (any case) |
| 171 | `409` · `resource_limit_reached` | the organization's cap |
| 173 | `409` · `record_changed` | stale `expected_updated_at` |
| 172–174 | `404` · `saved_reply_not_found` | not this organization's |
| 165 | `404` · `saved_reply_not_found` | `saved_reply_id` not this organization's (the reply is not sent) |

### 3.10 Rules worth knowing

- Changing or deleting a saved reply never changes a message already sent.
- Adding, changing and deleting are audited (resource `saved_reply`).

### 3.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| SRC1 | SR1–SR3, SR5: folder, schema, migration, FORCE-RLS list, public-id entity and prefix, param registry, the row cap; routes 170–174 with schema docs, the route catalog, i18n reasons |
| SRC2 | SR4, SR6: route 165 reads the saved reply, fills the placeholders, counts the use in its transaction |
| SRC3 | Tests: routes 170–174 (unique title any case, cap, stale update, 404 across organizations, viewer reads but cannot write), route 165 with a saved reply, the RLS matrix entry; seeds (a few demo replies) |

### 3.12 Nested sub-domains

None.

