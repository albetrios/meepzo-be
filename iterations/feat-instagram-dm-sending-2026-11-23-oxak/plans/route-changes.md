# Route changes — feat-instagram-dm-sending-2026-11-23-oxak

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-dm-sending-2026-11-23-oxak` |
| Mode | initial (Baseline none) |
| Intake mode | brief — from scratch |
| Intake hash | `e2875698ea64` |
| Date | 2026-11-23 |
| Stage | Step 5 — matched to the route review (`routes-final.md` §§ 1–12, rev 1, awaiting the owner's OK), then the owner's channel split ([P40](decisions.md)–[P47](decisions.md)) applied: common channel-connection and channel-account routes, Instagram routes under `/social/instagram/…`; then [P48](decisions.md)–[P51](decisions.md) (2026-11-24): contacts, automations, broadcasts and segments shared again at `/api/v1/app/…` with a `channel_account_id` filter, one feature check with named refusals. Written from the plan (`intake-files/Instagram-DM-Sending-Plan-v8.md`) and the as-built launch (`docs/routes.txt`); the AMBER defaults ([P1](decisions.md)–[P20](decisions.md)) and the answers [P26](decisions.md)–[P39](decisions.md) applied. Each row's Source ends with its route-review number (`routes-final § n, route m`) |

Every route here is a **proposal** — requirement level, what must be true, not how. Kickoff confirms each
one when it builds it and records any change in `AS-BUILT.md`; the built truth is `docs/routes.txt`.

- **Paths — the channel split ([P40](decisions.md)–[P47](decisions.md)), then shared product data ([P48](decisions.md)).** The app domain stays
  `/api/v1/app/…` (the launch's prefix, `docs/routes.txt:15`). What any channel has is **common**:
  the provider login under `/api/v1/app/social/channel-connections/…` (sub-domain `channel-connection/`,
  P41 — Meta's Unified Login is one login for Instagram, Facebook and ads, so the ads picker and Meta's
  deauthorize and data-deletion callbacks belong to the connection, P46) and the connected accounts under
  `/api/v1/app/social/channel-accounts/…` (sub-domain `channel-account/`, P42 — list, read, disconnect,
  pause, resume, activate). The product resources are **shared across channels** (P48, superseding
  P44): contacts, contact tags, automations (with their runs' failed messages and past-comment reads),
  broadcasts and segments are top-level app resources — `/api/v1/app/contacts…`, `/api/v1/app/contact-tags`,
  `/api/v1/app/automations…`, `/api/v1/app/broadcasts…`, `/api/v1/app/segments…` — each belonging to one
  channel account, named in the create body and as a required list filter (`channel_account_id`); the
  contacts and automations keep the launch's paths. What is Instagram's own stays under
  `/api/v1/app/social/instagram/…`: an account's settings, media, stories and sending status at
  `/api/v1/app/social/instagram/accounts/{channel_account_id}/…`, and the webhook and its debugging list
  (P45). The organization meter `/api/v1/app/usage` is common (P47). A
  organization holds many accounts (plan D26, plan:L237), so the launch's singular
  `/social/instagram/account*` routes leave in the same change ([P1](decisions.md), A1). This supersedes
  P38's `/api/v1/app/social/meta/…` (the plan wrote `/api/v1/app/meta/…`, plan:L4567 — finding 9).
- **Params** are snake_case and semantic (`{automation_id}`, `{channel_account_id}`,
  `{channel_connection_id}`); `{provider}` (`meta` today) is the existing non-entity param, as in
  `/auth/oauth/{provider}`. **One account id** (P47): every Instagram route names the account by
  `{channel_account_id}` — there is no second Instagram id. `docs/routes.txt` prints them as
  `:automation_id`. The active organization is the signed `org` claim, never a path segment.
- **Access** is the permission as `<resource> · <action>` (kebab-case codes, as the launch writes them),
  plus `team-only` (refused on a personal organization, as every launch app route) and
  `X-Idempotency-Key required` on every signed-in `POST` that creates a row or starts background work
  (the route review's K3) — state actions (go live, pause, resume) answer a repeat with the same state
  and take none, a `POST` that saves nothing (keyword test) takes none, and the PUBLIC Meta routes take
  none; `PUBLIC` routes name what proves the
  caller. Permission codes stay as they are (P47 — roles are product-wide): the common account and
  connection routes keep `instagram-account · read / manage`. New code: `contact · update` only
  ([P20](decisions.md), A20) — broadcasts, segments and past comments reuse the `automation` codes (plan
  D68, D69).
- **One feature check** ([P50](decisions.md)): go-live (RC-31), the settings (RC-12), a live save
  (RC-29) and a broadcast send (RC-52) ask one shared check — the channel's capability list (a code
  constant, Instagram the only entry, P48), the connection's granted permissions, the plan, and the Meta
  test (P36). A refusal names its reason: `channel_lacks_feature`, `permission_not_granted` (reconnect to
  allow it — RC-113 asks for the missing permission), `plan_lacks_feature`, `feature_not_offered`.
- **Action routes** ([P8](decisions.md), A8): go live, pause, duplicate and try-it are their own `POST`
  routes; `PATCH` on an automation saves content only. **No undo route** ([P15](decisions.md), A15): the
  toast replays the previous action. **The organization DM meter** is its own app route
  ([P14](decisions.md), A14), not a field on `GET /auth/me/context`.
- **Answers applied** ([P26](decisions.md)–[P39](decisions.md)): no cell rests on an open question. Every
  route of the plan's Part F (§44–47) is in its own area, **Product around sending**, in this iteration
  ([P28](decisions.md)); the referral program (§48, [P39](decisions.md)) and the file scan
  ([P34](decisions.md)) are out — see **Out of scope** after that area. Backend only: meepzo-fe opens its
  own iteration later on this contract ([P30](decisions.md)).

**Counts**

| Area | NEW | CHANGED | REMOVED |
| --- | --- | --- | --- |
| Channel connections | 9 | 2 | 1 |
| Channel accounts | 4 | 2 | 0 |
| Instagram account settings | 0 | 1 | 0 |
| Instagram media | 0 | 2 | 0 |
| Instagram webhook | 0 | 3 | 0 |
| Contacts & tags | 4 | 2 | 0 |
| Automations | 4 | 5 | 0 |
| Runs & messages | 6 | 0 | 0 |
| Broadcasts & segments | 13 | 0 | 0 |
| Past comments | 2 | 0 | 0 |
| Organization usage & notices | 1 | 0 | 0 |
| Product around sending | 6 | 38 | 4 |
| **Total** | **49** | **55** | **5** |

Since the last version ([P48](decisions.md)–[P51](decisions.md), 2026-11-24): no route is added or
removed and no change kind moves, so the counts stand; five areas lose the "Instagram" in their name.
**P48 (supersedes P44)** — contacts, automations, broadcasts and segments are shared across channels:
their 35 routes (RC-20–RC-34, RC-36–RC-55) move from `/social/instagram/…` to `/api/v1/app/…`, with the
`channel_account_id` filter and body field; the launch's contacts and automations routes (RC-20,
RC-25–RC-30) therefore keep their launch paths and change only in input, output and behaviour; the tag
list (RC-24) becomes `/api/v1/app/contact-tags` with a required `channel_account_id` filter. Sending
status (RC-35) and the account settings, media, stories and webhook routes stay Instagram's. **P50** —
one feature check; the go-live, settings, live-save and broadcast-send refusals name
`channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature` or `feature_not_offered`
(RC-12's `422 instagram_feature_not_offered` becomes `422 feature_not_offered`). **P49, P51** change no
route (the token's refresh field and Meta's usage per connection are data and background work; RC-4 and
RC-112 never return a token).

Earlier (the channel split, [P40](decisions.md)–[P47](decisions.md)): the Meta login
routes become the common **Channel connections** area under `/social/channel-connections/{provider}/…`
and `/social/channel-connections/{channel_connection_id}…` (RC-1–RC-5), with three new routes — one
connection (RC-112), reconnect (RC-113) and its ad accounts (RC-114); the ads picker (RC-15) moves from
the Instagram account to the connection; Meta's deauthorize and data-deletion callbacks (RC-17, RC-18)
move to `/social/channel-connections/{provider}/…`; the account routes become the common **Channel
accounts** area (`/social/channel-accounts/…`, RC-7–RC-11, and activate RC-60 from Product around
sending); every Instagram route takes `{channel_account_id}`; contacts, automations, broadcasts and
segments move under `/social/instagram/…` and their account filter and body field become
`channel_account_id`; the plan features are `message_month_limit` and `channel_accounts_max` (P47). Totals
46 / 54 / 5 → 49 / 54 / 5.

**Unchanged (EXISTING)** — the routes the plan keeps as they are:

- RC-67 `GET /api/v1/billing/payment-methods` (subscription · read, `listPaymentMethods`) — already
  answers `is_default` per card (`BillingAccountSerializer`), so it is served as built (BL19,
  plan:L8073; routes-final § 8, route 104).

Every other launch app route (`docs/routes.txt:20`–`:37`) is CHANGED or REMOVED below.

## Channel connections

Common to every channel ([P41](decisions.md)): one provider login per organization and business portfolio —
for Meta, Unified Login, one login for Instagram, Facebook and ads. `{provider}` is `meta` today.

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-1 | NEW | POST | `/api/v1/app/social/channel-connections/{provider}/start` | channel-account · manage · team-only | `startChannelConnection` — starts a provider login (for `meta`, Unified Login) for this organization and person: a one-use state, valid 10 minutes, bound to both, kept as a Redis nonce ([P26](decisions.md)); answers the provider's login address (always asks her to log in again). An unknown provider is `404` | plan:L4567, L4536–L4568; [P41](decisions.md), [P47](decisions.md); routes-final § 1, route 1 |
| RC-2 | NEW | POST | `/api/v1/app/social/channel-connections/{provider}/callback` | channel-account · manage · team-only · X-Idempotency-Key required | `completeChannelConnection` — takes the provider's code and the state. A state that is missing, used, too old, or another person's or organization's is refused and nothing is saved; the code is swapped on the server; a missing required permission (basic, messages, comments) is refused; then, in one commit, the organization's connection for that business portfolio (new, or the same row again) and its token. Answers the picker: each of her Instagram accounts as "here already", "in another organization" (cannot be picked) or free, and the plan's room (`channel_accounts_max`). **A reconnect lands here too** (RC-113 starts it): same portfolio → same connection, new token, the login stops of its accounts cleared | plan:L4570–L4578, L2621–L2622, L4674–L4681; [P41](decisions.md); routes-final § 1, route 2 |
| RC-3 | NEW | POST | `/api/v1/app/social/channel-connections/{channel_connection_id}/accounts` | channel-account · manage · team-only · X-Idempotency-Key required | `connectChannelAccounts` — attaches the picked accounts. Under the organization lock: over the plan's account limit refuses the whole pick; an account live in another organization is refused alone while the other picks still connect; each pick gets a new channel account (with its Instagram extension) or the organization's old row of that account back (its settings return), its settings and its four sending lanes. After the commit, the account set-up runs (`worker-changes.md`) and the connect is audited | plan:L4590–L4604, L2621; [P42](decisions.md); routes-final § 1, route 3 |
| RC-4 | NEW | GET | `/api/v1/app/social/channel-connections` | channel-account · read · team-only | `listChannelConnections` — the organization's connections for the connections screen: provider, business portfolio, status (connected, error, revoked), granted permissions, who connected, last daily check and its error code, and its channel accounts. Never a token | plan:L3524, L3550; routes-final § 1, route 4 |
| RC-112 | NEW | GET | `/api/v1/app/social/channel-connections/{channel_connection_id}` | channel-account · read · team-only | `getChannelConnection` — one connection, as a row of RC-4 | [P47](decisions.md); plan:L3517–L3553 |
| RC-5 | NEW | DELETE | `/api/v1/app/social/channel-connections/{channel_connection_id}` | channel-account · manage · team-only | `disconnectChannelConnection` — "Disconnect business": every channel account of the connection is disconnected as RC-9, and the token is erased | plan:L4683–L4693, L2623; routes-final § 1, route 5 |
| RC-113 | NEW | POST | `/api/v1/app/social/channel-connections/{channel_connection_id}/reconnect` | channel-account · manage · team-only | `reconnectChannelConnection` — starts a new login for this connection's provider and business portfolio, as RC-1 (a one-use state, 10 minutes); its callback is RC-2, which reuses the same connection | plan:L4674–L4681, L2622; [P47](decisions.md) |
| RC-114 | NEW | GET | `/api/v1/app/social/channel-connections/{channel_connection_id}/ad-accounts` | channel-account · read · team-only | `listChannelConnectionAdAccounts` — the ad accounts the connection's login reaches (Unified Login: one login for Instagram, Facebook and ads, P41), read live, never stored; without the optional ad permission the list is empty and says "Connect an ad account" | plan:L876–L880; [P41](decisions.md), [P47](decisions.md) |
| RC-15 | NEW | GET | `/api/v1/app/social/channel-connections/{channel_connection_id}/ads` | channel-account · read · team-only | `listChannelConnectionAds` — the ads of the connection's ad accounts (an optional ad-account filter), for ad-comment and ad "Send message" automations, read live; without the optional ad permission the list is empty and says "Connect an ad account"; ad comments and the 7-day ad window are built, refused at go-live until their Meta test passes ([P36](decisions.md)). Moved from the Instagram account to the connection (P41) | plan:L876–L880; [P41](decisions.md), [P47](decisions.md); routes-final § 2, route 15 |
| RC-17 | CHANGED — was `POST /api/v1/app/social/instagram/deauthorize` | POST | `/api/v1/app/social/channel-connections/{provider}/deauthorize` | PUBLIC (Meta signed request, Meta app secret) | `deauthorizeChannelConnection` — Meta-wide, so the connection's (P46): resolves which connections and channel accounts it reaches — the accounts by their Instagram user id through a new resolver (it replaces the app-scoped id one, IA19) — and disconnects them as RC-9; an id that matches nothing is still answered, and the team is told | plan:L4695–L4705, L2623; [P46](decisions.md); routes-final § 2, route 16 |
| RC-18 | CHANGED — was `POST /api/v1/app/social/instagram/data-deletion` | POST | `/api/v1/app/social/channel-connections/{provider}/data-deletion` | PUBLIC (Meta signed request, Meta app secret) | `requestChannelConnectionDataDeletion` — as RC-17 (the connection resolves the accounts and people it reaches, IA19, P46), then their data is erased; an unmatched id gets its confirmation code and the team is told | plan:L4695–L4705, L2624; [P46](decisions.md); routes-final § 2, route 17 |
| RC-6 | REMOVED | POST | `/api/v1/app/social/instagram/connect` | was instagram-account · manage · team-only · X-Idempotency-Key required | `connectInstagramAccount` (launch) — Instagram Login and its 60-day token go (plan D24). Replaced by RC-1 (start), RC-2 (code and reconnect), RC-3 (pick accounts) and RC-113 (reconnect) | plan:L4484–L4529, L2622; routes-final § 1 |

## Channel accounts

Common to every channel ([P42](decisions.md)): an organization's connected accounts — Instagram professional
accounts today (`channel` `instagram`), Facebook Pages later. `{channel_account_id}` is the one account id
the API knows (P47).

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-7 | NEW | GET | `/api/v1/app/social/channel-accounts` | channel-account · read · team-only | `listChannelAccounts` — the organization's accounts for the account menu that switches the whole app (an optional `channel` filter): channel, display name, the channel's profile (Instagram: username, picture, followers), status, its connection, paused, stopped and "not in your plan" state | plan:L2527, L2621; [P42](decisions.md); routes-final § 2, route 6 |
| RC-8 | CHANGED — was `GET /api/v1/app/social/instagram/account` | GET | `/api/v1/app/social/channel-accounts/{channel_account_id}` | channel-account · read · team-only | `getChannelAccount` — one account by its id: channel, display name, status and its connection, paused or suspended, the plan stop, the new-account limit's end; for Instagram its extension (username, account type, private flag, followers, picture, webhook subscribed, starter questions set) and its Instagram settings. The token end (`access_expires_at`) goes — the token never expires | plan:L2595, L4604, L2922–L2944; [P42](decisions.md); routes-final § 2, route 7 |
| RC-9 | CHANGED — was `DELETE /api/v1/app/social/instagram/account` | DELETE | `/api/v1/app/social/channel-accounts/{channel_account_id}` | channel-account · manage · team-only | `disconnectChannelAccount` — disconnects one account: for Instagram, starter questions removed and webhook unsubscribed (best effort), `revoked`, its lanes stopped, its short-lived copies dropped; the token is erased only with the connection's last account. Automations, contacts and history stay; waiting messages stay and expire by the 7-day rule | plan:L2623, L4683–L4693; routes-final § 2, route 8 |
| RC-10 | NEW | POST | `/api/v1/app/social/channel-accounts/{channel_account_id}/pause` | channel-account · manage · team-only | `pauseChannelAccount` — the owner pauses the account (on the channel account, P42): its four lanes send nothing; comments and taps are still saved | plan:L2599; [P42](decisions.md); routes-final § 2, route 9 |
| RC-11 | NEW | POST | `/api/v1/app/social/channel-accounts/{channel_account_id}/resume` | channel-account · manage · team-only | `resumeChannelAccount` — clears the owner's pause (error stops and a team suspend stay); lanes with waiting messages wake | plan:L2600; routes-final § 2, route 10 |
| RC-60 | NEW | POST | `/api/v1/app/social/channel-accounts/{channel_account_id}/activate` | channel-account · manage · team-only · X-Idempotency-Key required | `activateChannelAccount` — "choose active accounts": makes this "not in your plan" account active (clears its `plan_downgrade` stop) and stops the active account named in the body (`channel_account_id`) in its place, under the organization lock, so the active count always fits `channel_accounts_max` | plan:L2631, L7987–L8027; [P42](decisions.md), [P47](decisions.md); routes-final § 2, route 11 |

## Instagram account settings

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-12 | CHANGED — was `PATCH /api/v1/app/social/instagram/account/settings` | PATCH | `/api/v1/app/social/instagram/accounts/{channel_account_id}/settings` | instagram-account · manage · team-only | `updateInstagramAccountSettings` — the Instagram account's limits (opening DMs per hour, optional day limit, fast answers per hour, per person per hour, broadcasts per hour) within the plan's bounds, stop words, the automatic notice, replies under comments, once per person per post, mark as seen after a reply (turning on a feature the one feature check refuses answers `422` with its reason — `channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature` or `feature_not_offered` (Meta test not passed, [P36](decisions.md)); [P50](decisions.md)), and the extra delay before each message (PRO; `plan_lacks_feature` without it). The automation master switch is the channel account's (P42) and moves with it; the five public-reply settings leave the account (they move to each automation, plan D14, D32). A limit change gives the slow and reply lanes a new turn; other settings count for new events only | plan:L2610–L2611, L2673–L2684, L225; [P50](decisions.md); routes-final § 2, route 12 |

## Instagram media

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-13 | CHANGED — was `GET /api/v1/app/social/instagram/media` | GET | `/api/v1/app/social/instagram/accounts/{channel_account_id}/media` | instagram-account · read · team-only | `listInstagramMedia` — the picked account's posts and reels, read live with the Unified Login token, with caption and kind (post, reel, ad post); a missing picture falls back to the thumbnail or link | plan:L811, L2946–L2958; routes-final § 2, route 13 |
| RC-14 | CHANGED — was `GET /api/v1/app/social/instagram/stories` | GET | `/api/v1/app/social/instagram/accounts/{channel_account_id}/stories` | instagram-account · read · team-only | `listInstagramStories` — the account's live stories for "one story"; built now — a story way to start the code list marks untested (Meta test 3, stories on Unified Login) is refused at go-live until its test passes ([P36](decisions.md)) | plan:L811, L7558; routes-final § 2, route 14 |

## Instagram webhook

Instagram's own ([P45](decisions.md)), on a **per-object Meta path** ([P53](decisions.md)): the Meta dashboard takes one
callback URL per object, so Instagram's is `…/channel-connections/meta/webhooks/instagram`; a later `page`,
`whatsapp-business-account` or `ad-account` object gets its own path into the same shared receiver code, saving into its
own channel's tables.

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-115 | CHANGED: path (was `GET /api/v1/app/social/instagram/webhook`) | GET | `/api/v1/app/social/channel-connections/meta/webhooks/instagram` | PUBLIC (Meta's `hub.verify_token`) | `verifyInstagramWebhook` — Meta's subscription check; answers `hub.challenge` when the Meta webhook verify token matches | P53; routes-final § 5, route 60 |
| RC-16 | CHANGED | POST | `/api/v1/app/social/channel-connections/meta/webhooks/instagram` | PUBLIC (X-Hub-Signature-256, now signed with the Meta app secret) | `receiveInstagramWebhook` — signature first; read receipts and our own "sent" notices are dropped, our own echoes found by a Postgres lookup of the message id (WHQ1); an unknown or revoked channel account saves nothing (an `error` account is saved `received`, not `account_disconnected`; a paused or limit-full account still saves); echoes of the owner's hand-typed messages are saved `received`; events older than 8 days are dropped; a repeat is dropped by its stored event key; new kinds (Live comment, story mention, shared post, starter question, link, reaction, own comment, edit); saved before the answer, then handed to intake by kind. The store has a 3-second budget: Postgres down or slow answers 500 / 503 and saves nothing, so Meta delivers again — no Redis buffer ([P32](decisions.md), WH2) | plan:L4734–L4807; routes-final § 5, route 61 |
| RC-19 | CHANGED | GET | `/api/v1/app/social/instagram/webhook-events` | instagram-webhook-event · read · team-only | `listInstagramWebhookEvents` — adds the `channel_account_id` filter and field (many accounts, P47); shows the new event kinds and reasons (an own comment is `own_comment`; `flood` added, `echo` and `reaction` gone — echoes and reactions are saved `received`), a failed event's `next_attempt_at`, and only 8 days of events; `payload` is `null` once an event is done (WH23) | plan:L226, L3207–L3222, L4772–L4797; routes-final § 5, route 62 |

## Contacts & tags

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-20 | CHANGED — the launch's path, kept (P48) | GET | `/api/v1/app/contacts` | contact · read · team-only | `listContacts` — the contacts of one account (`channel_account_id`, a **required** filter, [P65](decisions.md)), with tags, opted out, automations paused, how she came in, first message, last comment and comment count; search by phone too; filter by tag | plan:L2960–L2993, L1727; routes-final § 3, route 18 |
| RC-21 | NEW | GET | `/api/v1/app/contacts/{contact_id}` | contact · read · team-only | `getContact` — one contact: profile, email and phone she gave, tags, private note, opted out, automations paused (by whom, when), how she came in | plan:L2627, L2960–L2993; routes-final § 3, route 19 |
| RC-22 | NEW | PATCH | `/api/v1/app/contacts/{contact_id}` | contact · update · team-only | `updateContact` — the private note (up to 2,000 characters; nothing is sent); tags added or removed (each change is a tag event that can start a tag automation); automations paused on or off for her (on: her waiting messages skipped and her open runs cancelled in the same commit; off: nothing restarts by itself) | plan:L2615–L2616, L2625–L2626, L5168–L5175; routes-final § 3, route 20 |
| RC-23 | NEW | POST | `/api/v1/app/contacts/bulk-actions` | contact · update · team-only · X-Idempotency-Key required | `runContactBulkAction` — one tag added or removed, or automations paused or resumed, on many contacts of one account (named by ids, 1–500, or by the list's filters); the change runs in the background in pieces of 500 (CT7) | plan:L2615, L2625, L1039; routes-final § 3, route 21 |
| RC-24 | NEW | GET | `/api/v1/app/contact-tags` | contact · read · team-only | `listContactTags` — one account's tags (`channel_account_id`, a **required** filter, P48) with how many contacts carry each, for the tag picker and filters | plan:L1034, L2991; [P48](decisions.md); routes-final § 3, route 22 |
| RC-25 | CHANGED — the launch's path, kept (P48) | DELETE | `/api/v1/app/contacts/{contact_id}` | contact · delete · team-only | `deleteContact` — as built (personal data wiped, row kept, open runs cancelled), and now also her waiting messages are cancelled | plan:L2628; routes-final § 3, route 23 |

## Automations

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-26 | CHANGED — the launch's path, kept (P48) | GET | `/api/v1/app/automations` | automation · read · team-only | `listAutomations` — one account's automations (`channel_account_id`, a **required** filter, [P65](decisions.md)); statuses `draft`, `live`, `paused`; each row with its all-time runs and % tapped, a draft with "edited …"; the top-bar totals (live count, runs). Sorting by the launch's completed count goes | plan:L2514–L2528; routes-final § 4, route 27 |
| RC-27 | CHANGED — the launch's path, kept (P48) | POST | `/api/v1/app/automations` | automation · create · team-only · X-Idempotency-Key required | `createAutomation` — saves a **draft**: only a name is needed, nothing is checked or sent; the account is named in the body as `channel_account_id` (many accounts, P47); the new ways to start, steps, message list, versions, wordings and reply step may be saved unfinished | plan:L2601, L676, L2995–L3145; routes-final § 4, route 28 |
| RC-28 | CHANGED — the launch's path, kept (P48) | GET | `/api/v1/app/automations/{automation_id}` | automation · read · team-only | `getAutomation` — the full automation in its new shape (way to start, steps, versions, wordings, reply step, starter questions, link code), its counters per hello version, a stop reason (`bad_text`), and a past-comments read in progress | plan:L2517–L2524, L2995–L3145, L2696; routes-final § 4, route 29 |
| RC-29 | CHANGED — the launch's path, kept (P48) | PATCH | `/api/v1/app/automations/{automation_id}` | automation · update · team-only | `updateAutomation` — saves content only (status moves by RC-31 and RC-32). A draft saves anything; a live or paused one runs the go-live checks again (the one feature check included, its reasons as RC-31, [P50](decisions.md)) and answers the problems, each with its step. New runs use the new steps; waiting messages read the new text; a removed step's waiting messages are cancelled. Fixing a refused text clears the stop and puts its bad-text failures back to waiting (under 7 days); a reply-step change restarts its box. A read-only plan still lets the owner save, except turning a PRO part on ([P10](decisions.md)) | plan:L2606, L2609, L2620, L2635–L2653; routes-final § 4, route 30 |
| RC-30 | CHANGED — the launch's path, kept (P48) | DELETE | `/api/v1/app/automations/{automation_id}` | automation · delete · team-only | `deleteAutomation` — the reason becomes optional (mistake, duplicate, not needed, other — `other` needs a note, [P11](decisions.md)); stops at once: open runs and waiting messages cancelled; contacts stay; a starter-question automation's questions are taken off the account | plan:L2608, L3035; routes-final § 4, route 31 |
| RC-31 | NEW | POST | `/api/v1/app/automations/{automation_id}/go-live` | automation · update · team-only | `goLiveAutomation` — runs the go-live checks (the plan's §5.1 list plus "a hello always has a next-step button when later steps exist", [P2](decisions.md)) and refuses with the missing items, each tagged with its step so the editor jumps there; refused when the plan ended, the month limit is reached or the account is not connected; a PRO part off Creator or Studio is `plan_lacks_feature`. Every way to start, step, message kind and feature goes through the one feature check ([P50](decisions.md)) — the channel's capability list ([P48](decisions.md)), the connection's granted permissions, the plan, the Meta test — and each refusal names its reason: `channel_lacks_feature`, `permission_not_granted` (reconnect to allow it, RC-113), `plan_lacks_feature`, `feature_not_offered` (on the untested code list — story repost, ad comments, Live comments, mark as seen, the 7-day ad window, quick replies / cards on Unified Login — until its §43 test passes, [P36](decisions.md)). Warnings (shared keyword, private account) do not refuse. A paused automation's waiting DMs go on (under 7 days); starter questions are set; its lanes wake | plan:L2602, L2635–L2653, L690–L707; [P50](decisions.md); routes-final § 4, route 32 |
| RC-32 | NEW | POST | `/api/v1/app/automations/{automation_id}/pause` | automation · update · team-only | `pauseAutomation` — pause with **keep** (waiting DMs stay, chats in progress finish) or **cancel** (its waiting messages count as cancelled from now); starter questions are taken off | plan:L2603–L2604; routes-final § 4, route 33 |
| RC-33 | NEW | POST | `/api/v1/app/automations/{automation_id}/duplicate` | automation · create · team-only · X-Idempotency-Key required | `duplicateAutomation` — a draft copy "<name> (copy)" on the same account; a link automation gets a new link code; counters start at 0 | plan:L2607; routes-final § 4, route 34 |
| RC-34 | NEW | POST | `/api/v1/app/automations/{automation_id}/keyword-test` | automation · read · team-only | `testAutomationKeyword` — "try it": takes a text and answers whether it starts this automation, which word matched (exact or close spelling), and which automation of the account would answer first by the match order. Sends and saves nothing | plan:L845, L5008–L5027; routes-final § 4, route 35 |

## Runs & messages

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-35 | NEW | GET | `/api/v1/app/social/instagram/accounts/{channel_account_id}/sending-status` | instagram-account · read · team-only | `getInstagramSendingStatus` — what the account's banners need: how many wait per lane, every stop with its reason and end, paused or suspended, the new-account limit, the estimate (about how many will go, how many may expire, done at about), today's daily line (sent, not sure, skipped, expired), the per-automation "chat closed" line, and the last broadcast, past-comments and retry results. Read from a short-lived copy, or Postgres without one | plan:L2530–L2574, L2232; routes-final § 6, route 63 |
| RC-36 | NEW | GET | `/api/v1/app/contacts/{contact_id}/activity` | contact · read · team-only | `listContactActivity` — "What happened": our messages to her of about the last 30 days ([P13](decisions.md)), her saved answers (email, phone, taps), her runs and their history (90 days). Never her own free text | plan:L2627, L261; routes-final § 3, route 24 |
| RC-37 | NEW | GET | `/api/v1/app/automations/{automation_id}/failed-messages/summary` | automation · read · team-only | `getAutomationFailedMessagesSummary` — the count before a retry: failed messages of about the last 30 days, how many can go again now, how many cannot (too old, chat closed, final for that person, text still refused, broadcast) | plan:L2617, L2700–L2733; routes-final § 4, route 36 |
| RC-38 | NEW | POST | `/api/v1/app/automations/{automation_id}/failed-messages/retry` | automation · update · team-only · X-Idempotency-Key required | `retryAutomationFailedMessages` — puts the ones still allowed back to waiting, each at most once ever; they go through the normal lanes, gates and limits; audited | plan:L2617, L6013–L6040; routes-final § 4, route 37 |
| RC-39 | NEW | GET | `/api/v1/app/contacts/{contact_id}/failed-messages/summary` | contact · read · team-only | `getContactFailedMessagesSummary` — as RC-37, for one contact | plan:L2617, L2702; routes-final § 3, route 25 |
| RC-40 | NEW | POST | `/api/v1/app/contacts/{contact_id}/failed-messages/retry` | contact · update · team-only · X-Idempotency-Key required | `retryContactFailedMessages` — as RC-38, for one contact | plan:L2617, L6013–L6040; routes-final § 3, route 26 |

## Broadcasts & segments

PRO (Creator and Studio, plan D68): on Free the broadcast create and send routes refuse with `403
plan_feature_required` ("Broadcasts are on Creator and Studio"); segments and audience counts stay open on
Free (BCQ2). Owner, Admin and Editor make, send and cancel; Viewer only reads (plan:L2690). Delete is soft,
then purged 90 days later ([P9](decisions.md), A9, BC4). Both lists need their account (BC5).

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-41 | NEW | GET | `/api/v1/app/segments` | automation · read · team-only | `listSegments` — one account's saved segments (`channel_account_id`, a **required** filter, BC5), by name | plan:L3719–L3750; routes-final § 7, route 77 |
| RC-42 | NEW | POST | `/api/v1/app/segments` | automation · create · team-only · X-Idempotency-Key required | `createSegment` — a named audience of one account: conditions in AND / OR groups, at most 2 levels and 20 conditions | plan:L2612, L1711, L3719–L3750; routes-final § 7, route 78 |
| RC-43 | NEW | GET | `/api/v1/app/segments/{segment_id}` | automation · read · team-only | `getSegment` — one segment with its conditions | plan:L3719–L3750; routes-final § 7, route 79 |
| RC-44 | NEW | PATCH | `/api/v1/app/segments/{segment_id}` | automation · update · team-only | `updateSegment` — name or conditions; a broadcast already sent keeps its own copy | plan:L2612, L3748; routes-final § 7, route 80 |
| RC-45 | NEW | DELETE | `/api/v1/app/segments/{segment_id}` | automation · delete · team-only | `deleteSegment` — soft delete; broadcasts keep their copy of the conditions | plan:L3750; routes-final § 7, route 81 |
| RC-46 | NEW | POST | `/api/v1/app/segments/audience-count` | automation · read · team-only · X-Idempotency-Key required | `countSegmentAudience` — the preview for conditions (saved or not): how many match and how many can get it now (chat open); conditions too heavy to count at once are counted in the background and the answer says so | plan:L1726, L2689; routes-final § 7, route 82 |
| RC-47 | NEW | GET | `/api/v1/app/broadcasts` | automation · read · team-only | `listBroadcasts` — one account's broadcasts (`channel_account_id`, a **required** filter, BC5): name, mode, status and numbers (sent, skipped, replies, taps) | plan:L2688; routes-final § 7, route 70 |
| RC-48 | NEW | POST | `/api/v1/app/broadcasts` | automation · create · team-only · X-Idempotency-Key required | `createBroadcast` — a `draft` on one account: the audience (a segment or its own conditions) and 1 to 3 messages (with `{name}`, versions, a "start automation X" button); the mode is chosen at send (RC-52). Refused on Free with `403 plan_feature_required` (BCQ2) | plan:L1705–L1770, L3752–L3791, L4070–L4089; routes-final § 7, route 71 |
| RC-49 | NEW | GET | `/api/v1/app/broadcasts/{broadcast_id}` | automation · read · team-only | `getBroadcast` — one broadcast with its status, mode, audience copy and numbers | plan:L3752–L3791; routes-final § 7, route 72 |
| RC-50 | NEW | PATCH | `/api/v1/app/broadcasts/{broadcast_id}` | automation · update · team-only | `updateBroadcast` — edits a `draft` only | plan:L4070–L4089; routes-final § 7, route 73 |
| RC-51 | NEW | DELETE | `/api/v1/app/broadcasts/{broadcast_id}` | automation · delete · team-only | `deleteBroadcast` — soft delete, allowed only for `draft`, `done` and `cancelled`; a `scheduled`, `sending` or `waiting_for_chats` one is `409 broadcast_active` (cancel it first, BC11) | plan:L3791; routes-final § 7, route 74 |
| RC-52 | NEW | POST | `/api/v1/app/broadcasts/{broadcast_id}/send` | automation · update · team-only · X-Idempotency-Key required | `sendBroadcast` — leaves `draft`; the send body carries the mode — `now`, `scheduled` with `scheduled_at`, or `when_chat_opens` with `open_wait_days` (1 to 7); it takes its copy of the conditions; only open chats get it; refusals named: `403 plan_feature_required`, `403 organization_read_only`, `409 message_month_limit_reached`, `422 broadcast_incomplete`, and a message kind the one feature check refuses (`channel_lacks_feature`, `permission_not_granted`, `feature_not_offered`, [P50](decisions.md)); audited (BC10) | plan:L2613, L1731–L1770, L4070–L4089; routes-final § 7, route 75 |
| RC-53 | NEW | POST | `/api/v1/app/broadcasts/{broadcast_id}/cancel` | automation · update · team-only · X-Idempotency-Key required | `cancelBroadcast` — a draft, scheduled, sending or waiting broadcast becomes `cancelled`: waiting recipients skipped, their waiting messages cancelled, sent ones stay sent; audited | plan:L2614, L2688; routes-final § 7, route 76 |

## Past comments

PRO, comment and ad-comment automations only (not Live), plan D69.

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-54 | NEW | POST | `/api/v1/app/automations/{automation_id}/backfills` | automation · update · team-only · X-Idempotency-Key required | `startAutomationBackfill` — "Also answer comments from the last N days" (1 to 7) on a live comment or ad-comment automation; refused while one runs for this automation ("Past comments are already being read"); one read at a time per account, the rest queue | plan:L2619, L2694–L2698, L5148–L5166; routes-final § 4, route 38 |
| RC-55 | NEW | GET | `/api/v1/app/automations/{automation_id}/backfills/{automation_backfill_id}` | automation · read · team-only | `getAutomationBackfill` — one read: status (queued, reading, done, failed), found, matched, queued so far | plan:L2696, L3818–L3849; routes-final § 4, route 39 |

## Organization usage & notices

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-56 | NEW | GET | `/api/v1/app/usage` | organization · read · team-only | `getAppUsage` — the organization's DM month meter (used, limit — the plan's `message_month_limit` (BLQ3, P47 — every channel together), resets on in the organization's time zone, state ok, nearly from 80 %, reached at 100 %), accounts used against the plan's maximum, and the organization notices to show (limit nearly reached, limit reached, payment failed, plan ended, being set up, paused); the trial notice ([P28](decisions.md)). Replaces the plan's `dm_month` field on `GET /auth/me/context` ([P14](decisions.md)) | plan:L2576–L2591, L8031–L8039; routes-final § 6, route 64 |

## Product around sending

The plan's Part F (§44–47), all in this iteration ([P28](decisions.md)) except the referral program (§48,
[P39](decisions.md)) — the month meter is RC-56, and the PRO gate has no route of its own. The role rename
(Member → Editor, a new Viewer) changes data, not routes. Plan prices are seed placeholders
([P37](decisions.md)).

| # | Change | Method | Path | Access | Operation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| RC-57 | CHANGED | GET | `/api/v1/billing/plans` | PUBLIC | `listPlans` — Free, Creator and Studio with typed features (DMs per month, accounts maximum, PRO parts, priority support) and the yearly price per month; old rows off. Prices are placeholders ([P37](decisions.md)) | plan:L7932–L7949; routes-final § 8, route 100 |
| RC-58 | CHANGED | GET | `/api/v1/billing/plans/{plan_id}` | PUBLIC | `getPlan` — as RC-57, one plan | plan:L7932–L7949; routes-final § 8, route 101 |
| RC-59 | CHANGED | POST | `/api/v1/billing/subscriptions/{subscription_id}/change-plan` | subscription · manage · team-only · X-Idempotency-Key required | `changePlan` — a move up stays immediate (and clears any scheduled change); a move down takes the channel accounts to keep (`keep_channel_account_ids`, P47) and is applied at the period end (no pick: the oldest-connected stay); the answer carries the `scheduled_change` (plan, when, accounts kept); PRO parts the new plan lacks are off, nothing is deleted (BL5, BL15, BLQ1) | plan:L7987–L8027, L2630; routes-final § 8, route 103 |
| RC-61 | CHANGED | POST | `/api/v1/uploads` | AUTH (upload · manage for an organization upload) · X-Idempotency-Key required | `createUpload` — a new purpose for message files: image (png, jpeg) up to 8 MB, voice note up to 25 MB, PDF up to 25 MB, bound to the organization; the upload ceiling goes from 10 MB to 25 MB. A message file may be used once confirm's type and magic-byte checks pass — no scan this iteration ([P34](decisions.md)) | plan:L8443; routes-final § 12, route 140 |
| RC-64 | CHANGED | GET | `/api/v1/auth/me/context` | AUTH | `getMeContext` — `plan_access` adds `trial_ends_at`, `plan` (id, name) and `features`; the organization adds its connected-account count (`channel_accounts_count`); "organization paused" is the existing `status` (`SUSPENDED`), no new field; the DM meter is RC-56 instead ([P14](decisions.md), BL16) | plan:L8214–L8236, L8111; routes-final § 8, route 108 |
| RC-65 | CHANGED | POST | `/api/v1/billing/subscriptions` | subscription · manage · team-only · X-Idempotency-Key required | `createSubscription` — the body's `is_trial` (optional, default false) takes a 7-day no-card trial on Creator or Studio, once per organization and per Instagram account (`409 trial_already_used`, `409 trial_used_by_account`, `422 plan_has_no_trial`; BL7, BL14) | plan:L8081–L8113; routes-final § 8, route 102 |
| RC-66 | CHANGED | POST | `/api/v1/billing/webhook` | PUBLIC (Stripe-Signature) | `receiveStripeWebhook` — moves an unpaid trial to Free, and applies a scheduled move down at the period end (the referral-earning cut on refunds and disputes is out, [P39](decisions.md); BL22) | plan:L8081–L8113, L8284; routes-final § 8, route 107 |
| RC-68 | NEW | DELETE | `/api/v1/billing/payment-methods/{payment_method_id}` | subscription · manage · team-only | `deletePaymentMethod` — removes a card; the only card is kept while a paid plan is on (`409 default_card_in_use`); `{payment_method_id}` is Stripe's `pm_…` id, a non-entity param (BLQ2, BL20) | plan:L8075; routes-final § 8, route 105 |
| RC-69 | NEW | POST | `/api/v1/billing/payment-methods/{payment_method_id}/default` | subscription · manage · team-only · X-Idempotency-Key required | `setDefaultPaymentMethod` — the customer's and the subscription's default card | plan:L8076; routes-final § 8, route 106 |
| RC-70 | NEW | POST | `/api/v1/auth/oauth/apple/callback` | PUBLIC (Apple's form post) | `completeAppleSignIn` — Apple's form callback, at most 16 KiB; it never signs anyone in by itself; answers `303` to the app page — the one named method-status exemption (ATQ2, recommended; the alternative is a `200` HTML page that redirects) | plan:L7662–L7693, L7686; routes-final § 10, route 124 |
| RC-71 | CHANGED | GET | `/api/v1/auth/oauth/providers` | PUBLIC | `listOAuthProviders` — Google and Apple; GitHub is hidden | plan:L7778; routes-final § 10, route 122 |
| RC-72 | CHANGED | GET | `/api/v1/auth/oauth/{provider}` | PUBLIC | `startOAuth` — a link mode for a signed-in person with a recent step-up, linking that Google or Apple account even with another email | plan:L7776; routes-final § 10, route 123 |
| RC-73 | CHANGED | POST | `/api/v1/auth/email/send-code` | PUBLIC | `sendEmailCode` — digits-only codes; answers when a new code may be asked and when it expires; a resend too soon is refused with its wait; a day limit | plan:L7634–L7660; routes-final § 10, route 120 |
| RC-74 | CHANGED | POST | `/api/v1/auth/email/login` | PUBLIC | `loginWithEmailCode` — separate reasons (wrong, expired, used up, day limit) and the tries left | plan:L7634–L7660; routes-final § 10, route 121 |
| RC-75 | CHANGED | POST | `/api/v1/auth/mfa/login` | PUBLIC | `loginWithSecondFactor` — "trust this device" for 30 days; a wrong code says the tries left; too many lock | plan:L7710–L7750; routes-final § 10, route 126 |
| RC-76 | CHANGED | POST | `/api/v1/auth/step-up` | AUTH | `stepUp` — takes an email code when there is no second factor (no password) | plan:L7752–L7771; routes-final § 10, route 127 |
| RC-77 | CHANGED | DELETE | `/api/v1/auth/me/auth-methods/{auth_method_id}` | AUTH | `deleteAuthMethod` — the email-code way can never be removed | plan:L7777; routes-final § 10, route 125 |
| RC-78 | CHANGED | GET | `/api/v1/auth/me/sessions` | AUTH | `listSessions` — each session's place (city, country) | plan:L8194–L8199; routes-final § 10, route 128 |
| RC-79 | NEW | POST | `/api/v1/auth/email/confirm` | PUBLIC (the emailed token) | `confirmEmail` — body `{ token }` (the link's token): marks the email confirmed; an unknown, spent or expired token is `400` (UN7) | plan:L8211; routes-final § 11, route 134 |
| RC-80 | NEW | POST | `/api/v1/users/me/email-confirmation` | AUTH | `requestEmailConfirmation` — emails the confirm link; a resend within 60 s is `429` with its wait (`retry_after_seconds`, UN6) | plan:L8209; routes-final § 11, route 133 |
| RC-81 | CHANGED | PATCH | `/api/v1/users/me` | AUTH | `updateMe` — onboarding's Instagram handle and goal | plan:L7802–L7826; routes-final § 11, route 130 |
| RC-82 | CHANGED | PATCH | `/api/v1/users/me/settings` | AUTH | `updateMySettings` — reduce motion; a personal organization is refused as the default | plan:L7857, L8204; routes-final § 11, route 131 |
| RC-83 | CHANGED | GET | `/api/v1/users/me/organizations` | AUTH | `listMyOrganizations` — role and counts per organization, search, personal organization hidden | plan:L7849–L7859; routes-final § 11, route 132 |
| RC-84 | CHANGED | GET | `/api/v1/users/me/notification-preferences` | AUTH | `getNotificationPreferences` — speaks **kinds**: the 7 kinds × channels (`{ kind, channel, is_enabled }`), with the new types inside them (broadcast done, past comments done, automation stopped, …) (UNQ1) | plan:L8135–L8182; routes-final § 11, route 135 |
| RC-85 | CHANGED | PUT | `/api/v1/users/me/notification-preferences` | AUTH | `updateNotificationPreferences` — as RC-84, saved per kind (one row per type of the kind); security and billing email cannot be turned off — turning one off is `422` (UNQ1) | plan:L8135–L8182, L2667; routes-final § 11, route 136 |
| RC-86 | NEW | POST | `/api/v1/tenancy/membership-invitations/{membership_invitation_id}/preview` | PUBLIC (the invitation token; a signed-in caller is recognised) | `previewMembershipInvitation` — what the invitation page shows, in its 7 states | plan:L7828–L7847; routes-final § 9, route 118 |
| RC-87 | CHANGED | GET | `/api/v1/tenancy/organization/memberships` | membership · read | `listMemberships` — adds the count per role | plan:L7895; routes-final § 9, route 116 |
| RC-88 | CHANGED | POST | `/api/v1/tenancy/organization/memberships` | membership · create · team-only · X-Idempotency-Key required | `inviteMembers` — 1 to 20 emails and one role (`role_ids`, exactly one), one result per email; the staff fields leave the invite (TN3) | plan:L7891–L7897; routes-final § 9, route 117 |
| RC-89 | CHANGED | PATCH | `/api/v1/tenancy/organization` | organization · update | `updateOrganization` — the slug is read only (sending it is `422 slug_read_only`, TN7); a tile colour (`logo_color`) | plan:L7899–L7907; routes-final § 9, route 110 |
| RC-90 | CHANGED | POST | `/api/v1/tenancy/organization/roles` | role · create · team-only · X-Idempotency-Key required | `createRole` — refused while custom roles are off | plan:L7861–L7889; routes-final § 9, route 111 |
| RC-91 | CHANGED | PATCH | `/api/v1/tenancy/organization/roles/{role_id}` | role · update | `updateRole` — refused while custom roles are off | plan:L7861–L7889; routes-final § 9, route 112 |
| RC-92 | CHANGED | DELETE | `/api/v1/tenancy/organization/roles/{role_id}` | role · delete | `deleteRole` — refused while custom roles are off | plan:L7861–L7889; routes-final § 9, route 113 |
| RC-93 | CHANGED | PUT | `/api/v1/tenancy/organization/roles/{role_id}/permissions` | role · update | `replaceRolePermissions` — refused while custom roles are off | plan:L7861–L7889; routes-final § 9, route 114 |
| RC-94 | CHANGED | POST | `/api/v1/tenancy/organization/roles/{role_id}/restore` | role · delete · X-Idempotency-Key required | `restoreRole` — refused while custom roles are off | plan:L7861–L7889; routes-final § 9, route 115 |
| RC-102 | CHANGED | GET | `/api/v1/auth/oauth/{provider}/callback` | PUBLIC (the OAuth state) | `oauthCallback` — takes `apple`, and the link mode of RC-72: links that Google or Apple account to the signed-in person (`409 provider_account_in_use` when it is someone else's) and answers the linked way instead of a new session (AT10, AT12) | plan:L7662–L7693, L7776; routes-final § 10 |
| RC-103 | CHANGED | DELETE | `/api/v1/auth/me/sessions` | AUTH | `revokeAllSessions` — "sign out everywhere else" also ends every trusted device but this browser's (AT17, AT19) | plan:L7736–L7750, L8199; routes-final § 10 |
| RC-104 | CHANGED | DELETE | `/api/v1/auth/me/mfa/{mfa_method_id}` | AUTH | `deleteMfa` — removing the last 2FA factor also ends the person's trusted devices (AT17) | plan:L7736–L7750; routes-final § 10 |
| RC-105 | CHANGED | DELETE | `/api/v1/auth/me/sessions/{session_id}` | AUTH | `revokeSession` — its strong step-up accepts the email code for a person without 2FA (no password, AT15) | plan:L7752–L7771; routes-final § 10 |
| RC-106 | CHANGED | DELETE | `/api/v1/auth/me/webauthn/credentials/{credential_id}` | AUTH | `webauthnRevokeCredential` — its strong step-up accepts the email code for a person without 2FA (AT15) | plan:L7752–L7771; routes-final § 10 |
| RC-107 | CHANGED | GET | `/api/v1/users/me` | AUTH | `getMe` — adds `instagram_handle` and `goal` (as RC-81 saves them) | plan:L7802–L7826; routes-final § 11 |
| RC-108 | CHANGED | GET | `/api/v1/users/me/settings` | AUTH | `getSettings` — adds `is_reduce_motion_enabled` (as RC-82 saves it) | plan:L8201–L8205; routes-final § 11 |
| RC-109 | CHANGED | POST | `/api/v1/tenancy/organizations` | AUTH · X-Idempotency-Key required | `createOrganization` — `slug` becomes optional: onboarding sends the name only, and the slug is made from it (kebab, unique with a short suffix); the tile colour is picked from the name (TN7) | plan:L7808, L7903; routes-final § 9 |
| RC-110 | CHANGED | GET | `/api/v1/tenancy/organization` | AUTH | `getOrganization` — adds `logo_color` (the tile colour) | plan:L7903–L7906; routes-final § 9 |
| RC-111 | CHANGED | POST | `/api/v1/uploads/{upload_id}/confirm` | AUTH | `confirmUpload` — adds the audio magic-byte checks (AAC, M4A, WAV), and a message file's every type must be checkable; still no scan ([P34](decisions.md), UP4) | plan:L8443; routes-final § 12 |
| RC-98 | REMOVED | POST | `/api/v1/auth/login` | was PUBLIC | `login` — passwords are off everywhere; replaced by the email code (`/auth/email/login`), Google and Apple | plan:L7613; routes-final § 10 |
| RC-99 | REMOVED | POST | `/api/v1/auth/password/forgot` | was PUBLIC | `forgotPassword` — no passwords; nothing replaces it | plan:L7613; routes-final § 10 |
| RC-100 | REMOVED | POST | `/api/v1/auth/password/reset` | was PUBLIC | `resetPassword` — no passwords; nothing replaces it | plan:L7613; routes-final § 10 |
| RC-101 | REMOVED | POST | `/api/v1/auth/password/change` | was AUTH | `changePassword` — no passwords; step-up uses the email code (RC-76) | plan:L7613; routes-final § 10 |

**Out of scope (P39)** — the referral program moves to a later iteration ([P39](decisions.md)); these
proposed routes leave the plan:

- RC-95 `GET /api/v1/billing/referrals/me` (`getMyReferral`), RC-96 `POST /api/v1/billing/referrals/claim`
  (`claimReferral`), RC-97 `POST /api/v1/billing/referral-payouts` (`recordReferralPayout`) — plan:L8294,
  L8310–L8312; and RC-66's referral part (refunds and disputes reduce a referral earning, plan:L8284).

**Out of scope (P34)** — no file scan this iteration, a D58 deviation recorded in `AS-BUILT.md`
([P34](decisions.md)); message files pass the type and magic-byte checks instead (RC-61):

- RC-62 `POST /api/v1/uploads/{upload_id}/confirm` (a confirmed message file is scanned) and RC-63
  `GET /api/v1/uploads/{upload_id}` (the scan result) — no scan; `GET` stays as built (plan:L8443,
  L269). Confirm changes only by its audio magic-byte checks — RC-111.

## Before → after

| # | Route | What changes | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| RC-115 | `GET /api/v1/app/social/channel-connections/meta/webhooks/instagram` | path | `GET /api/v1/app/social/instagram/webhook` | the Instagram object's per-object Meta path; the handshake itself unchanged (reads the Meta verify token) | P53 |
| RC-8 | `GET /api/v1/app/social/channel-accounts/{channel_account_id}` | path, output | `GET …/social/instagram/account` — the organization's one Instagram account, with the token end | a common channel account by its id (P42): channel, display name, status, its connection, paused / suspended, plan stop, new-account limit end; the Instagram extension and settings inside; no token end | many accounts (D26, [P1](decisions.md)); token never expires (D24); [P42](decisions.md), [P47](decisions.md) |
| RC-9 | `DELETE /api/v1/app/social/channel-accounts/{channel_account_id}` | path, behaviour | `DELETE …/social/instagram/account` — the one account `revoked`, token erased | the named channel account `revoked`, lanes stopped, starter questions removed; token erased only with the connection's last account; waiting messages stay and expire | D26, plan:L4683–L4693, [P42](decisions.md) |
| RC-12 | `PATCH /api/v1/app/social/instagram/accounts/{channel_account_id}/settings` | path, input | `…/account/settings` — automation switch + 5 public-reply settings | per account, by its channel account id: limits, stop words, automatic notice, comment replies, once per post, mark as seen, extra delay (PRO) — a feature the one feature check refuses is `422` with its reason (`channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature`, `feature_not_offered`); public-reply settings moved to the automation; the automation switch moved to the channel account | D14, D32, D26, [P36](decisions.md), [P42](decisions.md), [P47](decisions.md), [P50](decisions.md) |
| RC-13 | `GET …/social/instagram/accounts/{channel_account_id}/media` | path, output | `GET …/social/instagram/media` — the one account's posts, Instagram Login | the named account's posts with caption and kind, Unified Login | D24, D26, [P47](decisions.md) |
| RC-14 | `GET …/social/instagram/accounts/{channel_account_id}/stories` | path | `GET …/social/instagram/stories` | the named account's stories; "one story" offered only once Meta test 3 passes | D26, [P36](decisions.md), [P47](decisions.md) |
| RC-16 | `POST /api/v1/app/social/channel-connections/meta/webhooks/instagram` | path (was `/api/v1/app/social/instagram/webhook`, P53), behaviour | Instagram app secret; dedupe on the events table; echoes skipped; an `error` account's events skipped `account_disconnected`; one in-order run per account that also sends; store failure answers a failure | Meta app secret; read receipts and own "sent" dropped, our own echoes by a Postgres message-id lookup; hand-typed echoes and `error` accounts' events saved `received`; 8-day replay guard; key table dedupe; new kinds; intake by kind, never sends; a 3 s store budget — Postgres down or slow answers 500 / 503 so Meta delivers again ([P32](decisions.md)) | D15, D24, WH2, WHQ1, plan:L4734–L4807 |
| RC-17 | `POST …/social/channel-connections/{provider}/deauthorize` | path, behaviour | `POST …/social/instagram/deauthorize` — Instagram app secret; the account found by its app-scoped id | under the connection (Meta-wide, P46); Meta app secret; the connection resolves the accounts it reaches, by the Instagram user id (a new resolver); an unmatched id is answered and the team told | D24, IA19, plan:L4695–L4705, [P46](decisions.md) |
| RC-18 | `POST …/social/channel-connections/{provider}/data-deletion` | path, behaviour | `POST …/social/instagram/data-deletion` — as RC-17 before, then erase | under the connection (P46); as RC-17 after, then erase the accounts' and people's data; unmatched id still gets its code | D24, [P46](decisions.md) |
| RC-19 | `GET …/social/instagram/webhook-events` | input, output | 30 days, masked body kept, own comment `echo`, `failed` final; no account filter | 8 days, `payload` null when done, `own_comment` and `flood`, new kinds, `next_attempt_at`; the `channel_account_id` filter and field | D15, WH23, plan:L5105–L5115, [P47](decisions.md) |
| RC-20 | `GET /api/v1/app/contacts` | input, output | all the organization's contacts (one account) | same path, shared across channels (P48) — one account's contacts, the account a required filter; tag and phone search; opted out, paused, how she came in, comment numbers | D26, CTQ2, plan:L2960–L2993, [P47](decisions.md), [P48](decisions.md) |
| RC-25 | `DELETE /api/v1/app/contacts/{contact_id}` | behaviour | personal data wiped, open runs cancelled | same path (P48) — also her waiting messages cancelled | plan:L2628, [P47](decisions.md), [P48](decisions.md) |
| RC-26 | `GET /api/v1/app/automations` | input, output | every automation, status `active` / `inactive`, completed count | same path, shared across channels (P48) — one account's (a required filter), `draft` / `live` / `paused`, runs and % tapped from the all-time counts | CTQ2, plan:L2514–L2528, [P47](decisions.md), [P48](decisions.md) |
| RC-27 | `POST /api/v1/app/automations` | input, behaviour | a complete automation, fully checked; the account implicit | same path (P48) — a draft with only a name; the account in the body (`channel_account_id`); nothing checked | D28, D26, plan:L2601, [P47](decisions.md), [P48](decisions.md) |
| RC-28 | `GET /api/v1/app/automations/{automation_id}` | output | launch shape (opening message, follow, email, phone, one final DM) | same path (P48) — new shape: ways to start, message list, versions, wordings, reply step, counters per version, stop reason, past-comments read | plan:L2995–L3145, [P47](decisions.md), [P48](decisions.md) |
| RC-29 | `PATCH /api/v1/app/automations/{automation_id}` | input, behaviour | content and status (`active` / `inactive`), full check every save; read-only plan refused | same path (P48) — content only; check only when live or paused, problems by step, the one feature check's reasons (P50); read-only plan allowed except a PRO part on | [P8](decisions.md), [P10](decisions.md), D28, [P47](decisions.md), [P48](decisions.md), [P50](decisions.md) |
| RC-30 | `DELETE /api/v1/app/automations/{automation_id}` | input, behaviour | reason required; open runs cancelled | same path (P48) — reason optional; open runs and waiting messages cancelled; starter questions removed | [P11](decisions.md), plan:L2608, [P47](decisions.md), [P48](decisions.md) |
| RC-57 | `GET /api/v1/billing/plans` | output | Free, Starter, Growth, Pro | Free, Creator, Studio with typed sending features and yearly price per month | plan:L7932–L7949, [P28](decisions.md), [P37](decisions.md) |
| RC-58 | `GET /api/v1/billing/plans/{plan_id}` | output | as RC-57 before | as RC-57 after | [P28](decisions.md) |
| RC-59 | `POST …/subscriptions/{subscription_id}/change-plan` | input, output, behaviour | plan only; every change at once | plan + the channel accounts to keep (`keep_channel_account_ids`); up at once, down at the period end; the answer's `scheduled_change` | plan:L7987–L8027, [P28](decisions.md), [P47](decisions.md), BLQ1 |
| RC-61 | `POST /api/v1/uploads` | input | images and PDF up to 10 MB | + message-file purpose: image 8 MB, audio 25 MB, PDF 25 MB; type and magic-byte checks, no scan | plan:L8443, [P28](decisions.md), [P34](decisions.md) |
| RC-64 | `GET /api/v1/auth/me/context` | output | plan access (`state`, `grace_ends_at`) | + `trial_ends_at`, `plan`, `features`, connected-account count (`channel_accounts_count`, every channel); paused stays the existing `status` | plan:L8214–L8236, [P28](decisions.md), [P47](decisions.md), BL16 |
| RC-65 | `POST /api/v1/billing/subscriptions` | input | plan | + `is_trial` (no-card trial) | D73, [P28](decisions.md), BL14 |
| RC-66 | `POST /api/v1/billing/webhook` | behaviour | Stripe events as built | + unpaid trial to Free; a scheduled move down applied (no referral part) | [P28](decisions.md), [P39](decisions.md), BL22 |
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
| RC-84 | `GET …/notification-preferences` | output | 11 types × channels | 7 kinds × channels, new types inside them | [P28](decisions.md), [P87](decisions.md), UNQ1 |
| RC-85 | `PUT …/notification-preferences` | input | 11 types × channels | 7 kinds × channels; security and billing email off → `422` | [P28](decisions.md), [P87](decisions.md), UNQ1 |
| RC-87 | `GET /api/v1/tenancy/organization/memberships` | output | members | + count per role | [P28](decisions.md) |
| RC-88 | `POST /api/v1/tenancy/organization/memberships` | input, output | one email, with staff fields | 1–20 emails, one role (`role_ids`, exactly one), a result per email; staff fields gone | [P28](decisions.md), TN3 |
| RC-89 | `PATCH /api/v1/tenancy/organization` | input | slug editable | slug read only (`422 slug_read_only`); tile colour | [P28](decisions.md), TN7 |
| RC-90 | `POST /api/v1/tenancy/organization/roles` | behaviour | custom roles allowed | refused while custom roles are off | [P28](decisions.md) |
| RC-91 | `PATCH …/roles/{role_id}` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-92 | `DELETE …/roles/{role_id}` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-93 | `PUT …/roles/{role_id}/permissions` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-94 | `POST …/roles/{role_id}/restore` | behaviour | allowed | refused while off | [P28](decisions.md) |
| RC-102 | `GET /api/v1/auth/oauth/{provider}/callback` | input, behaviour | Google and GitHub sign-in only | + Apple; the link mode links the account to the signed-in person | AT10, AT12 |
| RC-103 | `DELETE /api/v1/auth/me/sessions` | behaviour | ends every other session | + ends every trusted device but this browser's | AT17, D56 |
| RC-104 | `DELETE /api/v1/auth/me/mfa/{mfa_method_id}` | behaviour | removes the factor | + 2FA off ends the trusted devices | AT17, D56 |
| RC-105 | `DELETE /api/v1/auth/me/sessions/{session_id}` | access | strong step-up by password or 2FA | + the email code counts as strong without 2FA | AT15 |
| RC-106 | `DELETE /api/v1/auth/me/webauthn/credentials/{credential_id}` | access | strong step-up by password or 2FA | + the email code counts as strong without 2FA | AT15 |
| RC-107 | `GET /api/v1/users/me` | output | name, job title, … | + `instagram_handle`, `goal` | plan:L7802–L7826 |
| RC-108 | `GET /api/v1/users/me/settings` | output | settings as built | + `is_reduce_motion_enabled` | plan:L8204 |
| RC-109 | `POST /api/v1/tenancy/organizations` | input | `slug` required | `slug` optional, made from the name; tile colour from the name | TN7 |
| RC-110 | `GET /api/v1/tenancy/organization` | output | the organization as built | + `logo_color` | plan:L7903–L7906 |
| RC-111 | `POST /api/v1/uploads/{upload_id}/confirm` | behaviour | magic bytes checked only for png, jpeg, webp, pdf | + audio (AAC, M4A, WAV); a message file's every type must be checkable; no scan | UP4, [P34](decisions.md) |

**REMOVED and what replaces it:** RC-6 (`POST …/social/instagram/connect`) → RC-1 + RC-2 + RC-3 (and
RC-113 for a reconnect), under `/social/channel-connections/…` (P41); RC-98
(`POST /auth/login`) → the email code, Google and Apple; RC-99 and RC-100 (forgot, reset) → nothing;
RC-101 (change password) → nothing, step-up by email code (RC-76). The four password routes go in this
iteration ([P28](decisions.md)).

## Findings

**Operations no route serves (coverage gaps)**

1. **Team "suspend an account"** (plan:L2655–L2661) — the column comes now, the platform-admin route later
   ([P18](decisions.md)). Team "stop all sending" is an environment switch, not a route.
2. **Dismissing an organization notice** — "can be dismissed" on the 80 % and trial notices (plan:L2582,
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

9. **Login path** — the plan writes `/api/v1/app/meta/connect/start`, `…/callback` and
   `…/meta/connections/:meta_connection_id/accounts` (plan:L4567, L4570, L4593); first settled as the
   `meta-connection` sub-domain under `/api/v1/app/social/meta/…` ([P38](decisions.md)), then
   superseded by the channel split: the common `channel-connection` sub-domain under
   `/api/v1/app/social/channel-connections/{provider}/…` and `…/{channel_connection_id}/…`, beside
   `social/channel-accounts`, `social/instagram` and the shared product resources (RC-1–RC-5, RC-112–RC-114; [P41](decisions.md),
   [P47](decisions.md)). Meta's deauthorize and data-deletion callbacks move with it (RC-17, RC-18;
   [P46](decisions.md)), and so does the ads picker (RC-15, RC-114).
10. **Apple's callback answers a redirect** (303, plan:L7686) while the API's method → status policy allows
    only 200 on POST with no exemptions (RC-70, in scope by [P28](decisions.md)) — the route review
    recommends one named `303` exemption for this route alone (ATQ2, routes-final § 10, open to the owner).
11. **The connect state lives only in Redis** (10 minutes, one use, plan:L4567) — settled: a Redis nonce,
    short-lived login state; nothing is lost if it goes, the owner starts the login again
    ([P26](decisions.md)).
12. **New params and ids** — `channel_connection_id`, `channel_account_id` (the one account id — no
    Instagram account id in any path, P47), `segment_id`, `broadcast_id`,
    `automation_backfill_id` (AU1 — not `backfill_id`; named after the shared table
    `app.automation_backfills`, P48) need entity entries and
    public-id prefixes; the plan names none (plan:L3241, L3524, L3726, L3759, L3825). `payment_method_id`
    is Stripe's `pm_…` id — a third non-entity param beside `{provider}` and `{slug}` (BLQ2, recommended).
13. **Idempotency** — settled by the route review (K3): `X-Idempotency-Key required` on RC-2, RC-3,
    RC-23, RC-27, RC-33, RC-38, RC-40, RC-42, RC-46, RC-48, RC-52, RC-53, RC-54, RC-60, RC-69 and the
    platform writes that already take it (RC-59, RC-61, RC-65, RC-88, RC-90, RC-94, RC-109); none on the state
    actions (RC-10, RC-11, RC-31, RC-32), on RC-34 (saves nothing), on RC-1 and RC-113 (they start a login
    and save nothing) or the PUBLIC Meta routes; the
    `docs/routes.txt` `I` column is the built truth.
14. **The month meter's home** — the plan's notices read everything from `GET /auth/me/context`
    (plan:L8231); with [P14](decisions.md) meepzo-fe reads RC-56 as well. The sibling meepzo-fe iteration
    must follow this contract (backend only now, [P30](decisions.md)).
15. **Webhook-events list horizon** — with 8 days and bodies cleared (D15), RC-19 is a much shorter
    debugging view than the launch's (risk, plan D15).
