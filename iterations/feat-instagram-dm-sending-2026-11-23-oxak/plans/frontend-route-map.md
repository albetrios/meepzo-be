# Frontend route map — feat-instagram-dm-sending-2026-11-23-oxak

For the frontend: what changed in the API for this iteration's design drop, each design operation's
route, every route the API has, and the design features the backend dropped.

Section 3 is generated — `pnpm iteration:frontend-map feat-instagram-dm-sending-2026-11-23-oxak` rewrites it from `docs/routes.txt`, the
OpenAPI document and `plans/routes-final.md`. Write sections 1, 2 and 4 by hand.

## 1. What changes on every call

This iteration changes **105 routes — 49 new, 55 changed, 1 as built — and removes 5**
([route-changes.md](route-changes.md)). `#n` is the route's number in [routes-final.md](routes-final.md); paths here
go after `/api/v1`. The exact request and answer shapes are the OpenAPI document (`pnpm docs:all`); every `reason`
below is listed with its status in [`docs/reference/api/response-codes.md`](../../../docs/reference/api/response-codes.md).

**Final at Close** — from [AS-BUILT.md](../AS-BUILT.md) rows R1–R53 and R56–R62 (R54, R55 are flow proofs with no
route change). 1.13 lists what the frontend sees from the background rows and the few design points not built.
meepzo-fe opens its own iteration on this contract ([P30](decisions.md)).

### 1.1 Basics (what is new since the launch)

| Topic | Rule |
| --- | --- |
| Base paths | Common to every channel: `/app/social/channel-connections…` (the Meta login) and `/app/social/channel-accounts…` (the connected accounts). Shared product data: `/app/contacts…`, `/app/contact-tags`, `/app/automations…`, `/app/broadcasts…`, `/app/segments…`, `/app/usage`. Instagram's own: `/app/social/instagram/accounts/:channel_account_id/…` and `/app/social/instagram/webhook-events` ([P40](decisions.md)–[P48](decisions.md)) |
| Many accounts | An organization holds 1, 3 or 10 Instagram accounts by plan. The launch's singular `/app/social/instagram/account*` routes are gone; every account route names `:channel_account_id` |
| The selected account | Contacts, contact tags, automations, broadcasts and segments belong to one account: send `channel_account_id` as a **required** filter on their lists and in the create body. A list without it answers `400` |
| Success, casing, ids | As the launch: `200` (a create too), `204` for `DELETE`, `snake_case` fields, `id` for a record's id, an unknown field `400`. **One exception**: Apple's form post (#124) answers `303` — the browser follows it, the frontend never calls it |
| Times | ISO 8601 in UTC out; send ISO 8601 with an offset |
| Live updates | None. Load again after a write or on refresh ([P27](decisions.md): a dismissed notice is remembered by the browser) |
| Undo | No undo route ([P15](decisions.md)): the toast replays the previous action (pause ↔ go live, a tag back) |
| Idempotency | `X-Idempotency-Key` is required on every signed-in `POST` that creates a row or starts background work ([P89](decisions.md)) — the `Idem` column of section 3. State actions (go live, pause, resume, cancel of an automation), the keyword test and the login / reconnect starts take none |
| Saving over a newer version | `PATCH` on a contact, an automation, a segment, a broadcast or an account's settings takes `expected_updated_at`; an older one answers `409 record_changed` |

### 1.2 Ids

| Prefix | Record | Where the frontend meets it |
| --- | --- | --- |
| `chc_` | Channel connection (one Meta login per business portfolio) | `:channel_connection_id`; `channel_connection_id` on an account |
| `cha_` | Channel account (an Instagram account) | `:channel_account_id`; `channel_account_id` on contacts, automations, broadcasts, segments, webhook events and as their list filter |
| `con_` | Contact | `:contact_id` |
| `aut_` | Automation | `:automation_id`; `first_automation_id` on a contact; `start_automation_id` on a broadcast |
| `abf_` | Past-comments read | `:automation_backfill_id`; `open_backfill` on an automation |
| `igm_` | Instagram message | the messages of a contact's activity (#24) |
| `brc_` | Broadcast | `:broadcast_id`; a broadcast message in the activity |
| `seg_` | Segment | `:segment_id`; `segment_id` on a broadcast and the count |
| `tra_` | Trial account | never returned on its own |
| `tdv_` | Trusted device | never returned (the `trusted_device` cookie carries it) |
| `pln_`, `inv_`, `rol_`, `usr_`, `iwe_` | Plan, invitation, role, user, webhook event (existing) | `:plan_id` must be a `pln_` id now (`400` otherwise) |

**`iga_` is gone** ([P47](decisions.md), R6): an Instagram account has one id, its `cha_` id, and every launch field
`instagram_account_id` is now `channel_account_id`. Instagram's own ids (`instagram_user_id`, media ids, …) stay
strings of digits.

### 1.3 Team only, roles and permissions

Every `/app/…` route is team only, as at launch. **Four fixed roles** on every team — Owner, Admin, Editor (the
launch's Member, renamed) and Viewer ([P20](decisions.md), R28) — and **custom roles are off**: creating, editing,
deleting or restoring a role, or replacing its codes (#111–#115), answers `403 custom_roles_off`; a membership names
exactly one system role. Show each button by its code in `GET /auth/me/context` › `my_permissions`.

| Permission code | Allows | Change |
| --- | --- | --- |
| `channel-account:read` | connections, accounts, the ad picker (#4, #6, #7, #15, #41, #42) | **new** — replaces `instagram-account:read` on the common routes; Owner, Admin, Editor, Viewer |
| `channel-account:manage` | connect, pick, reconnect, disconnect, pause, resume, activate (#1–#3, #5, #8–#11, #40) | **new** — Owner, Admin |
| `instagram-account:read` / `:manage` | media, stories, sending status (#13, #14, #63) / settings (#12) | kept only on the Instagram routes |
| `contact:update` | note, tags, pause for her, bulk actions, retry her failed messages (#20, #21, #26) | **new** — Owner, Admin, Editor |
| `automation:*` | also broadcasts, segments and past comments (no own codes) | Editor gains `automation:delete` |
| `upload:manage` | message files | Editor gains it; Viewer has none |

The Viewer reads (`organization:read`, `channel-account:read`, `instagram-account:read`, `automation:read`,
`contact:read`) and never writes.

### 1.4 Plans, trial and read-only

- **Plans** (#100, #101): Free, Creator, Studio. `features` is typed — the two limits `message_month_limit` and
  `channel_accounts_max`, priority support and **one switch per feature**: `email_ask`, `phone_ask`,
  `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `broadcasts`, `segments`, `past_comments`,
  `extra_delay`, `starter_questions`, `mark_seen` ([P83](decisions.md), [P103](decisions.md)). New
  `price_yearly_per_month`; `limits` removed. The old rows are switched off and carry Free's features.
- **Context** (#108, `GET /auth/me/context`): `plan_access` adds `trial_ends_at`, `plan`, `features`,
  `is_plan_choice_required` (on a switched-off plan — show the plan chooser); the organization adds
  `channel_accounts_count` (and `logo_color`). Read a PRO switch from `plan_access.features`, never from the plan name.
- **Trial** (#102): `is_trial: true` starts the 7-day no-card trial — `422 plan_has_no_trial` on Free,
  `409 trial_already_used` (this organization, or one of its accounts, had one); a pick during a trial of an account
  trialled elsewhere answers `409 trial_used_by_account` (#3).
- **Move up / down** (#103): up at once; down at the period end, with `keep_channel_account_ids` (the accounts that
  stay; `400 keep_channel_account_ids` when wrong); the answer's subscription carries `scheduled_change` and `is_trial`.
- **After Free** (an unpaid trial end or a move to Free leaves a local Free row with no card subscription):
  **subscribe again with #102**, not #103 — #102 replaces that Free row with the paid plan or a first trial (a used
  trial answers `409 trial_already_used`, [P502](decisions.md)); #103 to a paid plan from it answers
  `422 subscription_required` — send the person to #102 ([P503](decisions.md)).
- **Cards**: `DELETE /billing/payment-methods/:payment_method_id` (#105, `409 default_card_in_use` on the only card
  of a paid plan) and `POST …/:payment_method_id/default` (#106). `:payment_method_id` is Stripe's `pm_…` id.
- **Read-only plan** changed ([P10](decisions.md)): the owner may still edit, pause, delete and disconnect; refused
  with `403 organization_read_only` are **go live** (#32), a broadcast **send** (#75) and turning a PRO part on.
- **The feature check** ([P50](decisions.md), [P61](decisions.md)): a route that refuses a feature answers one of
  `403 plan_lacks_feature` (was `plan_feature_required`; offer the upgrade), `409 permission_not_granted` (reconnect
  to grant it — #40), `422 channel_lacks_feature`, `422 feature_not_offered` (Meta has not opened it yet — hide or
  grey it). Go live lists the same reasons as `errors[]` items instead (1.5).

### 1.5 Errors

| What | Rule |
| --- | --- |
| `errors[].reason` | A `400` on content and **`409 automation_not_ready`** (go live, #32) carry `errors[]` items `{ field, reason, message }`: `field` is the step path (`steps.hello.versions.0.buttons`, `trigger_type`, `features.email_ask`), `reason` one of `missing`, `count`, `text_invalid`, `next_button_missing`, `account_not_connected`, `month_limit_reached`, `catch_all_taken`, `starter_questions_over_limit`, `ref_code_taken`, `file_not_usable` or the four feature-check reasons. Show each beside its step. `422 broadcast_incomplete` (#75) works the same way |
| Extra fields | Some 4xx answers carry `tries_left` (a wrong email or 2FA code) and `retry_after_seconds` (with `Retry-After`: resend too soon, day limit, 2FA lock, confirm link too soon) next to `reason` |
| Reconnect | `404 instagram_reconnect_required` on the pickers (#13–#15, #41): the account or its connection is broken — show the reconnect card (#40) |
| Renamed | `instagram_feature_not_offered` → `feature_not_offered`; `plan_feature_required` → `plan_lacks_feature`; the launch's Instagram Login reasons (`instagram_code_invalid`, `instagram_account_not_professional`, `instagram_scopes_missing`, `organization_already_has_instagram_account`) are gone |
| Warnings | Go live may answer `200` with `meta.warnings` (worth knowing, not blocking) |

### 1.6 Pages the frontend hosts

| Page | Who sends the browser there | What the page does |
| --- | --- | --- |
| `/auth/meta/callback?code&state` | Meta, after its Unified Login — the address is `META_REDIRECT_URI`, registered on the Meta app exactly (R2, R3) | `POST /app/social/channel-connections/meta/callback` (#2) with `{ code, state }` and an idempotency key; the answer is the account picker. Then `POST …/:channel_connection_id/accounts` (#3) with the picks. A reconnect (#40) returns to the same page |
| `/callback/apple?code&state` or `?reason=` | Our `303` from Apple's form post (#124, R31) | With `code` and `state`: `GET /auth/oauth/apple/callback?code&state` (#143) as for Google. With `reason` (`oauth_cancelled`, `oauth_failed`, `oauth_expired`): show the sign-in page with that message |
| `/confirm-email?token=…` | The confirm-your-email email (R35) | `POST /auth/email/confirm` (#134) with `{ token }` → `{ is_email_verified: true }`; `400 email_confirm_token_invalid` (unknown, spent or over 24 hours) — offer a new link (#133) |
| The invitation page | The invitation email (existing) | Before accepting: `POST /tenancy/membership-invitations/:membership_invitation_id/preview` (#118, public) with `{ token }` → `state` (`valid` · `accepted` · `expired` · `revoked`), `organization { name, logo_color }`, `role_name`, `inviter_first_name`, `expires_at`, `email_matches`, `signed_in` |

### 1.7 Sign-in and security

- **Passwords are off** (R30, [P84](decisions.md); kept disabled, not removed — [P251](decisions.md)):
  `POST /auth/login`, `/auth/password/forgot`, `/reset` and `/change` are registered only when the server's
  `PASSWORD_ROUTES_ENABLED` is on (default off, and off in every deployed environment) and otherwise answer `404`.
  Section 3 lists them because the catalog is built with the flag on. Sign in with the email code, Google, Apple or a
  passkey; remove every password field. The password step-up stays removed (step-up by email code, #127).
- **Email code** (#120, #121): digits only, 6 of them. Send-code answers `{ message, resend_after_seconds,
  expires_in_seconds }`; too soon → `429 code_resend_too_soon` + `retry_after_seconds`. Login refuses with
  `401 code_wrong` + `tries_left`, `401 code_used_up` (ask a new code), `401 code_expired`, `429 code_day_limit`,
  `403 login_method_turned_off`, `401 account_not_active`.
- **Providers** (#122): `google` and `apple`; **GitHub is removed**. `GET /auth/oauth/:provider` (#123) takes
  `?intent=link` for a signed-in person after a recent step-up (`403 recent_step_up_required`) — the "connect Google /
  Apple" button in Settings; the callback (#143) then answers `409 provider_account_in_use` (that Google or Apple
  account is someone else's — now in the OpenAPI document too) or `403 oauth_link_needs_verified_email`.
- **2FA sign-in** (#126): body `trust_device: true` sets the 30-day `trusted_device` cookie (at most 10 devices);
  refusals `401 mfa_code_wrong` + `tries_left`, `429 mfa_locked` + `retry_after_seconds`, `401 mfa_session_invalid`.
  A trusted browser skips the 2FA step. Removing the last 2FA factor (#145) and "sign out everywhere else" (#144) end
  the trusted devices (#144 keeps this browser's).
- **Step-up** (#127): body `{ code }` (the email code) → `{ stepped_up, factor }`; it counts as strong without 2FA,
  so removing a passkey (#147), ending a session (#146) or removing a sign-in way works by email code. A person with
  2FA gets `403 mfa_step_up_required` — use `POST /auth/me/mfa/verify`.
- **The email-code way** can never be removed (#125): `409 email_code_always_on`; hide its remove button.
- **Sessions** (#128): each session has `place` — `{ city, country_code }` or `null`. The data is DB-IP Lite under
  **CC BY 4.0: show "IP geolocation by DB-IP" linking to <https://db-ip.com>** on the sessions screen or the legal
  page ([P86](decisions.md), R33).

### 1.8 Organization, team and profile

- **Create** (#141): `slug` is optional (made from the name); the tile colour comes from the name.
- **Edit** (#110): name and tile colour; a `slug` answers `422 slug_read_only`. Every organization answer carries
  `logo_color`, one of the chip tones — **`lav` is now `lavender`** ([P81](decisions.md); role and membership `tone`
  too).
- **Invite** (#117): body `{ emails: [1–20], role_ids: [exactly one system role], expires_in_days? }` — the staff
  fields are gone; inviting as Owner is `400`. The answer is one line per address:
  `{ results: [{ email, result, membership_id }], invited_count }`, `result` one of `invited`, `already_member`,
  `already_invited` (inviting again someone still invited answers this line, not an error), `invalid_email`
  (disposable domains too). Show the lines; never treat a partial result as a failure.
- **Members** (#116): `meta.counts_by_role` `[{ role_id, name, count }]` for the role filter chips.
- **Organization chooser** (#132, `GET /users/me/organizations`): **team organizations only — the personal one is
  hidden**; each row adds `role { id, name }` (may be `null`), `members_count`, `channel_accounts_count`,
  `live_automations_count`; `q` searches the name (≤ 100 characters).
- **Profile** (#130, #148): `instagram_handle` (a leading `@` and capitals are taken off; `null` clears) and `goal`
  for onboarding.
- **Settings** (#131, #149): `is_reduce_motion_enabled`; the personal organization as `default_organization_id`
  answers `422 team_organization_required`.
- **Confirm your email** (#133): `POST /users/me/email-confirmation` → `{ resend_after_seconds: 60, expires_at }`;
  `409 email_already_confirmed`, `429 email_confirmation_resend_too_soon`.
- **Notification preferences** (#135, #136) are by **kind**: `{ kinds: [{ kind, types, channels: [{ channel,
  is_enabled, is_default, is_locked }] }] }` — seven kinds; `PUT` takes 1–21 `{ kind, channel, is_enabled }`;
  billing email off → `422 notification_preference_locked` (show it locked). Nine new notification types (automation
  stopped, contact details left, role changed, removed, weekly summary, broadcast done, past comments done, trial
  ending, plan choice required).

### 1.9 Connecting Instagram (Meta's Unified Login)

The launch's `POST /app/social/instagram/connect` (Instagram Login) is removed. The flow is
**start (#1) → Meta → `/auth/meta/callback` → finish (#2, the picker) → pick (#3)**:

- **Start** (#1): `POST /app/social/channel-connections/meta/start` → the Meta login address (no idempotency key).
  A reconnect starts with `POST …/:channel_connection_id/reconnect` (#40). Both take an optional body
  `{ "with_page": true }` ([P358](decisions.md)): the login then uses the second configuration
  (`META_PAGE_CONFIG_ID`), which also asks for the account's linked Facebook Page and `pages_show_list` — the
  reconnect an account with `is_messages_webhook_missing` needs (ask her to pick the account **and** its Page);
  `400 instagram_page_login_not_configured` (`errors[].field` `with_page`) while that configuration is not set.
- **Finish** (#2): refusals `400 channel_connect_state_invalid` (start again), `422 provider_code_invalid`,
  `422 provider_permissions_missing`, `409 channel_connection_business_mismatch` (a reconnect from another business),
  `409 instagram_connect_restart_required`. The answer lists each assigned Instagram account as here already, in
  another organization (cannot be picked) or free.
- **Pick** (#3): over the plan's account room → `409 plan_account_limit` and nothing connects; an account live
  elsewhere is refused alone (`connected_elsewhere`), the other picks connect.
- **Connections** (#4, #42): status, granted permissions and the last daily check. **Disconnect business** (#5)
  stops every account of it and erases its token.
- **Ad picker** (#41 then #15 `?ad_account_id=&limit=&after=`): `meta.ad_access` `granted` · `missing` (reconnect
  for ads); `404 ad_account_not_found`.

### 1.10 Accounts and their Instagram parts

- **Accounts** (#6 list — the account menu, #7 one): channel, display name, status, its connection, paused /
  suspended, plan stop, new-account limit end, and the Instagram part inside (`username`, `account_type` and
  `is_private` — today always `null` and `false`, Meta's read has neither, R6; `is_webhook_subscribed`,
  `starter_questions_set_at` — empty means "starter questions not set yet", R40; `is_messages_webhook_missing` —
  direct messages happen at Instagram but none reaches us, Meta's limit for an account shared without its Facebook
  Page: show "Reconnect and share the linked Facebook Page" → #40 with `with_page: true`; it turns `false` with the
  next message, [P358](decisions.md)). No token end any more.
- **Actions**: disconnect one (#8 — keeps its automations, contacts and history; the token is erased only with the
  connection's last account), pause (#9), resume (#10), **activate** (#11, body `stop_channel_account_id` to swap one
  out at the limit; `409 channel_account_already_active`, `409 plan_account_limit`, `400 stop_channel_account_id`).
  A suspended account is shown, never resumable by the owner ([P18](decisions.md)).
- **Settings** (#12, `PATCH /app/social/instagram/accounts/:channel_account_id/settings`): the hour limits
  (`opening_hour_limit`, `opening_day_limit`, `fast_hour_limit`, `person_hour_limit`, `broadcast_hour_limit`,
  `null` = the default), `is_automatic_notice_enabled`, `extra_stop_words`, `is_comment_reply_trigger_enabled`,
  `is_once_per_person_per_post_enabled`, `is_mark_seen_after_reply_enabled`, `extra_delay_seconds_min` / `_max` (PRO,
  both or neither) and `is_automation_enabled` (now on the account). The answer adds `effective_limits` and
  `is_day_limit_enabled` (hide the day limit while it is `false`). **The five public-reply settings moved to the
  automation.**
- **Media and stories** (#13, #14): `kind` per item and one picture field falling back `media_url` → `thumbnail_url`
  → `permalink`; a Live is `live`.
- **Sending status** (#63, new): what waits in each lane, every stop with its reason and end, the estimate — what the
  account's banners need. **Usage** (#64, `GET /app/usage`, new, `organization:read`): the DM meter ("820 of 1,000
  this month"), accounts used and the notices; `being_set_up` while an account's set-up at Meta runs (R40). The 80 %
  and 100 % month notices and emails (R53) carry their numbers formatted for the reader's language ("820 of 1,000",
  R57); a move down that turns the email and phone asks off sends one billing notice "Moved to Free: email and
  phone steps are off in N automations" with `data.automations_count` ([P501](decisions.md)).
- **Webhook events** (#62): kept 8 days (was 30); `channel_account_id` filter and field; `payload` is `null` once
  done; new kinds and the `own_comment` / `flood` reasons; `next_attempt_at`.

### 1.11 Contacts, automations, broadcasts, segments

- **Contacts** (#18): `channel_account_id` required; `q` (≥ 3 characters, name, username, email or phone), filters
  `is_opted_out`, `is_automations_paused`, `came_in_via`, `first_automation_id`, tags. New: **one contact** (#19),
  **edit** (#20 — `note`, tags (≤ 50, `422 contact_tag_limit`), pause automations for her), **bulk** (#21 — one tag
  or pause on many, by ids or a filter, ≤ 100,000 — `422 contact_bulk_too_many`), **tag list with counts** (#22,
  `GET /app/contact-tags?channel_account_id=`), **What happened** (#24 — her messages, saved answers and runs, newest
  first, with `meta.message_horizon_days`), her failed messages counted (#25) and retried (#26). Delete (#23) also
  cancels her waiting messages.
- **Automations — a new shape** (#27–#35, R13; the object is routes-final § 4.A.6): status `draft` · `live` ·
  `paused` (was `active` / `inactive`); 15 ways to start (`trigger_type`, `also_start_from`), a target (`target_scope`,
  `between` with `target_starts_at` / `_ends_at`), `ref_code`, `starter_questions`, `ad_id`, `trigger_tag`; `steps`
  (hello with buttons and versions, nudge, follow / email / phone asks, a 1–10 message list in 7 kinds with waits,
  public replies with "Reply like a person", hide comment, tags) replace the launch's message columns; counters per
  version (runs, % tapped) replace `completed_run_count`; `stopped_reason`, `pro_parts_off`, `open_backfill`.
  The list (#27) needs `channel_account_id` and answers `meta.totals`.
  - **Create** (#28) saves a draft from a name and its way to start; the account goes in the body;
    `409 instagram_not_connected` for a disconnected account; `409 automation_ref_code_exists`.
  - **Edit** (#30) saves content only (no `status` field); a live or paused automation's content is checked
    (`400` with `errors[].reason` per step) and turning a PRO part on needs the plan.
  - **Actions**: go live (#32, 1.5), pause (#33, body `mode`: `keep` or `cancel` its waiting DMs;
    `409 transition_not_allowed` on a draft), duplicate (#34, a draft copy), keyword test (#35). Delete (#31): the
    reason is optional now.
  - Failed messages: count (#36) and retry (#37). Past comments: start (#38, `days` 1–7, PRO;
    `409 automation_not_live`, `422 automation_backfill_not_supported`, `409 automation_backfill_in_progress`) and
    read (#39).
- **Broadcasts** (#70–#76, PRO, new): a draft of 1–3 messages to a segment or inline conditions; send (#75) `mode`
  `now`, `scheduled` with `scheduled_at` (≤ 30 days ahead), or `when_chat_opens` with `open_wait_days` (1–7); refusals `409 broadcast_not_draft`,
  `409 broadcast_active` (cancel first), `409 transition_not_allowed`, `409 message_month_limit_reached`,
  `422 broadcast_incomplete`; numbers sent, skipped, replies, taps. An unknown or revoked account answers
  `404 instagram_not_connected` on the draft. The **"broadcast done" notice** (R53, R56) carries `sent`, `skipped`
  and `replies` in its copy and `data` ([P451](decisions.md)).
- **Segments** (#77–#82, PRO, new): conditions (≤ 2 levels, ≤ 20 conditions); the audience count (#82, saved or
  not) answers how many match and how many can get it now; listing, reading and deleting stay open on Free.

### 1.12 Files

`POST /uploads` (#140) takes the purpose `message-media`: png / jpeg ≤ 8 MB, aac / m4a / wav ≤ 25 MB, pdf ≤ 25 MB
(the ceiling is 25 MB). Confirm (#150) checks every type by its content; a fake file is refused and marked failed.
No malware scan (1.13, section 4).

### 1.13 Background rows, and what is not built

Every background row is built (R39, R41, R43–R53); none adds a route. What the frontend sees from them:

| Row | What the frontend sees |
| --- | --- |
| R39, R41 | Missed comments found after an outage are answered like any comment; a past-comments read (#38, #39) reads, counts (`found`, `matched`, `queued_count`) and ends `done` / `failed`; "my next post" links every 15 minutes |
| R43–R45 | The slow, reply, fast and broadcast lanes send; #63 shows each lane's waiting count, stops and the estimate |
| R46 | Bulk actions (#21), the background segment count (#82), the failed-message retry as a job (#26, #37 answer `is_queued: true`) and the attachment upload run as tasks |
| R47 | The 7-day expiry, closed windows, cancel-on-pause, a scheduled broadcast's start and its end |
| R48 | A Live still on, the outage and app-limit stops, the waiting estimate on #63 |
| R49, R50 | Retention as 1.10 says (webhook events 8 days, messages 30, runs 90) |
| R52, R53 | #64's grace, trial and plan notices; the month notices, owner problem emails, the weekly summary, "new contact details", "past comments done", "broadcast done" |

**Not built (owner items, [AS-BUILT.md › Owner items](../AS-BUILT.md#owner-items))** — build no screen for them yet:
the "Your DMs are safe" banner while Redis or the database has been down over a minute (AC-27.6: no #63 field), the
message-access banner ("Turn on 'Allow access to messages'": no field), and a team-paused organization's `paused`
notice (AC-12.10).

### 1.14 Removed routes

| Removed | Use instead |
| --- | --- |
| `POST /app/social/instagram/connect` | #1 → #2 → #3 (1.9), and #40 to reconnect |
| `GET` / `DELETE /app/social/instagram/account`, `PATCH …/account/settings`, `GET …/media`, `GET …/stories` | #7, #8, #12, #13, #14 by `:channel_account_id` |
| `GET` / `POST /app/social/instagram/webhook`, `POST …/deauthorize`, `POST …/data-deletion` (Meta's, no screen) | #60, #61, #16, #17 under `/app/social/channel-connections/…` |
| `POST /auth/login`, `POST /auth/password/forgot`, `/reset`, `/change` — **disabled**, `404` unless `PASSWORD_ROUTES_ENABLED` ([P251](decisions.md)) | the email code, Google, Apple, passkeys; step-up by email code (#127) |
| `GET /auth/oauth/github` (the provider) | Google or Apple |

## 2. Each design operation → its route

The design operations are the plan's ([intake-files/](../intake-files/), brief mode — no `schema-routes.md`), grouped
by the screen features of [KICKOFF.md › Features](../KICKOFF.md) (stories in [features/](features/)). `#n` is the
routes-final number. Every `/app/…` route below is team only; the account-scoped ones take the account the account
menu selected.

### 2.1 Connect Instagram (F1 — channel connection)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| "Connect Instagram" | `POST /app/social/channel-connections/meta/start` (#1) | Send the browser to the answer's Meta address |
| Meta returns to the app | `POST /app/social/channel-connections/meta/callback` (#2) | On `/auth/meta/callback` (1.6); key required; answers the picker |
| Pick accounts (up to the plan's room) | `POST /app/social/channel-connections/:channel_connection_id/accounts` (#3) | Key required; per-pick results; `409 plan_account_limit` |
| Connections list, status, last check | `GET /app/social/channel-connections` (#4), `GET …/:channel_connection_id` (#42) | `channel-account:read` |
| Reconnect | `POST …/:channel_connection_id/reconnect` (#40) | Then the same Meta round trip; asks for a missing permission |
| Disconnect business | `DELETE …/:channel_connection_id` (#5) | Stops every account of it |
| Ad picker: ad account, then ad | `GET …/:channel_connection_id/ad-accounts` (#41), `GET …/:channel_connection_id/ads` (#15) | For ad-comment and ad "Send message" automations |

### 2.2 Account menu and accounts (F2 — channel accounts)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Account menu (switch the whole app) | `GET /app/social/channel-accounts` (#6) | The chosen `cha_` id is the `channel_account_id` of every list and create |
| Account page | `GET /app/social/channel-accounts/:channel_account_id` (#7) | Status, plan stop, banners' flags |
| Pause / resume sending | `POST …/:channel_account_id/pause` (#9), `…/resume` (#10) | Repeats answer the same state |
| Disconnect one account | `DELETE …/:channel_account_id` (#8) | History stays |
| Choose the active accounts (over the plan) | `POST …/:channel_account_id/activate` (#11) | `stop_channel_account_id` swaps one out; key required |
| "Suspended by the team" | read only on #7 | No route ([P18](decisions.md)) |

### 2.3 Account settings (F3)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Open the settings | `GET /app/social/channel-accounts/:channel_account_id` (#7) | The settings sit in the account's Instagram part |
| Save limits, stop words, behaviour, extra delay | `PATCH /app/social/instagram/accounts/:channel_account_id/settings` (#12) | `expected_updated_at`; the feature check on what a save turns on (1.4) |
| Automation on / off for the account | #12 `is_automation_enabled` | Now on the account |

### 2.4 Content picker (F4)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Pick a post or reel | `GET /app/social/instagram/accounts/:channel_account_id/media` (#13) | Live from Instagram; `kind` per item |
| Pick a story | `GET …/:channel_account_id/stories` (#14) | "One story" only once Meta's test passes |
| Pick an ad | #41 → #15 | 2.1 |

### 2.5 Contacts (F5)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| List, search, filter, sort | `GET /app/contacts?channel_account_id=…` (#18) | `q` ≥ 3 characters |
| Open a contact | `GET /app/contacts/:contact_id` (#19) | Profile, details given, tags, how she came in, opted out, paused |
| Note, tags, pause for her | `PATCH /app/contacts/:contact_id` (#20) | `contact:update`; `expected_updated_at` |
| Tag / untag / pause / resume many | `POST /app/contacts/bulk-actions` (#21) | Key required; `503` until R46 (1.13) |
| Tag list with counts | `GET /app/contact-tags?channel_account_id=…` (#22) | |
| Delete a person | `DELETE /app/contacts/:contact_id` (#23) | `contact:delete`; erases her data |

### 2.6 Automations (F6)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| List with runs and % tapped | `GET /app/automations?channel_account_id=…` (#27) | `meta.totals` |
| Save a draft (name + way to start) | `POST /app/automations` (#28) | Key required; `channel_account_id` in the body |
| Open the editor | `GET /app/automations/:automation_id` (#29) | The new shape (1.11) |
| Save content | `PATCH /app/automations/:automation_id` (#30) | No `status`; checks only when live or paused |
| Go live | `POST …/:automation_id/go-live` (#32) | `409 automation_not_ready` + `errors[]`; `meta.warnings` |
| Pause, keep or cancel waiting DMs | `POST …/:automation_id/pause` (#33) | `{ mode }` |
| Duplicate | `POST …/:automation_id/duplicate` (#34) | Key required; a draft copy |
| Try a keyword | `POST …/:automation_id/keyword-test` (#35) | Saves nothing; no key |
| Delete, reason optional | `DELETE …/:automation_id` (#31) | |
| Message files | `POST /uploads` (#140) + `POST /uploads/:upload_id/confirm` (#150) | Purpose `message-media` (F15) |
| Undo toast | the opposite action | No route ([P15](decisions.md)) |

### 2.7 What happened and failed messages (F7)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| A contact's "What happened" | `GET /app/contacts/:contact_id/activity` (#24) | Messages, saved answers, runs |
| A contact's failed messages: count, retry | `GET …/:contact_id/failed-messages/summary` (#25), `POST …/retry` (#26) | Retry: `contact:update`, key required |
| An automation's failed messages: count, retry | `GET /app/automations/:automation_id/failed-messages/summary` (#36), `POST …/retry` (#37) | Retry: `automation:update`, key required |
| The account's sending banners | `GET /app/social/instagram/accounts/:channel_account_id/sending-status` (#63) | Lanes, stops, estimate |

### 2.8 Past comments (F8)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| "Also answer comments from the last N days" | `POST /app/automations/:automation_id/backfills` (#38) | PRO; live comment or ad-comment automations; key required |
| How the read goes | `GET …/backfills/:automation_backfill_id` (#39), `open_backfill` on #29 | Reads at R41 (1.13) |

### 2.9 Broadcasts and segments (F9)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Broadcast list with numbers | `GET /app/broadcasts?channel_account_id=…` (#70) | Status and mode filters |
| Write a draft | `POST /app/broadcasts` (#71), `PATCH /app/broadcasts/:broadcast_id` (#73) | PRO; 1–3 messages |
| Open one | `GET /app/broadcasts/:broadcast_id` (#72) | |
| Send now / at a time / when her chat opens | `POST …/:broadcast_id/send` (#75) | Key required; read-only plan refused |
| Cancel | `POST …/:broadcast_id/cancel` (#76) | Key required |
| Delete | `DELETE /app/broadcasts/:broadcast_id` (#74) | Not while active |
| Saved audiences | `GET /app/segments` (#77), `POST` (#78), `GET` / `PATCH` / `DELETE /app/segments/:segment_id` (#79–#81) | PRO for saves |
| "How many match, how many can get it now" | `POST /app/segments/audience-count` (#82) | Saved or not |

### 2.10 Usage and notices (F10)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| DM meter, accounts used | `GET /app/usage` (#64) | `organization:read` |
| Top-of-app notices | #64 notices, `GET /auth/me/context` (#108) `plan_access` | Dismissing is remembered by the browser ([P27](decisions.md)); month, trial, grace and plan notices (R52, R53) |
| Emails about account problems | none (sent by the backend) | Preferences: #135, #136 |

### 2.11 Plans, billing and trial (F11)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Compare plans | `GET /billing/plans` (#100), `GET /billing/plans/:plan_id` (#101) | Public |
| Start the 7-day trial / subscribe | `POST /billing/subscriptions` (#102) | `is_trial`; also the way back from a local Free row ([P502](decisions.md)) |
| Move up / down, keep accounts | `POST /billing/subscriptions/:subscription_id/change-plan` (#103) | `keep_channel_account_ids` on a move down; `422 subscription_required` from a local Free row to a paid plan — use #102 ([P503](decisions.md)) |
| Cards: list, remove, make default | `GET /billing/payment-methods` (#104), `DELETE …/:payment_method_id` (#105), `POST …/:payment_method_id/default` (#106) | |
| Plan state everywhere | `GET /auth/me/context` (#108) | `plan_access` (1.4) |

### 2.12 Roles and organization (F12)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Create an organization by its name | `POST /tenancy/organizations` (#141) | Slug optional |
| Organization name and tile colour | `GET /tenancy/organization` (#142), `PATCH` (#110) | Slug read only |
| Members with counts per role | `GET /tenancy/organization/memberships` (#116) | `meta.counts_by_role` |
| Invite up to 20 emails with one role | `POST /tenancy/organization/memberships` (#117) | One line per address |
| Invitation page | `POST /tenancy/membership-invitations/:membership_invitation_id/preview` (#118) | Public; then accept / decline as before |
| The four fixed roles | `GET /tenancy/organization/roles` (existing) | Role writes #111–#115 answer `403 custom_roles_off` |

### 2.13 Sign-in and security (F13)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Email code | `POST /auth/email/send-code` (#120), `POST /auth/email/login` (#121) | Digits; reasons and tries left |
| Google / Apple | `GET /auth/oauth/providers` (#122), `GET /auth/oauth/:provider` (#123), `GET /auth/oauth/:provider/callback` (#143) | Apple through `/callback/apple` (1.6) |
| Passkey | existing WebAuthn routes | Unchanged |
| 2FA with "Trust this device" | `POST /auth/mfa/login` (#126) | `trust_device` |
| Step-up by email code | `POST /auth/step-up` (#127) | |
| Sessions with their place | `GET /auth/me/sessions` (#128), `DELETE /auth/me/sessions` (#144), `DELETE …/:session_id` (#146) | DB-IP credit (1.7) |
| Remove a sign-in way / passkey / 2FA | #125, #147, #145 | The email-code way stays |
| Connect Google or Apple in Settings | #123 `?intent=link` | After a step-up |

### 2.14 Profile, settings and notifications (F14)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| Onboarding: Instagram handle and goal | `PATCH /users/me` (#130), `GET /users/me` (#148) | |
| Reduce motion, default organization | `PATCH /users/me/settings` (#131), `GET` (#149) | |
| Organization chooser | `GET /users/me/organizations` (#132) | Team organizations only |
| Confirm your email | `POST /users/me/email-confirmation` (#133), `POST /auth/email/confirm` (#134) | `/confirm-email` page (1.6) |
| Notifications per kind and channel | `GET` / `PUT /users/me/notification-preferences` (#135, #136) | |

### 2.15 Webhook events (F16)

| Design operation | Route(s) today | Notes |
| --- | --- | --- |
| The account's webhook debugging list | `GET /app/social/instagram/webhook-events` (#62) | `instagram-webhook-event:read`; 8 days |

### 2.16 Called by Meta (no screen)

`GET` / `POST /app/social/channel-connections/meta/webhooks/instagram` (#60, #61),
`POST /app/social/channel-connections/meta/deauthorize` (#16) and `…/data-deletion` (#17). Stripe calls
`POST /billing/webhook` (#107).

**Reading section 3.** `#` is `<section>.<route>` of the route review; blank where the review names no route (the
launch's unchanged routes, and the four disabled password routes of 1.7).

## 3. Every available route

<!-- GENERATED:START -->

203 routes, from `docs/routes.txt`.
Paths drop `/api/v1`; the health and operations routes in the last module sit outside it.
**Gate**: a permission code, `signed in`, `public`, `platform admin` or a token. **Idem** `req`:
`X-Idempotency-Key` required. **Team** `team`: team organizations only (`422` on a personal one).
**#**: the route review number (blank where the review does not name the route). Success is `200`,
or `204` for a `DELETE`. **What it does** is the OpenAPI summary.

| Module | Routes |
| --- | --- |
| [App (the product)](#app-the-product) | 60 |
| [Session and account](#session-and-account) | 52 |
| [Organization and team](#organization-and-team) | 44 |
| [Files](#files) | 4 |
| [Notifications and webhooks](#notifications-and-webhooks) | 14 |
| [Subscription billing (the platform)](#subscription-billing-the-platform) | 15 |
| [Platform administration and operations](#platform-administration-and-operations) | 14 |

### App (the product)

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/app/automations` | `automation:read` |  | team | 4.27 | List automations |
| POST | `/app/automations` | `automation:create` | req | team | 4.28 | Save an automation draft |
| GET | `/app/automations/:automation_id` | `automation:read` |  | team | 4.29 | Get an automation |
| PATCH | `/app/automations/:automation_id` | `automation:update` |  | team | 4.30 | Save automation content |
| DELETE | `/app/automations/:automation_id` | `automation:delete` |  | team | 4.31 | Delete an automation |
| POST | `/app/automations/:automation_id/backfills` | `automation:update` | req | team | 4.38 | Answer past comments |
| GET | `/app/automations/:automation_id/backfills/:automation_backfill_id` | `automation:read` |  | team | 4.39 | Get a past-comments read |
| POST | `/app/automations/:automation_id/duplicate` | `automation:create` | req | team | 4.34 | Duplicate an automation |
| POST | `/app/automations/:automation_id/failed-messages/retry` | `automation:update` | req | team | 4.37 | Retry an automation's failed messages |
| GET | `/app/automations/:automation_id/failed-messages/summary` | `automation:read` |  | team | 4.36 | Count an automation's failed messages |
| POST | `/app/automations/:automation_id/go-live` | `automation:update` |  | team | 4.32 | Go live |
| POST | `/app/automations/:automation_id/keyword-test` | `automation:read` |  | team | 4.35 | Try an automation keyword |
| POST | `/app/automations/:automation_id/pause` | `automation:update` |  | team | 4.33 | Pause an automation |
| GET | `/app/broadcasts` | `automation:read` |  | team | 7.70 | List broadcasts |
| POST | `/app/broadcasts` | `automation:create` | req | team | 7.71 | Create a broadcast draft |
| GET | `/app/broadcasts/:broadcast_id` | `automation:read` |  | team | 7.72 | Get a broadcast |
| PATCH | `/app/broadcasts/:broadcast_id` | `automation:update` |  | team | 7.73 | Update a broadcast draft |
| DELETE | `/app/broadcasts/:broadcast_id` | `automation:delete` |  | team | 7.74 | Delete a broadcast |
| POST | `/app/broadcasts/:broadcast_id/cancel` | `automation:update` | req | team | 7.76 | Cancel a broadcast |
| POST | `/app/broadcasts/:broadcast_id/send` | `automation:update` | req | team | 7.75 | Send a broadcast |
| GET | `/app/contact-tags` | `contact:read` |  | team | 3.22 | List contact tags |
| GET | `/app/contacts` | `contact:read` |  | team | 3.18 | List contacts |
| GET | `/app/contacts/:contact_id` | `contact:read` |  | team | 3.19 | Get a contact |
| PATCH | `/app/contacts/:contact_id` | `contact:update` |  | team | 3.20 | Update a contact |
| DELETE | `/app/contacts/:contact_id` | `contact:delete` |  | team | 3.23 | Delete a contact |
| GET | `/app/contacts/:contact_id/activity` | `contact:read` |  | team | 3.24 | List a contact's activity |
| POST | `/app/contacts/:contact_id/failed-messages/retry` | `contact:update` | req | team | 3.26 | Retry a contact's failed messages |
| GET | `/app/contacts/:contact_id/failed-messages/summary` | `contact:read` |  | team | 3.25 | Count a contact's failed messages |
| POST | `/app/contacts/bulk-actions` | `contact:update` | req | team | 3.21 | Run a bulk action on contacts |
| GET | `/app/segments` | `automation:read` |  | team | 7.77 | List segments |
| POST | `/app/segments` | `automation:create` | req | team | 7.78 | Create a segment |
| GET | `/app/segments/:segment_id` | `automation:read` |  | team | 7.79 | Get a segment |
| PATCH | `/app/segments/:segment_id` | `automation:update` |  | team | 7.80 | Update a segment |
| DELETE | `/app/segments/:segment_id` | `automation:delete` |  | team | 7.81 | Delete a segment |
| POST | `/app/segments/audience-count` | `automation:read` | req | team | 7.82 | Count a segment audience |
| GET | `/app/social/channel-accounts` | `channel-account:read` |  | team | 1.6 | List channel accounts |
| GET | `/app/social/channel-accounts/:channel_account_id` | `channel-account:read` |  | team | 1.7 | Get a channel account |
| DELETE | `/app/social/channel-accounts/:channel_account_id` | `channel-account:manage` |  | team | 1.8 | Disconnect a channel account |
| POST | `/app/social/channel-accounts/:channel_account_id/activate` | `channel-account:manage` | req | team | 1.11 | Choose an active channel account |
| POST | `/app/social/channel-accounts/:channel_account_id/pause` | `channel-account:manage` |  | team | 1.9 | Pause a channel account |
| POST | `/app/social/channel-accounts/:channel_account_id/resume` | `channel-account:manage` |  | team | 1.10 | Resume a channel account |
| GET | `/app/social/channel-connections` | `channel-account:read` |  | team | 1.4 | List channel connections |
| GET | `/app/social/channel-connections/:channel_connection_id` | `channel-account:read` |  | team | 1.42 | Get a channel connection |
| DELETE | `/app/social/channel-connections/:channel_connection_id` | `channel-account:manage` |  | team | 1.5 | Disconnect a business |
| POST | `/app/social/channel-connections/:channel_connection_id/accounts` | `channel-account:manage` | req | team | 1.3 | Connect picked channel accounts |
| GET | `/app/social/channel-connections/:channel_connection_id/ad-accounts` | `channel-account:read` |  | team | 1.41 | List a channel connection's ad accounts |
| GET | `/app/social/channel-connections/:channel_connection_id/ads` | `channel-account:read` |  | team | 1.15 | List one ad account's ads |
| POST | `/app/social/channel-connections/:channel_connection_id/reconnect` | `channel-account:manage` |  | team | 1.40 | Start a reconnect of a channel connection |
| POST | `/app/social/channel-connections/:provider/callback` | `channel-account:manage` | req | team | 1.2 | Finish a channel connection |
| POST | `/app/social/channel-connections/:provider/data-deletion` | public |  |  | 1.17 | Meta: delete the person's data (data deletion) |
| POST | `/app/social/channel-connections/:provider/deauthorize` | public |  |  | 1.16 | Meta: the app was removed (deauthorize) |
| POST | `/app/social/channel-connections/:provider/start` | `channel-account:manage` |  | team | 1.1 | Start a channel connection |
| GET | `/app/social/channel-connections/meta/webhooks/instagram` | public |  |  | 5.60 | Verify the Instagram webhook subscription |
| POST | `/app/social/channel-connections/meta/webhooks/instagram` | public |  |  | 5.61 | Receive an Instagram webhook delivery |
| GET | `/app/social/instagram/accounts/:channel_account_id/media` | `instagram-account:read` |  | team | 2.13 | List Instagram posts and reels |
| GET | `/app/social/instagram/accounts/:channel_account_id/sending-status` | `instagram-account:read` |  | team | 6.63 | Get an Instagram account sending status |
| PATCH | `/app/social/instagram/accounts/:channel_account_id/settings` | `instagram-account:manage` |  | team | 2.12 | Change an Instagram account settings |
| GET | `/app/social/instagram/accounts/:channel_account_id/stories` | `instagram-account:read` |  | team | 2.14 | List live Instagram stories |
| GET | `/app/social/instagram/webhook-events` | `instagram-webhook-event:read` |  | team | 5.62 | List received Instagram webhook events |
| GET | `/app/usage` | `organization:read` |  | team | 6.64 | Get the organization usage |

### Session and account

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/auth/email/confirm` | public |  |  | 11.134 | Confirm the email with the emailed link |
| POST | `/auth/email/login` | public |  |  | 10.121 | Log in with an email verification code |
| POST | `/auth/email/send-code` | public |  |  | 10.120 | Send email sign-in code |
| POST | `/auth/login` | public |  |  |  | Login with email and password |
| POST | `/auth/logout` | token (access-token) |  |  |  | Logout current session |
| GET | `/auth/me/auth-methods` | signed in |  |  |  | List my auth methods |
| POST | `/auth/me/auth-methods` | signed in |  |  |  | Add auth method |
| DELETE | `/auth/me/auth-methods/:auth_method_id` | signed in |  |  | 10.125 | Remove auth method |
| GET | `/auth/me/context` | signed in |  |  | 8.108 | Get my session context |
| GET | `/auth/me/mfa` | signed in |  |  |  | List enrolled MFA methods |
| DELETE | `/auth/me/mfa/:mfa_method_id` | signed in |  |  | 10.145 | Remove MFA method |
| POST | `/auth/me/mfa/enroll` | signed in |  |  |  | Begin MFA enrollment (phase 1 of 2) |
| POST | `/auth/me/mfa/enroll/confirm` | signed in |  |  |  | Confirm MFA enrollment (phase 2 of 2) |
| POST | `/auth/me/mfa/verify` | signed in |  |  |  | Verify MFA code |
| GET | `/auth/me/sessions` | signed in |  |  | 10.128 | List my active sessions |
| DELETE | `/auth/me/sessions` | signed in |  |  | 10.144 | Revoke all sessions |
| DELETE | `/auth/me/sessions/:session_id` | signed in |  |  | 10.146 | Revoke a specific session |
| GET | `/auth/me/webauthn/credentials` | signed in |  |  |  | List registered passkeys |
| DELETE | `/auth/me/webauthn/credentials/:credential_id` | signed in |  |  | 10.147 | Revoke a passkey |
| POST | `/auth/me/webauthn/register/options` | signed in |  |  |  | Begin passkey registration |
| POST | `/auth/me/webauthn/register/verify` | signed in |  |  |  | Complete passkey registration |
| POST | `/auth/mfa/login` | public |  |  | 10.126 | Complete MFA during login |
| GET | `/auth/oauth/:provider` | public |  |  | 10.123 | Initiate OAuth flow |
| GET | `/auth/oauth/:provider/callback` | public |  |  | 10.143 | OAuth callback |
| POST | `/auth/oauth/apple/callback` | public |  |  | 10.124 | Apple's sign-in form callback |
| GET | `/auth/oauth/providers` | public |  |  | 10.122 | List available OAuth providers |
| POST | `/auth/password/change` | signed in |  |  |  | Change current password |
| POST | `/auth/password/forgot` | public |  |  |  | Request password reset |
| POST | `/auth/password/reset` | public |  |  |  | Reset password with token |
| POST | `/auth/refresh` | token (session-cookie) |  |  |  | Refresh access token |
| POST | `/auth/step-up` | signed in |  |  | 10.127 | Step-up (re-authenticate) |
| POST | `/auth/switch-to-organization` | signed in |  |  |  | Switch active organization |
| POST | `/auth/switch-to-personal` | signed in |  |  |  | Switch to personal organization |
| POST | `/auth/webauthn/authenticate/options` | public |  |  |  | Begin passkey authentication |
| POST | `/auth/webauthn/authenticate/verify` | public |  |  |  | Complete passkey authentication |
| GET | `/users/me` | signed in |  |  | 11.148 | Get current user profile |
| PATCH | `/users/me` | signed in |  |  | 11.130 | Update current user profile |
| DELETE | `/users/me` | signed in |  |  |  | Delete my account |
| PUT | `/users/me/avatar` | signed in |  |  |  | Upload avatar |
| DELETE | `/users/me/avatar` | signed in |  |  |  | Remove avatar |
| POST | `/users/me/bug-reports` | signed in |  |  |  | Report a bug |
| POST | `/users/me/data-export` | signed in |  |  |  | Request GDPR data export |
| GET | `/users/me/data-export/:data_export_id` | signed in |  |  |  | Get GDPR data export status |
| POST | `/users/me/email-confirmation` | signed in |  |  | 11.133 | Email me a confirm link |
| GET | `/users/me/membership-invitations` | signed in |  |  |  | List my invitations |
| GET | `/users/me/notification-preferences` | signed in |  |  | 11.135 | Get my notification preferences |
| PUT | `/users/me/notification-preferences` | signed in |  |  | 11.136 | Save notification preferences |
| POST | `/users/me/onboarding/complete` | signed in |  |  |  | Mark onboarding complete |
| GET | `/users/me/organizations` | signed in |  |  | 11.132 | List my organizations |
| PUT | `/users/me/presence` | signed in |  |  |  | Set my presence |
| GET | `/users/me/settings` | signed in |  |  | 11.149 | Get my settings |
| PATCH | `/users/me/settings` | signed in |  |  | 11.131 | Update my settings |

### Organization and team

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/accept` | signed in | req |  |  | Accept invitation |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/decline` | signed in | req |  |  | Decline invitation |
| POST | `/tenancy/membership-invitations/:membership_invitation_id/preview` | public |  |  | 9.118 | Preview invitation |
| GET | `/tenancy/organization` | signed in |  |  | 9.142 | Get active organization |
| PATCH | `/tenancy/organization` | `organization:update` |  |  | 9.110 | Update organization |
| DELETE | `/tenancy/organization` | `organization:delete` |  | team |  | Delete organization |
| GET | `/tenancy/organization/api-keys` | `api-key:read` |  |  |  | List API keys |
| POST | `/tenancy/organization/api-keys` | `api-key:manage` | req |  |  | Create API key |
| GET | `/tenancy/organization/api-keys/:api_key_id` | `api-key:read` |  |  |  | Get API key |
| PATCH | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Update API key |
| DELETE | `/tenancy/organization/api-keys/:api_key_id` | `api-key:manage` |  |  |  | Delete API key |
| POST | `/tenancy/organization/api-keys/:api_key_id/rotate` | `api-key:manage` |  |  |  | Rotate API key |
| GET | `/tenancy/organization/audit-logs` | `audit-log:read` |  |  |  | List organization audit logs |
| POST | `/tenancy/organization/leave` | signed in |  |  |  | Leave organization |
| PUT | `/tenancy/organization/logo` | `organization:update` |  |  |  | Upload organization logo |
| DELETE | `/tenancy/organization/logo` | `organization:update` |  |  |  | Remove organization logo |
| GET | `/tenancy/organization/memberships` | `membership:read` |  |  | 9.116 | List memberships |
| POST | `/tenancy/organization/memberships` | `membership:create` | req | team | 9.117 | Invite members by email |
| GET | `/tenancy/organization/memberships/:membership_id` | `membership:read` |  |  |  | Get membership |
| PATCH | `/tenancy/organization/memberships/:membership_id` | `membership:update` |  |  |  | Update membership |
| DELETE | `/tenancy/organization/memberships/:membership_id` | `membership:delete` |  |  |  | Remove membership |
| DELETE | `/tenancy/organization/memberships/:membership_id/invitation` | `membership:delete` |  |  |  | Revoke invitation |
| POST | `/tenancy/organization/memberships/:membership_id/invitation/resend` | `membership:update` | req |  |  | Resend invitation |
| GET | `/tenancy/organization/memberships/:membership_id/permissions` | `membership:read` |  |  |  | Get membership permissions |
| POST | `/tenancy/organization/memberships/:membership_id/restore` | `membership:delete` | req | team |  | Restore membership |
| GET | `/tenancy/organization/notification-policies` | `notification-policy:read` |  |  |  | List notification policies |
| POST | `/tenancy/organization/notification-policies` | `notification-policy:manage` | req |  |  | Create notification policy |
| GET | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:read` |  |  |  | Get notification policy |
| PATCH | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Update notification policy |
| DELETE | `/tenancy/organization/notification-policies/:notification_policy_id` | `notification-policy:manage` |  |  |  | Delete notification policy |
| GET | `/tenancy/organization/roles` | `role:read` |  |  |  | List roles |
| POST | `/tenancy/organization/roles` | `role:create` | req | team | 9.111 | Create role |
| GET | `/tenancy/organization/roles/:role_id` | `role:read` |  |  |  | Get role |
| PATCH | `/tenancy/organization/roles/:role_id` | `role:update` |  |  | 9.112 | Update role |
| DELETE | `/tenancy/organization/roles/:role_id` | `role:delete` |  |  | 9.113 | Delete role |
| GET | `/tenancy/organization/roles/:role_id/permissions` | `role:read` |  |  |  | List role permissions |
| PUT | `/tenancy/organization/roles/:role_id/permissions` | `role:update` |  |  | 9.114 | Replace role permissions |
| POST | `/tenancy/organization/roles/:role_id/restore` | `role:delete` | req |  | 9.115 | Restore role |
| GET | `/tenancy/organization/settings` | `organization:read` |  |  |  | Get organization settings |
| PATCH | `/tenancy/organization/settings` | `organization:update` |  |  |  | Update organization settings |
| POST | `/tenancy/organization/transfer-ownership` | signed in | req | team |  | Transfer organization ownership |
| POST | `/tenancy/organizations` | signed in | req |  | 9.141 | Create organization |
| GET | `/tenancy/organizations/by-slug/:slug` | signed in |  |  |  | Get organization by slug |
| GET | `/tenancy/permissions` | signed in |  |  |  | List all permissions |

### Files

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/uploads` | signed in | req |  | 12.140 | Request pre-signed upload URL |
| GET | `/uploads/:upload_id` | signed in |  |  |  | Get upload metadata |
| DELETE | `/uploads/:upload_id` | signed in |  |  |  | Delete upload |
| POST | `/uploads/:upload_id/confirm` | signed in |  |  | 12.150 | Confirm uploaded object |

### Notifications and webhooks

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/notify/notifications` | signed in |  |  |  | List my notifications |
| GET | `/notify/notifications/:notification_id` | signed in |  |  |  | Get notification |
| DELETE | `/notify/notifications/:notification_id` | signed in |  |  |  | Delete notification |
| PATCH | `/notify/notifications/:notification_id/read` | signed in |  |  |  | Mark notification as read |
| POST | `/notify/notifications/mark-all-read` | signed in |  |  |  | Mark all notifications as read |
| GET | `/notify/notifications/unread-count` | signed in |  |  |  | Get unread notification count |
| GET | `/notify/webhook-events` | `webhook:read` |  |  |  | List dispatchable webhook event types |
| GET | `/notify/webhooks` | `webhook:read` |  |  |  | List webhooks |
| POST | `/notify/webhooks` | `webhook:manage` | req |  |  | Create webhook |
| GET | `/notify/webhooks/:webhook_id` | `webhook:read` |  |  |  | Get webhook |
| PATCH | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Update webhook |
| DELETE | `/notify/webhooks/:webhook_id` | `webhook:manage` |  |  |  | Delete webhook |
| GET | `/notify/webhooks/:webhook_id/delivery-attempts` | `webhook:read` |  |  |  | List webhook delivery attempts |
| POST | `/notify/webhooks/:webhook_id/test` | `webhook:manage` |  |  |  | Send test webhook |

### Subscription billing (the platform)

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/billing/invoices` | `subscription:read` |  |  |  | List billing invoices |
| GET | `/billing/payment-methods` | `subscription:read` |  |  | 8.104 | List payment methods |
| DELETE | `/billing/payment-methods/:payment_method_id` | `subscription:manage` |  | team | 8.105 | Remove payment method |
| POST | `/billing/payment-methods/:payment_method_id/default` | `subscription:manage` | req | team | 8.106 | Set default payment method |
| POST | `/billing/payment-methods/setup` | `subscription:manage` | req | team |  | Create payment method setup |
| GET | `/billing/plans` | public |  |  | 8.100 | List available plans |
| GET | `/billing/plans/:plan_id` | public |  |  | 8.101 | Get plan details |
| GET | `/billing/subscriptions` | `subscription:read` |  |  |  | List subscriptions |
| POST | `/billing/subscriptions` | `subscription:manage` | req | team | 8.102 | Create subscription |
| GET | `/billing/subscriptions/:subscription_id` | `subscription:read` |  |  |  | Get subscription |
| POST | `/billing/subscriptions/:subscription_id/cancel` | `subscription:manage` | req | team |  | Cancel subscription |
| POST | `/billing/subscriptions/:subscription_id/change-plan` | `subscription:manage` | req | team | 8.103 | Change subscription plan |
| GET | `/billing/subscriptions/:subscription_id/payment-setup` | `subscription:read` |  |  |  | Get payment setup for incomplete subscription |
| POST | `/billing/subscriptions/:subscription_id/resume` | `subscription:manage` | req | team |  | Resume cancelled subscription |
| POST | `/billing/webhook` | public |  |  | 8.107 | Stripe webhook receiver |

### Platform administration and operations

| Method | Path | Gate | Idem | Team | # | What it does |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/audit/logs` | platform admin |  |  |  | List audit logs (admin) |
| GET | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (GET) |
| POST | `/mcp` | platform admin |  |  |  | MCP streamable HTTP (POST) |
| GET | `/users` | platform admin |  |  |  | List all users (admin) |
| GET | `/users/:user_id` | platform admin |  |  |  | Get user by ID (admin) |
| PATCH | `/users/:user_id` | platform admin |  |  |  | Update user (admin) |
| DELETE | `/users/:user_id` | platform admin |  |  |  | Delete user (admin) |
| POST | `/users/:user_id/suspend` | platform admin |  |  |  | Suspend user (admin) |
| POST | `/users/:user_id/unsuspend` | platform admin |  |  |  | Unsuspend user (admin) |
| GET | `/internal/ops/circuit-breakers` | token (metrics) |  |  |  | List the outbound circuit breakers (operations only) |
| POST | `/internal/ops/circuit-breakers/:circuit_name/reset` | token (ops-admin) |  |  |  | Reset one circuit breaker (operations only) |
| GET | `/livez` | public |  |  |  | Liveness probe |
| GET | `/readyz` | public |  |  |  | Readiness probe |
| GET | `/metrics` | token (metrics) |  |  |  | Prometheus metrics (operations only) |

<!-- GENERATED:END -->

## 4. In the design, dropped — remove from the frontend

### 4.1 In the design, not served

| # | Design feature | Where in the design | Decision | In the frontend |
| --- | --- | --- | --- | --- |
| 1 | Referral program (invite friends, credit) | plan §48, D53 | Out of scope ([P39](decisions.md)) | Build no referral screen or link |
| 2 | Malware scan of message files ("scanning…") | plan D58 | Type and content checks only, the scan later ([P34](decisions.md)) | No scan state; a file is usable once confirmed (#150) |
| 3 | Undo after an action | toast, plan:L2582 | No route ([P15](decisions.md)) | The toast replays the opposite action |
| 4 | Dismiss a notice for everyone | plan:L2582, L2584 | No route ([P27](decisions.md)) | Remember the dismissal in the browser |
| 5 | Live screen updates | the screens | No realtime requirement | Load again after a write or on refresh |
| 6 | Team "suspend account" action | account page | Column only, the route later ([P18](decisions.md)) | Show "suspended"; no button |
| 7 | A connection's other assets (ad accounts, catalogs, Pages without Instagram) | connection page | With its first feature ([P52](decisions.md)) | List only the Instagram accounts and, in the ad picker, the ad accounts (#41) |
| 8 | Booking, link tracking, AI FAQ, same-meaning keywords, forms, integrations, ads sync, Facebook / Messenger | `Instagram-DM-Later-Features-v8.md` (D47, D70) | Later | Build none of them |
| 9 | Instagram account type and private flag | account card | Meta's profile read has neither (R6) | `account_type` is `null`, `is_private` `false` — hide them |
| 10 | The day limit | settings | Off while `DAY_LIMIT_ENABLED` is off (R7) | Show it only when `is_day_limit_enabled` |
| 11 | Meta-gated features (each until its §43 test passes) | automations, settings | `feature_not_offered` ([P36](decisions.md)) | Grey them out on that reason |
| 12 | "Seen" after a reply | settings (`is_mark_seen_after_reply_enabled`) | Saved, but nothing is sent until its Meta test ([P36](decisions.md), [P412](decisions.md)) | Show the switch as "coming soon" |
| 13 | "Your DMs are safe" banner (Redis or the database down over a minute) | sending status | Not built — owner item ([P452](decisions.md)) | No banner |
| 14 | Message-access banner ("Turn on 'Allow access to messages'") | account page | Not built — no field (owner item, [P409](decisions.md)) | No banner |

### 4.2 Gone from the API — remove the existing screens

| # | Feature in the current frontend | Decision | In the frontend |
| --- | --- | --- | --- |
| 1 | Password sign-in, forgot, reset and change password | Off: removed from the product ([P84](decisions.md), R30), the routes kept disabled behind `PASSWORD_ROUTES_ENABLED` ([P251](decisions.md)) | Remove the forms; step-up by email code |
| 2 | GitHub sign-in | Removed (R31) | Remove the button |
| 3 | Instagram Login connect and the one-account pages | Removed (RC-6, [P1](decisions.md)) | Use the Meta flow and the account menu (2.1, 2.2) |
| 4 | Custom roles editor | Switched off (TN3, R28) | Hide create / edit / delete / restore role and the code editor; show the four roles |
| 5 | Invite staff fields, one email per invite | Replaced (R29) | The 1–20 email form with one role |
| 6 | Editing the slug | Read only (R27) | Show the slug, never an input |
| 7 | The launch automation form (`active` / `inactive`, opening message, follow, email, phone, one final DM) and the account-level public-reply settings | Replaced (R13, R7) | The step editor; public replies per automation |
| 8 | The personal organization in the chooser and as the default | Hidden / refused (R34) | Offer team organizations only |
