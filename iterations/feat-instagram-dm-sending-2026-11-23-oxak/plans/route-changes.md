# Route changes — feat-instagram-dm-sending-2026-11-23-oxak

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-dm-sending-2026-11-23-oxak` |
| Mode | initial (Baseline none) |
| Intake mode | brief — from scratch |
| Intake hash | `e2875698ea64` |
| Date | 2026-11-23 |
| Stage | Step 1–4 draft — written from the plan (`intake-files/Instagram-DM-Sending-Plan-v8.md`) and the as-built launch (`docs/routes.txt`); the AMBER defaults of the Step 4 batch applied ([P1](decisions.md)–[P20](decisions.md)), and the answers [P26](decisions.md)–[P39](decisions.md) (Q1–Q12 answered). Not yet matched to a route review (`routes-final.md` comes at Step 5) |

Every route here is a **proposal** — requirement level, what must be true, not how. Kickoff confirms each
one when it builds it and records any change in `AS-BUILT.md`; the built truth is `docs/routes.txt`.

- **Paths.** The app domain stays `/api/v1/app/…` (the launch's prefix, `docs/routes.txt:15`). A workspace now
  holds many Instagram accounts (plan D26, plan:L237), so every account route carries the account:
  `/api/v1/app/social/instagram/accounts/{instagram_account_id}/…`, and the singular
  `/social/instagram/account*` routes leave in the same change ([P1](decisions.md), A1). Automations,
  contacts, segments and broadcasts stay top-level resources; each belongs to one account, named in the
  create body and as a list filter. The Meta login (Unified Login, plan D24) sits beside it under
  `/api/v1/app/social/meta/…`, the `meta-connection` sub-domain ([P38](decisions.md); the plan writes
  `/api/v1/app/meta/…`, plan:L4567 — finding 9).
- **Params** are snake_case and semantic (`{automation_id}`, `{instagram_account_id}`,
  `{meta_connection_id}`); `docs/routes.txt` prints them as `:automation_id`. The active organization is
  the signed `org` claim, never a path segment.
- **Access** is the permission as `<resource> · <action>` (kebab-case codes, as the launch writes them),
  plus `team-only` (refused on a personal workspace, as every launch app route) and
  `X-Idempotency-Key required` where a repeat must not act twice; `PUBLIC` routes name what proves the
  caller. New code: `contact · update` only ([P20](decisions.md), A20) — broadcasts, segments and past
  comments reuse the `automation` codes (plan D68, D69).
- **Action routes** ([P8](decisions.md), A8): go live, pause, duplicate and try-it are their own `POST`
  routes; `PATCH` on an automation saves content only. **No undo route** ([P15](decisions.md), A15): the
  toast replays the previous action. **The workspace DM meter** is its own app route
  ([P14](decisions.md), A14), not a field on `GET /auth/me/context`.
- **Answers applied** ([P26](decisions.md)–[P39](decisions.md)): no cell rests on an open question. Every
  route of the plan's Part F (§44–47) is in its own area, **Product around sending**, in this iteration
  ([P28](decisions.md)); the referral program (§48, [P39](decisions.md)) and the file scan
  ([P34](decisions.md)) are out — see **Out of scope** after that area. Backend only: meepzo-fe opens its
  own iteration later on this contract ([P30](decisions.md)).

**Counts**

| Area | NEW | CHANGED | REMOVED |
| --- | --- | --- | --- |
| Meta connection & accounts | 8 | 2 | 1 |
| Account settings | 0 | 1 | 0 |
| Media & ads picker | 1 | 2 | 0 |
| Meta callbacks & webhook | 0 | 4 | 0 |
| Contacts & tags | 4 | 2 | 0 |
| Automations | 4 | 5 | 0 |
| Runs & messages | 6 | 0 | 0 |
| Broadcasts & segments | 13 | 0 | 0 |
| Past comments | 2 | 0 | 0 |
| Workspace usage & notices | 1 | 0 | 0 |
| Product around sending | 7 | 29 | 4 |
| **Total** | **46** | **45** | **5** |

**Unchanged (EXISTING)** — the launch route the plan keeps as it is:

- `GET /api/v1/app/social/instagram/webhook` — Meta's subscription check (verify token), as built.

Every other launch app route (`docs/routes.txt:20`–`:37`) is CHANGED or REMOVED below.

## Meta connection & accounts

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-1 | NEW | POST | `/api/v1/app/social/meta/connect/start` | instagram-account · manage · team-only | `startMetaConnect` — starts a Meta login (Unified Login) for this workspace and person: a one-use state, valid 10 minutes, bound to both, kept as a Redis nonce ([P26](decisions.md)); answers the Meta login address (always asks her to log in again) | plan:L4567, L4536–L4568 |
| RC-2 | NEW | POST | `/api/v1/app/social/meta/connect/callback` | instagram-account · manage · team-only | `completeMetaConnect` — takes Meta's code and the state. A state that is missing, used, too old, or another person's or workspace's is refused and nothing is saved; the code is swapped on the server; a missing required permission (basic, messages, comments) is refused; then, in one commit, the workspace's connection for that business portfolio (new, or the same row again) and its token. Answers the picker: each of her Instagram accounts as "here already", "in another workspace" (cannot be picked) or free, and the plan's room. **Reconnect is the same call**: same portfolio → same connection, new token, the login stops of its accounts cleared | plan:L4570–L4578, L2621–L2622, L4674–L4681 |
| RC-3 | NEW | POST | `/api/v1/app/social/meta/connections/{meta_connection_id}/accounts` | instagram-account · manage · team-only · X-Idempotency-Key required | `connectInstagramAccounts` — attaches the picked accounts. Under the workspace lock: over the plan's account limit refuses the whole pick; an account live in another workspace is refused alone while the other picks still connect; each pick gets a new row or the workspace's old row of that account back (its settings return), its settings and its four sending lanes. After the commit, the account set-up runs (`worker-changes.md`) and the connect is audited | plan:L4590–L4604, L2621 |
| RC-4 | NEW | GET | `/api/v1/app/social/meta/connections` | instagram-account · read · team-only | `listMetaConnections` — the workspace's Meta connections for the connections screen: business portfolio, status (connected, error, revoked), granted permissions, who connected, last daily check and its error code, and its accounts. Never a token | plan:L3524, L3550 |
| RC-5 | NEW | DELETE | `/api/v1/app/social/meta/connections/{meta_connection_id}` | instagram-account · manage · team-only | `disconnectMetaConnection` — "Disconnect business": every account of the connection is disconnected as RC-9, and the token is erased | plan:L4683–L4693, L2623 |
| RC-6 | REMOVED | POST | `/api/v1/app/social/instagram/connect` | was instagram-account · manage · team-only · X-Idempotency-Key required | `connectInstagramAccount` (launch) — Instagram Login and its 60-day token go (plan D24). Replaced by RC-1 (start), RC-2 (code and reconnect) and RC-3 (pick accounts) | plan:L4484–L4529, L2622 |
| RC-7 | NEW | GET | `/api/v1/app/social/instagram/accounts` | instagram-account · read · team-only | `listInstagramAccounts` — the workspace's accounts for the account menu that switches the whole app: profile, connection status, its Meta connection, paused, stopped and "not in your plan" state | plan:L2527, L2621 |
| RC-8 | CHANGED — was `GET /api/v1/app/social/instagram/account` | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}` | instagram-account · read · team-only | `getInstagramAccount` — one account by its id: profile, connection status and its Meta connection, webhook subscribed, starter questions set, paused or suspended, the new-account limit's end, its settings. The token end (`access_expires_at`) goes — the token never expires | plan:L2595, L4604, L2922–L2944 |
| RC-9 | CHANGED — was `DELETE /api/v1/app/social/instagram/account` | DELETE | `/api/v1/app/social/instagram/accounts/{instagram_account_id}` | instagram-account · manage · team-only | `disconnectInstagramAccount` — disconnects one account: starter questions removed and webhook unsubscribed (best effort), `revoked`, its lanes stopped, its short-lived copies dropped; the token is erased only with the connection's last account. Automations, contacts and history stay; waiting messages stay and expire by the 7-day rule | plan:L2623, L4683–L4693 |
| RC-10 | NEW | POST | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/pause` | instagram-account · manage · team-only | `pauseInstagramAccount` — the owner pauses the account's four lanes; comments and taps are still saved, nothing goes | plan:L2599 |
| RC-11 | NEW | POST | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/resume` | instagram-account · manage · team-only | `resumeInstagramAccount` — clears the owner's pause (error stops and a team suspend stay); lanes with waiting messages wake | plan:L2600 |

## Account settings

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-12 | CHANGED — was `PATCH /api/v1/app/social/instagram/account/settings` | PATCH | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/settings` | instagram-account · manage · team-only | `updateInstagramAccountSettings` — the account's limits (opening DMs per hour, optional day limit, fast answers per hour, per person per hour, broadcasts per hour) within the plan's bounds, stop words, the automatic notice, replies under comments, once per person per post, mark as seen after a reply (Meta-test-gated: refused at go-live while the code list marks it untested, [P36](decisions.md)), and the extra delay before each message (PRO). The five public-reply settings leave the account (they move to each automation, plan D14, D32). A limit change gives the slow and reply lanes a new turn; other settings count for new events only | plan:L2610–L2611, L2673–L2684, L225 |

## Media & ads picker

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-13 | CHANGED — was `GET /api/v1/app/social/instagram/media` | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/media` | instagram-account · read · team-only | `listInstagramMedia` — the picked account's posts and reels, read live with the Unified Login token, with caption and kind (post, reel, ad post); a missing picture falls back to the thumbnail or link | plan:L811, L2946–L2958 |
| RC-14 | CHANGED — was `GET /api/v1/app/social/instagram/stories` | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/stories` | instagram-account · read · team-only | `listInstagramStories` — the account's live stories for "one story"; built now — a story way to start the code list marks untested (Meta test 3, stories on Unified Login) is refused at go-live until its test passes ([P36](decisions.md)) | plan:L811, L7558 |
| RC-15 | NEW | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/ads` | instagram-account · read · team-only | `listInstagramAds` — the ads of her connected ad accounts, for ad-comment and ad "Send message" automations; without the optional ad permission the list is empty and says "Connect an ad account"; ad comments and the 7-day ad window are built, refused at go-live until their Meta test passes ([P36](decisions.md)) | plan:L876–L880 |

## Meta callbacks & webhook

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-16 | CHANGED | POST | `/api/v1/app/social/instagram/webhook` | PUBLIC (X-Hub-Signature-256, now signed with the Meta app secret) | `receiveInstagramWebhook` — signature first; read receipts and our own "sent" notices are dropped; an unknown or revoked account saves nothing (an `error`, paused or limit-full account still saves); events older than 8 days are dropped; a repeat is dropped by its stored event key; new kinds (Live comment, story mention, shared post, starter question, link, reaction, own comment, edit); saved before the answer, then handed to intake by kind. When Postgres is down or slow it answers 500 / 503 and saves nothing, so Meta delivers again — no Redis buffer ([P32](decisions.md)) | plan:L4734–L4807 |
| RC-17 | CHANGED | POST | `/api/v1/app/social/instagram/deauthorize` | PUBLIC (Meta signed request, Meta app secret) | `deauthorizeInstagramAccount` — finds the accounts through the Meta connection and disconnects them as RC-9; an id that matches nothing is still answered, and the team is told | plan:L4695–L4705, L2623 |
| RC-18 | CHANGED | POST | `/api/v1/app/social/instagram/data-deletion` | PUBLIC (Meta signed request, Meta app secret) | `requestInstagramDataDeletion` — as RC-17, then the account's data is erased; an unmatched id gets its confirmation code and the team is told | plan:L4695–L4705, L2624 |
| RC-19 | CHANGED | GET | `/api/v1/app/social/instagram/webhook-events` | instagram-webhook-event · read · team-only | `listInstagramWebhookEvents` — shows the new event kinds and reasons (an own comment is `own_comment`, the launch's `echo`), a failed event's next try, and only 8 days of events; the body is cleared once an event is done | plan:L226, L3207–L3222, L4772–L4797 |

## Contacts & tags

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-20 | CHANGED | GET | `/api/v1/app/contacts` | contact · read · team-only | `listContacts` — the contacts of one account (`instagram_account_id` filter), with tags, opted out, automations paused, how she came in, first message, last comment and comment count; search by phone too; filter by tag | plan:L2960–L2993, L1727 |
| RC-21 | NEW | GET | `/api/v1/app/contacts/{contact_id}` | contact · read · team-only | `getContact` — one contact: profile, email and phone she gave, tags, private note, opted out, automations paused (by whom, when), how she came in | plan:L2627, L2960–L2993 |
| RC-22 | NEW | PATCH | `/api/v1/app/contacts/{contact_id}` | contact · update · team-only | `updateContact` — the private note (up to 2,000 characters; nothing is sent); tags added or removed (each change is a tag event that can start a tag automation); automations paused on or off for her (on: her waiting messages skipped and her open runs cancelled in the same commit; off: nothing restarts by itself) | plan:L2615–L2616, L2625–L2626, L5168–L5175 |
| RC-23 | NEW | POST | `/api/v1/app/contacts/bulk-actions` | contact · update · team-only | `runContactBulkAction` — one tag added or removed, or automations paused or resumed, on many contacts of one account; the tag change runs in the background in pieces of 500 | plan:L2615, L2625, L1039 |
| RC-24 | NEW | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/contact-tags` | contact · read · team-only | `listContactTags` — the account's tags with how many contacts carry each, for the tag picker and filters | plan:L1034, L2991 |
| RC-25 | CHANGED | DELETE | `/api/v1/app/contacts/{contact_id}` | contact · delete · team-only | `deleteContact` — as built (personal data wiped, row kept, open runs cancelled), and now also her waiting messages are cancelled | plan:L2628 |

## Automations

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-26 | CHANGED | GET | `/api/v1/app/automations` | automation · read · team-only | `listAutomations` — one account's automations (`instagram_account_id` filter); statuses `draft`, `live`, `paused`; each row with its all-time runs and % tapped, a draft with "edited …"; the top-bar totals (live count, runs). Sorting by the launch's completed count goes | plan:L2514–L2528 |
| RC-27 | CHANGED | POST | `/api/v1/app/automations` | automation · create · team-only · X-Idempotency-Key required | `createAutomation` — saves a **draft**: only a name is needed, nothing is checked or sent; the Instagram account is named in the body (many accounts); the new ways to start, steps, message list, versions, wordings and reply step may be saved unfinished | plan:L2601, L676, L2995–L3145 |
| RC-28 | CHANGED | GET | `/api/v1/app/automations/{automation_id}` | automation · read · team-only | `getAutomation` — the full automation in its new shape (way to start, steps, versions, wordings, reply step, starter questions, link code), its counters per hello version, a stop reason (`bad_text`), and a past-comments read in progress | plan:L2517–L2524, L2995–L3145, L2696 |
| RC-29 | CHANGED | PATCH | `/api/v1/app/automations/{automation_id}` | automation · update · team-only | `updateAutomation` — saves content only (status moves by RC-31 and RC-32). A draft saves anything; a live or paused one runs the go-live checks again and answers the problems, each with its step. New runs use the new steps; waiting messages read the new text; a removed step's waiting messages are cancelled. Fixing a refused text clears the stop and puts its bad-text failures back to waiting (under 7 days); a reply-step change restarts its box. A read-only plan still lets the owner save, except turning a PRO part on ([P10](decisions.md)) | plan:L2606, L2609, L2620, L2635–L2653 |
| RC-30 | CHANGED | DELETE | `/api/v1/app/automations/{automation_id}` | automation · delete · team-only | `deleteAutomation` — the reason becomes optional (mistake, duplicate, not needed, other — `other` needs a note, [P11](decisions.md)); stops at once: open runs and waiting messages cancelled; contacts stay; a starter-question automation's questions are taken off the account | plan:L2608, L3035 |
| RC-31 | NEW | POST | `/api/v1/app/automations/{automation_id}/go-live` | automation · update · team-only | `goLiveAutomation` — runs the go-live checks (the plan's §5.1 list plus "a hello always has a next-step button when later steps exist", [P2](decisions.md)) and refuses with the missing items, each tagged with its step so the editor jumps there; refused when the plan ended, the month limit is reached, the account is not connected, or a PRO part needs Creator or Studio. Ways to start and features on the untested code list (story repost, ad comments, Live comments, mark as seen, the 7-day ad window, quick replies / cards on Unified Login) are refused until their §43 test passes ([P36](decisions.md)). Warnings (shared keyword, private account) do not refuse. A paused automation's waiting DMs go on (under 7 days); starter questions are set; its lanes wake | plan:L2602, L2635–L2653, L690–L707 |
| RC-32 | NEW | POST | `/api/v1/app/automations/{automation_id}/pause` | automation · update · team-only | `pauseAutomation` — pause with **keep** (waiting DMs stay, chats in progress finish) or **cancel** (its waiting messages count as cancelled from now); starter questions are taken off | plan:L2603–L2604 |
| RC-33 | NEW | POST | `/api/v1/app/automations/{automation_id}/duplicate` | automation · create · team-only · X-Idempotency-Key required | `duplicateAutomation` — a draft copy "<name> (copy)" on the same account; a link automation gets a new link code; counters start at 0 | plan:L2607 |
| RC-34 | NEW | POST | `/api/v1/app/automations/{automation_id}/keyword-test` | automation · read · team-only | `testAutomationKeyword` — "try it": takes a text and answers whether it starts this automation, which word matched (exact or close spelling), and which automation of the account would answer first by the match order. Sends and saves nothing | plan:L845, L5008–L5027 |

## Runs & messages

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-35 | NEW | GET | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/sending-status` | instagram-account · read · team-only | `getInstagramSendingStatus` — what the account's banners need: how many wait per lane, every stop with its reason and end, paused or suspended, the new-account limit, the estimate (about how many will go, how many may expire, done at about), today's daily line (sent, not sure, skipped, expired), the per-automation "chat closed" line, and the last broadcast, past-comments and retry results. Read from a short-lived copy, or Postgres without one | plan:L2530–L2574, L2232 |
| RC-36 | NEW | GET | `/api/v1/app/contacts/{contact_id}/activity` | contact · read · team-only | `listContactActivity` — "What happened": our messages to her of about the last 30 days ([P13](decisions.md)), her saved answers (email, phone, taps), her runs and their history (90 days). Never her own free text | plan:L2627, L261 |
| RC-37 | NEW | GET | `/api/v1/app/automations/{automation_id}/failed-messages/summary` | automation · read · team-only | `getAutomationFailedMessagesSummary` — the count before a retry: failed messages of about the last 30 days, how many can go again now, how many cannot (too old, chat closed, final for that person, text still refused, broadcast) | plan:L2617, L2700–L2733 |
| RC-38 | NEW | POST | `/api/v1/app/automations/{automation_id}/failed-messages/retry` | automation · update · team-only | `retryAutomationFailedMessages` — puts the ones still allowed back to waiting, each at most once ever; they go through the normal lanes, gates and limits; audited | plan:L2617, L6013–L6040 |
| RC-39 | NEW | GET | `/api/v1/app/contacts/{contact_id}/failed-messages/summary` | contact · read · team-only | `getContactFailedMessagesSummary` — as RC-37, for one contact | plan:L2617, L2702 |
| RC-40 | NEW | POST | `/api/v1/app/contacts/{contact_id}/failed-messages/retry` | contact · update · team-only | `retryContactFailedMessages` — as RC-38, for one contact | plan:L2617, L6013–L6040 |

## Broadcasts & segments

PRO (Creator and Studio, plan D68): on Free the create and send routes refuse with "Broadcasts are on Creator
and Studio". Owner, Admin and Editor make, send and cancel; Viewer only reads (plan:L2690). Delete is soft,
then purged ([P9](decisions.md), A9).

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-41 | NEW | GET | `/api/v1/app/segments` | automation · read · team-only | `listSegments` — one account's saved segments (`instagram_account_id` filter), by name | plan:L3719–L3750 |
| RC-42 | NEW | POST | `/api/v1/app/segments` | automation · create · team-only · X-Idempotency-Key required | `createSegment` — a named audience of one account: conditions in AND / OR groups, at most 2 levels and 20 conditions | plan:L2612, L1711, L3719–L3750 |
| RC-43 | NEW | GET | `/api/v1/app/segments/{segment_id}` | automation · read · team-only | `getSegment` — one segment with its conditions | plan:L3719–L3750 |
| RC-44 | NEW | PATCH | `/api/v1/app/segments/{segment_id}` | automation · update · team-only | `updateSegment` — name or conditions; a broadcast already sent keeps its own copy | plan:L2612, L3748 |
| RC-45 | NEW | DELETE | `/api/v1/app/segments/{segment_id}` | automation · delete · team-only | `deleteSegment` — soft delete; broadcasts keep their copy of the conditions | plan:L3750 |
| RC-46 | NEW | POST | `/api/v1/app/segments/audience-count` | automation · read · team-only | `countSegmentAudience` — the preview for conditions (saved or not): how many match and how many can get it now (chat open); conditions too heavy to count at once are counted in the background and the answer says so | plan:L1726, L2689 |
| RC-47 | NEW | GET | `/api/v1/app/broadcasts` | automation · read · team-only | `listBroadcasts` — one account's broadcasts: name, mode, status and numbers (sent, skipped, replies, taps) | plan:L2688 |
| RC-48 | NEW | POST | `/api/v1/app/broadcasts` | automation · create · team-only · X-Idempotency-Key required | `createBroadcast` — a `draft` on one account: the audience (a segment or its own conditions), 1 to 3 messages (with `{name}`, versions, a "start automation X" button), and the mode | plan:L1705–L1770, L3752–L3791, L4070–L4089 |
| RC-49 | NEW | GET | `/api/v1/app/broadcasts/{broadcast_id}` | automation · read · team-only | `getBroadcast` — one broadcast with its status, mode, audience copy and numbers | plan:L3752–L3791 |
| RC-50 | NEW | PATCH | `/api/v1/app/broadcasts/{broadcast_id}` | automation · update · team-only | `updateBroadcast` — edits a `draft` only | plan:L4070–L4089 |
| RC-51 | NEW | DELETE | `/api/v1/app/broadcasts/{broadcast_id}` | automation · delete · team-only | `deleteBroadcast` — soft delete of a broadcast that is not sending or waiting (cancel it first) | plan:L3791 |
| RC-52 | NEW | POST | `/api/v1/app/broadcasts/{broadcast_id}/send` | automation · update · team-only · X-Idempotency-Key required | `sendBroadcast` — leaves `draft`: now, at a set time, or when her chat opens (active 1 to 7 days); it takes its copy of the conditions; only open chats get it; refused when the plan ended or the month limit is reached; audited | plan:L2613, L1731–L1770, L4070–L4089 |
| RC-53 | NEW | POST | `/api/v1/app/broadcasts/{broadcast_id}/cancel` | automation · update · team-only | `cancelBroadcast` — a draft, scheduled, sending or waiting broadcast becomes `cancelled`: waiting recipients skipped, their waiting messages cancelled, sent ones stay sent; audited | plan:L2614, L2688 |

## Past comments

PRO, comment and ad-comment automations only (not Live), plan D69.

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-54 | NEW | POST | `/api/v1/app/automations/{automation_id}/backfills` | automation · update · team-only | `startAutomationBackfill` — "Also answer comments from the last N days" (1 to 7) on a live comment or ad-comment automation; refused while one runs for this automation ("Past comments are already being read"); one read at a time per account, the rest queue | plan:L2619, L2694–L2698, L5148–L5166 |
| RC-55 | NEW | GET | `/api/v1/app/automations/{automation_id}/backfills/{backfill_id}` | automation · read · team-only | `getAutomationBackfill` — one read: status (queued, reading, done, failed), found, matched, queued so far | plan:L2696, L3818–L3849 |

## Workspace usage & notices

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-56 | NEW | GET | `/api/v1/app/usage` | organization · read · team-only | `getAppUsage` — the workspace's DM month meter (used, limit, resets on in the workspace's time zone, state ok, nearly from 80 %, reached at 100 %), accounts used against the plan's maximum, and the workspace notices to show (limit nearly reached, limit reached, payment failed, plan ended, being set up, paused); the trial notice ([P28](decisions.md)). Replaces the plan's `dm_month` field on `GET /auth/me/context` ([P14](decisions.md)) | plan:L2576–L2591, L8031–L8039 |

## Product around sending

The plan's Part F (§44–47), all in this iteration ([P28](decisions.md)) except the referral program (§48,
[P39](decisions.md)) — the month meter is RC-56, and the PRO gate has no route of its own. The role rename
(Member → Editor, a new Viewer) changes data, not routes. Plan prices are seed placeholders
([P37](decisions.md)).

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-57 | CHANGED | GET | `/api/v1/billing/plans` | PUBLIC | `listPlans` — Free, Creator and Studio with typed features (DMs per month, accounts maximum, PRO parts, priority support) and the yearly price per month; old rows off. Prices are placeholders ([P37](decisions.md)) | plan:L7932–L7949 |
| RC-58 | CHANGED | GET | `/api/v1/billing/plans/{plan_id}` | PUBLIC | `getPlan` — as RC-57, one plan | plan:L7932–L7949 |
| RC-59 | CHANGED | POST | `/api/v1/billing/subscriptions/{subscription_id}/change-plan` | subscription · manage · team-only · X-Idempotency-Key required | `changePlan` — a move down takes the Instagram accounts to keep; applied at the period end (no pick: the oldest-connected stay); PRO parts the new plan lacks are off, nothing is deleted | plan:L7987–L8027, L2630 |
| RC-60 | NEW | POST | `/api/v1/app/social/instagram/accounts/{instagram_account_id}/activate` | instagram-account · manage · team-only | `activateInstagramAccount` — "choose active accounts": makes this "not in your plan" account active and stops the active account named in the body in its place, under the workspace lock, so the active count always fits the plan | plan:L2631, L7987–L8027 |
| RC-61 | CHANGED | POST | `/api/v1/uploads` | AUTH | `createUpload` — a new purpose for message files: image (png, jpeg) up to 8 MB, voice note up to 25 MB, PDF up to 25 MB, bound to the workspace; the upload ceiling goes from 10 MB to 25 MB. A message file may be used once confirm's type and magic-byte checks pass — no scan this iteration ([P34](decisions.md)) | plan:L8443 |
| RC-64 | CHANGED | GET | `/api/v1/auth/me/context` | AUTH | `getMeContext` — adds the workspace's connected-account count, its paused status and the trial end; the DM meter is RC-56 instead ([P14](decisions.md)) | plan:L8214–L8236, L8111 |
| RC-65 | CHANGED | POST | `/api/v1/billing/subscriptions` | subscription · manage · team-only · X-Idempotency-Key required | `createSubscription` — takes a 7-day no-card trial, once per workspace and per Instagram account | plan:L8081–L8113 |
| RC-66 | CHANGED | POST | `/api/v1/billing/webhook` | PUBLIC (Stripe-Signature) | `receiveStripeWebhook` — moves an unpaid trial to Free (the referral-earning cut on refunds and disputes is out, [P39](decisions.md)) | plan:L8081–L8113, L8284 |
| RC-67 | CHANGED | GET | `/api/v1/billing/payment-methods` | subscription · read | `listPaymentMethods` — each card says whether it is the default | plan:L8073 |
| RC-68 | NEW | DELETE | `/api/v1/billing/payment-methods/{payment_method_id}` | subscription · manage | `deletePaymentMethod` — removes a card; the only default card is kept while a paid plan is on | plan:L8075 |
| RC-69 | NEW | POST | `/api/v1/billing/payment-methods/{payment_method_id}/default` | subscription · manage · X-Idempotency-Key required | `setDefaultPaymentMethod` — the customer's and the subscription's default card | plan:L8076 |
| RC-70 | NEW | POST | `/api/v1/auth/oauth/apple/callback` | PUBLIC (Apple's form post) | `completeAppleSignIn` — Apple's form callback, at most 16 KiB; it never signs anyone in by itself | plan:L7662–L7693, L7686 |
| RC-71 | CHANGED | GET | `/api/v1/auth/oauth/providers` | PUBLIC | `listOAuthProviders` — Google and Apple; GitHub is hidden | plan:L7778 |
| RC-72 | CHANGED | GET | `/api/v1/auth/oauth/{provider}` | PUBLIC | `startOAuth` — a link mode for a signed-in person with a recent step-up, linking that Google or Apple account even with another email | plan:L7776 |
| RC-73 | CHANGED | POST | `/api/v1/auth/email/send-code` | PUBLIC | `sendEmailCode` — digits-only codes; answers when a new code may be asked and when it expires; a resend too soon is refused with its wait; a day limit | plan:L7634–L7660 |
| RC-74 | CHANGED | POST | `/api/v1/auth/email/login` | PUBLIC | `loginWithEmailCode` — separate reasons (wrong, expired, used up, day limit) and the tries left | plan:L7634–L7660 |
| RC-75 | CHANGED | POST | `/api/v1/auth/mfa/login` | PUBLIC | `loginWithSecondFactor` — "trust this device" for 30 days; a wrong code says the tries left; too many lock | plan:L7710–L7750 |
| RC-76 | CHANGED | POST | `/api/v1/auth/step-up` | AUTH | `stepUp` — takes an email code when there is no second factor (no password) | plan:L7752–L7771 |
| RC-77 | CHANGED | DELETE | `/api/v1/auth/me/auth-methods/{auth_method_id}` | AUTH | `deleteAuthMethod` — the email-code way can never be removed | plan:L7777 |
| RC-78 | CHANGED | GET | `/api/v1/auth/me/sessions` | AUTH | `listSessions` — each session's place (city, country) | plan:L8194–L8199 |
| RC-79 | NEW | POST | `/api/v1/auth/email/confirm` | PUBLIC (the emailed token) | `confirmEmail` — marks the email confirmed | plan:L8211 |
| RC-80 | NEW | POST | `/api/v1/users/me/email-confirmation` | AUTH | `requestEmailConfirmation` — emails the confirm link; resend after 60 s | plan:L8209 |
| RC-81 | CHANGED | PATCH | `/api/v1/users/me` | AUTH | `updateMe` — onboarding's Instagram handle and goal | plan:L7802–L7826 |
| RC-82 | CHANGED | PATCH | `/api/v1/users/me/settings` | AUTH | `updateMySettings` — reduce motion; a personal workspace is refused as the default | plan:L7857, L8204 |
| RC-83 | CHANGED | GET | `/api/v1/users/me/organizations` | AUTH | `listMyOrganizations` — role and counts per workspace, search, personal workspace hidden | plan:L7849–L7859 |
| RC-84 | CHANGED | GET | `/api/v1/users/me/notification-preferences` | AUTH | `getNotificationPreferences` — the 7 kinds and the new types (broadcast done, past comments done, automation stopped, …) | plan:L8135–L8182 |
| RC-85 | CHANGED | PUT | `/api/v1/users/me/notification-preferences` | AUTH | `updateNotificationPreferences` — as RC-84; security and billing email cannot be turned off | plan:L8135–L8182, L2667 |
| RC-86 | NEW | POST | `/api/v1/tenancy/membership-invitations/{membership_invitation_id}/preview` | PUBLIC (the invitation token; a signed-in caller is recognised) | `previewMembershipInvitation` — what the invitation page shows, in its 7 states | plan:L7828–L7847 |
| RC-87 | CHANGED | GET | `/api/v1/tenancy/organization/memberships` | membership · read | `listMemberships` — adds the count per role | plan:L7895 |
| RC-88 | CHANGED | POST | `/api/v1/tenancy/organization/memberships` | membership · create · team-only · X-Idempotency-Key required | `inviteMembers` — 1 to 20 emails and one role, one result per email | plan:L7891–L7897 |
| RC-89 | CHANGED | PATCH | `/api/v1/tenancy/organization` | organization · update | `updateOrganization` — the slug is read only; a tile colour | plan:L7899–L7907 |
| RC-90 | CHANGED | POST | `/api/v1/tenancy/organization/roles` | role · create · team-only · X-Idempotency-Key required | `createRole` — refused while custom roles are off | plan:L7861–L7889 |
| RC-91 | CHANGED | PATCH | `/api/v1/tenancy/organization/roles/{role_id}` | role · update | `updateRole` — refused while custom roles are off | plan:L7861–L7889 |
| RC-92 | CHANGED | DELETE | `/api/v1/tenancy/organization/roles/{role_id}` | role · delete | `deleteRole` — refused while custom roles are off | plan:L7861–L7889 |
| RC-93 | CHANGED | PUT | `/api/v1/tenancy/organization/roles/{role_id}/permissions` | role · update | `replaceRolePermissions` — refused while custom roles are off | plan:L7861–L7889 |
| RC-94 | CHANGED | POST | `/api/v1/tenancy/organization/roles/{role_id}/restore` | role · delete · X-Idempotency-Key required | `restoreRole` — refused while custom roles are off | plan:L7861–L7889 |
| RC-98 | REMOVED | POST | `/api/v1/auth/login` | was PUBLIC | `login` — passwords are off everywhere; replaced by the email code (`/auth/email/login`), Google and Apple | plan:L7613 |
| RC-99 | REMOVED | POST | `/api/v1/auth/password/forgot` | was PUBLIC | `forgotPassword` — no passwords; nothing replaces it | plan:L7613 |
| RC-100 | REMOVED | POST | `/api/v1/auth/password/reset` | was PUBLIC | `resetPassword` — no passwords; nothing replaces it | plan:L7613 |
| RC-101 | REMOVED | POST | `/api/v1/auth/password/change` | was AUTH | `changePassword` — no passwords; step-up uses the email code (RC-76) | plan:L7613 |

**Out of scope (P39)** — the referral program moves to a later iteration ([P39](decisions.md)); these
proposed routes leave the plan:

- RC-95 `GET /api/v1/billing/referrals/me` (`getMyReferral`), RC-96 `POST /api/v1/billing/referrals/claim`
  (`claimReferral`), RC-97 `POST /api/v1/billing/referral-payouts` (`recordReferralPayout`) — plan:L8294,
  L8310–L8312; and RC-66's referral part (refunds and disputes reduce a referral earning, plan:L8284).

**Out of scope (P34)** — no file scan this iteration, a D58 deviation recorded in `AS-BUILT.md`
([P34](decisions.md)); message files pass the type and magic-byte checks instead (RC-61):

- RC-62 `POST /api/v1/uploads/{upload_id}/confirm` (a confirmed message file is scanned) and RC-63
  `GET /api/v1/uploads/{upload_id}` (the scan result) — both stay as built (plan:L8443, L269).

## Before → after

| # | Route | What changes | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| RC-8 | `GET /api/v1/app/social/instagram/accounts/{instagram_account_id}` | path, output | `GET …/social/instagram/account` — the workspace's one account, with the token end | the account by its id, with its Meta connection, paused / suspended, new-account limit end; no token end | many accounts (D26, [P1](decisions.md)); token never expires (D24) |
| RC-9 | `DELETE /api/v1/app/social/instagram/accounts/{instagram_account_id}` | path, behaviour | `DELETE …/social/instagram/account` — the one account `revoked`, token erased | the named account `revoked`, lanes stopped, starter questions removed; token erased only with the connection's last account; waiting messages stay and expire | D26, plan:L4683–L4693 |
| RC-12 | `PATCH /api/v1/app/social/instagram/accounts/{instagram_account_id}/settings` | path, input | `…/account/settings` — automation switch + 5 public-reply settings | per account: limits, stop words, automatic notice, comment replies, once per post, mark as seen, extra delay (PRO); public-reply settings moved to the automation | D14, D32, D26 |
| RC-13 | `GET …/accounts/{instagram_account_id}/media` | path, output | `GET …/social/instagram/media` — the one account's posts, Instagram Login | the named account's posts with caption and kind, Unified Login | D24, D26 |
| RC-14 | `GET …/accounts/{instagram_account_id}/stories` | path | `GET …/social/instagram/stories` | the named account's stories; "one story" offered only once Meta test 3 passes | D26, [P36](decisions.md) |
| RC-16 | `POST /api/v1/app/social/instagram/webhook` | behaviour | Instagram app secret; dedupe on the events table; one in-order run per account that also sends; store failure answers a failure | Meta app secret; read receipts and own "sent" dropped; 8-day replay guard; key table dedupe; new kinds; intake by kind, never sends; Postgres down answers 500 / 503 so Meta delivers again ([P32](decisions.md)) | D15, D24, plan:L4734–L4807 |
| RC-17 | `POST …/social/instagram/deauthorize` | behaviour | Instagram app secret; the account found by its app-scoped id | Meta app secret; found through the Meta connection; an unmatched id is answered and the team told | D24, plan:L4695–L4705 |
| RC-18 | `POST …/social/instagram/data-deletion` | behaviour | as RC-17 before, then erase | as RC-17 after, then erase; unmatched id still gets its code | D24 |
| RC-19 | `GET …/social/instagram/webhook-events` | output | 30 days, masked body kept, own comment `echo`, `failed` final | 8 days, body cleared when done, `own_comment`, new kinds, a failed event's next hourly try | D15, plan:L5105–L5115 |
| RC-20 | `GET /api/v1/app/contacts` | input, output | all the workspace's contacts (one account) | one account's contacts; tag and phone search; opted out, paused, how she came in, comment numbers | D26, plan:L2960–L2993 |
| RC-25 | `DELETE /api/v1/app/contacts/{contact_id}` | behaviour | personal data wiped, open runs cancelled | also her waiting messages cancelled | plan:L2628 |
| RC-26 | `GET /api/v1/app/automations` | input, output | every automation, status `active` / `inactive`, completed count | one account's, `draft` / `live` / `paused`, runs and % tapped from the all-time counts | plan:L2514–L2528 |
| RC-27 | `POST /api/v1/app/automations` | input, behaviour | a complete automation, fully checked; the account implicit | a draft with only a name; the account in the body; nothing checked | D28, D26, plan:L2601 |
| RC-28 | `GET /api/v1/app/automations/{automation_id}` | output | launch shape (opening message, follow, email, phone, one final DM) | new shape: ways to start, message list, versions, wordings, reply step, counters per version, stop reason, past-comments read | plan:L2995–L3145 |
| RC-29 | `PATCH /api/v1/app/automations/{automation_id}` | input, behaviour | content and status (`active` / `inactive`), full check every save; read-only plan refused | content only; check only when live or paused, problems by step; read-only plan allowed except a PRO part on | [P8](decisions.md), [P10](decisions.md), D28 |
| RC-30 | `DELETE /api/v1/app/automations/{automation_id}` | input, behaviour | reason required; open runs cancelled | reason optional; open runs and waiting messages cancelled; starter questions removed | [P11](decisions.md), plan:L2608 |
| RC-57 | `GET /api/v1/billing/plans` | output | Free, Starter, Growth, Pro | Free, Creator, Studio with typed sending features and yearly price per month | plan:L7932–L7949, [P28](decisions.md), [P37](decisions.md) |
| RC-58 | `GET /api/v1/billing/plans/{plan_id}` | output | as RC-57 before | as RC-57 after | [P28](decisions.md) |
| RC-59 | `POST …/subscriptions/{subscription_id}/change-plan` | input | plan only | plan + Instagram accounts to keep on a move down | plan:L7987–L8027, [P28](decisions.md) |
| RC-61 | `POST /api/v1/uploads` | input | images and PDF up to 10 MB | + message-file purpose: image 8 MB, audio 25 MB, PDF 25 MB; type and magic-byte checks, no scan | plan:L8443, [P28](decisions.md), [P34](decisions.md) |
| RC-64 | `GET /api/v1/auth/me/context` | output | plan access | + connected-account count, workspace paused, trial end | plan:L8214–L8236, [P28](decisions.md) |
| RC-65 | `POST /api/v1/billing/subscriptions` | input | plan | + no-card trial | D73, [P28](decisions.md) |
| RC-66 | `POST /api/v1/billing/webhook` | behaviour | Stripe events as built | + unpaid trial to Free (no referral part) | [P28](decisions.md), [P39](decisions.md) |
| RC-67 | `GET /api/v1/billing/payment-methods` | output | cards | + default flag | [P28](decisions.md) |
| RC-71 | `GET /api/v1/auth/oauth/providers` | output | Google, GitHub | Google, Apple | [P28](decisions.md) |
| RC-72 | `GET /api/v1/auth/oauth/{provider}` | input | sign in only | + link mode | [P28](decisions.md) |
| RC-73 | `POST /api/v1/auth/email/send-code` | behaviour, output | letters and digits | digits only, resend timer, day limit | [P28](decisions.md) |
| RC-74 | `POST /api/v1/auth/email/login` | output | one refusal | four reasons + tries left | [P28](decisions.md) |
| RC-75 | `POST /api/v1/auth/mfa/login` | input, output | code only | + trust this device; tries left; lock | [P28](decisions.md) |
| RC-76 | `POST /api/v1/auth/step-up` | input | password or second factor | + email code | [P28](decisions.md) |
| RC-77 | `DELETE /api/v1/auth/me/auth-methods/{auth_method_id}` | behaviour | any way removable | the email-code way is never removed | [P28](decisions.md) |
| RC-78 | `GET /api/v1/auth/me/sessions` | output | device, last active | + place | [P28](decisions.md) |
| RC-81 | `PATCH /api/v1/users/me` | input | name, job title | + Instagram handle, goal | [P28](decisions.md) |
| RC-82 | `PATCH /api/v1/users/me/settings` | input, behaviour | as built | + reduce motion; personal default refused | [P28](decisions.md) |
| RC-83 | `GET /api/v1/users/me/organizations` | output, input | plain list incl. personal | role, counts, search; personal hidden | [P28](decisions.md) |
| RC-84 | `GET …/notification-preferences` | output | 11 types | 7 kinds, new types | [P28](decisions.md) |
| RC-85 | `PUT …/notification-preferences` | input | 11 types | 7 kinds, new types | [P28](decisions.md) |
| RC-87 | `GET /api/v1/tenancy/organization/memberships` | output | members | + count per role | [P28](decisions.md) |
| RC-88 | `POST /api/v1/tenancy/organization/memberships` | input, output | one email | 1–20 emails, a result per email | [P28](decisions.md) |
| RC-89 | `PATCH /api/v1/tenancy/organization` | input | slug editable | slug read only; tile colour | [P28](decisions.md) |
| RC-90 | `POST /api/v1/tenancy/organization/roles` | behaviour | custom roles allowed | refused while custom roles are off | [P28](decisions.md) |
| RC-91 | `PATCH …/roles/{role_id}` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-92 | `DELETE …/roles/{role_id}` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-93 | `PUT …/roles/{role_id}/permissions` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-94 | `POST …/roles/{role_id}/restore` | behaviour | allowed | refused while off | [P28](decisions.md) |

**REMOVED and what replaces it:** RC-6 (`POST …/social/instagram/connect`) → RC-1 + RC-2 + RC-3; RC-98
(`POST /auth/login`) → the email code, Google and Apple; RC-99 and RC-100 (forgot, reset) → nothing;
RC-101 (change password) → nothing, step-up by email code (RC-76). The four password routes go in this
iteration ([P28](decisions.md)).

## Findings

**Operations no route serves (coverage gaps)**

1. **Team "suspend an account"** (plan:L2655–L2661) — the column comes now, the platform-admin route later
   ([P18](decisions.md)). Team "stop all sending" is an environment switch, not a route.
2. **Dismissing a workspace notice** — "can be dismissed" on the 80 % and trial notices (plan:L2582,
   L2584): settled — the browser remembers it; no route ([P27](decisions.md)).
3. **Undo** (plan:L2605) — no route by design ([P15](decisions.md)); the client replays go-live or pause.
4. **"Change the reply step"**, **"fix a refused text"** (plan:L2609, L2620) — served by RC-29, not their
   own routes.
5. **The account's daily counts** (the plan's "stats", plan:L2574) are served by RC-35, not a separate route.

**Routes no requirement reaches (left out)**

6. A broadcast's recipient list (`GET …/broadcasts/{broadcast_id}/recipients`, in the inventory) — the plan
   shows broadcast numbers only (plan:L2688), so no route is proposed.
7. A list of an automation's past-comments reads — the automation's own read in progress (RC-28) and one
   read by id (RC-55) are enough.
8. The launch account field `access_expires_at` — the token never expires; it leaves the output (RC-8).

**To settle at the route review (not in the questions file)**

9. **Meta login path** — the plan writes `/api/v1/app/meta/connect/start`, `…/callback` and
   `…/meta/connections/:meta_connection_id/accounts` (plan:L4567, L4570, L4593); settled — the
   `meta-connection` sub-domain ([P38](decisions.md)) under `/api/v1/app/social/meta/…`, beside
   `social/instagram` (RC-1–RC-5).
10. **Apple's callback answers a redirect** (303, plan:L7686) while the API's method → status policy allows
    only 200 on POST with no exemptions (RC-70, in scope by [P28](decisions.md)) — still to settle at Step 5.
11. **The connect state lives only in Redis** (10 minutes, one use, plan:L4567) — settled: a Redis nonce,
    short-lived login state; nothing is lost if it goes, the owner starts the login again
    ([P26](decisions.md)).
12. **New params and ids** — `meta_connection_id`, `instagram_account_id`, `segment_id`, `broadcast_id`,
    `backfill_id`, `payment_method_id` need entity entries and public-id prefixes; the plan names none
    (plan:L3241, L3524, L3726, L3759, L3825).
13. **Idempotency** — this file proposes `X-Idempotency-Key required` on the creates and on send / pick
    (RC-3, RC-27, RC-33, RC-42, RC-48, RC-52, RC-69); the plan states none for the app routes;
    be-idempotency-guard confirms the list at Step 5.
14. **The month meter's home** — the plan's notices read everything from `GET /auth/me/context`
    (plan:L8231); with [P14](decisions.md) meepzo-fe reads RC-56 as well. The sibling meepzo-fe iteration
    must follow this contract (backend only now, [P30](decisions.md)).
15. **Webhook-events list horizon** — with 8 days and bodies cleared (D15), RC-19 is a much shorter
    debugging view than the launch's (risk, plan D15).
