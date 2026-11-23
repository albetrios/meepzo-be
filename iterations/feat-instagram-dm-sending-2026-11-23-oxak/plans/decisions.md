# Decisions — feat-instagram-dm-sending-2026-11-23-oxak

Add-only: a changed mind is a new row that supersedes an old one. Kind: `RED` (answered by the user),
`AMBER` (safe default, still open), `SCOPE` (scope decision during implementation).

The plan's own decisions **D1–D73** (`intake-files/Instagram-DM-Sending-Plan-v8.md` §2, plan:L210–L284, approved
by the user on 22–23 Nov 2026) are locked inputs and are not repeated here. Rows below are this plan's own,
numbered `P<n>` so they never collide with the plan's `D<n>`.

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | A1 — account routes for many accounts (D26) | nested `…/instagram/accounts/{instagram_account_id}/…` · singular + query · an active-account claim | nested; the singular `/social/instagram/account*` routes removed in the same change | 2026-11-23 | Claude | AMBER |
| P2 | A2 — go-live check list (plan:L690–707 vs L2635–2653) | §5.1 · §15.5 | §5.1 + the database check: a hello always has a "next step" button when later steps exist | 2026-11-23 | Claude | AMBER |
| P3 | A3 — lanes stopped at the month limit (plan:L2014 vs L4051) | slow+fast+broadcast · slow+fast | slow + fast + broadcast (D62) | 2026-11-23 | Claude | AMBER |
| P4 | A4 — settings home (D22) | one plan file + version gate · per-sub-domain constants · one app-domain constants file | one app-domain constants file; environment-varying values only as env vars with production-safe defaults (`SENDING_ENABLED` default off); the D21 version gate kept | 2026-11-23 | Claude | AMBER |
| P5 | A5 — Redis copies | plan keys · be-read-cache-guard | be-read-cache-guard: organization-scoped keys, tombstone after commit, TTL ≤ 60 s | 2026-11-23 | Claude | AMBER |
| P6 | A6 — full-names rule on plan identifiers | rename · keep | rename (`direct_message_*`, `once_key`, `turn_number`, `_MILLISECONDS`, `count:`, `idx_`) | 2026-11-23 | Claude | AMBER |
| P7 | A7 — the every-minute helper | per-server slot leases · the existing cron scheduler | the existing scheduler, one repeat job per rule group, plus a 10-second repeat for the Redis-down check | 2026-11-23 | Claude | AMBER |
| P8 | A8 — go live, pause, duplicate, try it | action routes · `PATCH status` | action routes; `PATCH` saves content only | 2026-11-23 | Claude | AMBER |
| P9 | A9 — segments, broadcasts delete | soft delete + purge · hard delete | soft delete + purge | 2026-11-23 | Claude | AMBER |
| P10 | A10 — read-only plan | plan · launch | the owner may pause, delete, disconnect; only go-live and turning a PRO part on are refused | 2026-11-23 | Claude | AMBER |
| P11 | A11 — automation delete reason | optional · required | optional; `other` needs a note | 2026-11-23 | Claude | AMBER |
| P12 | A12 — "next post" expiry | never · launch window | never expires; the 15-minute expiry removed | 2026-11-23 | Claude | AMBER |
| P13 | A13 — message rows dropped by run-start week | accept ≈ 30 days · partition by created time | accept; "what happened" and "retry failed" read about the last 30 days | 2026-11-23 | Claude | AMBER |
| P14 | A14 — workspace DM meter | new app route · field on `/auth/me/context` | new app route | 2026-11-23 | Claude | AMBER |
| P15 | A15 — undo toast | client replays · undo route | client replays; no route | 2026-11-23 | Claude | AMBER |
| P16 | A16 — global sending tables without organization | documented exemption · per-organization rows | documented RLS exemption, maintenance login only | 2026-11-23 | Claude | AMBER |
| P17 | A17 — daily profile refresh | inside the token check · own job | inside the token check | 2026-11-23 | Claude | AMBER |
| P18 | A18 — team "suspend account" | column now, route later · both now | `suspended_at` column now, the platform-admin route later | 2026-11-23 | Claude | AMBER |
| P19 | A19 — plus addresses in email answers | accept + ask again ×3 · launch refusal | accept; ask again up to 3 times with wordings | 2026-11-23 | Claude | AMBER |
| P20 | A20 — permission codes | reuse `automation:*` + `contact:update` · new codes | broadcasts, segments, past comments reuse `automation:*` (D68, D69); `contact:update` for note, tags, pause | 2026-11-23 | Claude | AMBER |
| P21 | A21 — yes/no field names (db-changes N1) | `is_` / `has_` (be-sql-design-guard) · plan names | `is_` forms (`is_reply_like_person`, `is_counted_as_direct_message`, …); the launch's `is_public_reply_enabled` keeps its name | 2026-11-23 | Claude | AMBER |
| P22 | A22 — public-id prefixes for new tables (N2) | chosen at kickoff by `generatePublicId` · now | chosen at kickoff, recorded in AS-BUILT | 2026-11-23 | Claude | AMBER |
| P23 | A23 — launch ignored reasons `waiting_for_other_email`, `already_waiting` (N3) | keep · drop | keep (the plan is silent) | 2026-11-23 | Claude | AMBER |
| P24 | A24 — own comments skip reason (N4) | rename `echo` → `own_comment` · keep `echo` | `own_comment` for comments; `echo` stays for DM echoes | 2026-11-23 | Claude | AMBER |
| P25 | A25 — attachments point at `upload.uploads` (N5) | documented exception · keep the upload public id only | the upload public id only, read through the upload service (no cross-domain foreign key) | 2026-11-23 | Claude | AMBER |
| P26 | A26 — the Meta connect state (10 minutes, one use, plan:L4567) | Redis nonce · a Postgres row | Redis nonce: short-lived login state, nothing lost if it goes (the owner starts the login again) | 2026-11-23 | Claude | AMBER |
| P27 | A27 — dismissing a workspace notice (plan:L2582, L2584) | the browser remembers · a route | the browser remembers; no route | 2026-11-23 | Claude | AMBER |

## Step 4 answers (RED, 2026-11-23)

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| P28 | Q1 — scope of this iteration | engine + needed Part F · everything · engine only | **Everything in one**: Track A (§4–43) and Part F (§44–47) in this iteration — **except the referral program (§48)**, which goes to a later iteration (P39) | 2026-11-23 | Rimeet Mavani | RED |
| P29 | Q2 — how it ships | one PR same branch · merge launch first · one PR new branch | **One PR on `feat/instagram-automation`** with the frozen launch; the 7 `app` migrations change in place (D1); the PR waits until this iteration is frozen | 2026-11-23 | Rimeet Mavani | RED |
| P30 | Q3 — both repositories | backend only now · `--both` now | **Backend only now**; this plan owns the contract, meepzo-fe opens its own iteration later and links here | 2026-11-23 | Rimeet Mavani | RED |
| P31 | Q4 — route review confirmation | all in one pass · one sub-domain at a time | **All in one pass**: every sub-domain drafted, then reviewed together | 2026-11-23 | Rimeet Mavani | RED |
| P32 | Q5 — Redis holding data Postgres does not have | drop both · buffer taps only · as plan | **Drop both**: no webhook buffer (Postgres down → 500/503, Meta delivers again) and no save-result jobs (a result save is retried inside the send) | 2026-11-23 | Rimeet Mavani | RED |
| P33 | Q6 — partitioning | high-volume only · as plan · none | **High-volume only**: webhook events, send attempts and messages are partitioned; runs, run events, comment logs, broadcast recipients and event keys stay plain with batch deletes; partition upkeep runs under a maintenance scope, never the migration login | 2026-11-23 | Rimeet Mavani | RED |
| P34 | Q7 — file scan (D58) | build ClamAV · outside API · checks now, scan later | **Checks now, scan later**: file type and content (magic-byte) checks this iteration; the malware scan in a later iteration — a D58 deviation, recorded in AS-BUILT | 2026-11-23 | Rimeet Mavani | RED |
| P35 | Q8 — open runs per automation and person | always one · one per once key · (user's own) | **At most one open run per automation and person; a new comment replaces it.** When a comment may start a new run (a different post, or "every time" mode — D13 / D65 still decide), her open run of that automation is cancelled (waiting messages cancelled, reason `replaced`) and the new run starts. A second comment on the same post with "once" ON is still ignored (`once_per_post`). Every other way to start keeps the plan's rule: ignored while her run is open (`run_in_progress`) | 2026-11-23 | Rimeet Mavani | RED |
| P36 | Q9 — Meta-test-gated features | build, gate go-live · build tested only · offer all | **Build all; gate go-live**: a code list of offered ways to start and features refuses go-live for each untested one (story repost, ad comments, Live comments, mark as seen, the 7-day ad window, quick replies / cards on Unified Login) until its §43 test passes | 2026-11-23 | Rimeet Mavani | RED |
| P37 | Q10 — plan prices | placeholders · final now | **Placeholders** in the seed (Creator $29 / $23 yearly, Studio $79 / $63 yearly); ops creates the real Stripe products at go-live | 2026-11-23 | Rimeet Mavani | RED |
| P38 | Q11 — where new things live | plan's names in `app` · own names | **The plan's names**: every new `app` table in schema `app`; new sub-domains `meta-connection`, `instagram-sending`, `broadcast` (+ nested `broadcast-segment`, `broadcast-recipient`); past comments nested under `automation`; plan rows stay in `billing`; Part F tables in their merged domains (new migrations only, D48) | 2026-11-23 | Rimeet Mavani | RED |
| P39 | Q12 — referral payouts | bill credit · Stripe Connect · PayPal · not in scope | **Not in scope**: the referral program (§48, D53, `billing.referral_*`, the referral routes and the month-close worker) moves to a later iteration | 2026-11-23 | Rimeet Mavani | RED |

## Channel split (2026-11-23, after the route review draft)

The owner asked for common tables and routes where a future channel needs them, with Instagram-specific things kept
Instagram-specific. Proposal: scratchpad `2026-11-23_channel-common-design_v1.md`. Supersedes the naming parts of P38.

| # | Question | Options | Decision | Date | Who | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| P40 | Common core or Instagram-specific? | common core + adapters · common queues / routes only · keep Instagram-specific | **Common core + adapters**, with the line drawn by P41–P46 | 2026-11-23 | Rimeet Mavani | RED |
| P41 | Connections | common · Instagram | **Common**: `app.channel_connections` + `app.channel_connection_tokens` (supersede `meta_connections`, `meta_connection_tokens`), sub-domain `channel-connection/`. **Meta is one login (Unified Login) for Instagram, Facebook and ads**: one connection per business portfolio holds the granted scopes and its assets — Instagram accounts now, Facebook Pages and ad accounts through the same login later (D27); the ads picker reads through the connection | 2026-11-23 | Rimeet Mavani | RED |
| P42 | Connected accounts | common + Instagram extension · Instagram | **Common + extension**: `app.channel_accounts` (channel, connection, status, display, pause / suspend / plan stop, the automation switch), sub-domain `channel-account/`; `app.instagram_accounts` becomes the 1:1 Instagram extension (Instagram user id, username, account type, private flag, followers, picture, starter questions set at); `instagram_account_settings` stays Instagram | 2026-11-23 | Rimeet Mavani | RED |
| P43 | Sending tables | Instagram · common | **Instagram**: `instagram_send_lanes`, `instagram_messages`, `instagram_send_attempts`, `instagram_send_minute_counts`, `instagram_send_stops`, `instagram_attachments` (was `meta_attachments`); **shared**: `message_month_counts` (was `direct_message_month_counts`, the plan limit spans channels) and `sending_states` (the global send switch) | 2026-11-23 | Rimeet Mavani | RED |
| P44 | Contacts, automations, broadcasts, segments | shared · Instagram | **Instagram-specific**: `instagram_contacts`, `instagram_contact_tag_events`, `instagram_automations`, `instagram_automation_runs`, `instagram_automation_run_events`, `instagram_automation_comment_logs`, `instagram_automation_counts`, `instagram_automation_reply_states`, `instagram_automation_backfills`, `instagram_segments`, `instagram_broadcasts`, `instagram_broadcast_recipients`; sub-domains `instagram-contact/`, `instagram-automation/` (+ run, backfill), `instagram-broadcast/` (+ segment, recipient); `instagram_media` stays | 2026-11-23 | Rimeet Mavani | RED |
| P45 | Webhook, queues, workers | common · Instagram | **Instagram-specific**: the receiver, `instagram_webhook_events` + keys, the queues `instagram-webhook`, `instagram-send-slow`, `instagram-send-fast`, `instagram-tasks` and their workers (a later Facebook channel gets its own; Meta's app dashboard takes one callback per object, `instagram` / `page`) | 2026-11-23 | Rimeet Mavani | RED |
| P46 | Meta's deauthorize and data-deletion callbacks | with the connection · Instagram | **With the connection** (they are Meta-wide): `…/channel-connections/{provider}/deauthorize`, `…/{provider}/data-deletion`; the connection resolves which accounts and people they reach | 2026-11-23 | Rimeet Mavani | RED |
| P47 | Derived defaults of P40–P46 | — | Plan features `instagram_accounts_max` → `channel_accounts_max`, `direct_message_month_limit` → `message_month_limit`; Instagram routes take `{channel_account_id}` (the one account id, no second Instagram id); common routes under `/api/v1/app/social/channel-connections/…`, `/api/v1/app/social/channel-accounts/…`, Instagram routes under `/api/v1/app/social/instagram/…` (settings, media, stories, sending status, contacts, automations, broadcasts, segments, webhook, webhook events), `/api/v1/app/usage` common; the token check is the connection's (scheduled), every other job is Instagram's; permission codes stay as they are (`automation:*`, `contact:*` — roles are product-wide). The webhook review's findings F3 (never pause intake on a provider outage — only provider calls check the circuit) and F5 (one lock order, contact → automation → runs, in every intake path, tested with two intake jobs racing) are adopted | 2026-11-23 | Claude | AMBER |
