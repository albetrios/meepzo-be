# Meepzo API — Instagram engage (comments, mentions, tagged media), final routes, sub-domain by sub-domain

Started from branch `feat/instagram-automation` at `76de0ed`. Every decision reads **today → after**; today is the
code as built (`src/domains/app/sub-domains/…`, `file:line`). Sources: [`coverage.md`](coverage.md) (E1–E7,
`B:<line>` = `intake-files/BRIEF.md`), [`decisions.md`](decisions.md) (E-D1–E-D5), [`route-changes.md`](route-changes.md)
(RC-n), [`db-changes.md`](db-changes.md), [`worker-changes.md`](worker-changes.md) (WC-n).

## File header — legend

Paths are under `/api/v1/app/social`; `{x_id}` is a public id; **Gate** is the permission the caller needs;
**Idem** `req` = `X-Idempotency-Key` required; `*` = required. Route numbers continue the earlier reviews' (the
inbox ends at 174): new ones start at **175**.

## File header — sub-domains (in build order)

| # | Sub-domain | Folder (`src/domains/app/sub-domains/…`) | Paths (`/social/…`) | Routes touched | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Instagram comment | `instagram-account/instagram-comment/` | `instagram/accounts/{channel_account_id}/comments…` | 5 new (175–179) | instagram-account, instagram-media, automation comment log, reply lane | **rev 1 — awaiting your OK** |
| 2 | Instagram mention | `instagram-account/instagram-mention/` | `instagram/accounts/{channel_account_id}/mentions`, `…/tagged-media`; automations' `trigger_type` | 2 new (180, 181), 2 changed (automation create / update) | 1, automation | draft |

Total so far: **7 new routes, 2 changed** — none removed.

## File header — code layout and tables without routes

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.instagram_comments` | `instagram-account/instagram-comment/` | the webhook comment processing (WC-1) and the team routes (176–179) |
| 2 | `app.instagram_mentions` | `instagram-account/instagram-mention/` | the webhook mention processing (WC-3) |

## File header — rules for every sub-domain

| # | Rule |
| --- | --- |
| K1 | **One writer per source**: a comment row is created only by the webhook processing; the team routes change its reply / hide / delete state; the automation's own reply stays in the comment log (`automation_comment_logs`). |
| K2 | **Comment and mention text never reaches a log or Sentry** — only public ids, kinds and Meta codes (as the inbox's K2). |
| K3 | **Every new tenant table** has FORCE RLS with USING and WITH CHECK on `organization_id`, plus the retention-sweep arm (90 days, [E-D3](decisions.md)). |
| K4 | **Every Meta write is gated and paced** like an automation's: Meta usage gate, the circuit, `190` breaks the connection (`markConnectionBroken`), `503 instagram_unavailable` when Meta is down — nothing changes in our row unless Meta answered. |
| K5 | **Meta ids are bounded** by the shared `INSTAGRAM_ID_*` rules (C-D16 of the connect flow). |

## File header — connections

```text
1) WHO POINTS AT WHOM
   app.channel_accounts ◄── app.instagram_comments (channel_account_id)
   app.instagram_media  ◄── app.instagram_comments (instagram_media row)
   app.contacts         ◄── app.instagram_comments (contact_id, when known)
   app.instagram_comments ◄─ app.automation_comment_logs (matched by instagram_comment_id — read only)
   app.channel_accounts ◄── app.instagram_mentions (channel_account_id)

2) WHAT ONE ACTION SETS OFF
   webhook comment processed ► 1 comment row stored (once per comment id)          [worker]
   176 reply                 ► Meta reply, then the row's reply state
   177/178 hide / unhide     ► Meta hide=true/false, then the row's hidden state
   179 delete                ► Meta delete, then the row soft-deleted
   webhook mention processed ► 2 mention row stored; a live `mention` automation starts   [worker]
```

---

## 1. Instagram comment — rev 1 — awaiting your OK — no nested sub-domains

Code: a new nested folder `instagram-account/instagram-comment/` (schema, repository, service, controller, routes,
dto, validator, serializer, types), beside `instagram-media/` — a comment belongs to the account's media.

### 1.1 Decisions (whole sub-domain)

| # | Decision |
| --- | --- |
| IC1 | **Store every comment** ([E-D2](decisions.md)). Today a comment is stored only per automation that matched it (`automation_comment_logs`, `automation-comment-log.schema.ts:42-115`) — an unmatched comment is not kept. After: the webhook comment processing also upserts one `app.instagram_comments` row per Instagram comment id, matched or not (WC-1). Replies to a comment (`parent_id` in Meta's payload) are rows too, with `parent_instagram_comment_id`. |
| IC2 | **Answered by** — the list shows the automation's answer by joining the comment log on `instagram_comment_id` (latest public reply status and text); the team's own reply lives on the comment row (`reply_state` `none · automation · team`, `replied_at`, `replied_by_user_id`). The row never copies the automation's reply text (K1). |
| IC3 | **Moderation routes** — reply, hide, unhide, delete (RC-2–RC-5). Today the reply lane sends automation replies and hides (`instagram-reply-lane.service.ts`; `replyToInstagramComment` `meta-graph.client.ts:1117`, `hideInstagramComment` `:1151`); there is no unhide or delete. After: two new client calls (`hide=false`, `DELETE /{comment-id}`) and the four routes call Meta **directly, gated** (K4) — a person waiting on a button is not put in the paced lane's queue. Other option: queue them on the reply lane — rejected, the answer would come later than the click. |
| IC4 | **Delete is soft in our table** (B:32): `deleted_at` set after Meta confirms; the row stays for the 90 days and drops from the list. A comment Meta already deleted (its `not found`) is marked deleted too (`200`, idempotent). |
| IC5 | **Retention 90 days** ([E-D3](decisions.md)): monthly parts by `commented_at`, dropped by the shared partition upkeep after `AUTOMATION_RUN_KEEP_DAYS` (`automation-run.constants.ts:209`) — the comment log's rule. The contact erase empties `text`, `commenter_username`, `commenter_instagram_user_id` (as the comment log's, `automation-comment-log.schema.ts:66-70`). |
| IC6 | **Permission** `instagram-comment:manage` ([E-D5](decisions.md)) — Owner, Admin, Editor; reads use `instagram-account:read` (Viewer included). |

### 1.2 Open questions

None — E-D2, E-D3, E-D5 answered them.

### 1.3 Tables and relations

| Table | Change |
| --- | --- |
| `app.instagram_comments` | **NEW** — `id`, `public_id` (`igco_`), `organization_id`, `channel_account_id`, `instagram_media_id` (our media row, nullable until the post is stored), `instagram_comment_id` (Meta's, bounded K5), `parent_instagram_comment_id`, `contact_id` (nullable), `commenter_username`, `commenter_instagram_user_id`, `text`, `commented_at`, `is_hidden`, `hidden_at`, `reply_state`, `replied_at`, `replied_by_user_id`, `deleted_at`, `created_at`, `updated_at` |

**PostgreSQL design**: partitioned by month on `commented_at`; unique `(organization_id, channel_account_id,
instagram_comment_id, commented_at)` (the partition key in the key); keyset index `(organization_id,
channel_account_id, commented_at DESC, id DESC) WHERE deleted_at IS NULL`; index on `(organization_id,
instagram_media_id)`; `reply_state` text with a CHECK; FORCE RLS organization policy + the retention arm (K3); the
upkeep's CASE entry.

### 1.4 Permissions

| Code | Allows | Routes | Held by default |
| --- | --- | --- | --- |
| `instagram-account:read` | list comments | 175 | Owner, Admin, Editor, Viewer |
| `instagram-comment:manage` **new** | reply, hide, unhide, delete | 176–179 | Owner, Admin, Editor |

### 1.5 Common to every route

Base `/api/v1/app/social`, team organizations only (a personal one: read `404 team_organization_required`, write
`422`); `{channel_account_id}` is a `cha_` id of this organization's Instagram account, not revoked; `{instagram_comment_id}`
is our `igco_` id.

### 1.6 Objects returned

| Object | Shape |
| --- | --- |
| Instagram comment | `{ id, channel_account_id, media: { id, permalink, thumbnail_url } \| null, parent_id, commenter: { username, contact_id }, text, commented_at, is_hidden, reply_state, replied_at, replied_by_user_id, automation_reply: { status, text, at } \| null }` |

### 1.7 Routes

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 175 | GET | `/instagram/accounts/{channel_account_id}/comments` | The comment inbox, newest first | `instagram-account:read` | |
| 176 | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/replies` | Reply publicly | `instagram-comment:manage` | req |
| 177 | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/hide` | Hide | `instagram-comment:manage` | |
| 178 | POST | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}/unhide` | Unhide | `instagram-comment:manage` | |
| 179 | DELETE | `/instagram/accounts/{channel_account_id}/comments/{instagram_comment_id}` | Delete | `instagram-comment:manage` | |

### 1.8 Request details

- 175: query `media_id` (an `igm…` media id of ours), `answered` (`none · automation · team · any`, default `any`), `limit` (≤ 50), `cursor` (keyset).
- 176: body `{ text* }` (1–2,200 characters, Meta's comment limit ⚠️ unverified — owner check with EO1).
- 177, 178, 179: no body.

### 1.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| all | `404` · `channel_account_not_found` | not this organization's Instagram account, or revoked |
| 176–179 | `404` · `instagram_comment_not_found` **new** | not this account's comment, or deleted |
| 176–179 | `409` · `instagram_not_connected` | the account or its connection is not connected (a `190` breaks it first) |
| 176–179 | `503` · `instagram_unavailable` | Meta down, throttling, circuit open — nothing changed |
| 176 | `400` · `text` | empty or too long |
| 177–179 | `200` | already in that state (a repeat changes nothing) |

### 1.10 Rules worth knowing

- The list never calls Meta; only the four writes do.
- A comment the team replied to shows `reply_state: team` even when an automation also answered it.
- Hidden comments stay listed (with `is_hidden`); deleted ones are gone from the list.

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| ICC1 | IC1, IC5: the table + migration (partitioned, upkeep entry, FORCE RLS), schema, repository; the webhook comment processing's upsert (WC-1); the contact erase step |
| ICC2 | IC3: Meta client `unhideInstagramComment`, `deleteInstagramComment`; routes 175–179, controller, service, dto, validator, serializer; OpenAPI, catalogs, i18n `instagramCommentNotFound` |
| ICC3 | IC6: permission code, catalog row, default team grants (Editor) |
| ICC4 | Tests: storing a matched and an unmatched comment once; the list's filters and keyset; each write's Meta call and state; 404 / 409 / 503; viewer 403 on writes; another organization 404; the contact erase |

### 1.12 Nested sub-domains

None.

---

## 2. Instagram mention — draft

Written after sub-domain 1 is confirmed: the mention table, `mentions` subscription and intake (WC-2, WC-3), routes
180 (mentions) and 181 (tagged media, live from Meta), the `mention` trigger type ([E-D4](decisions.md)) on the
automation create / update.
