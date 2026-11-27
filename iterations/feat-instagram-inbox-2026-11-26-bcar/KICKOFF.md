# KICKOFF — feat-instagram-inbox-2026-11-26-bcar

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-inbox-2026-11-26-bcar` |
| Mode | initial (Baseline `none`) |
| Intake mode | brief — from scratch |
| Intake note | 1 received (`BRIEF.md`) · from scratch |
| Drop placed | 2026-11-26 |
| Intake hash | `1082fd1734e6` |
| Schema-routes | — (brief) |
| Date | 2026-11-26 |

## 2. Goal and scope

Every Instagram DM with a contact is kept as a conversation for 12 months — both directions, with who sent it — and the
team reads, takes, replies and notes from our app, while a bot never answers over a person. Route review:
[`plans/routes-final.md`](plans/routes-final.md) (final 2026-11-26).

- **In scope:** the ledger rename (`app.instagram_automation_messages`); `app.instagram_conversations`, `_messages`,
  `_notes`, `app.saved_replies`; routes 155–174 and the changes to routes 12 and 19; the intake and result-save writes;
  the direct team send; the hand-off hold and its 24-hour release; read receipts; file copies; two notification kinds;
  erase on contact, Meta deletion and organization; 12-month retention.
- **Out of scope:** Messenger, AI replies, automatic assignment rules, insights, publishing, a comment / mention inbox
  (brief), SSE (polling first, [I-D8](plans/decisions.md)), backfill of older chats ([I-D11](plans/decisions.md)), the
  frontend screens.

## 3. Locked decisions

| # | Summary |
| --- | --- |
| [I-D1](plans/decisions.md) | Instagram-prefixed conversation tables, routes under `/social/instagram/conversations` |
| [I-D3](plans/decisions.md) | Hand-off holds every automation DM; 24 h idle release |
| [I-D4](plans/decisions.md) | Contact codes reused |
| [I-D5](plans/decisions.md) | 12 months retention |
| [I-D6](plans/decisions.md) | Meta's data deletion erases conversations (supersedes D22 for them) |
| [I-D7](plans/decisions.md) | Inbound files copied into uploads |
| [I-D8](plans/decisions.md) | Polling first |
| [I-D9](plans/decisions.md) | Team replies stored as conversation messages, sent directly |
| [I-D13](plans/decisions.md) | `app.instagram_messages` renamed `app.instagram_automation_messages` |
| [I-D14](plans/decisions.md) | `sender_type` + `kind` on every message |
| [I-D15](plans/decisions.md)–[I-D17](plans/decisions.md) | Route review sub-domains 1–3 confirmed |

## 4. Features and order

7 `automation-messages-rename` → 1 `conversation-inbox` → 2 `conversation-messages` → 3 `hand-off` → 4 `saved-replies`
→ 5 `notifications` → 6 `privacy` ([stories](plans/features/)).

## 5. ROUTE

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 1 The ledger rename — routes-final § 1 (AM1–AM4; AMC1–AMC3) | sub-domain | — | `/be-build-requirement` (CHANGE table) | AC-7.1, AC-7.2 | — | done |
| R2 | `app.instagram_conversations` — routes-final § 2.A.3 | table | — | staged-build prompt (NEW table) | AC-1.1 | — | done |
| R3 | `app.instagram_conversation_messages` (monthly, 12 months, upkeep entry) — § 2.B.3 | table | R2 | staged-build prompt (NEW table) | AC-6.2 | — | done |
| R4 | `app.instagram_conversation_notes` — § 2.C.3 | table | R2 | staged-build prompt (NEW table) | AC-1.8 | — | done |
| R5 | `app.saved_replies` — § 3.3 | table | — | staged-build prompt (NEW table) | AC-4.1 | — | done |
| R6 | `instagram_account_settings.is_mark_seen_on_open_enabled`; the upload purpose — CV8, CVC8 | table | — | `/be-build-requirement` (CHANGE table) | AC-1.6 | — | open |
| R7 | 2.A Conversation routes 155–163, route 19's summary, route 12's field — § 2.A (CVC1, CVC5, CVC6) | sub-domain | R2, R6 | `/be-build-requirement` | AC-1.1–AC-1.7 | — | open |
| R8 | 2.B Messages: the intake write, the result save's text, routes 164–166, the direct team send — § 2.B (CVC2, CVC4) | sub-domain | R1, R3, R7 | `/be-build-requirement` | AC-2.1–AC-2.8 | — | open |
| R9 | 2.C Notes, routes 167–169 — § 2.C | sub-domain | R4, R7 | `/be-build-requirement` | AC-1.8 | — | open |
| R10 | 3 Saved replies, routes 170–174, and route 165's `saved_reply_id` — § 3 (SRC1–SRC3) | sub-domain | R5, R8 | `/be-build-requirement` | AC-4.1, AC-4.2 | — | open |
| R11 | Background — the hand-off hold (`conversation_taken`), the 24 h idle release, the Instagram-app takeover, snooze wake-up, `messaging_seen`, the file copy job, the stuck-`sending` repair — CV4, CV9, CVC3, CVC8 | background | R7, R8 | `/be-worker-complete` | AC-2.4, AC-2.6, AC-2.7, AC-3.1–AC-3.4 | — | open |
| R12 | Notifications — two kinds and the window-closing sweep — CV10, CVC7 | background | R7, R8 | `/be-worker-complete` | AC-5.1, AC-5.2 | — | open |
| R13 | Privacy — the contact erasure step, Meta's data deletion, the organization delete; no text in logs — CV11, K2, K3 | flow | R2–R4, R8 | `/be-build-requirement` | AC-6.1, AC-6.3 | — | open |
| R14 | Flow and close — every route's errors end to end; `docs/routes.txt`, OpenAPI, i18n, `plans/frontend-route-map.md` | flow | R1–R13 | `/be-build-requirement` | BRIEF-1–BRIEF-12 | — | open |

## 6. Requirements index

| File | Identifiers |
| --- | --- |
| [rename.md](plans/requirements/rename.md) | `rename.automation-messages` |
| [conversation.md](plans/requirements/conversation.md) | `conversation.created-once`, `conversation.list`, `conversation.counts`, `conversation.changes-polling`, `conversation.state-and-assignment`, `conversation.take-release`, `conversation.mark-read`, `conversation.typing` |
| [message.md](plans/requirements/message.md) | `message.inbound-once`, `message.outbound-captured`, `message.team-reply-direct`, `message.echo-matched`, `message.edit-unsent`, `message.read-receipts`, `message.reactions`, `message.files-copied`, `message.sender-type-kind` |
| [hand-off.md](plans/requirements/hand-off.md) | `hand-off.hold`, `hand-off.idle-release`, `hand-off.instagram-app-takeover` |
| [note.md](plans/requirements/note.md) | `note.notes` |
| [saved-reply.md](plans/requirements/saved-reply.md) | `saved-reply.crud`, `saved-reply.use` |
| [notification.md](plans/requirements/notification.md) | `notification.new-message`, `notification.window-closing` |
| [privacy.md](plans/requirements/privacy.md) | `privacy.erase`, `privacy.retention`, `privacy.no-text-in-logs` |
| [data.md](plans/requirements/data.md) | `data.instagram-conversations`, `data.instagram-conversation-messages`, `data.instagram-conversation-notes`, `data.saved-replies`, `data.mark-seen-on-open-setting`, `data.upload-purpose` |

## 7. Open AMBER items

| # | Default | Settles when |
| --- | --- | --- |
| [I-D2](plans/decisions.md) | `saved_replies` shared across channels | kickoff of R5 |
| [I-D10](plans/decisions.md) | the direct send's guards; team replies not counted in the month limit | kickoff of R8 |
| [I-D11](plans/decisions.md) | conversations start empty at the connect | — (a later backfill) |
| [I-D12](plans/decisions.md) | the window derived, not stored | kickoff of R7 |
| I1, I2 (owner tests) | typing, `mark_seen`, reactions, `reply_to`; Meta file download | the Meta dev app |

## 8. Standing deviations

`n/a — initial` (Baseline `none`). Kept from `fix-meta-unified-login-2026-11-26-ceuy`: the `/debug_token` query token
(F-D4) — untouched here.

## 9. Definition of done

Every ROUTE row `done` (or `deferred` with the user's OK); `plans/acceptance.md` filled; the `AS-BUILT.md` summary and
Standing deviations written; the gates green.

## 10. Verification

Brief mode: every `BRIEF.md` acceptance line traced in `plans/acceptance.md`. Gates: `pnpm validate`, `pnpm tsdoc:check`,
`pnpm db:migrate:lint`, `pnpm routes:catalog:check`, `pnpm docs:check`, the touched suites, `pnpm test:rls-role:changed`,
`pnpm test:contract` (Meta client), `pnpm iteration:frontend-map <iteration> --check`.
