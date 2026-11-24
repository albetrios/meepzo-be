# Database changes — feat-instagram-dm-sending-2026-11-23-oxak

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-dm-sending-2026-11-23-oxak` |
| Mode | initial (Baseline none) |
| Intake mode | brief (from scratch) |
| Intake hash | `e2875698ea64` |
| Date | 2026-11-23 |
| Stage | Step 5 — matched to the route review (`routes-final.md` §§ 1–12, rev 1, awaiting the owner's OK), then the owner's channel split ([P40](decisions.md)–[P47](decisions.md)) applied: common channel tables, Instagram tables named `instagram_*`. Each table section names the route-review section that owns its columns, keys and indexes |

The iteration's data model, kept current at every planning step. WHAT must be true, never HOW: logical
types only, no SQL, no indexes, no constraints — the column types, keys and indexes are the route review's
(`routes-final.md`, section 3 of each sub-domain); this file names one only where it changes a rule. `pnpm db:viewer` draws this file in plan mode. Sources
are cited as `plan:L<line>` — lines of `intake-files/Instagram-DM-Sending-Plan-v8.md`. The plan's own
decisions are `D1`–`D73` (plan:L210–L284, locked); this plan's are `P<n>` in
[decisions.md](decisions.md): `P1`–`P27` are the AMBER defaults A1–A27 (`P21`–`P25` are this file's
former data questions N1–N5), `P28`–`P39` the owner's Step 4 answers (RED), `P40`–`P47` the owner's
channel split (P47 its derived defaults, AMBER).

**Scope (P28, P39).** Track A (the sending engine, plan §4–43) and Part F (plan §44–47) are both in this
iteration; only the referral program (plan §48) moves to a later iteration — see **Out of scope (P39)**
at the end.

**Stated against the launch.** The launch iteration (`launch-2026-11-20-ujai`, frozen, not yet merged)
built the 10 `app` tables marked `EXISTING`, `CHANGED` or `REMOVED` here. Per plan D1 (plan:L212,
plan:L2888) this plan states every change against those tables, before → after. It ships in one PR on
`feat/instagram-automation` with the frozen launch: the 7 `app` migrations change in place (D1,
[P29](decisions.md)) — so a launch table the channel split renames (`app.contacts` →
`app.instagram_contacts`, …) is `CHANGED`, "renamed from …", not removed and made again; Part F's
changes to the platform domains are new migrations only (D48, [P38](decisions.md)).

| Change | Count | Entities |
| --- | --- | --- |
| NEW | 22 | **Common, Stages 1 and 6 (6):** channel_connection, channel_connection_token, channel_account, message_month_count, sending_state, sending_helper_slot · **Instagram, Stages 2–6 (14):** instagram_contact_tag_event, instagram_automation_count, instagram_automation_reply_state, instagram_automation_backfill, instagram_webhook_event_key, instagram_segment, instagram_broadcast, instagram_broadcast_recipient, instagram_send_lane, instagram_message, instagram_send_attempt, instagram_send_minute_count, instagram_send_stop, instagram_attachment · **Stage 8 (2):** trusted_device, trial_account |
| CHANGED | 15 | **app (9):** instagram_account (now the Instagram extension of channel_account), instagram_account_setting, instagram_media, instagram_contact (renamed from `app.contacts`), instagram_automation (from `app.automations`), instagram_automation_run (from `app.automation_runs`), instagram_automation_run_event (from `app.automation_run_events`), instagram_automation_comment_log (from `app.automation_comment_logs`), instagram_webhook_event · **Stage 7 (2):** plan, subscription · **Stage 8 (4):** organization, user, user_setting, session |
| REMOVED | 1 | instagram_account_token |
| EXISTING | 1 | upload — context only: not changed this iteration (no `scan_status`, P34); `instagram_attachment` names an upload by its public id |

Since the last version (the channel split, [P40](decisions.md)–[P47](decisions.md)): the Meta login is
the common `channel_connection` + `channel_connection_token` (was `meta_connection*`, P41 — provider
`meta`, one Unified Login for Instagram, Facebook and ads; ad accounts are read through it); the new
common `channel_account` holds what every channel's account has — channel, connection, status, display
name, the owner's pause, the team's suspend, the plan stop and the automation switch (P42), which leave
`instagram_account` (its connection fields), `instagram_account_setting` (the switch) and
`instagram_send_lane` (pause, suspend, plan stop); `instagram_account` becomes its 1:1 Instagram
extension (P42); every `instagram_account_id` on the product and sending tables becomes
`channel_account_id` → `channel_accounts` (P47); the product tables take the `instagram_` prefix (P44),
`meta_attachment` becomes `instagram_attachment` (P43) and the month count `message_month_count`
(P43); the plan features are `channel_accounts_max` and `message_month_limit` (P47).
`sending_helper_slot` stays until SNQ1 is answered (the route review recommends dropping it).

**Where the tables live (P38, P40–P44).** Every new or changed sending table stays in the `app` schema
(plan:L2800, plan:L8481), and its label carries that `domain.table`. **Common** — any channel's:
`app.channel_connections`, `app.channel_connection_tokens`, `app.channel_accounts` (sub-domains
`channel-connection/`, `channel-account/`), `app.message_month_counts` (the plan limit spans channels)
and `app.sending_states` (the global send switch). **Instagram** — everything else of this iteration's
`app` tables is `app.instagram_*` (sub-domains `instagram-account/`, `instagram-contact/`,
`instagram-automation/` with its run and backfill, `instagram-broadcast/` with its segment and recipient,
`instagram-sending/`, `instagram-webhook/`); a later Facebook channel adds its own `facebook_*` tables
beside them (P45). Part F's new tables go in their merged domains' schemas (`auth.trusted_devices`,
`billing.trial_accounts`; plan:L8467); the plan rows stay in `billing`.

**Names.** The plan's identifiers are rewritten to full names (A6, [P6](decisions.md)): `dm_month_counts`
→ `message_month_counts` (A6, then P43), the plan feature `dm_month_limit` → `message_month_limit`
(BLQ3, P47), `instagram_accounts_max` → `channel_accounts_max` (P47), `post_key` → `once_key`,
`turn_no` → `turn_number`, `dm_sent_at` →
`direct_message_sent_at`, and the same for every `_no`, `_nos`, `_ms` and `dm` the plan uses
(`message_number`, `version_number`, `wording_number`, `text_number`, `chain_number`,
`version_numbers`, `duration_milliseconds`). New true/false fields take the `is_` form the repository's
SQL guide asks for (be-sql-design-guard rule 5, like the launch's `is_automation_enabled`); the plan's
name is in each field's comment ([P21](decisions.md), AMBER). Reference fields inside the Instagram
tables keep their short names — `contact_id`, `automation_id`, `automation_run_id`, `broadcast_id`,
`segment_id` — with their `instagram_*` target in the field's comment, as the route params keep
`{contact_id}`, `{automation_id}` … (P44, P47).

**Rules every new table follows** (plan:L2800, plan:L4223–L4298):

- Every row belongs to one organization and goes away with it; a child row never points at another
  organization's row. Exceptions: the two global sending tables (`sending_state`,
  `sending_helper_slot`) have no organization — a documented exemption, read and written only by the
  maintenance login (A16, [P16](decisions.md)); and `billing.trial_accounts` outlives its workspace —
  its organization and subscription are emptied when they go, so an Instagram account that trialled in
  a deleted workspace never trials again (D73, routes-final § 8, 8.B.3).
- **One account id (P42, P47).** Every product and sending table names its account by
  `channel_account_id` → `channel_accounts`; `instagram_accounts` adds only Instagram's own fields, one
  row per channel account, with no id of its own in the API.
- A session sees and writes only its active organization's rows; background work runs in one
  organization's context at a time. The token table is readable only in its organization's own
  context — no clean-up across organizations reads it (plan:L4236–L4251).
- Instagram and Meta ids are digit strings, so they are `text`.
- Lists of values (scopes, keywords, stop words, starter questions) are `json` "list of text".
- Postgres holds every row; Redis holds nothing Postgres does not have — no webhook buffer and no
  save-result jobs ([P32](decisions.md)).

**How long rows stay** (plan §21, plan:L4124–L4217; [P33](decisions.md)). Only the three high-volume
tables are split by time and drop old parts: `instagram_webhook_events` (by day, 8 days),
`instagram_send_attempts` (by day, 8 days) and `instagram_messages` (by week of the run start, about 30
days, P13). Runs, run events, comment logs, broadcast recipients and webhook event keys stay plain
tables, emptied by batch deletes. Partition upkeep runs under a maintenance scope, never the migration
login. This file records only how long each table keeps its rows (in each table's **Holds**) — no
physical design.

## Overview

```mermaid
erDiagram
  organization["organization · CHANGED · tenancy.organizations"]
  user["user · CHANGED · auth.users"]
  plan["plan · CHANGED · billing.plans"]
  subscription["subscription · CHANGED · billing.subscriptions"]
  upload["upload · EXISTING · upload.uploads"]
  channel_connection["channel_connection · NEW · app.channel_connections"]
  channel_connection_token["channel_connection_token · NEW · app.channel_connection_tokens"]
  channel_account["channel_account · NEW · app.channel_accounts"]
  instagram_account["instagram_account · CHANGED · app.instagram_accounts"]
  instagram_account_setting["instagram_account_setting · CHANGED · app.instagram_account_settings"]
  instagram_account_token["instagram_account_token · REMOVED · app.instagram_account_tokens"]
  instagram_media["instagram_media · CHANGED · app.instagram_media"]
  instagram_contact["instagram_contact · CHANGED · app.instagram_contacts"]
  instagram_contact_tag_event["instagram_contact_tag_event · NEW · app.instagram_contact_tag_events"]
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"]
  instagram_automation_count["instagram_automation_count · NEW · app.instagram_automation_counts"]
  instagram_automation_reply_state["instagram_automation_reply_state · NEW · app.instagram_automation_reply_states"]
  instagram_automation_backfill["instagram_automation_backfill · NEW · app.instagram_automation_backfills"]
  instagram_automation_run["instagram_automation_run · CHANGED · app.instagram_automation_runs"]
  instagram_automation_run_event["instagram_automation_run_event · CHANGED · app.instagram_automation_run_events"]
  instagram_automation_comment_log["instagram_automation_comment_log · CHANGED · app.instagram_automation_comment_logs"]
  instagram_webhook_event["instagram_webhook_event · CHANGED · app.instagram_webhook_events"]
  instagram_webhook_event_key["instagram_webhook_event_key · NEW · app.instagram_webhook_event_keys"]
  instagram_segment["instagram_segment · NEW · app.instagram_segments"]
  instagram_broadcast["instagram_broadcast · NEW · app.instagram_broadcasts"]
  instagram_broadcast_recipient["instagram_broadcast_recipient · NEW · app.instagram_broadcast_recipients"]
  instagram_send_lane["instagram_send_lane · NEW · app.instagram_send_lanes"]
  instagram_message["instagram_message · NEW · app.instagram_messages"]
  instagram_send_attempt["instagram_send_attempt · NEW · app.instagram_send_attempts"]
  instagram_send_minute_count["instagram_send_minute_count · NEW · app.instagram_send_minute_counts"]
  message_month_count["message_month_count · NEW · app.message_month_counts"]
  instagram_send_stop["instagram_send_stop · NEW · app.instagram_send_stops"]
  sending_state["sending_state · NEW · app.sending_states"]
  sending_helper_slot["sending_helper_slot · NEW · app.sending_helper_slots"]
  instagram_attachment["instagram_attachment · NEW · app.instagram_attachments"]
  user_setting["user_setting · CHANGED · auth.user_settings"]
  session["session · CHANGED · auth.sessions"]
  trusted_device["trusted_device · NEW · auth.trusted_devices"]
  trial_account["trial_account · NEW · billing.trial_accounts"]

  organization ||--o{ channel_connection : "ADDED: logs in to a provider through"
  channel_connection ||--|| channel_connection_token : "ADDED: signs in with"
  channel_connection ||--o{ channel_account : "ADDED: brings in"
  organization ||--o{ channel_account : "ADDED: connects (many, D26)"
  user |o--o{ channel_account : "ADDED: connected"
  channel_account ||--|| instagram_account : "ADDED: is extended on Instagram by"
  channel_account ||--|| instagram_account_setting : "is set up by"
  instagram_account ||--|| instagram_account_token : "REMOVED: signs in with"
  channel_account ||--o{ instagram_media : "stores the posts of"
  channel_account ||--o{ instagram_contact : "brings in"
  instagram_contact ||--o{ instagram_contact_tag_event : "ADDED: has tag changes"
  instagram_automation |o--o{ instagram_contact_tag_event : "ADDED: tagged by"
  instagram_automation |o--o{ instagram_contact : "ADDED: first brought in"
  user |o--o{ instagram_contact : "ADDED: paused automations for"
  channel_account ||--o{ instagram_automation : "runs"
  instagram_automation ||--o{ instagram_automation_count : "ADDED: is counted in"
  instagram_automation ||--o| instagram_automation_reply_state : "ADDED: paces public replies by"
  instagram_automation ||--o{ instagram_automation_backfill : "ADDED: answers past comments through"
  instagram_automation ||--o{ instagram_automation_run : "starts"
  instagram_contact ||--o{ instagram_automation_run : "goes through"
  instagram_automation_run ||--o{ instagram_automation_run_event : "records"
  instagram_automation ||--o{ instagram_automation_comment_log : "logs"
  instagram_automation_run |o--o{ instagram_automation_comment_log : "is logged by"
  instagram_contact ||--o{ instagram_automation_comment_log : "is logged by"
  channel_account ||--o{ instagram_webhook_event : "receives events for"
  channel_account ||--o{ instagram_webhook_event_key : "ADDED: remembers event keys of"
  channel_account ||--o{ instagram_segment : "ADDED: saves audiences in"
  instagram_segment |o--o{ instagram_broadcast : "ADDED: is the audience of"
  channel_account ||--o{ instagram_broadcast : "ADDED: sends"
  instagram_broadcast ||--o{ instagram_broadcast_recipient : "ADDED: goes to"
  instagram_contact ||--o{ instagram_broadcast_recipient : "ADDED: receives"
  channel_account ||--|{ instagram_send_lane : "ADDED: sends through 4 lanes"
  instagram_automation_run |o--o{ instagram_message : "ADDED: sends"
  instagram_broadcast |o--o{ instagram_message : "ADDED: sends"
  instagram_message ||--o{ instagram_send_attempt : "ADDED: is tried by (no reference)"
  channel_account ||--o{ instagram_send_minute_count : "ADDED: is counted per minute in"
  organization ||--o{ message_month_count : "ADDED: is counted per month in"
  channel_account ||--o{ instagram_send_stop : "ADDED: has stop history"
  channel_account ||--o{ instagram_attachment : "ADDED: has Meta file ids"
  upload ||--o{ instagram_attachment : "ADDED: is uploaded to Meta as (public id, no reference)"
  plan ||--o{ subscription : "is paid through"
  plan |o--o{ subscription : "ADDED: is scheduled for"
  organization ||--o| subscription : "pays for"
  user ||--|| user_setting : "is set up by"
  user ||--o{ session : "signs in through"
  user ||--o{ trusted_device : "ADDED: trusts"
  organization |o--o{ trial_account : "ADDED: has trialled with (emptied when it goes)"
  subscription |o--o{ trial_account : "ADDED: started the trial of (emptied when it goes)"
  plan ||--o{ trial_account : "ADDED: is trialled as"
```

## Stage 1 — Channel connections and accounts

Everything hangs off a connected account, and every account now hangs off a provider login — the
common core of the channel split ([P40](decisions.md)–[P42](decisions.md)). Meta's Unified Login is the
only login (D24) and one login serves Instagram, Facebook and ads (P41); a workspace connects several
accounts (D26); the token moves from the account to the connection (plan:L2922–L2944,
plan:L3517–L3574). The common account (`channel_account`) holds what every channel has; Instagram's own
fields stay in `instagram_account`, its 1:1 extension (P42).

### channel_connection

- **Holds:** one provider login of a workspace — for Meta (`provider` `meta`), one workspace and one
  client business portfolio (D25, D27): the business id, the login configuration, the login type, its
  status, the granted scopes, who connected it and when, the last daily token check and its error codes
  (never Meta's text), and when it was disconnected. **One Meta login for Instagram, Facebook and ads**
  (Unified Login, P41): the connection holds the granted scopes and reaches its assets — the Instagram
  accounts now (`channel_account`), Facebook Pages later (D27); the ad accounts and their ads are read
  live through it for the ads picker, never stored. Meta's deauthorize and data-deletion callbacks
  belong to the connection: it resolves which accounts and people they reach (P46). One row per
  organization, provider and business: a reconnect reuses the row, a `revoked` one included. No soft
  delete — `revoked` stands in; rows stay until the organization is deleted. Has a public id (prefix
  not named by the plan). `status`: `connected` · `error` · `revoked` (plan §20.6) — `connected` to
  `error` on a token error, `revoked` on a disconnect or Meta's deauthorize request, back to
  `connected` by logging in with the same business again. `login_type`: `unified` only (room for a
  Facebook Pages login later, D27).
- **Table:** `app.channel_connections` ([P41](decisions.md); was `app.meta_connections`, P38)
- **Sources:** plan:L3517–L3553 (columns, rules), plan:L3998–L4013 (status), plan:L4528–L4575 (connect),
  plan:L876–L880 (ads picker), plan:L4695–L4705 (Meta's callbacks).
- **Added:** new — replaces the account-level login of the launch (Instagram Login, D24). The
  connect's plan check (accounts per plan, D26) locks the workspace's connection rows (plan:L3553).
  `provider` (P41): `meta` only today.
- **Replaced:** the launch's per-account `scopes` move here (from `instagram_account`). The Graph API
  version is a code constant (`META_GRAPH_VERSION`), not a column or an environment variable (MC2).
  `meta_connection` → `channel_connection` (P41).
- **Open:**
  - Public id prefix not named by the plan — chosen at kickoff by `generatePublicId`, recorded in
    AS-BUILT (P22, AMBER).
  - Columns, keys and the daily-check index: routes-final § 1, 1.3.

```mermaid
erDiagram
  channel_connection["channel_connection · NEW · app.channel_connections"] {
    id id PK
    id organization_id FK
    choice provider "meta only today (P41)"
    text client_business_id "digits; one row per organization, provider and business, a revoked one reused"
    text config_id "the login configuration used; not secret"
    choice login_type "unified only: one Meta login for Instagram, Facebook and ads (P41)"
    choice status "connected · error · revoked"
    datetime status_changed_at
    json scopes "list of text, at most 20 — the permissions Meta granted, the ad permission included"
    id connected_by_user_id FK "→ user; emptied when the person leaves"
    datetime connected_at
    datetime last_checked_at "last daily token check"
    text last_check_error "Meta's code, subcode and HTTP status only; at most 500"
    datetime disconnected_at "set exactly while revoked"
    datetime created_at
    datetime updated_at
  }
```

### channel_connection_token

- **Holds:** the connection's system-user access token, stored encrypted, its type and when it ends
  (empty = never, the default for a system-user token, D24). One per connection; deleted only when the
  connection is `revoked`. Read only on the provider client's path — never in a cache, a log or a job
  payload. No public id. Goes away with its connection.
- **Table:** `app.channel_connection_tokens` ([P41](decisions.md); was `app.meta_connection_tokens`,
  P38)
- **Sources:** plan:L3555–L3574; plan:L4577 (connect writes it), plan:L4236–L4251 (organization
  context only).
- **Added:** new — the one token path (D24). Unlike the launch's account token it has no renewal: the
  daily check — the connection's own scheduled work (P47) — only tests it and sets the connection to
  `error` when Meta rejects it.
- **Replaced:** `instagram_account_token` (removed below) — one token per account → one per
  connection. `meta_connection_token` → `channel_connection_token` (P41).
- **Open:** none.

```mermaid
erDiagram
  channel_connection_token["channel_connection_token · NEW · app.channel_connection_tokens"] {
    id id PK
    id organization_id FK
    id channel_connection_id FK, UK "one per connection"
    text encrypted_access_token "stored encrypted; never returned, cached or logged"
    choice token_type "system_user"
    datetime expires_at "empty = never ends"
    datetime created_at
    datetime updated_at
  }
  channel_connection["channel_connection · NEW · app.channel_connections"] {
    id id PK
  }
  channel_connection ||--|| channel_connection_token : "ADDED: signs in with"
```

### channel_account

- **Holds:** one connected account of a workspace on one channel — an Instagram professional account
  today (`channel` `instagram`, D27), a Facebook Page later — with what every channel's account has
  (P42): its channel, the connection it came from, its status, its display name, who connected it and
  when, the owner's pause, the team's suspend, the plan stop and the automation switch. Its public id
  is **the one account id** the API knows: the Instagram routes take `{channel_account_id}`, the product
  and sending tables point here (P47). Many per workspace (Free 1, Creator 3, Studio 10 by the plan's
  `channel_accounts_max`, D26, P47), counted across channels. `status`: `connected` · `error` ·
  `revoked` (the launch's `expired` was the 60-day token's end, D24). **The owner's pause** stops every
  lane of the account; comments and taps are still saved (RC-10, RC-11). **The team's suspend** (A18,
  [P18](decisions.md)) — the column now, the platform-admin route later; a suspended workspace stops
  them the same way. **The plan stop** (`plan_limit` · `plan_ended` · `plan_downgrade`) holds the slow,
  fast and broadcast lanes ([P3](decisions.md)); `plan_downgrade` marks an account "not in your plan"
  after a move down (D57), cleared by "choose active accounts" (RC-60). **The automation switch** — off,
  new events of this account are skipped (the launch's `is_automation_enabled`, moved from the
  Instagram settings). No soft delete — `revoked` stands in, and a reconnect of the same Instagram
  account reuses the row (its settings return). Has a public id (prefix not named by the plan).
- **Table:** `app.channel_accounts` ([P42](decisions.md))
- **Sources:** plan:L2922–L2944 (the account), plan:L3385–L3419 (pause, suspend, plan stop, then on the
  lanes), plan:L4590–L4604 (connect, plan limit), plan:L2599–L2600, L2631 (pause, resume, activate);
  routes-final § 2.
- **Added:** new (P42) — the common part of the launch's `instagram_accounts` (status, connection,
  who connected, when) and of the plan's lane and settings fields that are not Instagram's own.
- **Replaced:**
  - `instagram_account.connection_status`, `connection_status_changed_at`, `connected_by_user_id`,
    `connected_at`, `disconnected_at`, `name` → here (`status`, `status_changed_at`, …,
    `display_name`).
  - `instagram_account_setting.is_automation_enabled` → `is_automation_enabled` here.
  - The plan's lane fields `paused_at`, `suspended_at`, `plan_stop_reason`, `plan_stopped_at` → here,
    once per account instead of on each of its four lanes; the lane keeps only its error stop, so the
    two stops of SN12 still hold at once (the plan stop here, the error stop on the lane).
- **Open:**
  - Public id prefix — chosen at kickoff (P22, AMBER).
  - "At most one not-revoked account per provider account across organizations" is held on this table:
    `provider_account_id` unique per channel while not revoked, written with the extension's
    `instagram_user_id` (routes-final § 1B, CAQ1 — recommended, awaiting the one-pass review).

```mermaid
erDiagram
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK "the one account id the API knows (P47)"
    id organization_id FK "many per organization, up to channel_accounts_max (D26)"
    id channel_connection_id FK "the login it came from (D25)"
    choice channel "instagram (D27); a Facebook Page later"
    text provider_account_id "the account id at the provider (for Instagram the instagram_user_id); one live per channel across workspaces (routes-final CAQ1)"
    choice status "connected · error · revoked"
    datetime status_changed_at
    text display_name "the account's name on its channel"
    boolean is_automation_enabled "off = new events of this account are skipped; was on instagram_account_setting"
    datetime paused_at "owner pause; the lanes read it"
    datetime suspended_at "team suspend or a suspended workspace (A18)"
    choice plan_stop_reason "plan_limit · plan_ended · plan_downgrade; holds slow, fast, broadcast (P3)"
    datetime plan_stopped_at "set exactly with plan_stop_reason"
    id connected_by_user_id FK "→ user; emptied when the person leaves"
    datetime connected_at "referenced: new-account slow start"
    datetime disconnected_at "set exactly while revoked"
    datetime created_at
    datetime updated_at
  }
  channel_connection["channel_connection · NEW · app.channel_connections"] {
    id id PK
  }
  instagram_account["instagram_account · CHANGED · app.instagram_accounts"] {
    id id PK
  }
  channel_connection ||--o{ channel_account : "ADDED: brings in"
  channel_account ||--|| instagram_account : "ADDED: is extended on Instagram by"
```

### instagram_account

- **Holds:** as at launch, an Instagram professional account a workspace connected — now **the 1:1
  Instagram extension of its `channel_account`** (P42): only what is Instagram's own — the Instagram
  user id, the username, the account type, the private flag, the followers, the profile picture, the
  webhook subscription and when its starter questions were last set. Its status, connection, who
  connected it and when, its pause, suspend and plan stop are the channel account's. It has no id of
  its own in the API: the account is named by its `channel_account_id` (P47). One workspace per
  Instagram account stays: at most one row not `revoked` per Instagram account across organizations.
  The Instagram user id now comes from the connection's assigned-accounts list and is used for API
  paths and webhook routing. The daily check's profile refresh stays, inside the connection's token
  check (A17, [P17](decisions.md), P47).
- **Table:** `app.instagram_accounts` (live)
- **Sources:** plan:L2922–L2944; plan:L4590–L4604 (connect, plan limit); current schema
  `src/domains/app/sub-domains/instagram-account/instagram-account.schema.ts`.
- **Added:**
  - `channel_account_id` — the channel account it extends, one to one (P42); required.
  - `account_type` and `is_private` — the account's type and private flag (P42; a private account is
    a go-live warning, RC-31).
  - `starter_questions_set_at` — the last time this account's starter questions were sent to Meta;
    emptied when a starter-question automation goes live, pauses or changes its questions (D42).
- **Replaced:**
  - Accounts per organization: at most one not revoked (launch D5) → many, up to the plan's limit,
    checked at connect (D26), counted on `channel_account`.
  - `connection_status`, `connection_status_changed_at`, `connected_by_user_id`, `connected_at`,
    `disconnected_at`, `name` → `channel_account` (P42); `expired` is gone from the status (D24).
  - `public_id` → the channel account's (P47: one account id).
  - `instagram_app_user_id`, `scopes`, `token_expires_at` removed: Unified Login has no app-scoped
    id, the scopes move to `channel_connection`, the token ends on the connection (or never).
  - The launch's one-live-account-per-organization rule (`idx_instagram_accounts_organization_live`)
    and the app-scoped id lookup are dropped; "the accounts of a connection" is looked up on
    `channel_account` (organization, connection) — routes-final § 2, 2.A.3.
  - Meta's data-deletion and deauthorize requests reach the accounts through their connection and the
    Instagram user id, by a resolver that replaces the app-scoped one (IA19, P46).
- **Open:**
  - The launch's `access_expires_at` API field goes with `token_expires_at` (route-changes.md).

```mermaid
erDiagram
  instagram_account["instagram_account · CHANGED · app.instagram_accounts"] {
    id id PK
    id channel_account_id FK, UK "ADDED: the channel account it extends, 1:1 (P42)"
    id organization_id FK "CHANGED: many accounts per organization, up to the plan limit (D26)"
    text public_id "REMOVED: the account's one id is channel_account's (P47)"
    text instagram_user_id "CHANGED: now from the connection's assigned accounts; still one not-revoked account across organizations"
    text username "referenced: kept"
    choice account_type "ADDED: business · creator (P42)"
    boolean is_private "ADDED: the private flag (P42)"
    number followers_count "referenced: kept"
    text profile_picture_url "referenced: kept"
    text name "REMOVED → channel_account (display_name)"
    choice connection_status "REMOVED → channel_account (status: connected · error · revoked; expired gone)"
    datetime connection_status_changed_at "REMOVED → channel_account"
    id connected_by_user_id FK "REMOVED → channel_account"
    datetime connected_at "REMOVED → channel_account"
    datetime disconnected_at "REMOVED → channel_account"
    text instagram_app_user_id "REMOVED: Unified Login has none (D24)"
    json scopes "REMOVED: moved to channel_connection"
    datetime token_expires_at "REMOVED: the token lives on the connection"
    datetime webhook_subscribed_at "referenced: the helper checks the webhook stays on"
    datetime starter_questions_set_at "ADDED: last send of starter questions to Meta (D42)"
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--|| instagram_account : "ADDED: is extended on Instagram by"
```

### instagram_account_setting

- **Holds:** as at launch, the Instagram account's own settings — the owner's sending limits and
  account-wide behaviour; the automation master switch moves to `channel_account` (P42), and the row
  now names its account by `channel_account_id` (P47). It stays Instagram's (P42). Every new number is optional: empty means the value in the settings file
  (D22). The public reply safety moves to each automation (D32), so its five columns go. New:
  opening DMs per hour (1–750; the API stops at 700) and per day (used only when the day limit is on),
  fast messages per hour, messages per person per hour, broadcast messages per hour (1–2,000; empty =
  600), the "this is an automatic message" notice, the owner's extra stop words (at most 50, lower
  case), whether replies under comments start comment automations (on), once per person per post
  (on), mark as seen after a reply (off), and the extra random delay before each answer (1–20
  seconds, both ends or neither; PRO).
- **Table:** `app.instagram_account_settings` (live)
- **Sources:** plan:L2895–L2920; D5, D11, D22, D32, D64–D68; current schema
  `src/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.ts`.
- **Added:** the 13 fields marked `ADDED` below.
- **Replaced:** the 5 public reply safety fields → per automation (`instagram_automation.is_reply_like_person_enabled`,
  `public_reply_hour_limit`) and the settings file (D32); `is_automation_enabled` → `channel_account`
  (P42); `instagram_account_id` → `channel_account_id` (P47).
- **Open:** none — true/false names take the `is_` form (P21, AMBER).

```mermaid
erDiagram
  instagram_account_setting["instagram_account_setting · CHANGED · app.instagram_account_settings"] {
    id id PK
    id channel_account_id FK, UK "CHANGED: was instagram_account_id; → channel_account (P47)"
    boolean is_automation_enabled "REMOVED → channel_account (P42)"
    number opening_hour_limit "ADDED: 1 to 750; empty = settings file (D5)"
    number opening_day_limit "ADDED: over 0; used only with the day limit on"
    number fast_hour_limit "ADDED: over 0; empty = settings file (D11)"
    number person_hour_limit "ADDED: over 0; loop guard per person"
    number broadcast_hour_limit "ADDED: 1 to 2000; empty = 600 (D68)"
    boolean is_automatic_notice_enabled "ADDED: plan name automatic_notice_enabled; off"
    json extra_stop_words "ADDED: list of text, at most 50, lower case"
    boolean is_comment_reply_trigger_enabled "ADDED: plan name trigger_on_comment_replies; on (D64)"
    boolean is_once_per_person_per_post_enabled "ADDED: plan name once_per_person_per_post; on (D65)"
    boolean is_mark_seen_after_reply_enabled "ADDED: plan name mark_seen_after_reply; off (D66)"
    number extra_delay_seconds_min "ADDED: 1 to 20; both or neither; PRO (D67)"
    number extra_delay_seconds_max "ADDED: 1 to 20, not below the minimum (D67)"
    boolean is_public_reply_safety_enabled "REMOVED: per automation now (D32)"
    number public_reply_chance_percent "REMOVED: settings file (D32)"
    number public_reply_hour_limit "REMOVED: per automation (D32)"
    number public_reply_gap_min_seconds "REMOVED: settings file (D32)"
    number public_reply_gap_max_seconds "REMOVED: box timing decides (D32)"
  }
```

### instagram_account_token

- **Holds (before):** the account's long-lived Instagram Login token, encrypted, renewed daily before
  its 60 days ran out. Removed with the daily renewal, the Instagram Login client and its app secret
  (plan:L2938).
- **Table:** `app.instagram_account_tokens` (live) — removed
- **Sources:** plan:L2938, plan:L8458; current schema
  `src/domains/app/sub-domains/instagram-account/instagram-account-token.schema.ts`.
- **Added:** none.
- **Replaced:** → `channel_connection_token` (D24). No data moves: the Instagram Login code is replaced,
  not migrated (plan:L2924).
- **Open:** none.

```mermaid
erDiagram
  instagram_account_token["instagram_account_token · REMOVED · app.instagram_account_tokens"] {
    id id PK "REMOVED"
    id instagram_account_id FK "REMOVED"
    text encrypted_access_token "REMOVED"
    datetime expires_at "REMOVED"
  }
  instagram_account["instagram_account · CHANGED · app.instagram_accounts"] {
    id id PK
  }
  instagram_account ||--|| instagram_account_token : "REMOVED: signs in with"
```

### instagram_media

- **Holds:** as at launch, the account's stored posts — plus the missed-comment watch (when the helper
  last read the post's comments, when it reads again — empty = not watched — and the newest comment
  known) and when a Live ended, so waiting Live private replies expire without a call (D40).
  `media_product_type` adds Meta's value for a Live; `ad` marks an ad's post (D41). Stays Instagram's
  (P44); names its account by `channel_account_id` (P47).
- **Table:** `app.instagram_media` (live)
- **Sources:** plan:L2946–L2958; current schema
  `src/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.ts`.
- **Added:** the four time fields below; the Live value.
- **Replaced:** `instagram_account_id` → `channel_account_id` (P47).
- **Open:** the exact Live value Meta sends — a Meta test (plan §43). Live comments are refused at
  go-live until that test passes ([P36](decisions.md)).

```mermaid
erDiagram
  instagram_media["instagram_media · CHANGED · app.instagram_media"] {
    id id PK
    id channel_account_id FK "CHANGED: was instagram_account_id; → channel_account (P47)"
    text instagram_media_id "referenced by automations and comment logs"
    choice media_product_type "CHANGED: feed · reels · story · ad + the Live value"
    datetime published_at "referenced: between two dates, my next post"
    datetime comments_checked_at "ADDED"
    datetime comments_next_check_at "ADDED: empty = not watched"
    datetime last_comment_at "ADDED"
    datetime live_ended_at "ADDED (D40)"
  }
```

## Stage 2 — Audience and automations

Contacts and automations get the fields the 15 ways to start, the message list and the owner's
controls need; four small tables carry tag changes, all-time counts, public reply pacing and
past-comment runs.

### instagram_contact

- **Holds:** as at launch, one person who wrote to or commented on one account — plus the 24-hour
  private-reply rule (last opening message), the stop word (opted out), the channel (`instagram`,
  D27), the first automation that started a run for her ("via", set once) with how and from what ref
  she came in, the owner's private note (1–2,000), her first message time, the owner's "pause
  automations for this person" with who did it (D71), and her comment and story activity and last
  broadcast for segments (D68). The follow state keeps the launch's fields. Tags are 1–50 characters
  each (launch 1–255), at most 50 per contact (CT9). Kept until the owner deletes it, Meta asks, or the
  workspace goes (D51). Erasing a contact also clears her note, opted out, last opening message,
  automations pause (when and by whom), came-in ref, first message, last comment, last story activity
  and last broadcast, and sets her comment count to 0 — her activity is personal data too; the
  "via" automation, how she came in and the channel stay (CT11).
- **Table:** `app.instagram_contacts` (live; **renamed from `app.contacts`**, [P44](decisions.md) — the launch migration changes in place, P29)
- **Sources:** plan:L2960–L2993; D27, D45, D46, D49, D68, D71; current schema
  `src/domains/app/sub-domains/contact/contact.schema.ts`.
- **Added:** the 14 fields marked `ADDED`. The list and its sorts are per account (D26). The reference
  from `first_automation_id` to the automation is added by the automations migration (automations build
  after contacts). Broadcasts' "can get it now" reads her account, her open window and her exclusions
  through one index the contact writer adds (BC13, routes-final § 7).
- **Replaced:** the email check: the launch refused plus addresses (Standing deviation "Email and
  phone checks") → accepted (A19, [P19](decisions.md)); tags 1–255 → 1–50 (CT9); `instagram_account_id`
  → `channel_account_id` (P47); the table `app.contacts` → `app.instagram_contacts` (P44).
- **Open:** none — columns and checks: routes-final § 3, 3.A.3.

```mermaid
erDiagram
  instagram_contact["instagram_contact · CHANGED · app.instagram_contacts"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "CHANGED: was instagram_account_id; → channel_account (P47)"
    text email "CHANGED: plus addresses accepted (A19)"
    json tags "CHANGED: each tag 1 to 50 (was 1 to 255), at most 50 (CT9)"
    boolean is_following_account "referenced: follow state"
    datetime follow_checked_at "referenced: follow state"
    datetime last_direct_message_received_at "referenced: her 24-hour window"
    datetime deleted_at "referenced"
    datetime last_opening_message_at "ADDED: 24-hour private-reply rule (D8); cleared on erase"
    datetime opted_out_at "ADDED: stop word (D49); cleared on erase"
    choice channel "ADDED: instagram (D27)"
    id first_automation_id FK "ADDED: → instagram_automation; set once; emptied when it goes (D46); its reference added by the automations migration"
    choice came_in_via "ADDED: a trigger_type value; set once"
    text came_in_ref "ADDED: ref code or ad id, at most 64; cleared on erase"
    text note "ADDED: 1 to 2000; owner only; cleared on erase (D46)"
    datetime first_message_at "ADDED: set once; cleared on erase"
    datetime automations_off_at "ADDED: owner pause for her (D71); cleared on erase"
    id automations_off_by_user_id FK "ADDED: → user; set exactly with automations_off_at; cleared on erase"
    datetime last_comment_at "ADDED; cleared on erase"
    number comment_count "ADDED: 0 or more; 0 on erase"
    datetime last_story_activity_at "ADDED; cleared on erase"
    datetime last_broadcast_at "ADDED: 24-hour broadcast gap (D68); cleared on erase"
  }
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
  }
  instagram_automation |o--o{ instagram_contact : "ADDED: first brought in"
```

### instagram_contact_tag_event

- **Holds:** one row per tag added to or removed from a contact, written in the same commit as the
  change, so tag starts never lose one (D45). `kind`: `added` · `removed`; `source`: `automation` (a
  tag step) · `owner`. The chain number counts how many tag starts led to this change; intake starts
  nothing at 3 or more. Its id is part of the once key of a tag start. Kept 8 days. No public id.
  Goes with its contact; a deleted automation only empties `source_automation_id` (that reference is
  added by the automations migration, which builds after contacts).
- **Table:** `app.instagram_contact_tag_events` ([P44](decisions.md); the plan's `app.contact_tag_events`)
- **Sources:** plan:L3685–L3717; D45; routes-final § 3, 3.B.3.
- **Added:** new.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  instagram_contact_tag_event["instagram_contact_tag_event · NEW · app.instagram_contact_tag_events"] {
    id id PK "part of the tag start's once key"
    id organization_id FK
    id channel_account_id FK "→ channel_account; copy of the contact's account"
    id contact_id FK "→ instagram_contact; goes with the contact"
    text tag "1 to 50"
    choice kind "added · removed"
    choice source "automation · owner"
    id source_automation_id FK "→ instagram_automation; set exactly when source is automation; emptied when it goes (added by the automations migration)"
    number chain_number "0 or more; plan name chain_no"
    datetime created_at
    datetime queued_at
    datetime done_at
  }
  instagram_contact["instagram_contact · CHANGED · app.instagram_contacts"] {
    id id PK
  }
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
  }
  instagram_contact ||--o{ instagram_contact_tag_event : "ADDED: has tag changes"
  instagram_automation |o--o{ instagram_contact_tag_event : "ADDED: tagged by"
```

### instagram_automation

- **Holds:** as at launch, one automation of one account — now flat fields for how it starts and
  its public reply, and one `steps` object for everything it sends (hello, follow, email, phone, the
  message list, tags). A draft needs only a name (D28). `status`: `draft` · `live` · `paused`.
  `trigger_type`: `comment` · `live_comment` · `story_reply` · `story_mention` · `story_repost` ·
  `dm_keyword` · `first_message` · `shared_post` · `starter_question` · `ref_link` · `default_reply` ·
  `ad_comment` · `ad_message` · `tag_added` · `tag_removed` (D37). `also_start_from`: `story_reply`,
  `dm`, at most 2 (D38). `target_scope`: `any` · `specific` · `next` · `between` (D39).
  `next_post_status`: `waiting` · `linked` — a "next post" never expires (A12,
  [P12](decisions.md)). `default_reply_mode`: `once_a_day` · `every_time` (D44). `stopped_reason`:
  `bad_text` · `post_deleted` — a plan change never stops an automation (D57). Soft delete stays; the
  delete reason becomes optional, `other` still needs a note (A11, [P11](decisions.md)). Files in steps
  are referred to by upload public id, same workspace, checked by file type and content (magic bytes)
  — the malware scan comes in a later iteration (plan:L3094; [P34](decisions.md), a D58 deviation).
- **Table:** `app.instagram_automations` (live; **renamed from `app.automations`**, [P44](decisions.md), P29)
- **Sources:** plan:L2995–L3145; D28–D45, D52, D57, D59, D63; current schema
  `src/domains/app/sub-domains/automation/automation.schema.ts`.
- **Added:** the fields marked `ADDED`; the go-live checks of §5.1 plus the "next step" button rule
  (A2, [P2](decisions.md)).
- **Replaced:**
  - The launch's message fields (opening message, follow, email, phone, final message and their
    switches) → `steps` (D29–D31).
  - `is_dm_keyword_trigger_enabled` → `also_start_from` (D38).
  - `next_post_starts_at` / `next_post_ends_at` → `target_starts_at` / `target_ends_at` (D39).
  - `tags` → `steps.tags` (D45).
  - `completed_run_count` → `instagram_automation_count` (D36).
  - `is_public_reply_enabled` stays as it is; the plan renames it `public_reply_enabled`, which the
    repository's true/false rule does not allow ([P21](decisions.md)).
  - `instagram_account_id` → `channel_account_id` (P47); the table `app.automations` →
    `app.instagram_automations` (P44).
- **Open:** none (columns, keys and checks: routes-final § 4, 4.A.3). Every way to start is built; the ones that need a Meta test (`story_repost`,
  `live_comment`, `ad_comment`, the 7-day ad window, quick replies and cards on Unified Login) are
  refused at go-live by a code list of offered ways to start and features until their plan §43 test
  passes — a code list, no column ([P36](decisions.md)).

```mermaid
erDiagram
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "CHANGED: was instagram_account_id; → channel_account (P47); referenced"
    choice status "CHANGED: live · inactive → draft · live · paused (D28)"
    choice trigger_type "CHANGED: comment · story_reply · dm → the 15 ways to start (D37)"
    choice channel "ADDED: instagram (D27)"
    json also_start_from "ADDED: list of story_reply, dm; at most 2 (D38)"
    choice target_scope "CHANGED: adds between (D39)"
    datetime target_starts_at "ADDED (D39)"
    datetime target_ends_at "ADDED: after target_starts_at (D39)"
    choice next_post_status "CHANGED: expired removed (A12)"
    datetime next_post_starts_at "REMOVED: → target_starts_at"
    datetime next_post_ends_at "REMOVED: → target_ends_at"
    text ref_code "ADDED: letters, digits, dash, underscore, equals; at most 64; one per account, drafts included (D43)"
    json starter_questions "ADDED: list of text, at most 4, each 1 to 80 (D42)"
    text ad_id "ADDED: digits, at most 64 (D41)"
    text trigger_tag "ADDED: 1 to 50 (D45)"
    choice default_reply_mode "ADDED: once_a_day · every_time (D44)"
    boolean is_hide_comment_after_direct_message_enabled "ADDED: plan name hide_comment_after_dm; off (D33)"
    boolean is_public_reply_mention_enabled "ADDED: plan name public_reply_mention; on (D63)"
    boolean is_reply_like_person_enabled "ADDED: plan name reply_like_person; off, on for new paid automations (D59)"
    number public_reply_hour_limit "ADDED: 10, 20, 30, 60 or 100; empty = 60 (D32)"
    json steps "ADDED: hello, follow, email, phone, messages, tags; at most 64 KB (D29-D31)"
    choice stopped_reason "ADDED: bad_text · post_deleted"
    datetime stopped_at "ADDED: set exactly with stopped_reason"
    datetime cancelled_before_at "ADDED: Pause and Cancel"
    choice delete_reason "CHANGED: optional; other needs a note (A11)"
    boolean is_dm_keyword_trigger_enabled "REMOVED: → also_start_from"
    number completed_run_count "REMOVED: → instagram_automation_count"
    json tags "REMOVED: → steps.tags"
    boolean is_opening_message_enabled "REMOVED: → steps"
    json opening_message "REMOVED: → steps"
    boolean is_follow_required "REMOVED: → steps"
    text follow_request_message "REMOVED: → steps"
    boolean is_email_collection_enabled "REMOVED: → steps"
    text email_request_message "REMOVED: → steps"
    boolean is_phone_collection_enabled "REMOVED: → steps"
    text phone_request_message "REMOVED: → steps"
    json final_message "REMOVED: → steps.messages"
  }
```

### instagram_automation_count

- **Holds:** an automation's all-time counters — runs started, taps, typed answers, and the same per
  step version (for example `hello.1`) — split over 16 slots so busy automations do not wait on one
  row (D36). Survives the 90-day run delete. No public id. Goes away with its automation.
- **Table:** `app.instagram_automation_counts` ([P44](decisions.md); the plan's `app.automation_counts`)
- **Sources:** plan:L3576–L3599; D36, D61.
- **Added:** new.
- **Replaced:** `instagram_automation.completed_run_count` (removed).
- **Open:** none.

```mermaid
erDiagram
  instagram_automation_count["instagram_automation_count · NEW · app.instagram_automation_counts"] {
    id organization_id FK
    id automation_id FK, PK "→ instagram_automation"
    number slot PK "0 to 15"
    number runs_started "0 or more"
    number taps "0 or more"
    number typed_answers "0 or more"
    json runs_by_version "flat object, step.version to count"
    json taps_by_version "flat object"
    json typed_by_version "flat object"
    datetime updated_at
  }
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
  }
  instagram_automation ||--o{ instagram_automation_count : "ADDED: is counted in"
```

### instagram_automation_reply_state

- **Holds:** the "Reply like a person" pacing of one automation's public replies: the current random
  box, the last reply line used, and how many replies wait (D32). One per automation, made at its
  first public reply. No public id.
- **Table:** `app.instagram_automation_reply_states` ([P44](decisions.md); the plan names it in the singular,
  `app.automation_reply_state` — the repository's tables are plural)
- **Sources:** plan:L3601–L3621; D32, D52.
- **Added:** new — replaces the account-wide reply safety of the launch (D32).
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  instagram_automation_reply_state["instagram_automation_reply_state · NEW · app.instagram_automation_reply_states"] {
    id organization_id FK
    id automation_id FK, PK "→ instagram_automation; one per automation"
    id channel_account_id FK "→ channel_account; copy"
    datetime box_start
    number last_text_number "plan name last_text_no"
    number waiting_count "0 or more"
    datetime updated_at
  }
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
  }
  instagram_automation ||--o| instagram_automation_reply_state : "ADDED: paces public replies by"
```

### instagram_automation_backfill

- **Holds:** one "also answer comments from the last N days" run of a live comment or ad-comment
  automation (D69, PRO): the days (1–7), its status, posts read, comments found, matched and opening
  DMs queued, why it failed and the error codes (never Meta's text), who asked and when. `status`:
  `queued` · `reading` · `done` · `failed`; `fail_reason`: `meta_error` · `plan_feature_off`. One
  queued or reading per automation; a new press after a failure makes a new row. Has a public id
  (prefix not named by the plan).
- **Table:** `app.instagram_automation_backfills` ([P44](decisions.md); the plan's `app.automation_backfills`)
- **Sources:** plan:L3818–L3844, plan:L4109–L4120; D69.
- **Added:** new.
- **Replaced:** none.
- **Open:**
  - Public id prefix — chosen at kickoff (P22, AMBER).

```mermaid
erDiagram
  instagram_automation_backfill["instagram_automation_backfill · NEW · app.instagram_automation_backfills"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account; copy"
    id automation_id FK "→ instagram_automation; a live comment or ad-comment automation"
    number days "1 to 7"
    choice status "queued · reading · done · failed"
    number posts_read "0 or more"
    number found "0 or more"
    number matched "0 or more"
    number queued_count "0 or more"
    choice fail_reason "meta_error · plan_feature_off"
    text last_error "codes only, at most 500"
    id requested_by_user_id FK "→ user"
    datetime created_at
    datetime started_at
    datetime done_at
    datetime updated_at
  }
  instagram_automation["instagram_automation · CHANGED · app.instagram_automations"] {
    id id PK
  }
  instagram_automation ||--o{ instagram_automation_backfill : "ADDED: answers past comments through"
```

## Stage 3 — Runs and logs

A run now carries its once key, the 7-day clock and which step versions it used; the claim of a send
moves to the message row (Stage 6). Runs, run events and comment logs keep 90 days, not 180 (D16) —
plain tables emptied by batch deletes ([P33](decisions.md)). At most one open run per automation and
person; a new comment that may start a run replaces the open one ([P35](decisions.md)).

### instagram_automation_run

- **Holds:** as at launch, one person going through one automation — plus when the event that started
  it happened (the 7-day clock, D9), its once key (D13), when its first DM was sent, the highest list
  message sent (read by segments after message rows are gone) and which version of each step it used.
  `trigger_type` is how this run started (the 15 kinds; may differ from the automation's through
  "also start from"). `current_step`: `keyword_match` · `comment_reply` · `follow_check` ·
  `email_collect` · `phone_collect` · `messages`. `waiting_for` adds `any`. `cancel_reason` adds
  `expired` · `opted_out` · `window_closed` · `contact_excluded` · `replaced`. Her own free text is never
  kept (D46). Kept about 90 days after it ends (D16; launch 180) — a plain table, batch deletes (P33).
  **One open run per automation and person (P35):** when a comment may start a new run (a different
  post, or "every time" mode — D13 / D65 still decide), her open run of that automation is cancelled
  with `replaced` (its waiting messages too) and the new run starts. A second comment on the same post
  with "once" on is still ignored (`once_per_post`); every other way to start is ignored while her run
  is open (`run_in_progress`).
- **Table:** `app.instagram_automation_runs` (live; **renamed from `app.automation_runs`**, [P44](decisions.md), P29)
- **Sources:** plan:L3147–L3173, plan:L3893–L3924; D9, D13, D16, D29–D31, D46; current schema
  `src/domains/app/sub-domains/automation/automation-run/automation-run.schema.ts`.
- **Added:** the fields marked `ADDED`.
- **Replaced:**
  - The send claim (`sending_message_kind`, `sending_started_at`) → the message row's status
    (`instagram_message`).
  - The plan's open-run keys (one open run per automation, person and once key, in
    `automation_run_open_key`, plan:L3465–L3480) → the launch's rule stays: one open run per
    automation and person, and a new start replaces it (`replaced`, P35). **No open-run key table** —
    confirmed by the route review (AUQ4, WH14): the new start cancels the open run in the same commit,
    so the launch's one-open-run rule is the whole rule. The once key stays on the run, for the
    `once_per_post` check (D13); WC-45 frees no key.
- **Open:** none — columns and keys: routes-final § 4, 4.B.

```mermaid
erDiagram
  instagram_automation_run["instagram_automation_run · CHANGED · app.instagram_automation_runs"] {
    id id PK
    id automation_id FK "→ instagram_automation"
    id contact_id FK "→ instagram_contact"
    datetime started_at "referenced: messages copy it as their split key (P33)"
    choice trigger_type "CHANGED: the 15 kinds; how this run started"
    datetime trigger_occurred_at "ADDED: the 7-day clock (D9)"
    text once_key "ADDED: plan name post_key; at most 255 (D13)"
    datetime direct_message_sent_at "ADDED: plan name dm_sent_at; first DM sent or unknown"
    number last_message_number "ADDED: plan name last_message_no; 1 to 10"
    json version_numbers "ADDED: plan name version_nos; step to version, default empty object"
    choice current_step "CHANGED: final_dm → messages"
    choice waiting_for "CHANGED: adds any"
    choice cancel_reason "CHANGED: adds expired · opted_out · window_closed · contact_excluded · replaced (P35)"
    text trigger_text "REMOVED: her free text is never kept (D46)"
    choice sending_message_kind "REMOVED: claim moves to the message row"
    datetime sending_started_at "REMOVED: claim moves to the message row"
  }
```

### instagram_automation_run_event

- **Holds:** as at launch, the append-only history of a run — `event_type` adds `hello_tapped` and
  `follow_tapped` (the tap counts of D61). Kept with its run — a plain table, batch deletes (P33).
- **Table:** `app.instagram_automation_run_events` (live; **renamed from `app.automation_run_events`**, [P44](decisions.md), P29)
- **Sources:** plan:L3175–L3182; current schema
  `src/domains/app/sub-domains/automation/automation-run/automation-run-event.schema.ts`.
- **Added:** two event types.
- **Replaced:** none.
- **Open:** none — the plan's `automation_run_started_at` copy is not added: runs are not split (P33).

```mermaid
erDiagram
  instagram_automation_run_event["instagram_automation_run_event · CHANGED · app.instagram_automation_run_events"] {
    id id PK
    id automation_run_id FK "→ instagram_automation_run"
    choice event_type "CHANGED: adds hello_tapped · follow_tapped"
  }
  instagram_automation_run["instagram_automation_run · CHANGED · app.instagram_automation_runs"] {
    id id PK
  }
  instagram_automation_run ||--o{ instagram_automation_run_event : "records"
```

### instagram_automation_comment_log

- **Holds:** as at launch, one row per comment an automation saw, with each step's status — plus the
  comment's time and the hide step (status and when). The
  final DM step becomes the message list (`messages_status`, `messages_at`). Step statuses add
  `expired` · `unknown`; `current_step` / `failed_step` rename `final_dm` → `messages` and add
  `hide_comment`; `waiting_for` adds `any`. `ignored_reason`: `previous_run_final` → `once_per_post`,
  adds `thread_reply_off` · `own_comment` · `contact_excluded`, keeps `run_in_progress` and
  `comment_already_answered`. `public_reply_skip_reason`: `duplicate` · `random` · `hour_limit` ·
  `deleted_comment` (`gap` removed). Live and ad comments get logs; a Live's reply and hide stay
  `off`. Kept 90 days (D16; launch 180) — a plain table, batch deletes (P33).
- **Table:** `app.instagram_automation_comment_logs` (live; **renamed from `app.automation_comment_logs`**, [P44](decisions.md), P29)
- **Sources:** plan:L3184–L3205; D16, D32, D33, D64; current schema
  `src/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.ts`.
- **Added:** the fields marked `ADDED`.
- **Replaced:** `final_dm_status` / `final_dm_at` → `messages_status` / `messages_at`.
- **Open:**
  - The launch's ignored reasons `waiting_for_other_email` and `already_waiting` are kept — the plan
    is silent ([P23](decisions.md), AMBER).
  - The plan's `automation_run_started_at` copy is not added: runs are not split (P33).
  - The launch's `opening_dm_status` / `opening_dm_at` keep `dm` (as built); A6 renames only new
    names.

```mermaid
erDiagram
  instagram_automation_comment_log["instagram_automation_comment_log · CHANGED · app.instagram_automation_comment_logs"] {
    id id PK
    id automation_id FK "→ instagram_automation"
    id automation_run_id FK "→ instagram_automation_run"
    id contact_id FK "→ instagram_contact"
    datetime comment_occurred_at "ADDED"
    choice hide_status "ADDED: a step status; default off (D33)"
    datetime hidden_at "ADDED"
    choice messages_status "ADDED: replaces final_dm_status"
    datetime messages_at "ADDED: replaces final_dm_at"
    choice final_dm_status "REMOVED: → messages_status"
    datetime final_dm_at "REMOVED: → messages_at"
    choice public_reply_status "CHANGED: step statuses add expired · unknown"
    choice current_step "CHANGED: final_dm → messages; adds hide_comment"
    choice failed_step "CHANGED: final_dm → messages; adds hide_comment"
    choice waiting_for "CHANGED: adds any"
    choice ignored_reason "CHANGED: previous_run_final → once_per_post; adds thread_reply_off · own_comment · contact_excluded"
    choice public_reply_skip_reason "CHANGED: gap removed; adds deleted_comment"
  }
  instagram_automation_run["instagram_automation_run · CHANGED · app.instagram_automation_runs"] {
    id id PK
  }
  instagram_automation_run |o--o{ instagram_automation_comment_log : "is logged by"
```

## Stage 4 — Received content

Meta's events keep their table, kept 8 days instead of 30 and emptied once handled; their dedupe keys
move to a table of their own.

### instagram_webhook_event

- **Holds:** as at launch, one event Meta sent for a connected account — plus when a failed event is
  tried again (hourly, while the comment is under 7 days old). `event_kind` adds `live_comment` ·
  `story_mention` · `shared_post` · `referral` · `ice_breaker` and drops `read`; `skip_reason` drops
  `read_receipt`, `echo` and `reaction` and adds `own_comment` (D64) and `flood` (more than 20 of her
  message events in a minute, WH16). Echoes of the owner's hand-typed messages and reactions are saved
  `received` and taken in (an echo starts her quiet time, WH10); our own echoes are dropped before
  saving (WHQ1). The body is **null** once the event is processed or skipped, and a row born skipped
  stores none (WH22); read receipts, our own "sent" notices and tag events are never saved. Each
  event's intake group (messages, Live, comments) is worked out from its kind and stored (WH11). Kept 8
  days (D15; launch 30) — one of the three split tables, by day (P33).
- **Table:** `app.instagram_webhook_events` (live)
- **Sources:** plan:L3207–L3225, plan:L3926–L3941; D15, D64; current schema
  `src/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.ts`.
- **Added:** `next_attempt_at`; `intake_group`; five event kinds; `own_comment`, `flood`.
- **Replaced:**
  - The dedupe key on this table → `instagram_webhook_event_key`.
  - A failed event was final after 5 tries (launch) → retried hourly up to 7 days.
  - The launch's debugging list of events shows 8 days instead of 30.
  - A DM echo was skipped `echo` (launch) → saved `received` (WH10); `own_comment` is the skip of an
    own comment ([P24](decisions.md)).
  - `instagram_account_id` → `channel_account_id` (P47); the table keeps its Instagram name (P45).
- **Open:** none — columns, the split and its indexes: routes-final § 5, 5.B.3.

```mermaid
erDiagram
  instagram_webhook_event["instagram_webhook_event · CHANGED · app.instagram_webhook_events"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "CHANGED: was instagram_account_id; → channel_account (P47)"
    text event_key "CHANGED: uniqueness moves to instagram_webhook_event_key"
    choice event_kind "CHANGED: adds live_comment · story_mention · shared_post · referral · ice_breaker; read removed"
    choice skip_reason "CHANGED: read_receipt, echo and reaction removed; adds own_comment (D64) and flood (WH16)"
    json payload "CHANGED: optional; null once processed or skipped, none when born skipped (D15, WH22)"
    choice intake_group "ADDED: messages · live · comments, worked out from event_kind (WH11)"
    datetime next_attempt_at "ADDED: when a failed event is tried again"
    datetime created_at "CHANGED: kept 8 days, not 30 (D15); split by day (P33)"
  }
```

### instagram_webhook_event_key

- **Holds:** the key of every event received per account, so the same event arriving twice saves
  nothing more. Kept 8 days — a plain table, batch deletes (P33). No public id.
- **Table:** `app.instagram_webhook_event_keys` (P38; Instagram's, [P45](decisions.md))
- **Sources:** plan:L3453–L3461; D15.
- **Added:** new — the launch kept this key on the events, which now go after 8 days in whole days.
- **Replaced:** the event's own key uniqueness.
- **Open:** none — the plan's split by account is not used (P33). Its key leads with the
  organization: organization, account, event key (routes-final § 5, 5.B.3).

```mermaid
erDiagram
  instagram_webhook_event_key["instagram_webhook_event_key · NEW · app.instagram_webhook_event_keys"] {
    id organization_id FK, PK
    id channel_account_id FK, PK "→ channel_account"
    text event_key PK "at most 512; same key as on the event"
    datetime received_at
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--o{ instagram_webhook_event_key : "ADDED: remembers event keys of"
```

## Stage 5 — Broadcasts

Saved audiences and the message sets sent to them, only to people whose chat window is open (D68,
PRO). Segments and broadcasts are soft-deleted and purged later (A9, [P9](decisions.md)).

### instagram_segment

- **Holds:** a saved audience of one account: a name and its conditions in AND / OR groups (at most 2
  levels, 20 conditions) on tags, the automation she came through, how she came in, comments, activity,
  her details, story activity and "no broadcast in N days" (D68). Used again by many broadcasts. Has a
  public id (prefix not named by the plan). Soft delete (A9); purged 90 days after its delete, once no
  live broadcast points at it (BC4, BCQ1).
- **Table:** `app.instagram_segments` ([P44](decisions.md); the plan's `app.segments`)
- **Sources:** plan:L3719–L3750; D68.
- **Added:** `deleted_at` — the plan hard-deletes; A9 keeps the repository's soft delete.
- **Replaced:** none.
- **Open:**
  - Public id prefix — chosen at kickoff (P22, AMBER).

```mermaid
erDiagram
  instagram_segment["instagram_segment · NEW · app.instagram_segments"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account"
    text name "1 to 255"
    json conditions "AND / OR groups; at most 2 levels, 20 conditions"
    id created_by_user_id FK "→ user"
    id updated_by_user_id FK "→ user"
    datetime created_at
    datetime updated_at
    datetime deleted_at "soft delete (A9)"
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--o{ instagram_segment : "ADDED: saves audiences in"
```

### instagram_broadcast

- **Holds:** one message set (1–3 messages, the same shape as the automation's message list, with
  versions) sent to the people of a segment or a one-off audience — a copy of the conditions is kept
  when it starts. `status`: `draft` · `scheduled` · `sending` · `waiting_for_chats` · `done` ·
  `cancelled`; `mode`: `now` · `scheduled` · `when_chat_opens`, chosen **at send** — with the send's
  `scheduled_at` or its open wait of 1–7 days, which is a send input, not a column (`ends_at` holds its
  end; BC10); `cancel_reason`: `owner` · `plan_feature_off`. Counts of matched, sent, skipped, failed,
  replies and taps. Has a public id (prefix not named; it goes in the messages' button payload). Soft
  delete (A9); purged 90 days after its delete, its recipients and messages with it (BC4, BCQ1). Only a
  `draft`, `done` or `cancelled` broadcast may be deleted (BC11).
- **Table:** `app.instagram_broadcasts` ([P44](decisions.md); the plan's `app.broadcasts`)
- **Sources:** plan:L3752–L3791, plan:L4070–L4087; D57, D68.
- **Added:** `deleted_at` (A9).
- **Replaced:** none.
- **Open:**
  - Public id prefix — chosen at kickoff (P22, AMBER).
  - Columns and keys: routes-final § 7, 7.A.3.

```mermaid
erDiagram
  instagram_broadcast["instagram_broadcast · NEW · app.instagram_broadcasts"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account"
    text name "1 to 255"
    choice status "draft · scheduled · sending · waiting_for_chats · done · cancelled"
    choice mode "now · scheduled · when_chat_opens; set at send (BC10)"
    id segment_id FK "→ instagram_segment; emptied when the segment goes; empty for a one-off audience"
    json conditions "one-off conditions, and the copy taken at start"
    json messages "1 to 3 messages with versions"
    datetime scheduled_at "set exactly for scheduled"
    datetime ends_at "set exactly for when_chat_opens; 1 to 7 days after start (the send's open wait)"
    datetime started_at
    datetime finished_at
    datetime cancelled_at
    choice cancel_reason "owner · plan_feature_off; set exactly when cancelled"
    number matched "0 or more"
    number sent "0 or more"
    number skipped "0 or more"
    number failed "0 or more"
    number replies "0 or more; once per recipient"
    number taps "0 or more"
    id created_by_user_id FK "→ user"
    id updated_by_user_id FK "→ user"
    datetime created_at
    datetime updated_at
    datetime deleted_at "soft delete (A9)"
  }
  instagram_segment["instagram_segment · NEW · app.instagram_segments"] {
    id id PK
  }
  instagram_segment |o--o{ instagram_broadcast : "ADDED: is the audience of"
```

### instagram_broadcast_recipient

- **Holds:** one person a broadcast goes to: status, reason, which version she got, when it was sent
  and when she first replied. `status`: `waiting` · `sent` · `skipped` · `failed` · `unknown`;
  `reason`: `recent_broadcast` · `owner_chat` · `window_closed` · `opted_out` · `contact_excluded` ·
  `broadcast_cancelled` · `plan_feature_off` · `contact_deleted`, plus the message reasons. At most
  one row per broadcast and contact — unique (organization, broadcast, contact); a `skipped · owner_chat`
  row goes back to `waiting` instead of a second one (BC16). One broadcast per person per 24 hours. Its
  account is a copy of the broadcast's, with no reference of its own. Kept 90 days — a plain table,
  batch deletes (P33). No public id.
- **Table:** `app.instagram_broadcast_recipients` ([P44](decisions.md); the plan's `app.broadcast_recipients`)
- **Sources:** plan:L3793–L3816, plan:L4089–L4107; D68.
- **Added:** new.
- **Replaced:** none.
- **Open:** none — the plan's split by month is not used (P33); routes-final § 7, 7.C.

```mermaid
erDiagram
  instagram_broadcast_recipient["instagram_broadcast_recipient · NEW · app.instagram_broadcast_recipients"] {
    id id PK
    id organization_id FK
    id channel_account_id "→ channel_account; copy of the broadcast's account, no reference (BC16)"
    id broadcast_id FK "→ instagram_broadcast; unique with contact_id per organization (BC16)"
    id contact_id FK "→ instagram_contact"
    choice status "waiting · sent · skipped · failed · unknown"
    choice reason "recent_broadcast · owner_chat · window_closed · opted_out · contact_excluded · broadcast_cancelled · plan_feature_off · contact_deleted, plus the message reasons"
    number version_number "plan name version_no"
    datetime created_at
    datetime sent_at
    datetime replied_at
    datetime updated_at
  }
  instagram_broadcast["instagram_broadcast · NEW · app.instagram_broadcasts"] {
    id id PK
  }
  instagram_contact["instagram_contact · CHANGED · app.instagram_contacts"] {
    id id PK
  }
  instagram_broadcast ||--o{ instagram_broadcast_recipient : "ADDED: goes to"
  instagram_contact ||--o{ instagram_broadcast_recipient : "ADDED: receives"
```

## Stage 6 — Sending engine

The paced sender: four lanes per account, one row per message, the attempts, the minute and month
counts, the stop history, the two global rows and the Meta file ids. Intake never sends; the lanes do
(plan:L3226–L3640, D3, D4, D18).

### instagram_send_lane

- **Holds:** one row per account and lane — `slow` (opening DMs as private replies, one at a time),
  `reply` (public replies and hides), `fast` (every other DM), `broadcast` — made at connect (D25).
  `state`: `ready` · `working` · `sleeping` · `stopped` (fast uses `ready` and `stopped` only).
  `wait_reason`: `box` · `gap` · `hour_limit` · `day_limit` · `not_before` · `stop` · `test`. Holds the
  ticket turn, the lease, the random box, the last send, half speed, the day count, the current
  **error stop** (`stop_reason`: `too_fast` · `blocked` · `account_flagged` · `login_expired` ·
  `account_not_shared` · `access_off` · `app_not_approved` · `app_limit`), the account's one test
  claim and the fast lane's sends on their way. The owner's pause, the team's suspend and the **plan
  stop** are the account's, on `channel_account` ([P42](decisions.md)), read by every lane — so the
  error stop here and the plan stop there still hold at once (SN12). No public id.
- **Table:** `app.instagram_send_lanes` (P38; Instagram's, [P43](decisions.md))
- **Sources:** plan:L3385–L3419, plan:L3943–L3970; D3, D4, D5, D11, D19, D34, D35, D57, D62;
  routes-final § 6, 6.A.3.
- **Added:** new.
- **Replaced:** the plan's one stop for errors and plan states → an error stop and a plan stop (SN12,
  plan §33.2 rule 4); the pause, suspend and plan stop move from each lane to the account's
  `channel_account` row ([P42](decisions.md)); `instagram_account_id` → `channel_account_id` (P47).
- **Open:** none.

```mermaid
erDiagram
  instagram_send_lane["instagram_send_lane · NEW · app.instagram_send_lanes"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account; one row per account and lane"
    choice lane "slow · reply · fast · broadcast"
    choice state "ready · working · sleeping · stopped"
    datetime next_run_at
    choice wait_reason "box · gap · hour_limit · day_limit · not_before · stop · test"
    number turn_number "plan name turn_no"
    number working_turn
    datetime lease_until
    number pick_count "slow: place 1 to 5 in the new : old mix"
    datetime box_start
    datetime last_sent_at
    datetime half_speed_until
    date day_date "slow, day limit only"
    number day_count "slow, day limit only"
    choice stop_reason "an error stop group only (SN12)"
    datetime stop_until "empty = the owner must act"
    number stop_count
    number stop_error_code
    number stop_error_subcode
    datetime stop_cleared_at
    choice testing_lane "slow row only: slow · reply · fast · broadcast"
    datetime testing_until "slow row only"
    number sending_count "fast row only"
    datetime updated_at
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--|{ instagram_send_lane : "ADDED: sends through 4 lanes"
```

### instagram_message

- **Holds:** one message we send or plan to send — of a run or of a broadcast: its type
  (`opening_message` · `nudge` · `public_reply` · `hide_comment` · `follow_check` · `follow_request` ·
  `email_question` · `invalid_email` · `phone_question` · `message` · `broadcast`), list number, kind
  (`text` · `image` · `cards` · `quick_replies` · `audio` · `file` · `post`), version and wording,
  lane, channel (`private_reply` · `direct` · `comment_reply` · `comment_hide`), whether it counts as a
  DM, its status (`waiting` · `sending` · `sent` · `unknown` · `failed` · `skipped` · `cancelled` ·
  `expired`) and reason (about 30 values, plan:L3287–L3317, plus `replaced` for the waiting messages
  of a replaced run, P35), not-before time, tries and asks, the
  Instagram message id, error codes and the owner's one retry (D72). Moving lanes changes the same
  row while it waits. Copies of the account, automation and contact are kept without a reference.
  Kept 30 days (D50) — one of the three split tables, by week of the run start (P33, P13). Has a public
  id (prefix not named by the plan).
- **Table:** `app.instagram_messages` (P38; Instagram's, [P43](decisions.md))
- **Sources:** plan:L3234–L3355, plan:L3850–L3891; D8, D9, D13, D17, D29–D33, D50, D68, D72.
- **Added:** new — the launch claimed a send on the run and sent inline (Standing deviation "Sending
  again on a retry"); an `unknown` send now may go once more on her next action (D17).
- **Replaced:** the run's send claim.
- **Open:**
  - `automation_run_started_at` stays only as the split key: runs are plain (P33), so the link to
    the run is `automation_run_id` alone; a broadcast row puts its recipient's creation time in the
    same field.
  - Public id prefix — chosen at kickoff (P22, AMBER).

```mermaid
erDiagram
  instagram_message["instagram_message · NEW · app.instagram_messages"] {
    id id PK
    id organization_id FK
    id channel_account_id "→ channel_account; copy, no reference"
    id automation_id "copy, no reference; empty only for a broadcast"
    id automation_run_id FK "→ instagram_automation_run; empty only for a broadcast"
    id broadcast_id FK "→ instagram_broadcast; set exactly for a broadcast message"
    datetime automation_run_started_at "split key only (P33): the run's start, or the recipient's creation for a broadcast"
    id contact_id "copy, no reference"
    choice message_type "opening_message · nudge · public_reply · hide_comment · follow_check · follow_request · email_question · invalid_email · phone_question · message · broadcast"
    number message_number "plan name message_no; 1 to 10, broadcast 1 to 3"
    choice message_kind "text · image · cards · quick_replies · audio · file · post"
    number version_number "plan name version_no; 1 to 3"
    number wording_number "plan name wording_no; 1 to 10"
    choice lane "slow · reply · fast · broadcast"
    choice channel "private_reply · direct · comment_reply · comment_hide; empty only for follow_check"
    boolean is_counted_as_direct_message "plan name counts_as_dm"
    choice status "waiting · sending · sent · unknown · failed · skipped · cancelled · expired"
    choice reason "about 30 values, plan L3287-L3317, plus replaced (P35)"
    datetime not_before
    datetime trigger_occurred_at
    number tries
    number asks
    number text_number "plan name text_no"
    text instagram_message_id "at most 128"
    datetime sending_at "set when sending"
    datetime sent_at "set when sent"
    number error_code
    number error_subcode
    datetime owner_retry_at "the owner's one retry (D72)"
    datetime created_at
    datetime updated_at
  }
  instagram_automation_run["instagram_automation_run · CHANGED · app.instagram_automation_runs"] {
    id id PK
  }
  instagram_broadcast["instagram_broadcast · NEW · app.instagram_broadcasts"] {
    id id PK
  }
  instagram_automation_run |o--o{ instagram_message : "ADDED: sends"
  instagram_broadcast |o--o{ instagram_message : "ADDED: sends"
```

### instagram_send_attempt

- **Holds:** one call to Meta for a message: lane, count group (`open` · `reply` · `fast` ·
  `broadcast` · `none`), when it started, its result group (`sent`, the error and stop groups of §33,
  for example `too_fast`, `bad_text`, `no_answer`), HTTP status, error codes and how long it took.
  Feeds the "in a row" and "30% bad" rules. The message, automation and contact are copies without a
  reference. Kept 8 days (D16) — one of the three split tables, by day (P33). No public id.
- **Table:** `app.instagram_send_attempts` (P38; Instagram's, [P43](decisions.md))
- **Sources:** plan:L3357–L3383, plan:L5915–L5943; D16, D19.
- **Added:** new.
- **Replaced:** the launch's error fields on the comment log stay; this is the engine's own record.
- **Open:** none.

```mermaid
erDiagram
  instagram_send_attempt["instagram_send_attempt · NEW · app.instagram_send_attempts"] {
    id id PK
    id organization_id FK
    id channel_account_id "→ channel_account; copy, no reference"
    choice lane "slow · reply · fast · broadcast"
    id instagram_message_id "copy, no reference; plan name message_id"
    id automation_id "copy; empty for a broadcast"
    id contact_id "copy"
    choice count_group "open · reply · fast · broadcast · none"
    datetime started_at
    choice result_group "sent or an error group of plan section 33; empty while the call runs"
    number http_status
    number error_code
    number error_subcode
    number duration_milliseconds "plan name duration_ms"
  }
  instagram_message["instagram_message · NEW · app.instagram_messages"] {
    id id PK
  }
  instagram_message ||--o{ instagram_send_attempt : "ADDED: is tried by (no reference)"
```

### instagram_send_minute_count

- **Holds:** messages sent per account, count group (`open` · `reply` · `fast` · `broadcast`) and
  minute — gate 2, raised in the same commit that marks a message `sending` (D18). Kept 2 hours. No
  public id.
- **Table:** `app.instagram_send_minute_counts` (P38; Instagram's, [P43](decisions.md))
- **Sources:** plan:L3421–L3451; D18.
- **Added:** new.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  instagram_send_minute_count["instagram_send_minute_count · NEW · app.instagram_send_minute_counts"] {
    id organization_id FK
    id channel_account_id FK, PK "→ channel_account"
    choice count_group PK "open · reply · fast · broadcast"
    datetime minute_start PK "Postgres clock, to the minute"
    number count "0 or more"
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--o{ instagram_send_minute_count : "ADDED: is counted per minute in"
```

### message_month_count

- **Holds:** messages sent this calendar month by one workspace, in its time zone, across all its
  channels — the plan's `message_month_limit` spans channels ([P43](decisions.md), P47) — split into 16
  slots by channel account so accounts never wait on each other (D34). Every message into her chat
  counts, broadcast ones too (D68). Feeds the month meter (A14, [P14](decisions.md)) and the `plan_limit` stop of the
  slow, fast and broadcast lanes (A3, [P3](decisions.md)). Kept 13 months. No public id.
- **Table:** `app.message_month_counts` (common, [P43](decisions.md): the plan limit spans channels;
  plan name `app.dm_month_counts`, `app.direct_message_month_counts` under A6)
- **Sources:** plan:L3642–L3682; D34, D62, D68.
- **Added:** new.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  message_month_count["message_month_count · NEW · app.message_month_counts"] {
    id organization_id FK, PK
    date month_start PK "the 1st of the month in the workspace's time zone"
    number slot PK "0 to 15, from the channel account"
    number count "0 or more"
    datetime updated_at
  }
```

### instagram_send_stop

- **Holds:** the history of every stop of an account's lane, or of all its lanes: lane (`slow` ·
  `reply` · `fast` · `broadcast` · `all`), reason (a stop group of §33, or `plan_limit` · `plan_ended`
  · `plan_downgrade`), error codes, when it started, its planned end, when it ended and by what
  (`time` · `test` · `owner` · `team`). A plan stop is recorded here with lane `all`, though it now
  sits on `channel_account` ([P42](decisions.md)). Kept 90 days. No public id.
- **Table:** `app.instagram_send_stops` (P38; Instagram's, [P43](decisions.md))
- **Sources:** plan:L3482–L3494; D19, D34, D35, D57.
- **Added:** new.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  instagram_send_stop["instagram_send_stop · NEW · app.instagram_send_stops"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account"
    choice lane "slow · reply · fast · broadcast · all"
    choice reason "a stop group or plan_limit · plan_ended · plan_downgrade"
    number error_code
    number error_subcode
    datetime started_at
    datetime stop_until
    datetime ended_at
    choice ended_by "time · test · owner · team"
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--o{ instagram_send_stop : "ADDED: has stop history"
```

### sending_state

- **Holds:** one row for the whole system: the environment id that must match the running servers (a
  restored copy can never send, D20), the newest settings version that started (D21), the stop for
  all accounts and its count, and the one test for all accounts after it. No organization — a
  documented exemption, maintenance login only (A16).
- **Table:** `app.sending_states` (common, [P43](decisions.md): the global send switch; the plan names
  it in the singular, `app.sending_state`)
- **Sources:** plan:L3496–L3505; D20, D21.
- **Added:** new.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  sending_state["sending_state · NEW · app.sending_states"] {
    number id PK "always 1"
    text environment_id "must equal the servers' environment id (D20)"
    text settings_version "newest version that started (D21)"
    datetime settings_version_since
    datetime all_stop_until
    choice all_stop_reason "app_limit or Instagram down"
    number all_stop_count
    choice testing_lane "slow · reply · fast · broadcast"
    datetime testing_until
    datetime updated_at
  }
```

### sending_helper_slot

- **Holds:** 16 rows that share the every-minute helper's work between servers: each account belongs
  to one slot; a server leases its share. No organization — a documented exemption, maintenance login
  only (A16).
- **Table:** `app.sending_helper_slots` (P38)
- **Sources:** plan:L3507–L3515.
- **Added:** new as the plan writes it.
- **Replaced:** none.
- **Open:**
  - **SNQ1 (routes-final § 6, 6.2) — recommended: drop this table.** The repair runs on the existing
    scheduler, one repeating piece per rule group, each tick given to one server (A7,
    [P7](decisions.md)); the two per-server duties (the clock check, the Redis watch) need no slot. The
    table leaves this file once SNQ1 is answered as recommended.

```mermaid
erDiagram
  sending_helper_slot["sending_helper_slot · NEW · app.sending_helper_slots"] {
    number slot PK "0 to 15"
    text server_id "at most 128; empty = free"
    datetime lease_until
  }
```

### instagram_attachment

- **Holds:** the id Meta gave an uploaded file for one account, so a file is uploaded to Meta once
  and reused; deleted when Meta says it is gone. One per account and upload. No public id.
- **Table:** `app.instagram_attachments` ([P43](decisions.md); was `app.meta_attachments`)
- **Sources:** plan:L3623–L3640; D29, D58.
- **Added:** new — it names an upload by its public id only (`upload_public_id`, SN20), read through
  the upload service; no reference across domains ([P25](decisions.md), AMBER).
- **Replaced:** `meta_attachment` → `instagram_attachment` — Meta's file ids are per Instagram account
  ([P43](decisions.md)).
- **Open:** none. D58 deviation ([P34](decisions.md)): this iteration checks a file's type and
  content (magic bytes) only; the malware scan, and with it "only files scanned clean", comes in a
  later iteration — recorded in AS-BUILT.

```mermaid
erDiagram
  instagram_attachment["instagram_attachment · NEW · app.instagram_attachments"] {
    id id PK
    id organization_id FK
    id channel_account_id FK "→ channel_account; one per account and upload"
    text upload_public_id "the upload's public id only, no reference (P25, SN20)"
    text attachment_id "Meta's id, at most 128"
    datetime created_at
    datetime updated_at
  }
  upload["upload · EXISTING · upload.uploads"] {
    id id PK
  }
  channel_account["channel_account · NEW · app.channel_accounts"] {
    id id PK
  }
  channel_account ||--o{ instagram_attachment : "ADDED: has Meta file ids"
  upload ||--o{ instagram_attachment : "ADDED: is uploaded to Meta as (public id, no reference)"
```

## Stage 7 — Plans and the platform pieces sending needs

The Part F pieces the sending engine reads (in scope, [P28](decisions.md)): the plan rows and their
limits and the move-down pick of accounts. None of these is referenced by an `app` table, so the route
review can place them anywhere before go-live. The file scan of D58 is not built this iteration — the
upload table does not change ([P34](decisions.md)).

### plan

- **Holds:** as today, a billing plan row — now Free, Creator and Studio, with `features` holding
  exactly four keys, checked on every write and read: DMs per month (`message_month_limit` —
  1,000 / 10,000 / 50,000, every channel together; BLQ3, P47), connected accounts
  (`channel_accounts_max` — 1 / 3 / 10, every channel together; P47), PRO
  features (`is_pro_enabled`, plan name `pro_features`) and priority support (`has_priority_support`,
  plan name `priority_support`; P21, BL12). Starter, Growth and Pro stay, turned off (billing rows are
  never deleted); their features are mapped up — Starter to Creator's, Growth and Pro to Studio's
  (BLQ4). The plan's `limits` leaves the API — it is not a column. Members are unlimited on every
  plan (`included_seats` empty, D55).
- **Table:** `billing.plans` (live)
- **Sources:** plan:L7932–L7949, plan:L8459 (feature names); D26, D34, D55, D57; current schema
  `src/domains/billing/sub-domains/plan/plan.schema.ts`.
- **Added:** the Creator and Studio rows; the four feature keys. The plan rows are seeded with
  placeholder prices — Creator $29 a month ($23 yearly), Studio $79 ($63 yearly); ops creates the real
  Stripe products at go-live ([P37](decisions.md)).
- **Replaced:** `features` free-form → exactly these four keys; `included_seats` → empty on every plan.
- **Open:** none — the feature keys are `message_month_limit` and `channel_accounts_max` (BLQ3, full
  names P6, the channel split P47; routes-final § 8, 8.A).

```mermaid
erDiagram
  plan["plan · CHANGED · billing.plans"] {
    id id PK
    text name "CHANGED: Free updated; Creator, Studio added"
    json features "CHANGED: exactly message_month_limit, channel_accounts_max, is_pro_enabled, has_priority_support; old rows mapped up (BLQ4)"
    number included_seats "CHANGED: empty on every plan (D55)"
    boolean is_active "CHANGED: Starter, Growth, Pro turned off"
    money price_monthly "CHANGED: seeded placeholders (P37)"
    money price_yearly "CHANGED: seeded placeholders (P37)"
  }
```

### subscription

- **Holds:** as today, the workspace's subscription — plus a move down that waits for the period end:
  the plan it moves to and when (`scheduled_plan_id`, `scheduled_change_at` — mirrors of a Stripe
  subscription schedule, so the billing screen shows the change without a Stripe call; BLQ1), and the
  owner's pick of which accounts stay active after it (`downgrade_keep`, a list of channel account
  public ids — the one account id, P47 — set only with a scheduled change, editable until the period end; D57). A move up stays
  immediate and clears any scheduled change. Today there is no planned-change column at all.
- **Table:** `billing.subscriptions` (live)
- **Sources:** plan:L8012–L8024, plan:L8452 (`downgrade_keep`); D57; current schema
  `src/domains/billing/sub-domains/subscription/subscription.schema.ts`; routes-final § 8, 8.B.3.
- **Added:** `scheduled_plan_id`, `scheduled_change_at` (BLQ1), `downgrade_keep`.
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  subscription["subscription · CHANGED · billing.subscriptions"] {
    id id PK
    id organization_id FK
    id plan_id FK
    id scheduled_plan_id FK "ADDED: → plan; the plan a move down goes to at the period end (BLQ1)"
    datetime scheduled_change_at "ADDED: set exactly with scheduled_plan_id (BLQ1)"
    json downgrade_keep "ADDED: list of the channel account public ids kept after a move down (P47); set only with a scheduled change (D57)"
    datetime trial_end "referenced: also the workspace had a trial mark (BL7)"
  }
  plan["plan · CHANGED · billing.plans"] {
    id id PK
  }
  plan ||--o{ subscription : "is paid through"
  plan |o--o{ subscription : "ADDED: is scheduled for"
```

### upload

- **Holds:** as today, an uploaded file — **not changed this iteration** ([P34](decisions.md)): no
  `scan_status`. A file used in a message is checked by type and content (magic bytes) only; the
  malware scan comes in a later iteration — a D58 deviation, recorded in AS-BUILT. The new "message
  file" purpose (images to 8 MB, voice notes and PDF to 25 MB) is a code value, not a field
  (plan:L8445). Context only: `instagram_attachment` names an upload by its public id (P25).
- **Table:** `upload.uploads` (live, unchanged)
- **Sources:** plan:L8445–L8446, plan:L8457; D58; current schema
  `src/domains/upload/upload.schema.ts`.
- **Added:** none (the plan's scan result is not added, P34).
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  upload["upload · EXISTING · upload.uploads"] {
    id id PK
    id organization_id FK
  }
```

### Reference data (no new tables)

New rows in the existing tenancy tables (`tenancy.permissions`, `tenancy.roles`,
`tenancy.role_permissions`), not new tables — so the DB Viewer draws nothing for them:

- New permission code `contact:update` — note, tags and "pause automations for this person" (A20,
  [P20](decisions.md)). Broadcasts, segments and past comments reuse `automation:*` (D68, D69).
- The launch's locked **Member** role becomes **Editor** — the same row renamed, adding three codes:
  `automation:delete`, `contact:update`, `upload:manage` — and a new locked **Viewer** role joins every
  team workspace with four codes: `organization:read`, `instagram-account:read`, `automation:read`,
  `contact:read` (plan:L7861–L7889; TN1, TN2, routes-final § 9).
- The shared chip tone `lav` → `lavender` in the roles' and memberships' `tone` rows and checks, so one
  tone list serves them and the organization's tile colour (TNQ1, recommended; a tenancy migration).
- `auth.auth_methods`: every `PASSWORD` row revoked, and every `auth.users.password_hash` emptied, by the
  passwords-off migration (AT1, ATQ1; routes-final § 10).
- `auth.verification_tokens`: a new token type `EMAIL_CONFIRM` (the email confirm link); `PASSWORD_RESET`
  goes with the password routes (UN6, UN7; routes-final § 11).
- In scope with Part F ([P28](decisions.md)).

## Stage 8 — Product around sending

The rest of Part F (plan §44–47, plan:L8436–L8475): new fields and tables in the platform domains
(auth, user, tenancy, billing), in this iteration ([P28](decisions.md)) as new migrations in their own
domains (D48, [P38](decisions.md)). The referral program (§48) is out of scope ([P39](decisions.md)).
One new **app** migration rides with them, `app_member_organization_counts`: a read-only function the
workspace chooser calls for its counts (members, accounts, live automations per workspace; UN5,
routes-final § 11) — no table and no column.

### user

- **Holds:** as today, a person — plus the Instagram handle and the goal asked at onboarding.
  `goal`: `capture_leads` · `drive_sales` · `grow_community`. Passwords are off everywhere: every
  `password_hash` is emptied by the passwords-off migration; the column stays (AT1, ATQ1).
- **Table:** `auth.users` (live)
- **Sources:** plan:L7814–L7822, plan:L7613; current schema under `src/domains/user/`; routes-final
  § 10 (AT1), § 11.
- **Added:** `instagram_handle`, `goal`.
- **Replaced:** `password_hash` set → empty for every person (column kept).
- **Open:** none.

```mermaid
erDiagram
  user["user · CHANGED · auth.users"] {
    id id PK
    text instagram_handle "ADDED: letters, digits, dot, underscore; at most 30; lower case, no @"
    choice goal "ADDED: capture_leads · drive_sales · grow_community"
    text password_hash "CHANGED: emptied for every person, column kept (AT1)"
  }
```

### user_setting

- **Holds:** as today, a person's settings — plus reduce motion, next to dark mode (off).
- **Table:** `auth.user_settings` (live)
- **Sources:** plan:L8201–L8205; current schema
  `src/domains/user/sub-domains/user-settings/user-settings.schema.ts`.
- **Added:** `is_reduce_motion_enabled` (plan name `reduce_motion`; the `is_` form matches
  `is_dark_mode_enabled`, P21).
- **Replaced:** none.
- **Open:** none.

```mermaid
erDiagram
  user_setting["user_setting · CHANGED · auth.user_settings"] {
    id id PK
    id user_id FK
    boolean is_dark_mode_enabled "referenced: the neighbour it follows"
    boolean is_reduce_motion_enabled "ADDED: plan name reduce_motion; off"
  }
```

### session

- **Holds:** as today, a signed-in session — plus the city and country of its IP, looked up in a
  local file (the IP never leaves us); empty when not found.
- **Table:** `auth.sessions` (live)
- **Sources:** plan:L8194–L8199; current schema under `src/domains/auth/`.
- **Added:** `place_city`, `place_country` (the ISO 3166-1 two-letter code; AT18, routes-final § 10).
- **Replaced:** none.
- **Open:** the IP-to-place file's licence and updates (plan §53).

```mermaid
erDiagram
  session["session · CHANGED · auth.sessions"] {
    id id PK
    id user_id FK
    text place_city "ADDED: empty when not found"
    text place_country "ADDED: the ISO country code, 2 capital letters; empty when not found"
  }
```

### organization

- **Holds:** as today, a workspace — plus its tile colour: one of 5 tones (`sky` · `lavender` ·
  `sage` · `peach` · `slate`), always set — picked from the name at create, and the rows that exist
  are backfilled from their names before it becomes required (routes-final § 9, 9.A.3).
- **Table:** `tenancy.organizations` (live)
- **Sources:** plan:L7903–L7906; current schema
  `src/domains/tenancy/sub-domains/organization/organization.schema.ts`.
- **Added:** `logo_color`.
- **Replaced:** none.
- **Open:** none — the plan's tone `lav` is `lavender` (full names; TNQ1 recommends the same rename
  in the shared chip tones, see Reference data).

```mermaid
erDiagram
  organization["organization · CHANGED · tenancy.organizations"] {
    id id PK
    text timezone "referenced: the month count's month"
    choice status "referenced: SUSPENDED stops sending"
    choice logo_color "ADDED: required; sky · lavender · sage · peach · slate; backfilled from the name"
  }
```

### trusted_device

- **Holds:** a browser a person ticked "trust this device for 30 days" on, so sign-in skips the 2FA
  code there — never in a workspace that requires 2FA, never for a step-up (D56). Only the hash of
  its cookie is stored; at most 10 live per person; ends after 30 days, or early on 2FA off, "sign out
  everywhere else", or account deletion. Has a public id. A person reads only her own rows.
- **Table:** `auth.trusted_devices` (P38)
- **Sources:** plan:L7736–L7750; D56.
- **Added:** new.
- **Replaced:** none.
- **Open:** public id prefix — chosen at kickoff (P22, AMBER).

```mermaid
erDiagram
  trusted_device["trusted_device · NEW · auth.trusted_devices"] {
    id id PK
    id user_id FK
    text token_hash "hash of the cookie only"
    text user_agent
    datetime created_at
    datetime expires_at "30 days after the tick"
    datetime last_used_at
    datetime revoked_at
  }
  user["user · CHANGED · auth.users"] {
    id id PK
  }
  user ||--o{ trusted_device : "ADDED: trusts"
```

### trial_account

- **Holds:** every Instagram account that has had the 7-day no-card trial, in any workspace, so an
  account gets it only once (D73): the Instagram user id, the workspace, the subscription it came
  with, the plan and when it started. Append-only. The row outlives its workspace: the organization
  and the subscription are emptied when they go (an exception to "every row goes with its
  organization"), so such a row is seen by no workspace — only a read-only resolver answers "had a
  trial" for a list of Instagram ids, never which workspace (BL18).
- **Table:** `billing.trial_accounts` (P38)
- **Sources:** plan:L8095–L8110; D73; routes-final § 8, 8.B.3.
- **Added:** new.
- **Replaced:** none.
- **Open:** public id prefix — chosen at kickoff (P22, AMBER).

```mermaid
erDiagram
  trial_account["trial_account · NEW · billing.trial_accounts"] {
    id id PK
    text instagram_user_id UK "one trial per Instagram account, ever"
    id organization_id FK "optional; emptied when the workspace goes (D73)"
    id subscription_id FK "optional; the trial's subscription; emptied when it goes"
    id plan_id FK
    datetime started_at
  }
  organization["organization · CHANGED · tenancy.organizations"] {
    id id PK
  }
  subscription["subscription · CHANGED · billing.subscriptions"] {
    id id PK
  }
  plan["plan · CHANGED · billing.plans"] {
    id id PK
  }
  organization |o--o{ trial_account : "ADDED: has trialled with (emptied when it goes)"
  subscription |o--o{ trial_account : "ADDED: started the trial of (emptied when it goes)"
  plan ||--o{ trial_account : "ADDED: is trialled as"
```

## Before → after

One row per `CHANGED` or `REMOVED` table. Plan decisions are `D<n>`; this plan's are `P<n>`.

| Table | Before (launch / today) | After | Why |
| --- | --- | --- | --- |
| `app.instagram_accounts` | The whole account: one not-revoked account per organization; its own public id, status `connected` · `expired` · `error` · `revoked`, name, who connected it and when; Instagram Login ids, scopes and token end on the account; Meta's callbacks find it by the app-scoped id | The 1:1 Instagram extension of `app.channel_accounts` (`channel_account_id`): Instagram user id, username, account type and private flag (added), followers, picture, webhook subscription, starter-question send time (added); status (without `expired`), name, connection, who and when → `channel_account`; own public id, app-scoped id, scopes and token end removed; many per organization up to the plan limit; Meta's callbacks reach it through its connection and the Instagram user id | D24, D25, D26, D42, IA19, P42, P46, P47 |
| `app.instagram_account_settings` | Master switch + five public reply safety settings; keyed by the Instagram account | Owner limits (opening hour/day, fast, person, broadcast), stop words, notice, three account behaviours, extra delay; reply safety moved per automation; the master switch moved to `channel_account`; keyed by `channel_account_id` | D5, D11, D22, D32, D64–D68, P42, P47 |
| `app.instagram_account_tokens` | One encrypted Instagram Login token per account, renewed daily | Removed; one system-user token per channel connection (`app.channel_connection_tokens`) | D24, P41 |
| `app.instagram_media` | Stored posts of an Instagram account | + missed-comment watch times, Live end, the Live product type; points at `channel_account_id` | D40, D41, P47 |
| `app.instagram_contacts` (renamed from `app.contacts`) | `app.contacts`: person per account; plus addresses refused; tags 1–255; erase clears her personal columns | Renamed `app.instagram_contacts`; points at `channel_account_id`; + 24-hour rule, opted out, channel, "via" automation and how she came in, note, first message, owner pause, comment and story activity, last broadcast; plus addresses accepted; tags 1–50; erase also clears her activity columns | D8, D27, D45, D46, D49, D68, D71, P19, P44, P47, CT9, CT11 |
| `app.instagram_automations` (renamed from `app.automations`) | `app.automations`: `live` · `inactive`; 3 trigger types; message fields as columns; DM keyword switch; run counter; next-post window that expires | Renamed `app.instagram_automations`; points at `channel_account_id`; `draft` · `live` · `paused`; 15 ways to start; `steps` object; also start from; between dates; ref link, starter questions, ad, tag, default reply; per-automation public reply pacing and mention; hide comment; automatic stop; counters moved out | D28–D45, D52, D57, D59, D63, P11, P12, P44, P47 |
| `app.instagram_automation_runs` (renamed from `app.automation_runs`) | `app.automation_runs`: send claim on the run; free trigger text kept; one open run per automation and person; 180 days | Renamed; once key, 7-day clock, first DM time, last list message, step versions; send claim on the message; free text never kept; still one open run per automation and person, and a new start replaces it (`replaced`); no open-run key table (confirmed, AUQ4); 90 days, plain table | D9, D13, D16, D46, P33, P35, P44, AUQ4 |
| `app.instagram_automation_run_events` (renamed from `app.automation_run_events`) | `app.automation_run_events`: history of a run | Renamed; + two tap events; plain table, no run start copy | D16, D61, P33, P44 |
| `app.instagram_automation_comment_logs` (renamed from `app.automation_comment_logs`) | `app.automation_comment_logs`: final DM step; 180 days | Renamed; message list step, hide step, comment time; more step statuses and reasons; 90 days, plain table, no run start copy | D16, D32, D33, D64, P33, P44 |
| `app.instagram_webhook_events` | Kept 30 days with their dedupe key and body; failed final after 5 tries; `read` events; echoes and reactions skipped; points at the Instagram account | Kept 8 days, split by day, body null when done (none when born skipped); key in its own (plain) table, led by the organization; failed retried hourly up to 7 days; five new kinds, `read` gone; echoes and reactions saved `received`; skip reasons `own_comment`, `flood` added and `echo`, `reaction` gone; a stored intake group; no Redis buffer; points at `channel_account_id`, stays Instagram's | D15, D64, P24, P32, P33, P45, P47, WH10, WH16, WH22 |
| `billing.plans` | Free, Starter, Growth, Pro; free-form features; seats | Free, Creator, Studio (old rows off, their features mapped up) with seeded placeholder prices; exactly four feature keys (`message_month_limit`, `channel_accounts_max` — both across channels — `is_pro_enabled`, `has_priority_support`); unlimited members | D26, D34, D55, D57, P37, P47, BL12, BLQ3, BLQ4 |
| `billing.subscriptions` | Every plan change applied at once; no planned-change column | + a scheduled move down (`scheduled_plan_id`, `scheduled_change_at`) and the channel accounts kept after it | D57, P47, BLQ1 |
| `auth.users` (Stage 8) | Password hash kept | + Instagram handle, goal; every password hash emptied (column kept) | plan §45.2, P28, AT1 |
| `auth.user_settings` (Stage 8) | Dark mode | + reduce motion (`is_reduce_motion_enabled`) | plan §47.6, P28 |
| `auth.sessions` (Stage 8) | — | + place city and country (the ISO two-letter country code) | plan §47.5, P28, AT18 |
| `tenancy.organizations` (Stage 8) | — | + tile colour, required, backfilled from the name | plan §45.7, P28, TNQ1 |

`upload.uploads` is not in the table: it does not change this iteration (no scan result — P34, a D58
deviation). The common NEW tables (`app.channel_connections`, `app.channel_connection_tokens`,
`app.channel_accounts`, `app.message_month_counts`) are not in it either — they are new, not changed; the
plan's `meta_connections`, `meta_connection_tokens`, `direct_message_month_counts` and `meta_attachments`
were never built, so their new names (P41, P43) are renames of a proposal only.

## Out of scope (P39)

The referral program (plan §48, D53) moves to a later iteration ([P39](decisions.md)), with its routes
and the month-close worker. Its four tables leave this file:

- `billing.referral_links` — one referral link per person.
- `billing.referrals` — one friend who came in through a link.
- `billing.referral_earnings` — one line per paid invoice of a referred workspace.
- `billing.referral_payouts` — one payout our team made to a referrer.

## Data questions found while writing this file

All five are answered with safe defaults, now **AMBER rows [P21](decisions.md)–[P25](decisions.md)** in
decisions.md (still open to the owner's change) and applied above:

- **N1 → P21 — true/false names:** the `is_` / `has_` forms (`is_reply_like_person_enabled`,
  `is_counted_as_direct_message`, …); the launch's `is_public_reply_enabled` keeps its name.
- **N2 → P22 — public id prefixes:** chosen at kickoff by `generatePublicId`, recorded in AS-BUILT.
- **N3 → P23 — comment log ignored reasons:** `waiting_for_other_email` and `already_waiting` kept.
- **N4 → P24 — own comment:** `own_comment` for comments; `echo` stays for DM echoes.
- **N5 → P25 — reference across domains:** `instagram_attachment` keeps the upload public id only, read
  through the upload service — no cross-domain reference.
