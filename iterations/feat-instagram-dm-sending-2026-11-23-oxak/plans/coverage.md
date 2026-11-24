# Coverage — feat-instagram-dm-sending-2026-11-23-oxak

Mode **initial** (Baseline `none`, Intake mode `brief`, from scratch) · Intake hash `e2875698ea64` · 2026-11-23.
Sources: `intake-files/BRIEF.md` (the cover), `intake-files/Instagram-DM-Sending-Plan-v8.md` (`plan:L…`, the
full truth) and `intake-files/DM-System-Simple-Guide-v8.md` (`guide:L…`, its short version — "if they ever
disagree, the plan wins", guide:3). Questions `Qn` / defaults `An`: the Step 4 batch, answered in `decisions.md` (P1–P20 defaults, P26–P39 answers); the owner's channel split is P40–P47 (P47 its derived defaults) — rows whose requirement moves cite it, and **Channel split** below lists what it adds; the room for WhatsApp and TikTok is P48–P51 (P48 supersedes P44) — **Room for WhatsApp and TikTok** below lists what it adds; the owner's route-review answers are P54–P90 — **Route review answers** below lists them, and the rows they touch cite them; the scale review's fixes and defaults and the alignment check's settlement are P91–P99 — **Scale review and alignment** below lists them. The plan's "workspace" is written "organization" (P72).

Status: `covered` (a requirement reaches it) · `open` (waits for a RED answer) · `out-of-scope` (with its reason).
Requirement identifiers are proposals until Step 6 writes `plans/requirements/`.

## Coverage

### Part A — decisions and system

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L212 | D1 build in `app`, migrations in place | `data.app-migrations-in-place` | all | BRIEF AC-10 | covered — P29 |
| plan:L213 | D2 Neon, pooler link, direct link for migrations | `quality.database-links` | engine | — | covered |
| plan:L214–215 | D3–D4 queues and the four lanes | `background.sending-lanes` | sending-engine | BRIEF AC-4 | covered (queues and lanes stay Instagram's — P43, P45) |
| plan:L216–222 | D5–D11 opening / fast limits, timing, pick order, 24 h, 7 days, estimate | `operations.instagram-send-limits`, `background.opening-turn`, `background.fast-messages` | sending-engine | BRIEF AC-4 | covered |
| plan:L223–228 | D12–D17 follow check, once rule, public replies, events / history kept, unknown result | `operations.automation-follow-check`, `operations.automation-once-rule`, `quality.retention`, `operations.automation-unknown-outcome` | automations, sending-engine | BRIEF AC-5, AC-8 | covered (D13/D16/D17 flagged as risk) |
| plan:L229 | D18 two gates + month count in the send commit | `background.send-gates` | sending-engine | BRIEF AC-6 | covered |
| plan:L230 | D19 Instagram errors per lane | `background.instagram-error-stops` | sending-engine | BRIEF AC-4 | covered |
| plan:L231 | D20 a restore or copy never sends | `quality.restore-never-sends` | sending-engine | BRIEF AC-9 | covered |
| plan:L232–233 | D21–D22 rolling deploy, settings file | `quality.sending-settings` | sending-engine | — | covered (A4) |
| plan:L235–238 | D24–D27 Unified Login, connect, many accounts, `channel` | `integrations.channel-connection-unified-login`, `operations.channel-account-connect-multi`, `billing.plan-channel-accounts-max` | channel-connection, channel-account | BRIEF AC-2 | covered (A1; D24 risk; common connection and account — P41, P42; feature `channel_accounts_max` — P47) |
| plan:L239–256 | D28–D45 automation status, messages, hello, follow / email / phone, public replies, hide, month DMs, plan states, counters, 15 ways to start, also-start-from, targeting, Live, ads, starters, ref links, tags | `operations.automation-*` (see Part B rows) | automations | BRIEF AC-3, AC-7 | covered (ads / Live / repost: built, go-live gated — P36) |
| plan:L257 | D46 contacts | `operations.contact-*` | contacts | — | covered |
| plan:L258, L281 | D47, D70 later features | — | — | — | out-of-scope — the later-features file (BRIEF Out of scope) |
| plan:L259 | D48 Part F in merged domains, new migrations only | `data.merged-domains-forward-only` | product-around-sending | BRIEF AC-10 | covered — P28, P38 |
| plan:L260–263 | D49–D52 stop word, messages kept, contacts kept, reply lines | `operations.contact-stop-words`, `quality.retention` | contacts, automations | BRIEF AC-8 | covered |
| plan:L264 | D53 referral payout $50 | `billing.referral-payout` | product-around-sending | — | out-of-scope — P39 |
| plan:L265 | D54 email defaults | `notifications.owner-email-defaults` | notices | — | covered (Part F parts: P28) |
| plan:L266 | D55 unlimited members, Editor / Viewer | `access.editor-viewer-roles` | product-around-sending | — | covered — P28 |
| plan:L267 | D56 trusted device | `access.trusted-device` | product-around-sending | — | covered — P28 |
| plan:L268 | D57 moving down a plan | `billing.plan-downgrade` | plans-and-limits | BRIEF AC-7 | covered |
| plan:L269 | D58 file scan | `files.message-file-scan` | message-files | — | out-of-scope — P34 (D58 deviation: type and magic-byte checks only, scan later) |
| plan:L270–276 | D59–D65 reply default, close spellings, % tapped, month limit, `@username`, comment replies, once per post | `operations.automation-*`, `operations.instagram-account-settings-v8` | automations, account-settings | — | covered (D65's open run: P35) |
| plan:L277–278 | D66–D67 mark as seen, extra delay | `operations.instagram-mark-seen`, `operations.instagram-extra-delay` | account-settings | — | covered (mark seen: go-live gated — P36) |
| plan:L279 | D68 broadcasts | `operations.broadcast`, `operations.segment` | broadcasts | — | covered |
| plan:L280 | D69 past comments | `operations.automation-past-comments` | past-comments | — | covered |
| plan:L282–283 | D71–D72 pause one person, retry failed | `operations.contact-pause-automations`, `operations.instagram-message-retry-failed` | contacts, automations | — | covered |
| plan:L284 | D73 7-day free trial | `billing.paid-trial` | plans-and-limits | — | covered — P28 |
| plan:L290–305 | version-7 rules (size, limits per account, types, two automations one post, ask once, pause, half speed, owner sees, worker never waits, Redis, missed comments, places, review fixes) | `background.*`, `quality.*` | sending-engine | — | covered (no Redis buffer: P32) |
| plan:L416–444 | §3.1 where it lives, migration rule | `data.*` | all | — | covered — P29, P38 |

### Channel split (P40–P47)

The owner's split of common and Instagram-specific tables, routes and background work (`decisions.md`
P40–P47, 2026-11-23). Each row is what the split adds or moves; the rows above that it touches cite it too.

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| decisions.md P40 | common core + Instagram adapters, the line drawn by P41–P46 | `data.channel-common-core` | all | — | covered — P40 |
| decisions.md P41 | common connections (`app.channel_connections`, `app.channel_connection_tokens`, provider `meta`); one Unified Login for Instagram, Facebook and ads; ad accounts and ads read through the connection | `integrations.channel-connection-unified-login`, `operations.channel-connection-ad-picker` | channel-connection | BRIEF AC-2 | covered — P41 (db-changes Stage 1; route-changes RC-1–RC-5, RC-15, RC-112–RC-114) |
| decisions.md P42 | common connected accounts (`app.channel_accounts`: channel, connection, status, display name, pause, suspend, plan stop, automation switch); `app.instagram_accounts` the 1:1 Instagram extension | `operations.channel-account`, `data.instagram-account-extension` | channel-account | — | covered — P42 (db-changes Stage 1; route-changes RC-7–RC-11, RC-60) |
| decisions.md P43 | sending tables Instagram's (`instagram_send_*`, `instagram_messages`, `instagram_attachments`); `app.message_month_counts` and `app.sending_states` shared | `background.sending-lanes`, `billing.plan-message-month-limit` | sending-engine | BRIEF AC-6 | covered — P43 (db-changes Stage 6) |
| decisions.md P44 | contacts, automations, runs, broadcasts, segments Instagram-named (`app.instagram_*`), launch tables renamed in place | `data.shared-product-tables` (was `data.instagram-product-tables`) | contacts, automations, broadcasts | BRIEF AC-10 | covered — superseded by P48: shared tables, no rename, routes under `/api/v1/app/…` (see **Room for WhatsApp and TikTok**) |
| decisions.md P45 | webhook, event tables, queues and workers Instagram's | `integrations.instagram-webhook-save`, `background.*` | webhook, sending-engine | — | covered — P45 (worker-changes: every row but WC-34) |
| decisions.md P46 | Meta's deauthorize and data-deletion callbacks with the connection | `integrations.channel-connection-meta-callbacks` | channel-connection | — | covered — P46 (route-changes RC-17, RC-18) |
| decisions.md P47 | derived: features `channel_accounts_max`, `message_month_limit`; `{channel_account_id}` the one account id; common and Instagram route prefixes; `/app/usage` common; the token check the connection's; permission codes unchanged; F3 and F5 adopted | `billing.plan-channel-accounts-max`, `billing.plan-message-month-limit`, `background.token-check`, `background.intake`, `quality.lock-order` | channel-connection, channel-account, sending-engine, plans-and-limits | — | covered — P47 (route-changes, worker-changes WC-1–WC-4, WC-34, notes 7–9) |

### Room for WhatsApp and TikTok (P48–P51)

The owner's answers of 2026-11-24 (`decisions.md` P48–P51): the product data is shared again so a later
channel reuses it, with Instagram-specific adapters around it. P48 supersedes P44.

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| decisions.md P48 | shared product data, keyed by `channel_account_id` (+ `channel` on contacts, automations, broadcasts): `app.contacts`, `app.contact_tag_events`, `app.automations`, `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.automation_counts`, `app.automation_reply_states`, `app.automation_backfills`, `app.segments`, `app.broadcasts`, `app.broadcast_recipients`; the four launch tables changed in place with no rename | `data.shared-product-tables` | contacts, automations, broadcasts | BRIEF AC-10 | covered — P48 (db-changes Stages 2, 3 and 5; counts then 22 / 15 / 1 / 1; 21 / 15 / 1 / 1 since P73) |
| decisions.md P48 | their routes back at `/api/v1/app/contacts…`, `/automations…`, `/broadcasts…`, `/segments…`, `/contact-tags` with a required `channel_account_id` filter; the launch's contacts and automations paths kept | `operations.shared-product-routes` | contacts, automations, broadcasts, past-comments | — | covered — P48 (route-changes RC-20–RC-34, RC-36–RC-55; counts then 49 / 54 / 5; 49 / 55 / 5 since P53's RC-115) |
| decisions.md P48 | per-channel capability list — ways to start, steps and message kinds — a code constant, Instagram the only entry; no table | `operations.channel-capability-list` | automations, broadcasts | — | covered — P48 (db-changes "Per-channel capability list and the one feature check"; route-changes RC-29, RC-31, RC-52) |
| decisions.md P48 | still Instagram's: `instagram_accounts` (extension), settings, media, sending tables, `instagram_attachments`, webhook events and keys, their routes under `/social/instagram/…`, the Instagram background work; the shared run engine hands every send through one interface (save a waiting message) | `background.channel-send-interface` | sending-engine, webhook | — | covered — P48 with P43, P45 (worker-changes WC-1, WC-2 and the P48 note) |
| decisions.md P49 | `channel_connection_tokens` gains `encrypted_refresh_token` (empty for Meta) and `token_type` `system_user` · `oauth_user` | `data.channel-connection-token-refresh` | channel-connection | — | covered — P49 (db-changes Stage 1, `channel_connection_token`; worker-changes WC-34 unchanged for Meta) |
| decisions.md P50 | one feature check — channel capability ∧ granted permission ∧ plan ∧ Meta test — called by go-live, settings and the engine; refusals `channel_lacks_feature`, `permission_not_granted` (reconnect asks for it), `plan_lacks_feature`, `feature_not_offered`; the connection's granted permissions feed it, no new table | `operations.feature-check` | automations, account-settings, broadcasts, sending-engine | BRIEF AC-7 | covered — P50 (db-changes note and `channel_connection`; route-changes RC-12, RC-29, RC-31, RC-52; worker-changes WC-1, WC-2, WC-41) |
| decisions.md P51 | Meta's usage (`X-Business-Use-Case-Usage` and app-level) kept per connection (`usage_percent`, `usage_read_at` — routes-final's name, P99 — `usage_wait_until`), Postgres with a short Redis copy; every channel's engine reads it before a call (80 % slows, 95 % waits Meta's time or 15 minutes); no per-lane usage | `background.meta-usage-per-connection` | channel-connection, sending-engine | — | covered — P51 (db-changes `channel_connection`, `instagram_send_lane`; worker-changes WC-6, WC-26, WC-41) |

### Route review answers (P54–P90)

The owner's answers to the route review's open questions, in one pass (`decisions.md` P54–P90,
2026-11-24; P79 the one AMBER default; P90 confirms every sub-domain). Grouped by area; each row names the
change files that carry it. None is open.

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| decisions.md P54–P58 | channel connection: a reconnect moves an account's row at the callback; a pick re-reads Meta; Meta's deauthorize and data deletion match `provider_account_id`, else `client_business_id`; ads one ad account at a time; reconnect its own route | `integrations.channel-connection-unified-login`, `integrations.channel-connection-meta-callbacks`, `operations.channel-connection-ad-picker` | channel-connection | BRIEF AC-2 | covered — P54–P58 (route-changes RC-2, RC-3, RC-15, RC-17, RC-18, RC-113, RC-114; db-changes `channel_connection`, `channel_account`) |
| decisions.md P59 | 15 of the 17 shared connection and account routes take `channel-account:read` / `manage` (RC-17, RC-18 are PUBLIC); only the Instagram settings and media keep `instagram-account:*` (and the sending status `instagram-account:read`); the webhook receiver is public (Meta's signature) and its debugging list uses `instagram-webhook-event:read` (wording corrected, P99); a tenancy migration renames the grants | `access.channel-account-codes` | channel-connection, channel-account | — | covered — P59 (route-changes Access cells, RC-8 / RC-9 Before → after; db-changes Reference data) |
| decisions.md P60–P61 | one live account per provider account held on `channel_accounts`; the feature check's refusal statuses `422` / `409` / `403` / `422` | `operations.channel-account`, `operations.feature-check` | channel-account, automations, broadcasts | BRIEF AC-7 | covered — P60, P61 (db-changes `channel_account`; route-changes RC-12, RC-29, RC-52) |
| decisions.md P62–P63 | our own echoes by a Postgres lookup, an early echo matched by intake within 10 minutes; the flood guard counted in Postgres at intake | `integrations.instagram-webhook-save`, `background.intake` | webhook, sending-engine | — | covered — P62, P63 (route-changes RC-16; worker-changes WC-1; db-changes `instagram_webhook_event`) |
| decisions.md P64–P67 | the tag list cached per organization and account (account confirmed in Postgres first); `channel_account_id` required on lists; bulk by ids (1–500) or a filter; `GET /contact-tags?channel_account_id=` | `operations.contact-tags`, `operations.contact-bulk-actions`, `operations.shared-product-routes` | contacts | — | covered — P64–P67 (route-changes RC-20, RC-23, RC-24, RC-26; worker-changes WC-36) |
| decisions.md P68–P71 | go-live `409 automation_not_ready` with `errors[]`; a live save checks content only; the way to start required at create; no open-run key table (P71 — reversed by P100, the P100 row) | `operations.automation-go-live-check`, `operations.automation-status-draft-live-paused`, `operations.automation-trigger-types` | automations | BRIEF AC-3, AC-7 | covered — P68–P71 (route-changes RC-27, RC-29, RC-31; db-changes `automation_run`; worker-changes WC-45, a CHANGED row since P99) |
| decisions.md P72 | workspace = organization in every identifier, column, route and code | `data.organization-naming` | all | — | covered — P72 (all three change files; `app_member_organization_counts`) |
| decisions.md P73–P74 | `sending_helper_slots` dropped, the repair on scheduler repeat jobs; `SENDING_ENABLED` `true` in `.env.example`, schema default `false` | `background.helper-*`, `quality.sending-settings` | sending-engine | — | covered — P73, P74 (db-changes NEW 22 → 21; worker-changes repair note, notes 6 and 11) |
| decisions.md P75–P76 | deleted broadcasts and segments purged after 90 days; segments PRO only — every segment and broadcast route refuses Free `403 plan_lacks_feature`; a trial's segments kept, unusable until an upgrade | `operations.broadcast`, `operations.segment`, `billing.plan-pro-features` | broadcasts | — | covered — P75, P76 (route-changes RC-41–RC-53; worker-changes WC-39, WC-62; db-changes `segment`) |
| decisions.md P77–P80 | a move down a Stripe subscription schedule; Stripe's card id in paths; `message_month_limit`; the switched-off Starter, Growth, Pro rows held to Free's features and limits, a notice and an email once — by the plan-state check (P99) | `billing.plan-downgrade`, `billing.payment-methods`, `billing.plan-message-month-limit`, `billing.retired-plans` | plans-and-limits | BRIEF AC-7 | covered — P77–P80 (route-changes RC-57–RC-59, RC-68, RC-69; db-changes `plan`, `subscription`, Reference data; worker-changes WC-38, WC-59's retired-plan finding — WC-66 folded in by P99; route-changes RC-64 `is_plan_choice_required`) |
| decisions.md P81–P82 | the tone `lav` → `lavender` everywhere; invites take `role_ids` with exactly one | `access.editor-viewer-roles`, `tenancy.organization-logo-color` | product-around-sending | — | covered — P81, P82 (route-changes RC-88, RC-89, RC-110; db-changes `organization`, Reference data) |
| decisions.md P83 | one on / off switch per feature key in the plan's typed features, beside `channel_accounts_max`, `message_month_limit`, `has_priority_support`; no `is_pro_enabled` / `pro_features` bundle; the PRO switches: email ask, phone ask, reply like a person, more than one public reply line, message versions, broadcasts, segments, past comments, extra delay | `billing.plan-feature-switches`, `operations.feature-check` | plans-and-limits, automations, broadcasts | BRIEF AC-7 | covered — P83 (db-changes `plan`; route-changes RC-12, RC-57, RC-58, RC-59, RC-64; worker-changes WC-38, WC-57) |
| decisions.md P84–P86 | passwords removed (routes and code; `password_hash` emptied); Apple's `303` the one named method-status exception; the session place from DB-IP "IP to City Lite" | `access.sign-in-v8`, `access.session-place` | product-around-sending | — | covered — P84–P86 (route-changes RC-70, RC-78, RC-98–RC-101; db-changes `user`, `session`, Reference data) |
| decisions.md P87–P88 | notification preferences speak kinds, stored per type; an email with in-app off uses the caller's `dedupe_key`, the in-app row only when on | `notifications.kinds-v8` | notices | — | covered — P87, P88 (route-changes RC-84, RC-85; db-changes Reference data; worker-changes notices bullet) |
| decisions.md P89 | `X-Idempotency-Key` on a `POST` that creates a row or starts background work only; state switches, "try it" and the login / reconnect starts take none | `quality.idempotency` | all | — | covered — P89 (route-changes Access note, finding 13) |
| decisions.md P90 | the route review confirmed: every open question answered, every sub-domain confirmed in one pass | — | all | — | covered — P90 (the change files' Stage rows) |

### Scale review and alignment (P91–P100)

The read-only scale review ([`reviews/scale-review-2026-11-24.md`](reviews/scale-review-2026-11-24.md), S1–S29 —
the Fix column is the spec) and the alignment check
([`reviews/alignment-check-2026-11-24.md`](reviews/alignment-check-2026-11-24.md), 16 mismatches), settled in
`decisions.md` P91–P99 (2026-11-24), and the open-run key table that routes-final rev 5 adds with them (P100). Each row names the change files that carry it. None is open.

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| decisions.md P91 | S1 — an in-process database limiter for the send, intake and task work (≈ 16–24 places a process, a 2 s wait then the ticket goes back) counted by the connection budget; the new send concurrency settings with their own maximum; the send work its own service; the now / 1,000-account arithmetic in the resource limits doc | `quality.connection-budget` | sending-engine | — | covered — P91 (worker-changes note 12; kickoff names the service and settings) |
| decisions.md P92 | S3 — the clean-ups hourly, each until a time budget (≈ 10 minutes) with a per-table cap of the rows a day × 2; a gauge "oldest row past its keep time" per table, alerting after 1 day | `quality.retention`, `background.retention-*` | sending-engine | BRIEF AC-8 | covered — P92 (worker-changes WC-47–WC-54, WC-62, WC-64 and their Before → after; db-changes "How long rows stay", `broadcast_recipient`, `contact_tag_event`, `instagram_send_stop`) |
| decisions.md P93 | S12 — the missed-comment full pass keeps the normal round's limits (7 days, 25 posts), lowest priority, stops at 60 % Meta usage, one per account | `background.missed-comment-check` | sending-engine | — | covered — P93 (worker-changes WC-26) |
| decisions.md P94 | S15 — one scheduled run per every-minute repair duty, in parallel, each until a 40 s budget, tickets re-added in bulk; round time and backlog per duty | `background.helper-*` | sending-engine | — | covered — P94 (worker-changes the repair note, WC-13–WC-15, WC-17–WC-20, WC-28, WC-29, WC-37, WC-56, WC-57, WC-67) |
| decisions.md P95 | S16 — a `minimum_compatible_settings_version` per release, raised only when incompatible; an older server takes no tickets, an older compatible one does; the rollback step and command; how the host rolls several replicas | `quality.rolling-deploy` | sending-engine | BRIEF AC-9 | covered — P95 (db-changes `sending_state`; worker-changes the "which servers send" bullet, note 13) |
| decisions.md P96 | S4 — partition now: `automation_runs` and `automation_run_events` by month of the run's start, `automation_comment_logs` by month, `instagram_webhook_event_keys` by Meta's event day (dedupe kept; the missed-comment and past-comment reads use the same day); expiry drops a part; `broadcast_recipients` stays plain | `quality.retention`, `background.partition-upkeep`, `data.split-tables` | sending-engine | BRIEF AC-8 | covered — P96 (db-changes overview note, "How long rows stay", the four tables' Holds and Before → after, the one-open-run rule — under the contact lock at first, the key table since P100; worker-changes WC-45, WC-48, WC-51, WC-52, WC-55) |
| decisions.md P97 | the "decide at kickoff" findings S2, S5–S11, S13, S14, S17–S21, S25, S26, S29 recorded as defaults — kickoff builds each as the review's Fix column says, differences into AS-BUILT | `quality.*`, `background.*`, `data.*` | sending-engine, contacts, webhook | — | covered — P97 (worker-changes WC-55 for S17, note 14; db-changes "Not drawn here" — S5, S7, S8, S13, S29 data built at kickoff and synced back) |
| decisions.md P98 | the operations findings S22–S24, S27, S28 — after launch, listed in KICKOFF.md's open items | `operations.after-launch` | sending-engine | — | covered — P98 (worker-changes note 15; KICKOFF.md open items) |
| decisions.md P99 | the alignment check's 16 mismatches — names follow routes-final, design follows the decisions: `usage_read_at`; `connection_status` + `paused_by_user_id`; `broadcasts.channel` kept; the plan stop on `channel_accounts`; the retired-plan notice in WC-59; WC-45 CHANGED; RC-102–RC-111 numbered in routes-final; route-changes' section cites; P59's wording | `data.*`, `background.*`, `access.channel-account-codes` | all | — | covered — P99 (db-changes `channel_connection`, `channel_account`, `instagram_account`, `plan`, Reference data; route-changes intro, RC-7–RC-11, RC-15, RC-17, RC-18, RC-60, RC-64, RC-112–RC-114; worker-changes WC-45, WC-59; routes-final its own items) |
| decisions.md P100 | one open run per automation and person now that runs are split by month (P96): the key table `app.automation_run_open_keys` — one row per open run, unique on (organization, automation, contact), pointing at the run (id + start month); the new run and its key in one commit, the key deleted in the commit that ends the run (P35's replacement swaps it in the same commit); a repair duty removes keys whose run has ended; RLS FORCE — reverses P71 | `operations.automation-once-rule`, `data.split-tables`, `background.helper-*` | automations | BRIEF AC-5 | covered — P100 (db-changes `automation_run_open_key` (NEW), `automation_run`, Stage 3, overview; worker-changes WC-67 (NEW), WC-45; route-changes: no route; routes-final AU23, AU37, AUC15, 4.B.3) |

### Part B — what people and owners see (§4–16)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L452–472 | 15 ways to start | `operations.automation-trigger-types` | automations | BRIEF AC-3 | covered (repost / ads / Live: go-live gated — P36) |
| plan:L478–515 | once keys per way | `operations.automation-once-key` | automations | BRIEF AC-3 | covered |
| plan:L499–505 | window rule, Live, ad window, tag-start window, every-time mode | `operations.automation-window-rule`, `operations.automation-every-time-mode` | automations | — | covered (open run replaced: P35) |
| plan:L517–571 | match order (5 levels) | `operations.automation-message-match-order` | automations | BRIEF AC-3 | covered |
| plan:L573–596 | comment match | `operations.automation-comment-match` | automations | — | covered |
| plan:L598–618 | six webhook fields | `integrations.instagram-webhook-fields` | webhook | — | covered |
| plan:L649–710 | draft / live / paused, pause keep or cancel, duplicate, delete, auto stop, live edit, downgrade, go-live check | `operations.automation-status-draft-live-paused`, `operations.automation-go-live-check` | automations | BRIEF AC-7 | covered (A2, A8, A11) |
| plan:L712–796 | step order, step matrix, also start from | `operations.automation-step-order`, `operations.automation-also-start-from` | automations | — | covered |
| plan:L800–880 | targeting, typo match, try it, option row, starter questions, ref link, ad picker | `operations.automation-keyword-typo-match`, `operations.automation-try-it`, `operations.instagram-starter-questions-sync`, `operations.automation-ref-link`, `operations.channel-connection-ad-picker` | automations, channel-connection | — | covered (ad picker: go-live gated — P36; read through the connection — P41) |
| plan:L882–954 | hello, versions, nudge, follow, email, phone | `operations.automation-step-hello`, `operations.automation-nudge`, `operations.automation-step-follow`, `operations.automation-step-email-ask` | automations | — | covered (A19) |
| plan:L956–1008 | message list, attachments, waits, window | `operations.automation-step-messages`, `operations.automation-message-attachments` | automations, message-files | — | covered (scan out-of-scope — P34; type and magic-byte checks) |
| plan:L1010–1061 | public replies, tags, tag events, bulk tags, hide | `operations.automation-step-public-reply`, `operations.contact-tag-events`, `operations.automation-hide-comment` | automations, contacts | — | covered |
| plan:L1075–1131 | account settings v8, past comments | `operations.instagram-account-settings-v8`, `operations.automation-past-comments` | account-settings, past-comments | — | covered |
| plan:L1136–1192 | lanes, message types, DM counting | `background.sending-lanes`, `operations.instagram-dm-counting` | sending-engine | BRIEF AC-6 | covered |
| plan:L1195–1443 | comment flow, Live, ads, no-hello, own comment, replies | `operations.automation-comment-flow`, `operations.automation-live-ended`, `operations.automation-ad-comment` | automations | — | covered (Live / ads: go-live gated — P36) |
| plan:L1445–1818 | story reply, DM, first message, shared post, broadcasts, segments | `operations.automation-message-start-flow`, `operations.broadcast`, `operations.segment` | automations, broadcasts | — | covered (A9) |
| plan:L1820–1949 | once rule, 24 h, window | `operations.automation-once-rule`, `operations.automation-window-table` | automations | — | covered (open run replaced: P35) |
| plan:L1951–2103 | limits, month DMs, accounts max, plan states, PRO, choose active accounts, trial | `operations.instagram-send-limits`, `billing.plan-message-month-limit`, `billing.plan-states`, `billing.plan-pro-features`, `operations.channel-account-choose-active` | plans-and-limits, channel-account | BRIEF AC-6, AC-7 | covered (PRO parts checked by the one feature check — P50 — reading one plan switch per feature — P83; segments PRO — P76; retired plans held to Free's — P80; trial: P28; A3; `message_month_limit` and `channel_accounts_max` across channels, plan stop on the channel account — P42, P43, P47) |
| plan:L2105–2263 | human timing, extra delay, expiry, estimate | `operations.instagram-timing-boxes`, `operations.instagram-message-expiry`, `operations.instagram-pending-estimate` | sending-engine | — | covered |
| plan:L2267–2362 | public replies per automation, usage header | `operations.automation-public-reply-per-automation`, `background.meta-usage-per-connection` | automations | — | covered (the usage kept per connection — P51) |
| plan:L2364–2510 | follow check, email / phone parse, answer table, stop words, ask once, mark seen, pause one person | `operations.automation-answer-table`, `operations.contact-stop-words`, `operations.contact-pause-automations` | automations, contacts | — | covered |
| plan:L2512–2736 | owner screens: counters, switcher, 35 banners, organization notices, pause / resume account, undo, fix text, limits, contacts (note, timeline, delete, tags), connect / reconnect / disconnect, team suspend, owner emails, broadcast screen, backfill button, retry failed | `operations.automation-list-counters`, `operations.instagram-account-banners`, `operations.organization-notices`, `operations.contact-note`, `operations.contact-timeline`, `notifications.owner-emails` | owner-actions | — | covered (A14, A15, A18; connect, reconnect, disconnect, pause, resume and team suspend on the channel connection and account — P41, P42) |
| plan:L2737–2791 | 26 Riya examples | acceptance seeds | all | `plans/acceptance.md` | covered |

### Part C — data (§17–23)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L2798–2884 | table map, reused tables, "already solved" | `data.*` | all | — | covered |
| plan:L2886–3225 | 9 changed `app` tables, token table removed | `data.*` (db-changes.md stages 1–5) | all | — | covered (P29; the four launch product tables changed in place with no rename — P48, superseding P44; `instagram_accounts` the extension of `channel_accounts` — P42) |
| plan:L3226–3847 | 20 new tables | `data.*` (db-changes.md) | all | — | covered (names: P38, then the channel split P40–P43 — common `channel_*`, `message_month_counts`, `sending_states`; then P48 — the product tables shared under their plan names, the Instagram adapter `instagram_*`) |
| plan:L3848–4123 | statuses and state pictures | `data.*-states` | sending-engine | — | covered (A3) |
| plan:L4124–4220 | partitions and retention | `quality.retention`, `background.partition-upkeep` | sending-engine | BRIEF AC-8 | covered — P33, P96 (seven split tables: + runs, run events, comment logs, event keys), P92 (hourly clean-ups within a time budget, the oldest-row gauge) |
| plan:L4221–4300 | row security, roles, organization context | `access.row-security`, `access.global-sending-tables` | all | — | covered (A16) |
| plan:L4302–4342 | Redis keys | `quality.redis-notes` | sending-engine | — | covered (A5, A6; no buffer: P32; connect state a Redis nonce: P26; the usage copy keyed by connection, Postgres first — P51) |

### Part D — the sending engine (§24–35)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L4346–4480 | queues, tickets, places, BullMQ rules | `background.sending-lanes`, `quality.worker-places` | sending-engine | — | covered (Instagram's queues and workers — P45; intake never paused by a provider outage — P47, F3) |
| plan:L4482–4730 | Unified Login connect, scopes, subscribe, token check, reconnect, disconnect, callbacks, message access | `integrations.channel-connection-unified-login`, `integrations.channel-connection-meta-callbacks`, `background.token-check`, `background.account-setup` | channel-connection | BRIEF AC-2 | covered (A17; the token check is the connection's, callbacks with the connection — P41, P46, P47) |
| plan:L4732–4818 | webhook save, event kinds, Postgres down | `integrations.instagram-webhook-save` | webhook | — | covered — P32 (no buffer; Postgres down → 500 / 503) |
| plan:L4820–5175 | intake | `background.intake` | sending-engine | — | covered (never paused by a provider outage — F3; one lock order, raced in a test — F5; P47) |
| plan:L5177–5413 | slow and reply lane turns | `background.opening-turn`, `background.reply-turn` | sending-engine | — | covered |
| plan:L5415–5702 | fast messages, attachments | `background.fast-messages`, `background.attachment-upload` | sending-engine | — | covered (scan out-of-scope — P34) |
| plan:L5704–5866 | gates, month count, Redis down, every wait | `background.send-gates` | sending-engine | BRIEF AC-6 | covered |
| plan:L5868–6040 | Instagram errors, stops, tests | `background.instagram-error-stops` | sending-engine | BRIEF AC-4 | covered (go-live code list from the tests: P36) |
| plan:L6042–6093 | helper every minute | `background.helper-*` | sending-engine | — | covered (A7; no helper slots — P73; one scheduled run per duty, a 40 s budget, bulk re-add — P94) |
| plan:L6095–6185 | locks, transactions, timeouts | `quality.lock-order` | sending-engine | — | covered (contact → automation → runs in every intake path, tested with two intake jobs racing — P47, F5) |

### Part E — running it (§36–43)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L6189–6869 | settings file, every number | `quality.sending-settings` | sending-engine | — | covered (A4, A6) |
| plan:L6871–6941 | Neon set-up | `quality.database-links` | — | — | covered (ops parts: out-of-scope — runbook, not code) |
| plan:L6943–7045 | deploy, restart, many servers | `quality.rolling-deploy` | sending-engine | — | covered (a minimum compatible settings version, so a rollback keeps sending — P95) |
| plan:L7047–7115 | backup, restore, test copies | `quality.restore-never-sends` | sending-engine | BRIEF AC-9 | covered |
| plan:L7117–7179 | health checks and alerts | `quality.sending-health` | sending-engine | — | covered |
| plan:L7181–7375 | security and privacy | `quality.token-secrecy`, `quality.message-privacy` | all | — | covered |
| plan:L7377–7494 | size for 1,000 accounts | `quality.capacity` | — | — | covered (estimates; no load test this iteration; the connection budget for now and 1,000 accounts — P91; the scale review's defaults — P97, after-launch operations — P98) |
| plan:L7496–7594 | tests with Meta before building | — | — | — | out-of-scope — the owner's tasks with a real Meta app (BRIEF Out of scope); their results gate go-live (P36) |

### Part F — the product around sending (§44–49)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L7598–7780 | sign-in: passwords off, Apple, digits code, trusted devices, step-up, GitHub off | `access.sign-in-v8`, `access.session-place` | product-around-sending | — | covered — P28 (passwords removed — P84; Apple's `303` — P85; the session place from DB-IP Lite — P86) |
| plan:L7782–7909 | organizations, members, Editor / Viewer, `contact:update`, invitations, chooser, `logo_color` | `access.editor-viewer-roles`, `access.contact-update-code` | product-around-sending | — | covered — P28 (`contact:update`: A20; `channel-account` codes — P59; `lavender` — P81; `role_ids` with one — P82; workspace = organization — P72) |
| plan:L7911–8115 | Flowdm plans, typed features, plan states, read-only, cards, trial | `billing.flowdm-plans`, `billing.plan-states`, `billing.paid-trial` | plans-and-limits | BRIEF AC-7 | covered — P28, P37 (placeholder prices); one switch per feature — P83; old rows Free's — P80; move down a Stripe schedule — P77; Stripe card ids — P78 |
| plan:L8117–8238 | profile, settings, notification kinds, notices | `notifications.kinds-v8` | notices | — | covered — P28 (per kind — P87; the caller's dedupe key — P88) |
| plan:L8240–8316 | refer | `billing.referral` | product-around-sending | — | out-of-scope — P39 |
| plan:L8318–8327 | later features | — | — | — | out-of-scope — D47 |

### Part G — build and track (§50–53)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L8331–8348 | the process: re-open or two new iterations, `--both` | — | — | — | covered — P28, P29, P30 |
| plan:L8350–8377 | step 0 Meta app check, creator test | — | — | — | out-of-scope — owner task |
| plan:L8409–8434 | Track A A1–A10 | ROUTE rows (Step 6) | all | — | covered |
| plan:L8436–8481 | Track B B1–B6, Part F names | ROUTE rows (Step 6) | product-around-sending, message-files | — | covered — P28 (B6 scan: out-of-scope — P34) |
| plan:L8483–8498 | app names from §18–20 | db-changes.md | all | — | covered (A6) |
| plan:L8500–8525 | Meta review checklist | — | — | — | out-of-scope — owner task |
| plan:L8527–8531 | tests and close | `quality.gates` | all | BRIEF AC-1 | covered |
| plan:L8535–8603 | 45 review items | spread over the rows above | all | — | covered |
| plan:L8775–8777 | open: referral payouts, plan prices, AI | — | — | — | covered — P37 (placeholder prices); referral payouts out-of-scope — P39; AI out-of-scope (later) |
| plan:L8779–8805 | to test with Meta, to check when building | — | — | — | covered by P36 (go-live gate) and kickoff checks |

## Reconciliation

The drop has no `PRD.md` / `schema-routes.md`; the plan is the one approved source. Rows below are the plan
against itself, against the guide, and against what the launch built (`SD` = launch Standing deviation,
`iterations/launch-2026-11-20-ujai/AS-BUILT.md`). A verdict only where one approved line settles it.

| # | Item | Says (A) | Says (B) | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| R1 | Go-live checks | §5.1: 17 checks, hello always needs a next-step button (plan:L690–707) | §15.5: 10 checks, button "when later steps exist" (plan:L2635–2653); DB check unconditional (plan:L3111) | — | A2 (default) |
| R2 | Month-limit lanes | slow + fast + broadcast (plan:L2014, L3407, D62 plan:L273) | slow + fast (plan:L4051–4052) | D62 (user-approved) wins: slow + fast + broadcast | A3 |
| R3 | Stop-word restart list | keyword comment, keyword DM, starter, ig.me link (plan:L557, L2423, D49 plan:L260) | "only a keyword DM, a starter tap or a link" (plan:L1471) | D49 (user) wins: the four | none |
| R4 | One open run | one per automation + person in "every time" (plan:L505, L1944) | open key includes the once key with "once" ON (plan:L3473) | — | P35; the key table back as `automation_run_open_keys`, keyed by automation + person (P100) |
| R5 | Ad comments live-able | offered only after the Meta test (plan:L626, L1364) | DB checks and backfills allow `ad_comment` live (plan:L3103, L3828) | — | P36 |
| R6 | Run retention clock | 90 days after the run ends (plan:L4144) | parts dropped by `started_at` month, "approximate" (plan:L3151, L1850) | P96 (supersedes P33's plain table): month parts by the run's start, a part dropped once every run in it ended over 90 days ago — 90 days or a little more, never sooner | P33, P96 |
| R7 | Messages kept 30 days | D50 (plan:L261) | weekly parts by run start (plan:L3236, L4143) → "what happened" ≈ 30 days | — | A13, P33 (messages time-split) |
| R8 | Per-person limit bounds | owner 5–100 (plan:L1960) | DB check "over 0" (plan:L2904) | two layers (API vs database), consistent | none |
| R9 | Upload scan | D58 "the upload domain scans every file" (plan:L269) | B6 "meepzo-be has no scanner today" (plan:L8444); code: none | the premise of D58 is false | P34 (checks now, scan later) |
| R10 | Intake never paused | send queues "not paused by the circuit" (plan:L4470–4480) | the launch's intake worker pauses on the open Instagram circuit (`createProviderPausableWorker`) | P47 adopts the webhook review's F3: intake is never paused; only provider calls check the circuit, per provider, per job | P47 (worker-changes WC-1, note 7) |
| R11 | Webhook store failure | Redis buffer, answer 200 (plan:L4799–4807) | launch: store first, 500/503 so Meta re-delivers (SD "Store before answering") | repository rule: Postgres only source of truth | P32 (no buffer; 500 / 503) |
| R12 | Once rule | per once key, resets ~90 days (D13) | launch: once ever, `previous_run_final` (SD "Trigger after an earlier run") | D13 (user) wins | before → after in requirements |
| R13 | Unknown result | resend once on her next action (D17) | launch: fail the step (SD "Sending again on a retry") | D17 (user, 22 Nov) wins | before → after |
| R14 | Retention | events 8 d, runs / logs 90 d (D15, D16) | launch 30 d / 180 d (SD "Wait limit and run retention") | D15 / D16 (user) win | before → after |
| R15 | Accounts per organization | 1 / 3 / 10 by plan (D26) | launch: one not-revoked account, singular routes (SD "Accounts per organization") | D26 wins | A1 |
| R16 | Login | Unified Login only (D24) | launch: Instagram Login, token table, daily renewal (SD "Daily account check") | D24 wins | REMOVED rows |
| R17 | Read-only plan | owner may pause, delete, disconnect (plan:L2066) | launch: `organization_read_only` on create / edit / delete (SD "Read-only plan") | — | A10 |
| R18 | Delete reason | optional (plan:L677, L3035) | launch: required (SD "Automation delete") | — | A11 |
| R19 | Next post | never expires (plan:L3015, L3140) | launch: window + 15-minute expiry (SD "Next-post linking and expiry") | — | A12 |
| R20 | Email plus addresses | allowed (plan:L2384, L2978) | launch refuses Gmail plus (SD "Email and phone checks") | — | A19 |
| R21 | Guide vs plan | guide parts 1–29 summarise §1–53 | the guide defers to the plan (guide:3) | plan wins by its own rule | none |
| R22 | Repository rules | plan names (`dm_*`, `post_key`, `turn_no`, `_MS`, `cnt:`, `uq_`), Redis copies keyed by account, runtime DDL on the migration login, raw `set_config` | full-names rule, be-read-cache-guard, the three logins, the context wrappers | agent-os decides (plan:L8348) | A5, A6, P33 (upkeep under a maintenance scope) |

## Delta

n/a — initial (Baseline `none`). The launch iteration (`launch-2026-11-20-ujai`, frozen, not merged) built the
`app` tables, routes and background work this plan changes; every change is written before → after against
it, and its Standing deviations this change touches go into `KICKOFF.md` section 8.

## Counts

Coverage rows 134 — covered 126, open 0, out-of-scope 8 (P39 referrals ×2, P34 file scan ×1, owner tasks ×3,
later features ×2) — the P100 row (the open-run key table) is new, covered; the 9 rows of **Scale review and alignment** (P91–P99) are new, all covered; the 16 rows of **Route review answers** (P54–P58, P59, P60–P61, P62–P63, P64–P67,
P68–P71, P72, P73–P74, P75–P76, P77–P80, P81–P82, P83, P84–P86, P87–P88, P89, P90) are new, all covered;
the 7 rows of **Room for WhatsApp and TikTok** (P48 ×4, P49, P50, P51) are new, all
covered, and the P44 row is covered as superseded by P48; the 8 rows of **Channel split** (P40–P47), all covered; a few covered rows carry an out-of-scope part (B6 scan — P34, referral payouts — P39, AI,
Neon ops runbook). Reconciliation rows 22 — 8 settled by an approved line, 7 by an owner answer (P32–P36;
R7 and R22 with a default too), 7 by a default (A1–A19); none open; R6's verdict moves from P33 to P96 (runs split by month). R10 is now settled by P47 (the webhook review's F3 adopted) instead of
at kickoff.
