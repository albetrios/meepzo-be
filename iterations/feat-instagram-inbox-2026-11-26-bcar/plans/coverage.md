# Coverage — feat-instagram-inbox-2026-11-26-bcar

Mode **initial** (Baseline `none`, Intake mode `brief`, from scratch) · Intake hash `1082fd1734e6` · 2026-11-26.
Source: `intake-files/BRIEF.md` (`brief rule n` / `brief AC n`). No `PRD.md` / `schema-routes.md`: the brief is reconciled
against the code as built (`SD/` = `src/domains/app/sub-domains/`).

Status: `covered` · `change` · `new` · `open` (a Step 4 question `Qn`) · `out-of-scope`.

## Coverage — rules

| # | Brief | Today (code) | Proposal | Status |
| --- | --- | --- | --- | --- |
| 1 | Source of truth is the webhook intake, once per Meta id | one path: intake event transaction `markEventFinal` → `recordInboundContactEvent` (`SD/instagram-webhook/workers/instagram-webhook-intake.processor.ts:939-958`); but the dispatch carries no `mid` and no attachments (`SD/instagram-webhook/instagram-webhook-event-dispatch.util.ts:86-96`) — the `mid` is only in `event_key` | WC-1 (write the message in that transaction), WC-2 (dispatch carries `mid`, attachments, `reply_to`) | change |
| 2 | Outbound text captured when sent; echoes matched, not shown twice | the result save `saveSendResult` (`SD/instagram-sending/instagram-message/instagram-message.service.ts:866`) gets ids only — the text is built inside the call closure (`instagram-send-compose.service.ts:316`); our echoes are dropped by `findOwnSentMessageIds` (`instagram-webhook.service.ts:457-464`) | WC-3 (the call returns what it sent; the result save writes the outbound message) | change |
| 3 | Replies only inside the 24-hour window; Human agent later | `isInstagramChatWindowOpen` (23 h 45 m) over `contact_activities.last_direct_message_received_at` (`instagram-message.util.ts:31`, `contact/contact.constants.ts:78`) | reuse; RC-6 refuses outside it | covered (reuse) |
| 4 | Hand-off pauses the contact's automations; idle release | `isOwnerChatting` (echoes in the last 6 h) suppresses only the `default_reply` fallback (`automation-run-matching.util.ts:451`); `automations_off_at` is a manual pause | DB-1 thread `assignee`, WC-4 | open — Q2 |
| 5 | Read / reply permission codes | `contact:read`, `contact:update`, `contact:delete` only (`src/domains/app/app.permissions.ts:20-33`) | new codes or reuse | open — Q3 |
| 6 | Privacy, retention, erase with contact / Meta deletion / organization | contact erase steps (`app.container.ts:614-634`); org delete cascades; **Meta data deletion does not touch contacts** (`instagram-account-erasure.service.ts:62`, launch D22) | DB retention, WC-5 erase step | open — Q4 (retention), Q5 (Meta deletion) |
| 7 | Attachments: copy or link | no server-side "download a URL into uploads" path (`upload.service.ts`); purposes `avatar … message-media` (`src/domains/upload/upload.constants.ts:2-12`) | WC-6 copy job or link-only | open — Q6 |
| 8 | Tenant tables, FORCE RLS, split by time, keyset | `app.fn_create_monthly_partitions`; upkeep CASE per table (`migrations/20261125190000_app_partition_upkeep.sql:91-98`) | DB-2 monthly; WC-7 upkeep entry | covered (reuse) |
| 9 | Backfill old conversations | none | start empty (AMBER) | covered — AMBER A1 |
| 10 | Channel on thread and message | contacts carry `channel` (`contact.schema.ts:64`) | DB-1, DB-2 `channel` | covered |
| 11 | Data model: thread 1:1 contact, monthly messages, one write path each, window not stored twice, files as uploads, audit | contact is per (organization, account, person) | DB-1–DB-5 | open — Q1 (names / domain) |
| 12 | Real-time to the browser | no SSE/websocket for app routes (only MCP, `src/infrastructure/mcp/mcp-server.ts:19`) | RC-16 | open — Q7 |
| 13 | An Instagram-app reply takes the thread, pauses the bot | the "owner typed it" echo is kept as `owner_message` (`processor :942-953`) | WC-4 | open — Q2 |
| 14 | States, assignment, filters, username search | none | DB-1, RC-1–RC-4 | new |
| 15 | Notes, saved replies, notifications, response times | notify: `notifyOrganizationKind` with per-member preferences (`src/domains/notify/sub-domains/notification/notification-notice.service.ts:135`) | DB-3, DB-4, RC-9–RC-14, WC-8, WC-9 | new |
| 16 | Read receipts, typing, mark-seen setting, react, reply-to | `mark_seen` already a feature (`CHANNEL_FEATURES.mark_seen`, `isMetaTestRequired: true`); `messaging_seen` not subscribed; read receipts not saved (classifier returns `null`) | RC-7, RC-8, RC-15, WC-10 | new — ⚠️ send-side unverified |
| 17 | Unsent erases text; edited shows latest | `is_deleted` → `deleted:<mid>` skipped; `edit:<mid>:<num>` skipped (classifier) | WC-2 handles both | change |
| 18 | Window ready for the Human agent tag | window derived, 23 h 45 m | DB-1 `window_kind` derived, no column (AMBER A2) | covered — AMBER A2 |

## Coverage — acceptance (brief AC 1–12)

| Brief AC | Covered by |
| --- | --- |
| 1 every inbound kind once, in order | WC-1, WC-2 |
| 2 our sends with text and result, no echo twice | WC-3 |
| 3 reply inside the window via the paced sender | RC-6, Q8 |
| 4 taking pauses automations | WC-4, Q2 |
| 5 erase removes threads and messages | WC-5, Q5 |
| 6 no text in logs; FORCE RLS | DB-1–DB-4 |
| 7 keyset lists; unread right | RC-1, RC-5, RC-7 |
| 8 an Instagram-app reply takes the thread | WC-4 |
| 9 assign, states, snooze, notes, saved replies audited | RC-3, RC-9–RC-14 |
| 10 unsent text gone; edit shows latest | WC-2 |
| 11 updates without reload | RC-16, Q7 |
| 12 notifications respect preferences | WC-8, WC-9 |

## Delta

`n/a — initial` (Baseline `none`).

## Reconciliation — brief vs the code as built

| # | Item | Brief says | Code says | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| R1 | Where a team reply is recorded | rule 2, rule 11: outbound rows link `app.instagram_messages` | a message row needs exactly one of `automation_run_id`, `broadcast_id` (`chk_instagram_messages_source`, `instagram-message.schema.ts:134`); composing reads an automation step | conflict | Q8 |
| R2 | Outbound text at the result save | rule 2: "written in the sender's existing one result save" | the save gets ids only (`instagram-send-core.service.ts:1206-1245`) | partly | WC-3 widens the call's answer |
| R3 | Hand-off scope | rule 4/13: pause the contact's automations | existing owner-chat logic pauses only the default reply, 6 h (`instagram-webhook.constants.ts:65`) | extend | Q2 |
| R4 | Meta data deletion erases the inbox | rule 6 | launch D22: contacts are not touched by Meta's callbacks | conflict with a locked launch decision | Q5 |
| R5 | `mark_seen` | rule 16: an organization setting | already a plan feature with a Meta test gate (`channel-account-capabilities.constants.ts`) | reuse | RC-15 reads the feature |
| R6 | Dispatch shape | rule 1: Meta message id unique per account | the dispatch has no `mid` (`dispatch.util.ts:86-96`) | gap | WC-2 |

## Findings

- F1 — a team reply cannot be stored in `app.instagram_messages` as it is (R1): Q8 decides between widening it and a team send path of its own.
- F2 — the brief's Meta-deletion erase (rule 6) contradicts launch decision D22 (R4).
- F3 — the send-side extras (typing, mark seen, react, reply-to) are unverified for Unified Login; each needs a dev-app check (owner test I1).
