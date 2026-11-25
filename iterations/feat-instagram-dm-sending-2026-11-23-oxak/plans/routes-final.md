# Route review — feat-instagram-dm-sending-2026-11-23-oxak

**Route review final — 2026-11-24.** Every sub-domain is confirmed; the frontend may kick off on these routes.

**Status: final — rev 5 (2026-11-24), confirmed 2026-11-24 ([P90](decisions.md); the scale and alignment fixes [P91–P100](decisions.md), confirmed by the owner — M13): every open question answered ([P54–P89](decisions.md), M12) and written into its sub-domain; sub-domains 1, 1B, 3–7 and 11 at rev 5, 2, 8 and 12 at rev 4, 9 and 10 at rev 3 — every sub-domain and nested sub-domain final (one-pass review, [P31](decisions.md)).**

Iteration `feat-instagram-dm-sending-2026-11-23-oxak` · on branch `feat/instagram-automation` at `20823e3` (2026-11-23) · built
from `intake-files/Instagram-DM-Sending-Plan-v8.md` (cited `plan:L<line>`) and `intake-files/BRIEF.md`, [decisions.md](decisions.md) P1–P100 (binding; the plan's D1–D73 are locked inputs; P91–P98 rest on the scale review [`reviews/scale-review-2026-11-24.md`](reviews/scale-review-2026-11-24.md), S1–S29, P99 on the alignment check [`reviews/alignment-check-2026-11-24.md`](reviews/alignment-check-2026-11-24.md), and P100 is the open-run key table), [db-changes.md](db-changes.md), [route-changes.md](route-changes.md)
(RC-n) and [worker-changes.md](worker-changes.md) (WC-n). The "before" of every changed app sub-domain is the frozen launch
review, [`launch-2026-11-20-ujai/plans/routes-final.md`](../../launch-2026-11-20-ujai/plans/routes-final.md), as built (its
`AS-BUILT.md` › Standing deviations); its ids are cited "launch IA5". Shape:
[routes-final-template.md](../../../docs/design-workflow/process/routes-final-template.md). This is a proposal: kickoff builds
it **ditto**, and where agent-os cannot, it stops and asks before anything differs.

How to read the tables: sub-domains 1, 1B and 2–7 are the `app` domain, paths under `/api/v1/app` (launch D1) — the common ones under `/social/channel-connections` and `/social/channel-accounts` (P47), the shared product at the top — `/contacts`, `/contact-tags`, `/automations`, `/broadcasts`, `/segments`, each list filtered by `channel_account_id` (P48) — and Instagram's own under `/social/instagram` (P47, P48); sub-domains 8–12 change
the platform domains in place, paths under `/api/v1` as written (`/billing/…`, `/tenancy/…`, `/auth/…`, `/users/…`,
`/uploads`). `{x_id}` is a public id (Stripe's `{payment_method_id}` is the one exception — BLQ2, P78); **Gate** is the permission
the caller needs (`AUTH` = signed in, no code; `PUBLIC` = no sign-in, with the provider's signature or token where named);
**Idem** `req` = `X-Idempotency-Key` header required, empty, `none` or `—` = none (why: K3); `*` = required. Lists take
`limit` and `after` (cursor). Route numbers are global, in three bands — 1–42 (app core; 40–42 added in rev 2, M9), 60–82 (app engine), 100–150 (product; 141–150 added in rev 5 for the ten changed platform routes this review had named without a number, RC-102–RC-111 — P99, M13) — with gaps between sub-domains and never a repeat (65–68 are left unused, M6; no revision renumbered anything, so 1's routes are 1–5, 15–17 and 40–42, and 9–12 keep their first numbers and add 141–150). **(new)**,
**(changed)**, **(moved)**, **(as built)** and **REMOVED** compare against today's code.

## Sub-domains (in build order)

Each sub-domain builds on the ones it names. The numbers stay as they are (rev 2 inserted **1B** so 2–12 keep theirs —
M9); the **build order** differs in three places:

- **Billing's plan features first.** Sub-domain 8's typed plan features and `getPlanAccess` (8.A, BL2, BL12) are read by 1
  (`channel_accounts_max`, the trial port), 1B (the limit at route 11), 4 (PRO at save, go-live and run time) and 6 (PRO,
  `message_month_limit`), so 8.A and the plan read are built before 1; the rest of 8 follows in its place.
- **5 is split around 6.** Sub-domain 6's message table must exist before 5's new intake (intake writes `waiting` rows
  there): build 5's receiver and tables (5.A receiver, 5.B events and keys), then 6, then 5's intake. 7's migration then
  adds the messages' foreign key to broadcasts (SN17).
- **Built with 6.** The lane steps of 1's pick (route 3) and 1B's disconnect (route 8), 1B's pause, resume and activate
  (routes 9–11), 3's "What happened" and failed messages (routes 24–26) and 4's failed messages (routes 36–37) land in 6's
  ROUTE row, where the lanes and the message rows exist (CA5).

Build order: 8.A → 1 Channel connection → 1B Channel account → 2 Instagram account → 3 → 4 → 5 (receiver and tables) → 6 →
5 (intake) → 7 → 8 (the rest) → 9 → 10 → 11 → 12.

| # | Sub-domain | Folder (`src/domains/…`) | Paths (`/app/…` for 1–7; as written for 8–12) | Routes | Builds on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Channel connection | `app/sub-domains/channel-connection/` **(new)** (+ adapter folder `channel-connection-meta/`) | `social/channel-connections` (+ `{provider}/start`, `{provider}/callback`, `{provider}/deauthorize`, `{provider}/data-deletion`, `{channel_connection_id}`, `accounts`, `reconnect`, `ad-accounts`, `ads`) | 11 (1–5, 15–17, 40–42); RC-6 removed | organizations, users; 8 (`channel_accounts_max`, the trial port — M4); 1B's and 2's account rows and 6's lanes at the pick | **final (rev 5, confirmed 2026-11-24)** — no nested sub-domains |
| 1B | Channel account | `app/sub-domains/channel-account/` **(new)** | `social/channel-accounts` (+ `{channel_account_id}`, `pause`, `resume`, `activate`) | 6 (6–11) | 1; 8 (account limit); routes 9–11 and route 8's lane step built with 6 | **final (rev 5, confirmed 2026-11-24)** — no nested sub-domains |
| 2 | Instagram account | `app/sub-domains/instagram-account/` (+ `instagram-account-settings/`, `instagram-media/`) | `social/instagram/accounts/{channel_account_id}` (+ `settings`, `media`, `stories`) | 3 (12–14) | 1, 1B; 8 (PRO) | **final (rev 4, confirmed 2026-11-24)** — nested sub-domains 2.A–2.C |
| 3 | Contacts (shared, P48) | `app/sub-domains/contact/` (+ `contact-tag-event/`) | `contacts` (+ `bulk-actions`, `activity`, `failed-messages`), `contact-tags` — lists by `channel_account_id` | 9 (18–26) | 1B, 2; routes 24–26 over 4 and 6 | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 3.A–3.B |
| 4 | Automations (shared, P48) | `app/sub-domains/automation/` (+ `automation-run/`, `automation-backfill/` **(new)**) | `automations` — lists by `channel_account_id` (+ `go-live`, `pause`, `duplicate`, `keyword-test`, `failed-messages`, `backfills`) | 13 (27–39) | 1B, 2, 3; 8 (PRO, plan ended); 6 (message rows, the month count at go-live; routes 36–37 over its retry service) | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 4.A–4.C |
| 5 | Instagram webhook | `app/sub-domains/instagram-webhook/` (+ `instagram-webhook-event/`) | `social/channel-connections/meta/webhooks/instagram`, `social/instagram/webhook-events` | 3 (60–62) | 1, 1B, 2, 3, 4; 6 for intake's writes (intake built after 6) | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 5.A–5.B |
| 6 | Instagram sending | `app/sub-domains/instagram-sending/` **(new)** (+ `instagram-message/`, `instagram-attachment/`) | `social/instagram/accounts/{channel_account_id}/sending-status`, `usage` | 2 (63–64) | 1, 1B, 2, 3, 4, 8, 12; 5's receiver and tables | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 6.A–6.C |
| 7 | Broadcasts (shared, P48) | `app/sub-domains/broadcast/` **(new)** (+ `broadcast-segment/`, `broadcast-recipient/`) | `broadcasts` (+ `send`, `cancel`), `segments` (+ `audience-count`) — lists by `channel_account_id` | 13 (70–82) | 1B, 2, 3, 4, 6, 8 | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 7.A–7.C |
| 8 | Billing — Flowdm plans, plan states, trial | `billing/sub-domains/plan/`, `subscription/` (+ `trial-account.*`, `workers/subscription-plan-state-check.*`), `stripe-webhook/` | `/billing/plans` (+ `{plan_id}`), `/billing/subscriptions` (+ `change-plan`), `/billing/payment-methods` (+ `{payment_method_id}`, `default`), `/billing/webhook`, `/auth/me/context` | 9 (100–108) | organizations, users; the app's accounts port (1B) | **final (rev 4, confirmed 2026-11-24)** — nested sub-domains 8.A–8.D |
| 9 | Tenancy — roles and organization | `tenancy/sub-domains/organization/`, `member-roles/`, `membership/` (+ `membership-invitation/`) | `/tenancy/organizations`, `/tenancy/organization`, `/tenancy/organization/roles/*`, `/tenancy/organization/memberships`, `/tenancy/membership-invitations/{membership_invitation_id}/preview` | 11 (110–118, 141–142) | users; the app's codes (`app.permissions.ts`) and the upload code | **final (rev 3, confirmed 2026-11-24)** — nested sub-domains 9.A–9.C |
| 10 | Auth — sign-in | `auth/sub-domains/auth-method/` (+ `oauth/`), `auth-mfa/`, `auth-trusted-device/` **(new, no routes)**, `auth-session/` | `/auth/email/*`, `/auth/oauth/*` (+ `apple/callback`), `/auth/mfa/login`, `/auth/step-up`, `/auth/me/auth-methods/{auth_method_id}`, `/auth/me/sessions` (+ `{session_id}`), `/auth/me/mfa/{mfa_method_id}`, `/auth/me/webauthn/credentials/{credential_id}` | 14 (120–128, 143–147); 4 removed (RC-98–RC-101) | users; 9 (the MFA policy) | **final (rev 3, confirmed 2026-11-24)** — nested sub-domains 10.A–10.D |
| 11 | User and notify — profile, settings, notifications | `user/` (root), `user/sub-domains/user-settings/`, `user-notification-preferences/`; `notify/sub-domains/notification/` (+ two workers) | `/users/me`, `/users/me/settings`, `/users/me/organizations`, `/users/me/email-confirmation`, `/auth/email/confirm`, `/users/me/notification-preferences` | 9 (130–136, 148–149) | 10 (verification tokens, mail), 9 (memberships), the app's three ports | **final (rev 5, confirmed 2026-11-24)** — nested sub-domains 11.A–11.D |
| 12 | Upload — message files | `upload/` | `/uploads` (+ `{upload_id}/confirm`) | 2 (140, 150) | organizations; 9 (`upload:manage`) | **final (rev 4, confirmed 2026-11-24)** — no nested sub-domains |

Domain total: **105 routes** — 49 new, 55 changed (moves included; route 60 moved by P53, RC-115; routes 141–150 are RC-102–RC-111, numbered in rev 5 — P99: 45 + 10 = 55, as route-changes counts them), 1 already as built (RC-67, route 104); **5 removed** (RC-6, RC-98–RC-101). Against today, one clause per sub-domain: **1** a provider login (Meta's
Unified Login for Instagram, Facebook and ads) replaces the launch's Instagram Login connect (RC-6 removed, D24), and holds
the reconnect, the ad picker and Meta's two callbacks; **1B** new — the common account of any channel: many accounts per
organization under `{channel_account_id}` paths, with pause, resume and choose active; **2** the Instagram extension — settings,
posts and stories under `social/instagram/accounts/{channel_account_id}`; **3** a contact can now be opened, noted, tagged,
paused and acted on in bulk, with "What happened" and a retry of her failed messages; **4** the new automation shape with
go-live, pause, duplicate, a keyword test, a retry of its failed messages and past comments; **5** the same three routes,
with a key table, an 8-day events table and an intake that only saves; **6** new — the sending engine's status and the
message meter (it serves 3's and 4's failed-message retry); **7** new — broadcasts and segments; **8** Flowdm plans, the
trial, the move down at the period end and two card routes; **9** four fixed roles, `contact:update`, inviting several
emails, the invitation preview, the optional slug at create and the tile colour on read; **10** no passwords — four routes removed, Apple and trusted devices added, five more routes that end them or take the email code; **11**
onboarding fields, the organization chooser, email confirmation and notification kinds; **12** the message-file purpose on
upload and the audio checks on confirm. Rev 2 (the channel split, P40–P47) touched 1–8, 11 and 12 (renames for 8, 11, 12); 9 and 10 are unchanged. Rev 3
(P48–P51, M10) makes **3, 4 and 7 shared by every channel** (tables without the `instagram_` prefix, keyed by
`channel_account_id` with a `channel` column; paths `/contacts…`, `/contact-tags`, `/automations…`, `/broadcasts…`,
`/segments…`), adds the **two channel seams** — Instagram's intake (5) calls the shared contacts and run engine with
normalized event kinds, and the shared run engine and broadcasts save a waiting message through the channel's sending
sub-domain (6) — the token's refresh column (1, P49), **one feature check** in 1B (P50) and **Meta's usage per
connection** in 1 (P51); route numbers, counts and gates do not change. Rev 5 (P91–P100, M13) adds the scale review's fixes (P91–P96 — K16 and the owning
sub-domains; P97's kickoff defaults are listed under the rules) and settles the alignment check (P99): routes 141–150 numbered,
the plan stop on the channel account, `broadcasts.channel`; no route renumbered.

## Open questions — one-pass review

Every question of every sub-domain, in one table ([P31](decisions.md)). Each sub-domain's section 2 holds the same question
with its context. **All answered on 2026-11-24** ([P54–P89](decisions.md), confirmed by [P90](decisions.md); Merge notes M12):
the **Answer** column names each decision row. Three answers differ from the recommendation and are written into their
sub-domains — **MCQ3 → P56** (MC15, MC16), **BCQ2 → P76** (BC3, BC19), **BLQ4 → P80** (BL11, BL24); BLQ3 (P79) is the one
answer taken as the default (AMBER). MGQ2 comes from the merge (Merge notes M7). Rev 3 added CAQ2 (the feature check's
statuses, P50) and CTQ4 (where the tag list lives, P48).

| Id | Sub-domain | Question | Recommended | Alternative | Answer |
| --- | --- | --- | --- | --- | --- |
| MCQ1 | 1 Channel connection | A reconnect from a portfolio an account moved to: attach its row at the callback, or only when the owner picks it? | **At the callback** (MC6) — the account is the organization's already, the owner pressed Reconnect for it, and it saves a step; plan:L4676 reads the same | Only at a pick | **P54** — at the callback (as recommended) |
| MCQ2 | 1 Channel connection | Does the pick re-read the assigned accounts from Meta, or trust the list the callback read? | **Re-read** (MC7) — the pick can come minutes later and a stale list could attach an account the business no longer shares; one Graph call per pick | Keep the callback's list in the login state | **P55** — re-read from Meta at every pick (as recommended) |
| MCQ3 | 1 Channel connection | Which id does Meta sign on the Unified Login callbacks — the person, the Instagram account or the business (plan:L4699–L4705, a §43 test)? (rev 1 IAQ1) | **Match the account's `provider_account_id` now** (the plan's step 3a); an unmatched id is answered with its code and the team is emailed (MC16); a connection column only if the test says so — then a new decision | Also match `client_business_id`; or a person-id column on the connection | **P56 — not the recommendation**: the account id **and** the business id — `provider_account_id` first, else `client_business_id` (every account of that connection); an unmatched id still gets its code and the team an email; revisit after the §43 test (MC15, MC16) |
| MCQ4 | 1 Channel connection | Does the ads list read one ad account at a time, or every ad account of the connection in one list? (rev 1 IAQ2) | **One at a time** (`ad_account_id` required; route 41 lists the ad accounts) — Meta pages per ad account, so a merged list has no single cursor | All ad accounts merged in one list | **P57** — one ad account at a time (as recommended) |
| MCQ5 | 1 Channel connection | Does "Reconnect" get its own route? | **Route 40**, a login bound to the connection (MC17) — the callback can refuse another business, and a connected connection can re-grant `ads_read` | Only a new login through route 1 (rev 1) | **P58** — its own route, 40 (as recommended) |
| CAQ1 | 1B Channel account | Where does "one organization per account" live, now that status is on `app.channel_accounts` and the Instagram id on the extension? | **`provider_account_id` on the channel account**, unique per channel while not revoked, written with the extension's `instagram_user_id` in one commit (CAC5) | A status copy on the extension | **P60** — on `app.channel_accounts` (as recommended, CAC5) |
| CAQ2 | 1B Channel account | P50's one feature check answers four reasons — which status does a route give each, when it refuses outright (not as a go-live list item)? | **`422 channel_lacks_feature`** (the channel cannot do it — the request asks for something impossible), **`409 permission_not_granted`** (the connection's state; the same call passes after a reconnect that grants it, route 40), **`403 plan_lacks_feature`** (was `plan_feature_required`, K11), **`422 feature_not_offered`** (as route 12's refusal, M2) — CA11 | `403` for all four | **P61** — split: `422` · `409` · `403` · `422` (as recommended) |
| CTQ1 | 3 Contacts | The tag list's cache key: be-read-cache-guard rule 1 takes a key from the verified scope, never a request parameter, but the list is per account | **`…:<organization>:<account>`**, the account id read back from Postgres inside the scope (CT8) — the organization segment is the tenant boundary and comes from the scope | One key per organization holding every account's list (ten lists recomputed on every tag change) | **P64** — organization + account, the account read back inside the scope (as recommended, CT8) |
| CTQ2 | 3 Contacts | Must every contact list name its account? | **Required** (CT2) — the app is switched per account and the indexes lead with it; the launch is unreleased (P29) | Optional, default every account | **P65** — required (as recommended) |
| CTQ3 | 3 Contacts | Do bulk actions select by ids only, or also "every contact matching these filters"? | **Both** (CT7) — "select all 12,000" is the case pieces of 500 exist for (plan:L1039) | Ids only (1–500) | **P66** — ids (1–500) or a filter, in pieces of 500 (as recommended) |
| CTQ4 | 3 Contacts | The account's tag list now that contacts are shared: `GET /contact-tags?channel_account_id=` or keep it under the account (`/social/channel-accounts/{channel_account_id}/contact-tags`)? | **`/contact-tags?channel_account_id=*`** (route 22, CT18) — every other contact read is a shared path filtered by the account, and the contact sub-domain owns the path it serves (M6's rule); the cache key still reads the account back inside the scope (CTQ1) | Under the channel account — a 1B path served by 3 | **P67** — `GET /contact-tags?channel_account_id=` (as recommended) |
| AUQ1 | 4 Automations | Go-live answers a list of problems, each with its step (plan §5.1) — which status? | **`409 automation_not_ready` with `errors[]`** — the request is fine, the saved state conflicts and the same call passes once fixed (response-codes' 409 vs 422 rule); `errors[]` on this 409 is documented in `response-codes.md` | `422` with `errors[]` | **P68** — `409 automation_not_ready` with `errors[]` (as recommended) |
| AUQ2 | 4 Automations | Does a save of a live or paused automation also run the account, plan and month checks (plan:L670)? | **Content checks only** (AU12) — a month-limit or plan-ended organization must still fix a refused text (P10); the rest run at go-live | The full go-live list on every save | **P69** — content checks only (as recommended) |
| AUQ3 | 4 Automations | A draft "needs only a name" (D28) — is the way to start chosen at create? | **`trigger_type` required at create** — the editor opens on a chosen way, a later change stays in the same group (plan:L687), every database check keys on it | Optional until go-live | **P70** — required at create (as recommended) |
| AUQ4 | 4 Automations | Drop the plan's `app.automation_run_open_key` (db-changes' proposal under P35)? | **Drop** — with P35 a new allowed start cancels the open run in the same commit, so `idx_automation_runs_one_open` was enough while runs were one table; WC-45 frees no key | Keep the key table | **P71** — drop (as recommended); **superseded by P100** (rev 5): runs split by month need the key table `app.automation_run_open_keys` (AU37) |
| WHQ1 | 5 Instagram webhook | How is "our own sent message" recognised before saving (plan step 3, the Redis `mid:` note)? | **A Postgres lookup** of the echo's `mid` in `app.instagram_messages` inside the store unit — the row holds `instagram_message_id`; no data only Redis has (P32); an early echo is stored `received` and matched by intake within 10 minutes (plan §27.13) | The plan's Redis `mid:` note (10 min; with P5's 60-second cap) | **P62** — a Postgres lookup (as recommended) |
| WHQ2 | 5 Instagram webhook | The inbound flood count (`inbound:{account}:{contact}`, 1 minute, plan §26.4 rule 5) | **Intake counts her message events of the last minute in Postgres** — the events are saved anyway; an index on (`channel_account_id`, `contact_instagram_user_id`, `created_at`) answers "more than 20 in the last minute" | The webhook adds 1 to a Redis counter | **P63** — Postgres at intake (as recommended) |
| SNQ1 | 6 Instagram sending | Keep `app.sending_helper_slots` (16 slots leased by servers, plan §34.1)? | **Drop it** — the repair runs as scheduler repeat jobs, one worker per tick (P7); the two per-server duties (clock, Redis watch) need no slot; db-changes loses the table | Keep it as the plan writes | **P73** — drop `app.sending_helper_slots` (as recommended) |
| SNQ2 | 6 Instagram sending | `.env.example`'s `SENDING_ENABLED`? | **`true`** — the dev value ships active (CLAUDE.md), the schema default stays `false`; a hosted environment still needs its own `SENDING_ENVIRONMENT_ID` | `false` in the template too | **P74** — `true` in the template (as recommended) |
| BCQ1 | 7 Broadcasts | How long does a deleted broadcast or segment wait before its purge? | **90 days** — the same as recipients' keep (P33), so a purge never leaves numbers no row explains | 30 days; or the automation's 180 | **P75** — 90 days (as recommended) |
| BCQ2 | 7 Broadcasts | May a Free organization make segments and count audiences? | **Yes** — only broadcast create and send are PRO (RC-48, RC-52); a trial's segments survive it and the editor can show the count before an upgrade | No — segments are PRO too | **P76 — not the recommendation**: PRO only — segment create, edit and count need Creator or Studio (`403 plan_lacks_feature`, the `segments` switch, P83); Free sees the upsell; a trial's segments stay saved, unusable until an upgrade (BC3, BC19) |
| BLQ1 | 8 Billing | How does the move down wait for the period end? | **A Stripe subscription schedule** + two mirror columns `scheduled_plan_id`, `scheduled_change_at` — Stripe invoices the renewal itself; the columns let route 103 and the billing screen show the change without a Stripe call | Keep the target only on our row and change Stripe's price ourselves at renewal (races the invoice) | **P77** — the Stripe subscription schedule (as recommended) |
| BLQ2 | 8 Billing | `{payment_method_id}` is Stripe's `pm_…` id, not one of our public ids | **A third non-entity param** beside `{provider}` and `{slug}` — cards live only in Stripe (plan:L8069); checked by shape (`pm_` + 1–250 letters and digits) and by ownership | Mint our own ids (a new table of cards) | **P78** — Stripe's id, a third non-entity param (as recommended) |
| BLQ3 | 8 Billing | The plan feature key `dm_month_limit` (db-changes open item) | **`message_month_limit`** — full names, and channel-neutral since rev 2 (P43, P47: the table is the shared `message_month_counts`; rev 1 had `direct_message_month_limit`); applied across this file (M1, M9) | The plan's `dm_month_limit` | **P79** — `message_month_limit` (the recommendation, kept as the default — AMBER) |
| BLQ4 | 8 Billing | The features of the turned-off rows Starter, Growth and Pro (a typed read refuses their old keys) | **Map them up**: Starter → Creator's, Growth and Pro → Studio's — an organization still paying an old plan keeps paid powers; no Stripe change | Give them Free's | **P80 — not the recommendation**: Free's — an organization still on an old row is held to Free's features and limits until it picks Creator or Studio; Stripe untouched; a notice and an email (BL11, BL24) |
| TNQ1 | 9 Tenancy | The lavender tile value: the shared chip tones (`CHIP_TONE`) store it as `lav` | **Rename `lav` → `lavender`** everywhere in the same PR (a tenancy migration rewrites the `tone` rows and both `CHECK`s; meepzo-fe follows) — the full-names rule; one tone list for roles, members and the new column | Keep `lav` as a wire literal | **P81** — rename to `lavender` (as recommended) |
| TNQ2 | 9 Tenancy | An invite takes one role (plan:L7891) but the code takes `role_ids` (main first) | **Keep `role_ids` with exactly one** — the shape `PATCH …/memberships` uses; turning extra roles on later is no contract change | A new `role_id` field | **P82** — `role_ids` with exactly one (as recommended) |
| ATQ1 | 10 Auth | Passwords: remove the code, or keep it behind `AUTH_PASSWORDS_ENABLED` false (the plan's switch)? | **Remove** the four routes and the password code paths now (AT1) — the migration empties every `password_hash`, so the switch could never come back on without a reset flow; the column stays | A code constant that leaves them unregistered | **P84** — remove (as recommended) |
| ATQ2 | 10 Auth | Apple's form callback must end in a browser redirect (`303`, plan:L7686), while every `POST` answers `200` with no exemption | **One named exemption** — route 124 answers `303` with `Location`, listed in one allowlist the method-status middleware and the success-status gate both read, pinned by a test; CLAUDE.md and `response-codes.md` then say "no exemptions except the Apple form callback (303)" | `200` with a tiny HTML page whose `<meta http-equiv="refresh">` goes to the app (no exemption); or Apple's `response_mode=query` (only without the name and email scopes) | **P85** — the one named `303` exception (as recommended) |
| ATQ3 | 10 Auth | The IP-to-place file (plan:L8804 — its licence and monthly updates) | **DB-IP "IP to City Lite"** (CC BY 4.0, no account or key; `.mmdb` read with the `maxmind` package; the file comes with the monthly image build; unset path → place empty, never an error) | MaxMind GeoLite2 City (free account + licence key, its EULA); or no place | **P86** — DB-IP "IP to City Lite" (as recommended) |
| UNQ1 | 11 User and notify | The preferences API shape: the screen saves kind × channel (plan:L8150) | **The routes speak kinds** (`{ kind, channel, is_enabled }`); the server writes one row per type of the kind — only `NOTIFICATION_KINDS` knows the kinds; per-type rows stay the stored form | Keep type × channel and let the app expand kinds | **P87** — per kind (as recommended) |
| UNQ2 | 11 User and notify | In-app off but email on: the email still needs a dedupe key (plan:L8180 uses the notification's public id) | **The caller's `dedupe_key`**; the outbox key is `<type>:<dedupe_key>:<user>` and the in-app row is written only when in-app is on — every new type already has a "once" rule naming its key | Always write the row, hidden when in-app is off | **P88** — the caller's `dedupe_key` (as recommended) |
| MGQ2 | header (K3) | Which idempotency rule do the app's signed-in `POST`s follow? | **The rewritten K3** — a `POST` that creates a row or starts background work requires the key; state actions (9, 10, 32, 33), a `POST` that saves nothing (35) and the login and reconnect starts (1, 40, a one-use Redis state — MC4, MC17) take none; it matches CLAUDE.md's per-route `idempotencyRequired` and the platform domains | The launch K3 and the template's hand-over line "every `POST` is `req`" — routes 1, 9, 10, 32, 33, 35 and 40 gain `req` | **P89** — creates and jobs only: the rewritten K3 (as recommended) |

## Merge notes

The three drafted parts were merged verbatim except for these harmonisations (M1–M8); M9 is rev 2's channel split, M10
rev 3's shared product and channel seams, M11 the webhook paths (P53), M12 rev 4's answers (P54–P90) and M13 rev 5's scale and alignment fixes (P91–P100).

| # | Note |
| --- | --- |
| M1 | **`dm_month_limit` → `direct_message_month_limit` (rev 1) → `message_month_limit` (rev 2, P47)** (BLQ3, P6): replaced in sub-domain 6 (SN15, SNC7 — three places); only BLQ3's question still names the old key. `dm` as a *value* (`also_start_from`, `source` on route 35, the `dm:<date>` once key in 5) is a wire value and is not renamed here — say if it should be. |
| M2 | **`feature_not_offered` and `instagram_feature_not_offered` are two different things, both kept** (P36): `feature_not_offered` is the **go-live problem code** — one item of `409 automation_not_ready`'s `errors[]` when an automation uses a feature in `APP_UNTESTED_META_FEATURES` (4.A, AU4); `instagram_feature_not_offered` is the **settings-field reason** — `422` when route 12 turns mark-as-seen on while it is untested (2.B.9). Both places now say which is which. |
| M3 | **`lav` → `lavender`** (TNQ1): the body already writes `lavender` (TN8, `logo_color`'s `CHECK`); `lav` remains only as today's value inside TNQ1. |
| M4 | **The pick checks the trial** (sub-domain 8's trial port, BL14, BL18): MC7 and 1.9 gain `409 trial_used_by_account` and `recordTrialAccounts` in the pick's commit; sub-domain 1 builds on 8. |
| M5 | **RC-17 and RC-18** (Meta's deauthorize and data-deletion callbacks) are claimed by one sub-domain only — rev 1 sub-domain 2 (2.D), rev 2 sub-domain 1 (routes 16–17, MC14–MC16, M9); sub-domain 5 serves RC-16 and RC-19 and names neither. |
| M6 | **The failed-messages routes had two owners.** Part 1 numbered RC-37–RC-40 as 4's routes 36–37 and 3's 25–26; part 2 as 6's routes 65–68, with its own object shape. Settled by the main session's rule — **a route lives in the sub-domain whose path it has**: `/automations/{automation_id}/failed-messages/…` stays in 4 (36–37) and `/contacts/{contact_id}/failed-messages/…` in 3 (25–26), each calling sending's summary query and retry service; 6 keeps only its own paths (63–64). In 6: rows 65–68 removed from 6.4, 6.7 and 6.B (6.B.4, .6–.9 now point at 3.A and 4.A), the intro, SN1, SN18, WC-42's trigger, 6.12 and SNC14 point at 3's and 4's routes; numbers 65–68 stay unused (no renumbering). The objects are 3.A.6's (`failed_count`, `retryable_count`, `not_retryable`, `horizon_days`; `expected_retry_count`, `is_queued`); SN18's reason `window_closed` became 3.A.6's `chat_closed`. |
| M7 | **K3**: the header carries part 1's rewritten K3 (MGQ2). Part 2's 7.5 still cites the launch K3 ("so 76 and 82 too"), but under the rewrite routes 76 (cancels a broadcast's waiting messages) and 82 (may start the background count, WC-39) keep `req` all the same — no row changes. |
| M8 | **Dropped** from the merged body: each part's "Header inputs" block (built into this header) and its own "Before you hand this part over" list (re-run on the whole file — see the end). Their lists of changes for `db-changes.md`, `route-changes.md` and `worker-changes.md` go to the change files' sync; this file edits none of them. |
| M9 | **The channel split, P40–P47 (rev 2, 2026-11-23).** The owner chose a common core for the login and the account and Instagram-specific everything else. (1) Sub-domain 1 **Meta connection → Channel connection** (`channel-connection/`, `app.channel_connections` + `app.channel_connection_tokens`, `provider` `meta`; the Meta client moved into its adapter folder `channel-connection-meta/`, MC2); it gains the reconnect start (40), one connection (42), the ad accounts (41), the ads (15, from 2) and Meta's two callbacks (16–17, from 2.D — P46). (2) New **1B Channel account** (`channel-account/`, `app.channel_accounts`: channel, connection, status, display name, pause / suspend / plan stop, the automation switch — P42); routes 6–11 moved to it; numbered 1B so 2–12 keep their numbers and their citations. (3) Sub-domain 2 is the **Instagram extension** (`app.instagram_accounts` 1:1, settings, media; routes 12–14); 2.D removed. (4) P44: the product tables and folders of 3, 4 and 7 take the `instagram_` / `instagram-` prefix and their paths move under `/social/instagram/…`; path ids `{contact_id}`, `{automation_id}`, `{broadcast_id}`, `{segment_id}`, `{automation_backfill_id}` and reference columns (`contact_id`, `automation_id`) keep their short names. (5) P43: `meta_attachments` → `instagram_attachments`, `direct_message_month_counts` → `message_month_counts` (shared), features `message_month_limit`, `channel_accounts_max`. (6) P47: every `instagram_account_id` → `channel_account_id` (pointers → `app.channel_accounts`, filters, bodies — `stop_channel_account_id`, `keep_channel_account_ids`), job payloads `channelAccountPublicId`, reason `channel_account_not_found`, audit `app.channel_connection.*`, `app.channel_account.*`, `app.instagram_contact.*`, `app.instagram_automation.*`, `app.instagram_broadcast.*`, `app.instagram_segment.*`. (7) P45: webhook, queues and workers stay Instagram's; 5 adopts F3 and F5 (WH25, WH26). Permission codes unchanged (P47). Ids: MC kept (+ MC13–MC17: MC13 was IA16, MC14–MC16 were IA18–IA20), IAQ1 → MCQ3, IAQ2 → MCQ4; 1B's CA2–CA9 were IA1–IA5, IA9–IA11 (CA1, CA10 new; CA10 from IA7), CAC1–CAC4 were IAC1, IAC2, IAC4, IAC6 + IAC7; MCC8 took IAC9's ad part, MCC9 was IAC11; IA ids left in 2 keep their numbers. **Route numbers: none renumbered** — moved routes keep theirs; the three new routes take 40–42 (the gap after 39). Old → new: |

M9's route table — numbers stay; what moved (rev 1 → rev 2, paths under `/api/v1/app`):

| Route | Rev 1 path · sub-domain | Rev 2 path · sub-domain |
| --- | --- | --- |
| 1–5 | `social/meta/connect/start`, `…/connect/callback`, `social/meta/connections` (+ `{meta_connection_id}`, `…/accounts`) · 1 | `social/channel-connections/{provider}/start`, `…/{provider}/callback`, `social/channel-connections` (+ `{channel_connection_id}`, `…/accounts`) · 1 |
| 6–11 | `social/instagram/accounts` (+ `{instagram_account_id}`, `pause`, `resume`, `activate`) · 2 | `social/channel-accounts` (+ `{channel_account_id}`, `pause`, `resume`, `activate`) · 1B |
| 12–14 | `social/instagram/accounts/{instagram_account_id}/settings`, `media`, `stories` · 2 | `social/instagram/accounts/{channel_account_id}/settings`, `media`, `stories` · 2 |
| 15 | `social/instagram/accounts/{instagram_account_id}/ads` · 2 | `social/channel-connections/{channel_connection_id}/ads` · 1 |
| 16–17 | `social/instagram/deauthorize`, `social/instagram/data-deletion` · 2 | `social/channel-connections/{provider}/deauthorize`, `…/{provider}/data-deletion` · 1 |
| 18–26 | `contacts…`, `social/instagram/accounts/{instagram_account_id}/contact-tags` · 3 | `social/instagram/contacts…`, `social/instagram/accounts/{channel_account_id}/contact-tags` · 3 |
| 27–39 | `automations…` · 4 | `social/instagram/automations…` · 4 |
| 63 | `social/instagram/accounts/{instagram_account_id}/sending-status` · 6 | `social/instagram/accounts/{channel_account_id}/sending-status` · 6 |
| 70–82 | `broadcasts…`, `segments…` · 7 | `social/instagram/broadcasts…`, `social/instagram/segments…` · 7 |
| 40, 41, 42 | — | **new**: `social/channel-connections/{channel_connection_id}/reconnect` (RC-113), `…/ad-accounts` (RC-114), `…/{channel_connection_id}` `GET` (RC-112) · 1 |

| # | Note |
| --- | --- |
| M10 | **Room for WhatsApp and TikTok, P48–P51 (rev 3, 2026-11-24).** P48 (option B) supersedes P44. (1) **Shared again**: the product tables lose the `instagram_` prefix and are keyed by `channel_account_id`, with a `channel` column where the row needs it — `app.contacts`, `app.contact_tag_events`, `app.automations`, `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.automation_counts`, `app.automation_reply_states`, `app.automation_backfills`, `app.segments`, `app.broadcasts`, `app.broadcast_recipients`; folders `contact/` (+ `contact-tag-event/`), `automation/` (+ `automation-run/`, `automation-backfill/`), `broadcast/` (+ `broadcast-segment/`, `broadcast-recipient/`); index, check, file, service (`BroadcastService`, `BroadcastRecipientService`) and audit names (`app.contact.*`, `app.automation.*`, `app.automation_backfill.*`, `app.broadcast.*`, `app.segment.*`) follow; sub-domains 3, 4 and 7 are "Contacts", "Automations" and "Broadcasts" again; their routes move to `/contacts…`, `/automations…`, `/broadcasts…`, `/segments…`, and route 22 to `/contact-tags?channel_account_id=` (CTQ4); every list keeps `channel_account_id` required. (2) **Still Instagram's** (P43, P45 unchanged): `instagram_accounts` (the extension), its settings and media, every sending table, `instagram_attachments`, the webhook events and keys, the four queues `instagram-webhook`, `instagram-send-slow`, `instagram-send-fast`, `instagram-tasks` and their workers, the routes under `/social/instagram/…`. The shared sub-domains' jobs (contact bulk action, tag-event pick-up, past comments, segment count, broadcast audience) stay registered on `instagram-tasks`, the one task queue this iteration; a later channel registers the same job names on its own queue. (3) **The capability list** `CHANNEL_CAPABILITIES` — a code constant in 1B (CA11), Instagram the only entry: per channel its ways to start, steps, message kinds and features. (4) **The two seams** — outbound, `ChannelSendingPort` (AU34, SN22): the shared run engine and broadcasts never send; they save a waiting message through the account's channel's sending sub-domain (Instagram's 6 today), which picks the lane and reports `sent` · `failed` · `skipped` · `unknown` back to the run engine's `recordMessageResult` (4.B) or the recipient service (7.C); inbound (WH27, CT18): Instagram's intake turns its kinds into normalized event kinds and calls the shared entry points of contacts and the run engine. (5) **P49**: `app.channel_connection_tokens` gains `encrypted_refresh_token` (empty for Meta) and `token_type` `system_user` · `oauth_user` (MC18). (6) **P50**: one feature check in 1B (CA11) — the channel's capability **and** the connection's granted permission **and** the plan **and** the Meta test — replaces the three separate checks (capability, PRO, `APP_UNTESTED_META_FEATURES`); go-live (AU13, AU34), settings (2.B) and the engine (SN22) call it; its reasons `channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature` (renames `plan_feature_required` across this file) and `feature_not_offered` (now also route 12's refusal: `instagram_feature_not_offered` is retired, so M2's two names become one; CAQ2 holds the statuses). (7) **P51**: Meta's usage (`X-Business-Use-Case-Usage` and the app usage) is kept **per connection** by the shared Meta client (MC19 — columns on `app.channel_connections`, a short Redis copy for gate 1); every channel's engine reads it before a call (SN23); no Instagram lane keeps its own. P52 changes nothing here (the ad picker reads Meta live, MC13). New ids: MC18, MC19, MCC11, MCC12, CA11, CAC6, CAQ2, CT18, CTC12, CTQ4, AU34, AU35, AUC13, WH27, WHC17, SN22, SN23, SNC16, BC18, BCC10, K15. Route numbers, counts, gates and idempotency are unchanged. Old → new: |
| M11 | **Meta webhooks, one route per object (P53, rev 3, 2026-11-24).** Routes 60–61 move from `/api/v1/app/social/instagram/webhook` to `/api/v1/app/social/channel-connections/meta/webhooks/instagram` (the Instagram object's callback URL in the Meta dashboard); later objects get their own path (`…/webhooks/page`, `…/webhooks/whatsapp-business-account`, `…/webhooks/ad-account`). Shared: only the receiver code in `channel-connection` (app-secret signature, verify-token handshake, envelope split). Separate: each object's event tables, intake queue and workers (Instagram: `instagram_webhook_events` + keys, P45). Route 62 (`/social/instagram/webhook-events`) is unchanged. Route numbers unchanged |
| M12 | **Your answers, P54–P90 (rev 4, 2026-11-24) — the route review is final.** Every open question is answered (the header table's and each section 2's **Answer** column) and every sub-domain and nested sub-domain is `final (rev N, confirmed 2026-11-24)` (P90). (1) **Three answers differ from the recommendation** and are written in: **MCQ3 → P56** (MC15, MC16, MCC9: Meta's deauthorize and data-deletion calls match `provider_account_id` first, else `client_business_id` — every not-revoked account of that business's connections; a second resolver `app.resolve_organization_public_ids_for_provider_business` and the index `idx_channel_connections_provider_business`; an unmatched id still answers its code and emails the team); **BCQ2 → P76** (BC3, BC19, BCC11: segment create, edit and the audience count are PRO — Free → `403 plan_lacks_feature` on routes 78, 80, 82 and the upsell; reading and deleting stay open; a trial's segments stay saved, unusable until an upgrade); **BLQ4 → P80** (BL11, BL24, BLC13: the switched-off Starter, Growth and Pro rows carry Free's features and limits, so an organization still on one is held to Free until it picks Creator or Studio; Stripe untouched; route 108's `is_plan_choice_required`, the billing notice and one email `billing.plan_choice_required` — UN8 now nine new types, 20 in all). (2) **P83 — one plan switch per feature** (supersedes BL12's `is_pro_enabled`, the plan's `pro_features` bundle): the plan's typed `features` hold `message_month_limit`, `channel_accounts_max`, `has_priority_support` and `feature_switches`, one boolean per feature key (`PLAN_FEATURE_KEYS`, billing's; 1B's `CHANNEL_FEATURES` names each feature's key — CA11). The PRO switches: email ask `email_ask`, phone ask `phone_ask`, reply like a person `reply_like_person`, more than one public reply line `multiple_public_reply_lines`, message versions `message_versions`, broadcasts `broadcasts`, segments `segments`, past comments `past_comments`, extra delay `extra_delay` — off on Free, on for Creator and Studio; Studio alone `has_priority_support`. The one feature check (P50, CA11) reads the exact switch; a move down (D57) turns off exactly the switches the new plan lacks (BL8, WC-38); "PRO" is a label, not a field. Applied in K11, CA11, AU4, 2.B, BC3, BC19, BL12, BL13, 8.A.3, 8.A.6, BLC6. (3) **P59 — permission codes**: the shared Channel connection (1) and Channel account (1B) routes 1–11, 15, 40–42 are gated by the new `channel-account:read` / `channel-account:manage` — the same roles (Owner and Admin manage; Editor and Viewer read); routes 16–17 stay PUBLIC; Instagram settings and media (2) keep `instagram-account:*`, the webhook events (5) `instagram-webhook-event:read`; tenancy's migration `tenancy_permission_channel_account` adds the two codes and copies every grant of their `instagram-account:*` twins (TN12, TNC8 — P59's "rename", done as add-and-copy because Instagram keeps its codes); the reconnect notice goes to `channel-account:manage` (CA4, CAC2); K4 counts twelve app codes. (4) **P72 — workspace = organization**: identifiers, columns, routes and codes say `organization` (the one identifier with the word was the plan's `app_member_workspace_counts`, already `app_member_organization_counts`); the prose says organization too — 9.A is "Organization", 11.A "the organization chooser" — and "workspace" stays only where a screen is quoted (the Roles matrix's "Workspace · …" groups, "Workspace paused"). (5) **P73** drops `app.sending_helper_slots` (the repair runs as scheduler repeat jobs, P7); **P85** makes the Apple form callback (route 124) the one named `303` exception (K2); **P89** confirms K3 as rewritten — creates and jobs take `X-Idempotency-Key`, state switches, "try it" and the login / reconnect starts do not. (6) Revs bumped where content changed — 1, 1B, 2–7 and 11 to rev 4, 8 and 12 to rev 3, 9 and 10 to rev 2; each changed sub-domain's section 1 says what. New ids: BC19, BCC11, BL24, BLC13, TN12, TNC8, M12. Route numbers, counts and idempotency unchanged; gates change by P59 only, and routes 78, 80, 82 gain a plan refusal (P76). |
| M13 | **The scale review and the alignment check, P91–P100 (rev 5, 2026-11-24).** The owner confirmed these fixes; the review stays final and the frontend's routes 1–140 are untouched. (1) **P91** — the send, intake and task workers take a database slot from an in-process limiter (≈ 16–24 a process; 2 s, then the ticket goes back) and the connection budget counts the slots, not job places; the send concurrency settings get their own maximum; the send workers run as their own service (queue family `instagram-send`) — SN24, SN2, SNC2, SNC17, K8, K16. (2) **P92** — the high-volume clean-ups run hourly until a ≈ 10-minute budget is spent, capped per table from the plan's rows a day × 2, with an "oldest row past its keep time" gauge per table alerting after 1 day — SN6, SNC5, 6.3, 6.10 (WC-53, WC-54), BC4, BC7, BC16, BCC3, BCC9 (WC-62, WC-53); in 4 and 5 the clean-ups become part drops (P96). (3) **P93** — the missed-comment full pass keeps the normal round's limits (comments of the last 7 days, 25 posts), runs at the lowest priority, stops at 60 % Meta usage and fans out one job per account — WH17, WHC10 (WC-26). (4) **P94** (refines P73's text) — one repeat job per repair duty, in parallel, each until a 40 s budget is spent (no fixed 500 cap), re-adding tickets in bulk, with a round-time and backlog metric per duty — SN6, SNC5, 6.10, BC7, BC11, BCC3, BCC7. (5) **P95** — `app.sending_states.minimum_compatible_settings_version`, raised only by an incompatible release: a server older than it takes no tickets, an older-but-compatible one does; a rollback step and command in be-path-to-production — SN7, SNC6, 6.A.3. (6) **P96** (supersedes P33's plain list) — `automation_runs` and `automation_run_events` split by month of the run's start, `automation_comment_logs` by month, `instagram_webhook_event_keys` by Meta's event day (the dedupe rule kept); expiry drops a part; the shared upkeep covers them — AU36, AUC14, 4.3, 4.B.3, AU22, AU23, AU30, WH20, WH24, WHC12, WHC13, WHC15, SN17; `broadcast_recipients` stays plain (BC16). (7) **P97** — the kickoff defaults S2, S5–S11, S13, S14, S17–S21, S25, S26, S29 are listed under the rules (after K16) and built at kickoff as the review's Fix column says; a rule here that one of them replaces carries "→ S<n>, P97". (8) **P98** (S22–S24, S27, S28) goes to KICKOFF.md's open items, not here. (9) **P99** — names follow this file (`usage_read_at`, `connection_status`, `paused_by_user_id`); RC-102–RC-111 are routes **141–150** (9.A: 141–142; 10.B–10.D: 143–147; 11.A: 148–149; 12: 150), so the total is 105 = 49 new + 55 changed + 1 as built; route 60 cites RC-115; `broadcasts.channel` in 7.3 and 7.A.3; **the plan stop lives on `app.channel_accounts`** (`plan_stop_reason` `plan_limit` · `plan_ended` · `plan_downgrade` with `plan_stopped_at` — `plan_limit` holds the slow, fast and broadcast lanes and the reply lane goes on, D62; the other two hold all four) and the lanes keep only their error stop — CA3, CA9, 1B.3, 1B.6, 1B.9, SN8, SN9, SN12, 6.3, 6.A.3, 6.A.6, 6.10, SNC10, BL7, 8.B.10; WC-62 (the purge, BC4), WC-63 (the grouped note, UN13), WC-64 (the trusted-device clean-up, 10.C), WC-65 (seat sync off, BL9) cited; WC-45 cited as CHANGED (AU30). (10) **P100** (reverses P71 / AUQ4) — one open run per automation and person is the key table `app.automation_run_open_keys` (written and deleted in its run's commits, the P35 swap in one commit, a repair duty for leftovers) — AU23, AU37, AUC15, 4.3, 4.B.3, WH14, WHC8, SN6. (11) Revs: 1, 1B, 3–7 and 11 to rev 5, 8 and 12 to rev 4, 9 and 10 to rev 3; 2 unchanged (rev 4); each bumped sub-domain's section 1 says what. New ids: K16, SN24, SNC17, AU36, AU37, AUC14, AUC15, M13. Routes 141–150 added, none renumbered; the gates and idempotency of routes 1–140 unchanged. |

M10's route table — numbers stay; what moved (rev 2 → rev 3, paths under `/api/v1/app`):

| Route | Rev 2 path · sub-domain | Rev 3 path · sub-domain |
| --- | --- | --- |
| 18–21, 23–26 | `social/instagram/contacts…` · 3 Instagram contacts | `contacts…` · 3 Contacts |
| 22 | `social/instagram/accounts/{channel_account_id}/contact-tags` · 3 | `contact-tags?channel_account_id=` · 3 (CTQ4) |
| 27–39 | `social/instagram/automations…` · 4 Instagram automations | `automations…` · 4 Automations |
| 70–76 | `social/instagram/broadcasts…` · 7 Instagram broadcasts | `broadcasts…` · 7 Broadcasts |
| 77–82 | `social/instagram/segments…` · 7 | `segments…` · 7 |

## Code layout and tables without routes

Every app sub-domain is one folder, laid out like a domain; the domain's shared kernel stays at `src/domains/app/`
(`app.routes.ts`, `app.container.ts`, `app.permissions.ts`, the app settings file with `APP_UNTESTED_META_FEATURES` — P4,
owned by 6, read by 1B's feature check — P50). The folders fall in three groups (rev 3, P48):

- **Common to every channel** — `channel-connection/` (with the Meta adapter folder `channel-connection-meta/`, which holds
  the one Meta Graph client and keeps Meta's usage per connection — P51) and `channel-account/` (with the capability list
  `CHANNEL_CAPABILITIES` and the one feature check — P50).
- **The shared product** — `contact/`, `automation/`, `broadcast/`: tables without a channel prefix (`app.contacts`,
  `app.automations`, `app.broadcasts`, `app.segments`, …), each row keyed by `channel_account_id` (+ `channel` where the row
  needs it); they call a channel only through the two seams (K15).
- **Instagram's** — `instagram-account/`, `instagram-webhook/`, `instagram-sending/`, each table `app.instagram_*`, except
  the two shared counters `app.message_month_counts` and `app.sending_states` (P43); `instagram-sending/` implements the
  outbound seam and `instagram-webhook/` calls the inbound one. A later channel (WhatsApp, TikTok) adds its own three.

Sub-domains 8–12 change the platform domains' own folders in place, with new migrations only
(D48). A table with no routes of its own is a persistence part of its parent: schema and repository (and a service only
when it holds logic) in the parent's folder, **no controller, no routes file**; the parent's service writes it.

| Sub-domain | Table | Lives in | Written by |
| --- | --- | --- | --- |
| 1 | `app.channel_connection_tokens` | `channel-connection/` (folder root) | the connection's token service — the callback (route 2; a reconnect replaces it); deleted when the connection is `revoked` (route 5, or 1B's last account) |
| 2 | `app.instagram_accounts` | `instagram-account/` (folder root) | the extension service only — 1's pick, the profile refresh, the set-up job, the erasure; read inside 1B's routes |
| 2 | `app.instagram_media` | `instagram-account/instagram-media/` | the media service only — intake's posts (5), "next post" links (4), the missed-comment watch; routes 13–14 read Meta live and never write it |
| 3 | `app.contact_tag_events` | `contact/contact-tag-event/` | the tag change's commit (contact service, intake); its pick-up and retention workers |
| 4 | `app.automation_counts`, `app.automation_reply_states` | `automation/` (folder root) | the run engine in the event's commit (AU19); the reply-state service, called back by 6 for the public-reply pacing |
| 4 | `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.automation_run_open_keys` | `automation/automation-run/` | the run engine (4.B), called by intake (5); split by month, parts dropped by the shared upkeep (AU36, P96); the open-run keys written and deleted with their runs (AU37, P100) |
| 5 | `app.instagram_webhook_event_keys` | `instagram-webhook/instagram-webhook-event/` | the store function (webhook, missed comments, past comments); split by Meta's event day, its day parts dropped by the shared upkeep (WH20, P96) |
| 6 | `app.instagram_send_lanes`, `app.instagram_send_stops`, `app.instagram_send_minute_counts`, `app.message_month_counts`, `app.sending_states` | `instagram-sending/` (folder root) | the lanes, the claim, the repair duties; lanes created by 1's pick through `createLanesForAccount` |
| 6 | `app.instagram_send_attempts` | `instagram-sending/instagram-message/` | the claim and `saveSendResult` |
| 6 | `app.instagram_attachments` | `instagram-sending/instagram-attachment/` | the attachment-upload task and the fast lane |
| 7 | `app.broadcast_recipients` | `broadcast/broadcast-recipient/` | the audience task, intake (5), `saveSendResult` (6), the end duty, contact's erasure step |
| 8 | `billing.trial_accounts` | `billing/sub-domains/subscription/` (`trial-account.*`) | the subscription service (trial start); the trial port (1's pick during a trial) |
| 10 | `auth.trusted_devices` | `auth/sub-domains/auth-trusted-device/` | the trusted-device service (route 126, sign-in, the early ends) |

## Rules for every sub-domain

The launch's K1–K10 carried forward; **rewritten** and **new** rules marked.

| # | Rule |
| --- | --- |
| K1 | **Base and organization scope** (launch K1). App routes are under `/api/v1/app` — the common login and account routes under `/social/channel-connections` and `/social/channel-accounts`, Instagram's under `/social/instagram` (P47), `/usage` common — take the active organization from the token (no organization segment) and are team-only: on a personal organization a write answers `422` (`assertTeamOrganization`) and a read `404 team_organization_required`. Another organization's id → `404`, never `403`. Path ids `{<table singular>_id}` in `PARAM_NAME_TO_ENTITY`. Sub-domains 8–12 keep their domains' bases and as-built scope (`/tenancy/organization` singular, `/users/me`, `/auth/me`); team-only where their section says so (routes 105–106, 131). |
| K2 | **Shape** (launch K2). Success `200` (`DELETE` → `204`) with `{ data, meta }`; keyset lists through `finishKeysetPage`; snake_case body keys; unknown fields → `400`; errors `{ error: { type, code, reason?, detail, errors[] } }` with stable reasons and i18n keys. **New**: the envelope gains `error.tries_left` and `error.retry_after_seconds` (AT3); `409 automation_not_ready` carries `errors[]` (AUQ1). Exceptions, each named in its sub-domain: Meta's and Stripe's own answer shapes; a failed provider signature is `400`; and the one named method→status exception, route 124 → `303` (ATQ2 → [P85](decisions.md)), listed in one allowlist the method-status middleware and the success-status gate both read. |
| K3 | **Idempotency — rewritten (MGQ2 → [P89](decisions.md)).** In the app, every signed-in `POST` that creates a row or starts background work requires `X-Idempotency-Key`; state actions (`go-live`, `pause`, `resume`) answer a repeat with the same state and take none; a `POST` that saves nothing (`keyword-test`, the login start's and the reconnect start's one-use Redis state — routes 1, 40) takes none; the PUBLIC Meta routes (16, 17, 60, 61) take none — Meta's own ids make them safe to repeat. Sub-domains 8–12 keep the as-built `idempotencyRequired` set (the `I` column of `docs/routes.txt`: 102, 103, 106, 111, 115, 117, 140, 141); sign-in, step-up, `/users/me/*` and the provider webhooks take none. The launch's K3 said every signed-in `POST`. |
| K4 | **Codes and roles — rewritten.** Twelve app codes in `app.permissions.ts` — the launch's nine (launch IA2), `contact:update` (CTC1) and the two channel codes (P59): `channel-account:read` · `:manage` **(new, P59)**, `instagram-account:read` · `:manage`, `instagram-webhook-event:read`, `automation:read` · `:create` · `:update` · `:delete`, `contact:read` · `:update` **(new, P20)** · `:delete`. Since [P59](decisions.md) the shared channel connection (1) and channel account (1B) routes take `channel-account:*` — the same roles (Owner and Admin manage; Editor and Viewer read), tenancy's migration copies the `instagram-account:*` grants (TN12); Instagram's settings and media (2) keep `instagram-account:*` and its webhook events (5) `instagram-webhook-event:read`. Broadcasts and segments are gated by the `automation:*` codes (BC2); route 64 by the existing `organization:read`. Every team organization holds four fixed roles — Owner, Admin, Editor (was Member), Viewer (new) — D55, sub-domain 9; custom roles are off (`TENANCY_CUSTOM_ROLES_ENABLED`, a code constant). |
| K5 | **Row-level security** (launch K5). Every table: `organization_id` → organizations `ON DELETE CASCADE`, RLS enabled and forced, an organization policy with `USING` and `WITH CHECK`. Lookups before the organization is known go through narrow `SECURITY DEFINER` resolvers that answer only an organization public id or a yes / no, then work in that organization's scope. **Named exceptions**: `billing.trial_accounts` outlives its organization (`organization_id` nullable, `SET NULL` — D73; the resolver `billing.resolve_trialled_instagram_user_ids`, BL18); `app.sending_states` is one row with no organization, maintenance login only (P16); `auth.trusted_devices` has a user policy (AT17). |
| K6 | **Who did it** (launch K6). `*_by_user_id` → users `ON DELETE SET NULL`; no membership pointers (table below). |
| K7 | **Personal data** (launch K7). Contact email, phone, name, profile, note and message text are masked in logs and erased when the team erases the contact (3.A, CT11 — also her waiting messages, tag events and recipients); the channel connection's token is encrypted and read only on the Meta client's path (MC9). |
| K8 | **Background work** (launch K8). Pull-based, in the worker registry, one job per organization (or account) where it touches tenant data (`organizationPublicId` in the payload), safe to repeat, never sends a message twice (D16, D17); only a channel's sending sub-domain sends — Instagram's 6 (K15). **Rev 5 ([P91](decisions.md))**: the send, intake and task workers take a database slot from the in-process limiter before each unit of work, and the worker registry gives them the limiter's size as their Postgres concurrency, not their job places (the connection budget counts slots); the send workers run as their own service — queue family `instagram-send` (SN24). |
| K9 | **Audit** (launch K9). `<domain>.<resource>.<verb>` with the resource in snake_case: `app.channel_connection.connect`, `app.channel_account.pause`, `app.automation.go_live`, `app.instagram_message.retry`, … |
| K10 | **Outside calls — rewritten.** Meta's Graph API on `graph.facebook.com`, `META_GRAPH_VERSION = 'v27.0'` as a code constant (MC2), through the one client `meta-graph.client.ts` in sub-domain 1's adapter folder `app/sub-domains/channel-connection/channel-connection-meta/` (moved from `src/infrastructure/social/instagram.client.ts` in rev 2, MC2) on the outbound pattern, its circuit `metaGraphCircuit` checked per call (never a whole queue — WH25; → S14, P97: a backstop per call class); the token only in `Authorization`, plus `appsecret_proof`; never inside a database context. **Rev 3 (P51)**: the client reads Meta's usage headers on every answer and keeps them per connection (MC19); every channel's engine reads that usage before a call (SN23). Stripe through `stripe.client.ts` the same way, never inside a database context (8.10). |
| K11 | **Plan entitlement — new.** Every plan decision reads sub-domain 8's `getPlanAccess` (state, typed features `message_month_limit`, `channel_accounts_max`, `has_priority_support` and one on / off switch per feature in `feature_switches` (P83), trial end — BL2, BL12); a PRO part — one of those switches — is decided by **1B's one feature check** (P50, CA11 — `plan_lacks_feature`, `403` where a route refuses outright, CAQ2; it replaces `assertPlanFeature` as a separate check, which becomes one of its inputs); the plan ended → `403 organization_read_only` only where each section says (AU4, BC10); billing never reads app tables — it uses the app's ports (8.10). |
| K12 | **Settings and switches — new.** Product switches are code constants (P4): `TENANCY_CUSTOM_ROLES_ENABLED`, `BILLING_SEAT_SYNC_ENABLED`, `APP_UNTESTED_META_FEATURES`; `BILLING_READ_ONLY_ENFORCED` stays an env var with its default flipped (BL4); the sending switch is the env var `SENDING_ENABLED` with `SENDING_ENVIRONMENT_ID` (SN7, SNQ2); `AUTH_PASSWORDS_ENABLED` does not exist (ATQ1). |
| K13 | **Path params — new.** Non-entity params: `{provider}` (the auth providers, and `meta` on sub-domain 1's routes 1, 2, 16, 17), `{slug}` and `{payment_method_id}` (BLQ2 → P78) (Stripe's `pm_…`). |
| K14 | **Shared reasons — new.** One name each across sub-domains: `plan_lacks_feature` (403, PRO), `plan_account_limit` (409, 1 and 1B), `channel_account_not_found` (404, 1B, 2, 3, 6 — was `instagram_account_not_found`), `message_month_limit_reached` (409, 7), `trial_used_by_account` (409, 1 via 8), `team_organization_required` (404, now also route 131); P50's four feature-check reasons `channel_lacks_feature` (422), `permission_not_granted` (409), `plan_lacks_feature` (403 — was `plan_feature_required`) and `feature_not_offered` (422; one name since rev 3 — M2, M10), each also a go-live problem code in `409 automation_not_ready`'s `errors[]` (CA11, CAQ2). Each new reason has its `errors:` key in `src/shared/locales/en/` and its row in `response-codes.md`. |
| K15 | **Shared product, channel seams — new (rev 3, P48).** Contacts (3), automations (4) and broadcasts (7) are shared by every channel; they never import a channel's sub-domain. **Outbound**: they save a waiting message through `ChannelSendingPort`, picked by the account's `channel` (Instagram's implementation in 6 — AU34, SN22), and take results back at one entry point each (`recordMessageResult` in 4.B, the recipient service in 7.C). **Inbound**: a channel's intake (Instagram's 5) turns its provider's events into normalized event kinds and calls the shared entry points of contacts and the run engine (WH27, CT18). What a channel can do is `CHANNEL_CAPABILITIES` (1B, CA11), checked through the one feature check (P50). The port types live in the app kernel (`app.channel-ports.ts`), the wiring per channel in `app.container.ts`. |
| K16 | **Scale — new (rev 5, [P91–P96](decisions.md); the [scale review](reviews/scale-review-2026-11-24.md)'s Fix column is the spec).** (1) **Database slots, not job places** (P91): the send, intake and task workers share an in-process limiter (≈ 16–24 slots a process; a unit of work waits 2 s for one, then its ticket goes back with no try used); the budget counts the slots; the send workers run as their own service (SN24). (2) **Clean-ups keep up** (P92): a high-volume plain table is cleaned **hourly**, each run until a time budget (≈ 10 minutes) is spent, capped per table from the plan's rows a day × 2; every kept table has a gauge "oldest row past its keep time" that alerts after 1 day. (3) **Split while empty** (P96): runs and run events by month of the run's start, comment logs by month, event keys by Meta's event day — beside webhook events (day), send attempts (day) and messages (week); each expires by dropping a part through the shared upkeep (WHC13), never a batch delete; `broadcast_recipients` stays plain. (4) **One scheduled job per duty** (P94): each repair duty is its own repeat job, running until a 40 s budget is spent and re-adding tickets in bulk — never one job for many duties. (5) **A rollback keeps sending** (P95): `minimum_compatible_settings_version` (SN7). |

**Kickoff defaults from the scale review** ([P97](decisions.md); [`reviews/scale-review-2026-11-24.md`](reviews/scale-review-2026-11-24.md) —
each finding's Fix column). Kickoff builds each one as written there and records any difference in `AS-BUILT.md`; the
sections are not rewritten for them, but a rule here that one of them replaces carries **→ S<n>, P97**. The operations findings
S22–S24, S27 and S28 are KICKOFF.md's open items (P98).

- **S2** — Neon's pooler limits read for the plan's compute range, written into `resource-limits.md`; first-byte latency per transaction measured and alerted.
- **S5** — the fast-changing contact fields (`last_*_at`, counts, window times) in a narrow 1:1 `contact_activities` table; `contacts` keeps identity and search fields (3).
- **S6** — contact search needs ≥ 3 characters and an index that leads with the account, with its own short timeout (3, route 18).
- **S7** — a `contact_tag_counts` table kept in the tag commit serves the tag counts instead of a scan (3, route 22).
- **S8** — a per-account, per-day counter row (by status and reason), raised in `saveSendResult`'s commit, serves the sending status's day counts (6, route 63).
- **S9** — validly signed webhook requests are not counted against the per-IP cap; the cap stays for unsigned traffic (5, route 61).
- **S10** — the webhook gets its own pool slice or service; under load the UI sheds first (5).
- **S11** — the new-contact profile read moves to a low-priority task; several comment-intake jobs per account claim with `SKIP LOCKED`, the contact lock keeps her order (5).
- **S13** — Meta's usage kept per (connection, asset, type) as the header reports it, the app-level usage once in `app.sending_states` (refines P51; 1, 6).
- **S14** — the Meta circuit only as a backstop per call class (send, upload, read); per-account outage decisions stay with WC-22 (K10, 6).
- **S17** — parts made ≥ 14 days ahead (alert below 7), drops with a short lock timeout and retries, an explicit DEFAULT part with an alert on any row in it (5's upkeep, WHC13).
- **S18** — `REDIS_BULLMQ_URL` required when sending is on (a production `.refine()`), the ticket Redis sized for peak delayed jobs (6).
- **S19** — the task queue split into Meta-calling and database-heavy jobs, capped per organization (6, 7).
- **S20** — one tag-intake job per 500 contacts, not one per contact (3, 5).
- **S21** — an in-flight cap per organization on the fast queue (6).
- **S25** — no `queued` update after the store; intake and the pick-up claim `received` rows (5).
- **S26** — the daily token check re-encrypts a token still on an old key version (1, WC-34).
- **S29** — the waiting estimate stored by its 10-minute job (WC-24) and read by route 63, not rebuilt on a miss (6).

Who-did-it pointers:

| Sub-domain | Pointer | On delete | When the user is deleted |
| --- | --- | --- | --- |
| 1, 1B, 2 | `channel_connections.connected_by_user_id`, `channel_accounts.connected_by_user_id`, `channel_accounts.paused_by_user_id`, `instagram_account_settings.updated_by_user_id` | `SET NULL` | the connection, account, pause and settings stay; the pointer empties |
| 3 | `contacts.automations_off_by_user_id` | `SET NULL` | the pause stays; the pointer empties |
| 4 | `automations.created_by_user_id`, `updated_by_user_id`, `automation_backfills.requested_by_user_id` | `SET NULL` | the automation and its read stay; the pointer empties |
| 7 | `broadcasts.created_by_user_id`, `updated_by_user_id` (and segments) | `SET NULL` | the broadcast stays; the pointer empties |
| 5, 6, 8–12 | no new membership or user pointer (platform tables keep their as-built pointers) | — | — |

## How the sub-domains call each other

Always through the owner's service or a wired port, never its repository. Names as the owning sub-domain defines them. Since
rev 3 the shared product (3, 4, 7) reaches Instagram (2, 5, 6) **only through the two seams** (K15) — `ChannelSendingPort`
out, the normalized inbound entry points in — and every "may this account use X" through 1B's feature check (P50).

| Caller | Owner | What it calls |
| --- | --- | --- |
| 1 | 1B, 2 | create or reuse channel accounts (1B) and their Instagram extension and settings rows (2) at the pick; reconnect and break accounts (1B); the profile refresh (2, P17); disconnect each account (1B, route 5); the callbacks' disconnect (1B) and Instagram erasure (2) |
| 1, 1B | 6 | `createLanesForAccount`; wake, stop (login), clear login stops; the lane turn reads 1B's pause, suspend and plan stop (CA3) |
| 1 (pick) | 8 (trial port) | `assertInstagramAccountsMayJoinTrial` → `409 trial_used_by_account`; `recordTrialAccounts` in the pick's commit |
| 1, 1B, 2, 4, 6, 7 | 8 | `getPlanAccess` — `channel_accounts_max`, PRO features, `message_month_limit`, plan state, trial end |
| 1B, 2 | 1 | `markConnectionBroken`, the connection's token, delete the token with the last account; the Meta client (MC2); the connection's granted scopes (1B's feature check, P50) |
| 2, 4, 6, 7 | 1B | `canChannelAccountUseFeature` — the one feature check (P50, CA11): capability, permission, plan, Meta test |
| 5, 6 | 1 | the connection's Meta usage before a call (P51, MC19 — read with the token, written by the client) |
| 1B | 2 | the account's Instagram part (read for routes 6–7; the disconnect's unsubscribe and starter-question removal) |
| 2 | 1B | the account's status and the automation switch (route 12 writes the switch, IA12) |
| 2 | 5 | the missed-comment look after a webhook field was off (WC-26) |
| 3 | 4, 6 | the erase and pause steps (registered in `app.container.ts`); the run-event and message readers for "What happened"; 6's summary query and retry service (routes 25–26, WC-42) |
| 4 | 1B, 2 | the account state and its row lock at go-live (1B); media, the starter-question sync (2) |
| 4 | 3 | `recordContactFirstRun`, `addContactTags` (+ tag events), `lockLiveContact`, `findContactSendState` |
| 4 | 6 (through `ChannelSendingPort`) | `saveWaitingMessage` (never sends), cancel or skip waiting rows, the month count at go-live; the summary query and retry service (routes 36–37, WC-42) — AU34 |
| 4 (past comments) | 5 | the store function (events with `comment:` keys, low priority) |
| 5 | 1, 1B, 2, 3, 4 | the Meta signature check (1's adapter); account state and the automation switch (1B); the Instagram user id, settings and posts (2); **the inbound seam** (WH27): contacts' `recordInboundContactEvent` and the run engine's `handleInboundEvent` with a normalized event kind — match, once keys, the P35 replacement (WH13, WH14) |
| 5 | 6 | Instagram to Instagram, no seam: `findOwnSentMessageIds` (WHQ1), a tap's `unknown` → `sent` through `saveSendResult`, lane moves when her chat opens; lane wake after commit (the run engine's waiting rows go through `ChannelSendingPort`) |
| 5 | 7 | the inbound seam: `BroadcastService.handleChatOpened`, recipients' `replied_at` and taps |
| 6 | 1, 1B, 3, 4, 7 | the Meta client, the token and the connection's usage (1, P51); the account's pause, suspend and plan stop (1B); `recordContactOpeningMessage`; the results back through the seam — `recordMessageResult` (4.B) and `BroadcastRecipientService.recordMessageResult` (7.C) — and the reply-state service; the broadcast lane reads broadcasts and recipients through `BroadcastRecipientService` |
| 6 | 9, 12 | the organization's `status` (`SUSPENDED` stops sending, TN5); `findUsableMessageFile` (attachment task) |
| 7 | 6 (through `ChannelSendingPort`) | `saveWaitingMessage` (recipients' messages), cancel a broadcast's waiting messages; the month count (route 75) — BC18 |
| 8 | 6 | `PLAN_STATE_CHANGED` → the app's handler enqueues WC-38 (the accounts' plan stop on 1B, `plan_ended`, PRO off, broadcasts cancelled) |
| 8 | 1B (accounts port) | `listActiveChannelAccounts`, `countConnectedChannelAccounts` (route 108) |
| 3–9 (events) | 11 | `createAndDispatchNotification` with a `dedupe_key` (UNQ2); `noteContactDetailsLeft` |
| 11 | app (three ports) | the chooser's counts (`app.list_organization_counts_for_user`), `readWeeklySummary`, `countContactsWithDetailsLeft` |
| 4 | 12 | `findUsableMessageFile` (go-live check) |

## Connections

```text
1) WHO POINTS AT WHOM                         A ──► B = a column on A points at B

   tenancy.organizations ◄── every app table (K5) · billing.subscriptions · billing.trial_accounts (SET NULL, D73)
   auth.users ◄───────────── connected_by, paused_by, updated_by, created_by, requested_by, automations_off_by (K6)
                             auth_methods · webauthn_credentials · trusted_devices (new) · sessions · user_settings

   1 CHANNEL CONNECTION ──< token (1:1, + refresh token P49)   Meta usage on the row (P51); ad accounts, ads read live (MC13)
      └──< 1B CHANNEL ACCOUNTS ──── 2 INSTAGRAM ACCOUNT (1:1) ──< settings (1:1) · stored posts
             │                       (capability list + the one feature check live in 1B, P50)
             │   SHARED PRODUCT (every channel, keyed by channel_account_id, P48)
             ├──< 3 CONTACTS ──< tag events
             ├──< 4 AUTOMATIONS ──< counts · reply state · backfills
             │      └──< automation runs ──< run events · comment logs        runs ──► 3 contacts
             ├──< 7 BROADCASTS ──< recipients ──► 3 contacts;  SEGMENTS ◄── broadcasts
             │   INSTAGRAM (P43, P45)
             ├──< 6 lanes · stops · minute counts · attachments ┄┄ upload (12)
             │      └──< INSTAGRAM MESSAGES ──► 4 runs | 7 broadcasts (exactly one) ──< send attempts
             └──< 5 webhook events · event keys          (no key into 1–4, 6; matched by value)
   seams (K15): 5 ══ normalized event kinds ══► 3, 4, 7    ·    4, 7 ══ ChannelSendingPort ══► 6 ══ results ══► 4, 7
   tenancy.organizations ──< 6 message month counts (shared, every channel) · sending states (one row, no organization)
   8 plans ◄── subscriptions (plan, scheduled plan) · trial accounts ┄┄ Instagram user ids (no key into the app)
   9 roles ──< role permissions >── permissions (+ contact:update) · memberships ──< invitations

2) THE GRAPH — each row points at the columns marked ●  (○ = writes there through its service; ◇ = reads through a port)

                          Orgs  Users  1    1B   2    3    4    5    6    7    8    12
   1  Channel connection  ●     ●           ○    ○                   ○         ◇
   1B Channel account     ●     ●      ●         ◇                   ○         ◇
   2  Instagram account   ●     ●      ◇    ●                   ○              ◇
   3  Contacts            ●     ●           ●    ◇         ●         ○
   4  Automations         ●     ●           ●    ◇    ●○             ○         ◇    ◇
   5  Instagram webhook   ●            ◇    ●    ◇    ○    ○         ○    ○
   6  Instagram sending   ●            ◇    ●    ◇         ●              ●○   ◇    ◇
   7  Broadcasts          ●     ●           ●         ●    ●         ○         ◇
   8  Billing             ●     ●           ◇
   11 User and notify           ●      ◇ app counts, weekly summary, contact notes

3) WHAT ONE ACTION SETS OFF (same transaction unless marked worker)

   2 provider callback ───► connection + token in one commit; a reconnect re-attaches accounts (MC6) → the picker
   40 reconnect ──────────► a one-use state bound to the connection → the login → route 2 (MC17)
   3 pick accounts ───────► channel accounts (1B) + Instagram rows and settings (2) · four lanes (6) · trial rows during
                            a trial (8) · set-up job                                                            [worker]
   5 disconnect business ─► each account disconnected (1B) · its lanes stopped (6) · the token deleted
   16 / 17 Meta callbacks ► deauthorize · data deletion (1, MC14–MC16)
   61 event received ─────► stored once (event keys), answered 200 → intake by kind                                 [worker]
                            → kind normalized → 3 contact first → 4 run engine → `ChannelSendingPort` → 6 `waiting`
                            messages → a lane sends (after the connection's usage check, P51)                       [worker]
   23 erase a contact ────► 4 comment-log copies erased · her waiting messages cancelled (6) · tag events gone (CT11)
   32 go live ────────────► the full check (AU13, with 1B's feature check — P50) · the starter questions synced after commit
   26 / 37 retry failed ──► the `retry-failed` job (6) puts the allowed ones back to `waiting`, each once          [worker]
   75 send a broadcast ───► the audience task builds recipients (WC-40) → the broadcast lane sends                   [worker]
   8 plan state changes ──► PLAN_STATE_CHANGED → WC-38: accounts' plan stop (1B), PRO off, broadcasts cancelled     [worker]
   every minute ──────────► the sending repair (never sends) (6)                                                    [worker]
   daily / hourly ────────► the connection's token check (WC-34) · clean-ups · the weekly summary sweep (11)        [worker]
```

---

## 1. Channel connection — rev 5 (2026-11-24) — no nested sub-domains (one nested adapter folder); final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md); the channel split, [P40–P47](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`channel-connection` sub-domain folder** — `app/sub-domains/channel-connection/` (**new**, [P41](decisions.md)),
the connection and its token at the folder root, and one nested folder **`channel-connection-meta/`** — the Meta provider
adapter (the Graph client, its error map, the login calls, the two signature checks); it has no table and no route of its
own, so it is not a nested sub-domain with sections (1.12).

1.1 Decisions (whole sub-domain) · 1.2 Open questions · 1.3 Tables and relations · 1.4 Permissions · 1.5 Common to every route ·
1.6 Objects returned · 1.7 Routes · 1.8 Request details · 1.9 Errors · 1.10 Rules worth knowing · 1.11 Code changes (whole sub-domain) ·
1.12 Nested sub-domains (none; one adapter folder).

One provider login of an organization for one business: for Meta, **Unified Login** (D24) — one connection per business
portfolio for Instagram, Facebook and ads, holding the granted scopes and its assets (Instagram accounts now; Facebook Pages
and ad accounts through the same login later — D27, P41). This sub-domain starts the login, finishes it, starts a reconnect,
picks which of its accounts to connect under the plan's account limit (D25, D26 — the account rows are sub-domain 1B's), lists
the connections, "Disconnect business", reads the connection's ad accounts and ads (the ad picker, D41), and answers Meta's
deauthorize and data-deletion callbacks (P46 — they are Meta-wide). It owns the only token path: one system-user token per
connection, which never expires by default and is checked once a day by the connection's own scheduled job (WC-34, P47). The
launch's Instagram Login (connect route, 60-day token, daily renewal, `app.instagram_account_tokens`) goes (RC-6, D24).
Design read: plan §25 (plan:L4482–L4705), §19.10–19.11 (plan:L3517–L3574), §36 env (plan:L6531–L6535, L6808–L6812), the ad
picker (plan:L876–L880); `db-changes.md` › channel_connection, channel_connection_token, instagram_account_token;
`route-changes.md` RC-1–RC-6, RC-15, RC-17, RC-18, RC-112–RC-114; `worker-changes.md` WC-30, WC-34, WC-35, WC-46. Builds on:
organizations, users, billing plans (sub-domain 8 — the `channel_accounts_max` read), sub-domain 1B for the account rows the
pick writes and sub-domain 2 for their Instagram extension rows (1B and 2 point at 1; 1's pick writes them through their
services). Route numbers: 1–5, 15–17, 40–42 (M9).

### 1.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). The launch's
review is the "before" ([launch routes-final § 1](../../launch-2026-11-20-ujai/plans/routes-final.md)). The ids stay MC… (the
sub-domain was "Meta connection" in rev 1); MC13–MC16 came from rev 1's 2.C and 2.D.

**rev 2 changes** (P40–P47, M9): renamed Meta connection → **Channel connection** (`channel-connection/`,
`app.channel_connections`, `app.channel_connection_tokens`, `provider` = `meta`); paths under `/social/channel-connections/…`
with `{provider}` (start, callback, Meta's callbacks) and `{channel_connection_id}` (pick, reconnect, disconnect, ads); a reconnect route (40, MC17) and a one-connection read (42, MC8); the ad picker moved here (routes 41 and 15, MC13); Meta's deauthorize and data deletion moved
here (routes 16–17, MC14–MC16); the Meta client and adapter in `channel-connection-meta/` (MC2); the pick writes channel
accounts (1B) and their Instagram extension (2) under `channel_accounts_max` (MC7); questions IAQ1 → MCQ3, IAQ2 → MCQ4, new
MCQ5.

**rev 3 changes** (P49, P50, P51, M10): the token table gains `encrypted_refresh_token` (empty for Meta) and `token_type` `system_user` · `oauth_user` (MC18); the shared Meta client keeps **Meta's usage per connection** — three columns on `app.channel_connections` and a short Redis copy — and every channel's engine reads it before a call (MC19); the reconnect (route 40) is also the answer to the feature check's `permission_not_granted` — it asks for the missing permission (P50, CA11), and the connection's granted `scopes` are one of that check's inputs. Routes, gates and counts unchanged.

**rev 4 changes** (P54–P59, M12): Meta's two callbacks match the account id, else the business id — every account of that connection (MCQ3 → P56: MC15, MC16, a second resolver and an index); routes 1–5, 15, 40–42 gated by `channel-account:*` (P59); MCQ1, MCQ2, MCQ4, MCQ5 answered as recommended (P54, P55, P57, P58).

**rev 5 changes** (P97, M13): no route or table changes — MC19 and K10 point at the scale review's kickoff defaults S13 and S14 (→ S<n>, P97).

| # | Decision |
| --- | --- |
| MC1 | **Folder, names, ids (P41, P47).** Today: no provider login; the Instagram Login lives in `instagram-account/` (`connect`, the token schema / repository / service at its root, `INSTAGRAM_APP_*` env). After: a new sub-domain `app/sub-domains/channel-connection/` with `channel-connection.{routes,controller,service,repository,schema,dto,validator,serializer,types,constants}.ts` and the token as a persistence part at the same root (`channel-connection-token.{schema,repository,service}.ts`, no controller, no routes — the launch's IA1 pattern). Tables `app.channel_connections` (column `provider`, `meta` the only value this iteration) and `app.channel_connection_tokens` — they supersede the rev 1 `app.meta_connections` and `app.meta_connection_tokens` (P41). Public-id entity `channelConnection` (prefix chosen at kickoff, P22); path param `{channel_connection_id}` in `PARAM_NAME_TO_ENTITY`; `{provider}` is the existing non-entity param (K13), its one value `meta`. Paths under `/api/v1/app/social/channel-connections/…` (P47). OpenAPI tag `Channel connection`. Other option: rev 1's Meta-only `meta-connection/` — a later Facebook or WhatsApp login would need a second copy. |
| MC2 | **The one Meta client, in the connection's adapter folder (launch IA4 → after).** Today: `src/infrastructure/social/instagram.client.ts` speaks `api.instagram.com` / `graph.instagram.com` `v24.0`, puts the token in the query for the two exchanges and the renewal, and is the only caller of Instagram (outbound pattern, `instagramCircuit`, nock contract tests). After: the **same client, moved** (reuse rule — moved, never copied) to the nested adapter folder `app/sub-domains/channel-connection/channel-connection-meta/` as `meta-graph.client.ts`, beside `meta-graph-error.util.ts` (was `instagram-error.util.ts`), `meta-login.ts` (login address, code exchange) and `meta-signature.ts` (the `signed_request` check of routes 16–17 and the `X-Hub-Signature-256` check sub-domain 5's receiver imports); rebased on `graph.facebook.com`: the Instagram Login exchanges, renewal and `/me` go; it gains the Unified Login code exchange (`/oauth/access_token`, the app secret in the query, so that URL is redacted), `GET /me?fields=client_business_id`, `GET /me/assigned_instagram_accounts?fields=id,username`, the granted-permission read (plan:L4577 — which call shows a system-user token's permissions is a Meta test, §43), `GET /me/adaccounts` and an ad account's ads (MC13), and `DELETE /{instagram_user_id}/subscribed_apps`; every call with a customer token sends it only in `Authorization` and adds `appsecret_proof` (plan:L7183–L7194, SE.M.14). The circuit becomes `metaGraphCircuit` — one per provider; only provider calls check it, never a whole queue (P47 F3, sub-domain 5). The Graph version is a **code constant** `META_GRAPH_VERSION = 'v27.0'` beside `STRIPE_API_VERSION` — it does not vary by environment, so P4 keeps it out of env. The error map keeps its four classes; auth (190) now breaks the **connection** (MC11). Sub-domains 2, 5 and 6 call Meta only through this folder. Other option: keep the client in `src/infrastructure/social/` — the adapter would then be split across two trees. |
| MC3 | **Settings (env) — the Meta app, not the Instagram app (D24, P4).** Today: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (env-schema `INSTAGRAM_VARS`); unset → `503 instagram_not_configured`; the secret needs 32 characters when set (launch D53). After: `META_APP_ID`, `META_APP_SECRET` (code exchange, `appsecret_proof`, the webhook signature and Meta's callbacks — one secret), `META_CONFIG_ID`, `META_REDIRECT_URI` (the frontend's return page), `META_WEBHOOK_VERIFY_TOKEN` (renamed; sub-domain 5 reads it) — the four `INSTAGRAM_*` leave in the same change (be-env-schema-add; `.env.example`, `harness-provider-env.ts`, the external-credentials fill, GitHub Environments). Unset → the same `503 instagram_not_configured` (the frontend already branches on it; the reason names the product, not the vendor). Login-state time `CONNECT_STATE_MINUTES` 10 and `PROFILE_READ_TIMEOUT_MILLISECONDS` 3000 are constants in the app domain's settings file (P4, P6: `_MILLISECONDS`). |
| MC4 | **Start (route 1) — a one-use login state in Redis (P26).** Today: Instagram Login has no server state (launch IQ6: the frontend checks `state`); the OAuth sign-in keeps a one-use Redis state (`oauth-state.ts`: `randomBytes` → `SET … EX`, `GETDEL` on use). After: route 1 (`{provider}` = `meta`) mints `state` (32 random bytes, base64url), stores `{ provider, organization_public_id, user_public_id, channel_connection_public_id: null }` under a one-use key for 10 minutes, and answers the Meta login address `https://www.facebook.com/dialog/oauth?client_id&config_id&redirect_uri&response_type=code&state&prompt=login` (always asks her to log in again). The set / one-use read core of `oauth-state.ts` is lifted into one shared helper both call (reuse rule — never two copies); the key stays in Redis only — short-lived login state, nothing is lost if it goes (P26). No body, no `X-Idempotency-Key` (a repeat mints another harmless state). Other option: a Postgres row per login attempt. |
| MC5 | **Callback (route 2) — the code, then one commit, then the picker; a reconnect finishes here too.** Today: the launch's `POST …/instagram/connect` exchanges a code and commits account + token + settings at once (launch IA12). After, in order (plan:L4570–L4578): (1) read-and-delete the state — missing, used, older than 10 minutes, another user's, another organization's or another provider's → `400 channel_connect_state_invalid`, nothing saved; (2) exchange the code on the server — refused → `422 provider_code_invalid`; Meta down before the exchange → `503 instagram_unavailable` with `Retry-After`; Meta failing after the one-time code was spent → `409 instagram_connect_restart_required` (launch D56, kept); (3) read `client_business_id` and the assigned Instagram accounts; a state minted by route 40 for a connection of **another** business → `409 channel_connection_business_mismatch`, nothing saved; (4) a missing required permission (`instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`) → `422 provider_permissions_missing`, nothing saved — `ads_read` is optional (MC13); (5) **one commit** in the caller's scope: insert or update the `(organization_id, provider, client_business_id)` connection row (`connected`, `config_id`, `scopes`, `connected_by_user_id`, `connected_at`, `status_changed_at`, `last_checked_at` = now; clears `disconnected_at`), write the encrypted token (`system_user`, `expires_at` empty), and **reconnect** (plan:L4674–L4681, MC6); (6) after commit: the audit entry, one account-set-up job (WC-30, sub-domain 2) per reconnected account, and their lanes woken (sub-domain 6). Answers the picker (1.6). `X-Idempotency-Key` required: the state is one-use, so a network retry without a replay would answer `400`; the frontend uses `channel-connect:<state>` as the key. |
| MC6 | **What a reconnect touches (plan:L4674–L4681).** In MC5's commit: every **not-revoked** channel account of this organization (1B) whose `provider_account_id` is in the new assigned list is attached to this connection (`channel_connection_id` — an account that moved to this portfolio moves its row) and goes `error → connected`; its login stops end (`stop_cleared_at`, through sub-domain 6's lane service). Only an account whose Instagram id equals the row's ever takes the row (plan:L2622). A `revoked` row is not reconnected here — the owner picks it (route 3, its settings come back). A connection left with no not-revoked account by a move goes `revoked` and its token is deleted in the same commit (nothing uses it). Other option: attach moved accounts only when the owner picks them again (one more step for the owner, MCQ1). |
| MC7 | **Pick accounts (route 3) — the plan limit under the organization lock (D25, D26, plan:L4590–L4604).** Before the transaction: re-read the connection's assigned accounts with its token (a pick not in the list → that pick `not_assigned`; Meta down → `503 instagram_unavailable`) and one profile read per pick (3 s each, fails open — the username is enough). One commit: `pg_advisory_xact_lock` on the organization id first (two first connects of one organization have no row to lock yet, plan:L3553); count the organization's not-revoked channel accounts — that plus the new picks over the plan's `channel_accounts_max` (billing, sub-domain 8, P47) → `409 plan_account_limit`, nothing saved; each pick → a new channel account (1B, `channel` = `instagram`, `provider_account_id` = the Instagram user id, `display_name` = `@username`) with its Instagram extension row (2.A) and settings row (2.B, every owner value empty), or the organization's own old row of that account back (a revoked row — its settings return), `channel_connection_id` set, `connected`, `connected_at` = now (the new-account limit); a pick live in **another** organization → that pick `connected_elsewhere` (`idx_channel_accounts_provider_account_live`), the others still connect; a pick already connected here → `already_connected`, unchanged; for a new row its four lanes (`slow`, `reply`, `fast`, `broadcast`, `ready` — sub-domain 6's service). After commit: one account-set-up job per connected pick (WC-30) and `app.channel_account.connect` per account. Answers one result per pick. During a trial (`TRIALING`), the picks go through billing's trial port first (sub-domain 8 — 8.B, BL14, BL18): an Instagram account that already had a trial in any organization → `409 trial_used_by_account`, nothing saved; the pick's commit records its `billing.trial_accounts` rows (`recordTrialAccounts`). A connection not `connected` → `409 channel_connection_not_connected`. Today: one not-revoked account per organization (launch D5) → many, up to the plan. |
| MC8 | **List (route 4), one connection (route 42) and "Disconnect business" (route 5).** Route 42 (new in rev 2, RC-112): one connection as in the list, a revoked one included (its id is known). Route 4: the organization's connections for the connections screen — provider, business id, status, granted permissions, who connected and when, the last daily check and its error codes (never Meta's text), and its channel accounts (`id`, `channel`, `display_name`, `connection_status`); revoked ones only with `include_revoked=true`; never a token; no paging (an organization has a handful). Route 5 (plan:L4683–L4693, L2623): before the transaction, per account of the connection, the best-effort starter-question removal and unsubscribe (logged, never blocks); one commit, lock order of plan §35: each not-revoked account as route 8 (sub-domain 1B, through its service), then the connection `revoked`, `disconnected_at`, its token deleted; after commit the accounts' Redis keys deleted and the audit entries. Automations, contacts and history stay; waiting messages stay and expire by the 7-day rule. Answers `204`. A revoked connection → `404 channel_connection_not_found` (a repeat). |
| MC9 | **Token isolation (launch IA5–IA7, moved here).** Today: the token lives in `app.instagram_account_tokens`, read only by its repository through the token service and the daily check, decrypted only inside the Instagram client, pinned by `instagram-account-token-isolation.policy.unit.test.ts`; its RLS has no maintenance arm. After, unchanged in kind, moved to the connection: (1) only `encrypted_access_token` is stored; (2) the plain token exists only inside the Meta client (MC2) — it takes the ciphertext, decrypts right before the call, returns new tokens already encrypted; (3) only `channel-connection-token.repository.ts` reads `app.channel_connection_tokens`, used only by the token service, the sender (sub-domain 6, right before a call) and the token check — the policy test is renamed `channel-connection-token-isolation.policy.unit.test.ts` and lists exactly these files; (4) its policy has the organization arm only — no sweep reads a token; (5) never in Redis, a log, a job payload or an idempotency replay (`encrypted_access_token` stays in the secret-field lists). The secrets-key rotation re-encrypts this table instead of the old one (launch D37). |
| MC10 | **The daily token check — the connection's scheduled job (WC-34, P47; replaces the launch's daily account check, P17).** Today: once a day at 04:00 UTC per account — renew within 7 days of the end, refresh the profile, retry the subscription (`instagram-account-daily-check`). After: per **connection** every 24 h, spread by connection: an hourly sweep (maintenance scope, `idx_channel_connections_check_due`) hands one job per due connection to the `channel-connection-token-check` worker on the `instagram-tasks` queue (D3, P45 — the only queue a Meta job has this iteration), payload `organizationPublicId` + `channelConnectionPublicId`. The job, inside its organization: `GET /me/assigned_instagram_accounts`; OK → `last_checked_at`, `last_check_error` cleared, each connected account's Instagram profile refreshed (P17, through sub-domain 2, which also updates 1B's `display_name`), a connected account missing from the list → that account `error` (1B), its lanes stopped (no end), its reconnect notice; 190 or another "token not valid" → MC11; Meta down or "too fast" → try again later, nothing changes (the job checks `metaGraphCircuit` per call; the worker is never paused — F3). No renewal (WC-35 removed); the subscription check moves to WC-25 (sub-domain 2). |
| MC11 | **A broken token breaks every account of its connection (plan:L4648–L4658, §33.1).** Today: the account service's guarded `markConnectionBroken` moves one account `connected → expired \| error` and only the winner enqueues the reconnect notice (launch IA9). After: `ChannelConnectionService.markConnectionBroken` — one guarded change `connected → error` on the connection (`status_changed_at`, `last_check_error` codes only) and, in the same commit, every `connected` channel account of it → `error` (1B) and all their lanes stopped (login, no end — sub-domain 6); the winner enqueues one reconnect notice per account after commit (WC-46, the existing Instagram worker in sub-domain 2). Called by the token check and by any send or read that gets 190 (sub-domains 2, 6 and routes 15, 41). `expired` is gone (the token never ends). |
| MC12 | **Audit (launch K9 form).** `app.channel_connection.connect` (WARNING, `metadata.provider`, `is_reconnect`, `reconnected_account_count`), `app.channel_connection.disconnect` (WARNING, `disconnected_account_count`), per picked account `app.channel_account.connect` (WARNING), and `app.channel_connection.deauthorize` / `.data_deletion` (WARNING, `anonymousActor`, `metadata.source = 'meta'`, MC14) — all after commit. Failed connects log the support record of plan:L4590 (app id, `config_id`, the step that failed, Meta's code, subcode, trace id) — never a token or the app secret. |
| MC13 | **The ad picker, read through the connection (routes 41 and 15, D41, plan:L876–L880; was rev 1's IA16 on the account).** The ads permission belongs to the login, not to one Instagram account (P41), so the picker reads the connection. Route 41: with `ads_read` on the connection, its ad accounts (`/me/adaccounts`: `ad_account_id`, `name`, `account_status`), no paging (Meta's first 100). Route 15: the ads of **one** ad account (`ad_account_id` required — MCQ4) with their Instagram post: `ad_id`, `name`, `status`, `instagram_media_id`, `channel_account_id` (the connected Instagram account the ad runs as, matched by its Instagram id, or null), `thumbnail_url`, `created_at`; Meta's cursor, `limit` 1–50. Without `ads_read`: both answer `data: []` and `meta.ad_access = 'missing'` — the screen says "Connect an ad account" (a new login), never an error. A connection in `error` → `404 instagram_reconnect_required`; a 190 calls MC11. Ad comments and the 7-day ad window stay refused at go-live while untested (P36, sub-domain 4). **As built (R4, [P401](decisions.md), [P402](decisions.md)):** only Meta code 190 breaks the connection (`markConnectionBroken`, built here for R51 to reuse); another permission code on an ad read answers `meta.ad_access = 'missing'`; route 15 checks `ad_account_id` against route 41's list first (two Meta calls per page) and also answers `404 ad_account_not_found` when Meta refuses the ads read; an ad runs as the creative's `instagram_user_id`; a `revoked` connection answers `404 instagram_reconnect_required` on 15 and 41. |
| MC14 | **Meta's two callbacks, signed with the Meta app secret (routes 16–17, D24, P46; was rev 1's IA18 under the account).** Today (launch IA18): `signed_request` checked with `INSTAGRAM_APP_SECRET` (HMAC-SHA256, constant time), a route-scoped form parser, `WEBHOOK_RATE_LIMIT`, a body over 16 KB `413`, only connections older than `issued_at` (launch D53). After: the same plugin (`meta-signature.ts`, MC2) with `META_APP_SECRET`, on `/social/channel-connections/{provider}/deauthorize` and `…/data-deletion` (`{provider}` = `meta`; Meta's app dashboard takes one address of each per app, and the login is Meta-wide); unset → `503 instagram_not_configured`. No auth, no idempotency key (K3), always `200` once verified. |
| MC15 | **Who is found — the account id, else the business id (plan:L4695–L4705, MCQ3 → [P56](decisions.md); was IA19).** Today: `app.resolve_organization_public_ids_for_instagram_app_user(text)` — every organization with a row of that app-scoped id. After: that resolver is **replaced** by two, each `SET search_path`, `GRANT EXECUTE` to `meepzo_be_app`, `REVOKE … FROM PUBLIC`, public ids only (launch IA6 pattern): (1) `app.resolve_organization_public_ids_for_provider_account(text, text)` — every organization with a channel account of that provider's channel and `provider_account_id` (for `meta`: an Instagram account's `instagram_user_id`), any status; (2) only when (1) finds none, `app.resolve_organization_public_ids_for_provider_business(text, text)` — every organization with a connection of that provider and `client_business_id`, any status (`idx_channel_connections_provider_business`). Which id Meta signs on a Unified Login callback is still a §43 test, so the id is tried as an account id first, then as a business id (your answer, P56 — revisit when the test shows). Each change runs in that organization's `VERIFIED` scope (P46): an account match reaches that account; a business match reaches **every not-revoked channel account of that connection**. Route 16 (deauthorize): in each, the disconnect of CA8 (1B) for every account reached, without the unsubscribe call — `revoked`, lanes stopped, the connection's token deleted (and the connection `revoked`) with its last account. Other option (the recommendation): match `provider_account_id` only, a business column after the test. |
| MC16 | **Data deletion and the unmatched id (route 17, plan:L4699–L4705; was IA20).** As route 16 (the account id, else the business id — P56), plus in each organization the Instagram profile erased and the stored posts deleted of every account it reached (sub-domain 2's services; launch IA20 kept; contacts untouched, launch D22). An id that matches neither still answers `200` (with its derived confirmation code), is logged and **emails the team** to handle the deletion by hand (the team-alert path of sub-domain 6, WC-57's team part). The answer shape is Meta's, as built. |
| MC17 | **Reconnect (route 40) — start a login bound to this connection (new in rev 2, MCQ5).** The connections screen's "Reconnect" button: route 40 mints the same one-use state as route 1 with `channel_connection_public_id` set and answers the same login address; route 2 finishes it (MC5) and refuses a different business (`409 channel_connection_business_mismatch`). Allowed on a `connected` or `error` connection (a `connected` one re-grants permissions, e.g. `ads_read` for the ad picker); a `revoked` one → `404 channel_connection_not_found` (connect again with route 1). No body, no key (as route 1). A login started by route 1 for an already-connected business still reconnects at the callback (MC6). |
| MC18 | **Refresh tokens for providers whose tokens expire (P49).** Today (rev 2): one system-user token per connection, `token_type` `system_user` only. After: `app.channel_connection_tokens` gains `encrypted_refresh_token` (`text`, null; `encryptFieldSecret` output, never empty when set) and `token_type` takes `system_user` · `oauth_user`. Meta's Unified Login keeps writing a `system_user` token with no refresh token (D24); a later provider whose user tokens expire (TikTok's OAuth) writes `oauth_user` with its refresh token and adds its own renewal in its adapter folder. Read only on the client path, like the access token (MC9). No job and no route changes now. |
| MC19 | **Meta's usage, kept per connection (P51).** Today (rev 2): each Instagram lane reads Meta's usage from the answers it gets (WC-6 doubles the reply lane's boxes at 80 % and waits at 95 %; the past-comments read and the missed-comment look pause at 80 %), so Instagram, Facebook and ads calls of one business never see each other's use. After: the shared Meta client in `channel-connection-meta/` reads `X-Business-Use-Case-Usage` (per business, shared by its products) and the app usage header on **every** answer and keeps the highest percentage on the connection — `usage_percent`, `usage_wait_until` (Meta's estimated time to regain access, else now + 15 minutes at ≥ 95 %), `usage_read_at` — in a small unit of its own after the call (never inside a send's transaction; an older reading never overwrites a newer one), plus a Redis copy `app:meta_usage:<organization public id>:<connection public id>` (≤ 60 s, tombstoned on write, fail open to Postgres — P5, P32: Postgres stays the holder). Every channel's engine calls `readConnectionUsage` before a Meta call: ≥ 80 % slows (the plan's rule, plan:L2353–L2360), ≥ 95 % waits until `usage_wait_until`. Sub-domain 6's lanes and gate 1 (SN23), 4.C's past-comments read and 5's missed-comment look read it; none keeps its own. → S13, P97: kept per connection, asset and type; the app-level usage once in `sending_states`. **As built (R2, [P107](decisions.md); R3, [P112](decisions.md)):** the usage is parsed per (asset id, type) and kept behind `ChannelConnectionUsageStore` — the Postgres store `app.channel_connection_usages` (R3, not three columns) — and `MetaAppUsageStore` (R18); `readConnectionUsage` answers the strictest matching entry. |

### 1.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| MCQ1 | A reconnect from a portfolio an account moved to: attach its row at the callback, or only when the owner picks it? | at the callback (MC6) · only at a pick | **At the callback** — the account is the organization's already, the owner pressed Reconnect for it, and it saves a step; the plan's "its account row moves to the new connection" (plan:L4676) reads the same | **P54** — at the callback (as recommended) |
| MCQ2 | The pick re-reads the assigned accounts from Meta, or trusts the list the callback read? | re-read (MC7) · keep the callback's list in the login state | **Re-read** — the pick can come minutes later; a stale list could attach an account the business no longer shares; the cost is one Graph call per pick | **P55** — re-read from Meta at every pick (as recommended) |
| MCQ3 | Which id does Meta sign on the Unified Login callbacks — the person, the Instagram account or the business (plan:L4699–L4705, a §43 test)? (rev 1 IAQ1) | match the account's `provider_account_id` · also match `client_business_id` · a person-id column on the connection | **Match `provider_account_id` now** (the plan's step 3a); an unmatched id is answered with its code and the team is emailed (MC16); add a connection column only if the test says so — a new decision then | **P56 — not the recommendation**: the account id **and** the business id — `provider_account_id` first, else `client_business_id` (every account of that connection); an unmatched id still gets its code and the team an email; revisit after the §43 test (MC15, MC16) |
| MCQ4 | The ads list reads one ad account at a time, or every ad account of the connection in one list? (rev 1 IAQ2) | one at a time (`ad_account_id` required, route 41 lists them) · all merged | **One at a time** — Meta pages per ad account, so a merged list has no single cursor; the frontend shows an ad-account switcher fed by route 41 | **P57** — one ad account at a time (as recommended) |
| MCQ5 | Does "Reconnect" get its own route, or is it only a new login through route 1 (rev 1)? | its own route 40, bound to the connection (MC17) · route 1 only | **Its own route** — the callback can then refuse a login into another business instead of silently creating a second connection, and a `connected` connection can re-grant `ads_read` | **P58** — its own route, 40 (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 1.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.channel_connections` | one provider login of an organization for one business (Meta: a business portfolio) | one row per organization, provider and business, a revoked one reused (MC5); status by actions only (MC5, MC8, MC11); no soft delete — `revoked` stands in |
| `app.channel_connection_tokens` | its encrypted token — Meta's system-user token; an OAuth user's token with its refresh token for a later provider (P49) | one per connection; read only on the client path (MC9); deleted when the connection is `revoked` |
| ~~`app.instagram_account_tokens`~~ | **removed** (D24) | its rows, repository, service, policy test and the daily renewal go; no data moves (plan:L2924) |

```text
tenancy.organizations
   │
   └──< app.channel_connections ──┬──< app.channel_connection_tokens (1:1)   ciphertext only (MC9)
                                  ├──< app.channel_accounts (1B)            the accounts it brings in (D25)
                                  │       └──< app.instagram_accounts (2, 1:1)
                                  └──> auth.users (connected by)
   ad accounts and ads: read live from Meta through the connection (MC13) — not stored

A ──< B   one A has many B     A ──> B   a column on A points at one B
```

Pointing at these from other sub-domains: `channel_accounts.channel_connection_id` (1B — composite
`(organization_id, channel_connection_id)` → `(organization_id, id)`, `ON DELETE RESTRICT`: a connection is never deleted,
only `revoked`). Branch rule: none. Membership pointers: none; `connected_by_user_id` → users `ON DELETE SET NULL` (K6).

**PostgreSQL design**

The launch's standard columns (launch § 1.3): `id bigserial`, `organization_id bigint NOT NULL` → organizations
`ON DELETE CASCADE`, `created_at` / `updated_at` with `chk_<table>_updated`; value lists `varchar(n)` + a lowercase
`CHECK`; Meta ids `varchar(64)` digits. Both tables in the `app` migrations changed in place (D1, P29) — they join the
account migration `20261121064529_app_instagram_account.sql`, which loses the token table (db-changes decides whether the
two channel tables get a migration of their own).

`app.channel_connections`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `public_id` | `varchar(28)` | no | | `generatePublicId('channelConnection')` (prefix at kickoff, P22) |
| `provider` | `varchar(20)` | no | `'meta'` | **new in rev 2**: `meta` (`chk_channel_connections_provider`) |
| `client_business_id` | `varchar(64)` | no | | digits; Meta's `GET /me?fields=client_business_id` (the business portfolio) |
| `config_id` | `varchar(64)` | no | | the login configuration used; not secret |
| `login_type` | `varchar(20)` | no | `'unified'` | `unified` (Instagram, Facebook Pages and ads through one login, D27) |
| `status` | `varchar(10)` | no | `'connected'` | `connected` · `error` · `revoked` |
| `status_changed_at` | `timestamptz` | no | `now()` | every status change |
| `scopes` | `text[]` | no | `'{}'` | granted permissions (P41); `cardinality(scopes) <= 20` (moved from the account) |
| `connected_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL` |
| `connected_at` | `timestamptz` | no | `now()` | the latest connect or reconnect |
| `last_checked_at` | `timestamptz` | yes | | the last daily token check (MC10) |
| `last_check_error` | `varchar(500)` | yes | | Meta's code, subcode, HTTP status — never its text |
| `disconnected_at` | `timestamptz` | yes | | `(status = 'revoked') = (disconnected_at IS NOT NULL)` |
| `usage_percent` | `smallint` | yes | | **new in rev 3** (MC19): Meta's highest usage percentage of the business and the app, 0–100 |
| `usage_wait_until` | `timestamptz` | yes | | **new in rev 3** (MC19): set at ≥ 95 %; calls wait until it |
| `usage_read_at` | `timestamptz` | yes | | **new in rev 3** (MC19): when the last answer was read; a reading older than this one is dropped |

Indexes: unique `idx_channel_connections_public_id`; unique `idx_channel_connections_organization_id_id` `(organization_id,
id)` — the parent key of accounts and tokens; unique `idx_channel_connections_organization_business` `(organization_id,
provider, client_business_id)`; `idx_channel_connections_provider_business` `(provider, client_business_id)` — Meta's callbacks matched by business across organizations (MC15, P56, rev 4); `idx_channel_connections_check_due` `(last_checked_at) WHERE status = 'connected'` — the sweep
across organizations; `idx_channel_connections_connected_by_user_id` `WHERE connected_by_user_id IS NOT NULL`. Checks
`chk_channel_connections_provider`, `_status`, `_login_type`, `_client_business_id`, `_disconnected`, `_scopes`, `_usage_percent` (0–100, rev 3), `_updated`.
RLS: enabled and forced, `channel_connections_tenant_isolation` `FOR ALL` — `USING` the organization arm OR
`maintenanceBypassArm('app.global_retention_cleanup')` (the sweep), `WITH CHECK` the organization arm only.

`app.channel_connection_tokens` (no public id; a persistence part — no routes)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_connection_id` | `bigint` | no | | composite → connections `ON DELETE CASCADE`; one per connection |
| `encrypted_access_token` | `text` | no | | `encryptFieldSecret` output, `length > 0` |
| `token_type` | `varchar(20)` | no | `'system_user'` | **changed in rev 3** (P49): `system_user` · `oauth_user` |
| `encrypted_refresh_token` | `text` | yes | | **new in rev 3** (MC18): `encryptFieldSecret` output, `length > 0` when set; empty for Meta |
| `expires_at` | `timestamptz` | yes | | empty = never ends (D24) |

Indexes: unique `idx_channel_connection_tokens_organization_connection` `(organization_id, channel_connection_id)` (one per
connection, and the composite key's index). Checks `chk_channel_connection_tokens_token_type`,
`_encrypted_access_token_not_empty`, `_encrypted_refresh_token_not_empty` (rev 3), `_updated`. RLS: the organization arm in `USING` and `WITH CHECK`, **no** bypass arm
(MC9); enabled and forced. Both tables in `EXPECTED_FORCE_RLS_TABLES` (+2; the token table of the launch −1).

### 1.4 Permissions

Two new codes, `channel-account:read` and `channel-account:manage` ([P59](decisions.md)) — shared by every channel's connection and account, added by tenancy's migration with the grants the `instagram-account:*` codes have (TN12). Held by default per the four roles (D55, sub-domain 9).

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `channel-account:manage` | Workspace · Connect and remove Instagram accounts | start, finish, reconnect, pick, disconnect business | 1, 2, 3, 5, 40 | Owner, Admin |
| `channel-account:read` | Automations · See automations | the connections list, one connection, the ad accounts and ads | 4, 15, 41, 42 | Owner, Admin, Editor, Viewer |

Routes 16–17 are PUBLIC (Meta's signed request).

### 1.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1), under `/social/channel-connections` |
| Auth | routes 1–5, 15, 40–42: `Authorization: Bearer <access token>`; the active organization from the token; no organization segment. Routes 16–17: PUBLIC, Meta's `signed_request` (MC14) |
| Path params | `{provider}` (non-entity, K13; `meta` only — another value → `400 provider`) on 1, 2, 16, 17; `{channel_connection_id}` on 3, 5, 15, 40–42 — another organization's → `404 channel_connection_not_found`. The two share the segment after `channel-connections/`; the next segment always tells them apart (MCC10) |
| Organization | team-only (K1): writes 1, 2, 3, 5, 40 → `422` (`assertTeamOrganization`, the `INSTAGRAM` capability); reads 4, 15, 41, 42 → `404 team_organization_required`; `403 missing_permission` comes first (a personal Owner holds no app code) |
| Writes | routes 2 and 3 need `X-Idempotency-Key` (MC5, MC7); routes 1 and 40 take none (MC4, MC17); 16–17 none (K3) |
| Success | `200` with `{ data, meta }`; route 5 → `204`; route 17 answers Meta's own shape |
| Lists | route 4: all, no paging; route 41: Meta's first 100, no paging; route 15: Meta's cursor, `limit` 1–50 (default 25), `after`, no `estimated_total` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `409`, `422`, `429`, `503 instagram_unavailable` (with `Retry-After`) / `instagram_not_configured` |

### 1.6 Objects returned

**Channel connection**: `id` (prefix at kickoff), `provider` (`meta`), `client_business_id`, `login_type`, `status`
(`connected` · `error` · `revoked`), `status_changed_at`, `scopes`, `has_ads_access` (`ads_read` granted),
`connected_by_user_id` (`usr_…` or null), `connected_at`, `last_checked_at`, `last_check_error` (codes only),
`disconnected_at`, `channel_accounts` (`[{ id, channel, display_name, profile_picture_url, connection_status }]`),
`created_at`, `updated_at`. Never the token.

**Channel connect start** (routes 1, 40): `login_url`, `state_expires_at`.

**Channel connect result** (route 2): `is_reconnect` (the business was connected before), `channel_connection` (Channel
connection), `accounts` (`[{ channel, provider_account_id, username, profile_picture_url, state, channel_account_id }]`,
`channel` = `instagram`, `state` = `connected_here` · `connected_elsewhere` (cannot be picked) · `free`;
`channel_account_id` = `cha_…` when `connected_here`), `reconnected_account_ids` (`cha_…` set back to `connected`),
`plan_room` (`{ accounts_max, accounts_used, accounts_free }`).

**Channel account pick result** (route 3): `channel_connection_id`, `results` (`[{ provider_account_id, result,
channel_account }]`, `result` = `connected` · `already_connected` · `connected_elsewhere` · `not_assigned`,
`channel_account` = the Channel account (1B.6) when `connected` or `already_connected`), `plan_room`.

**Meta ad account** (route 41): `ad_account_id`, `name`, `account_status`; list `meta.ad_access` (`granted` · `missing`).

**Meta ad** (route 15): `ad_id`, `name`, `status`, `ad_account_id`, `instagram_media_id` (or null for an ad that is not an
Instagram post), `channel_account_id` (`cha_…` or null), `thumbnail_url`, `created_at`; list `meta.ad_access`.

**Meta data-deletion answer** (route 17): unchanged — `url`, `confirmation_code`.

### 1.7 Routes (1–5, 15–17, 40–42)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/social/channel-connections/{provider}/start` | Start the provider's login (Meta's Unified Login) **(new, RC-1)** | `channel-account:manage` | none (MC4) |
| 2 | POST | `/social/channel-connections/{provider}/callback` | Finish the login, or a reconnect; answers the picker **(new, RC-2)** | `channel-account:manage` | req |
| 40 | POST | `/social/channel-connections/{channel_connection_id}/reconnect` | Start a reconnect of this connection **(new, RC-113 — MC17)** | `channel-account:manage` | none (MC17) |
| 3 | POST | `/social/channel-connections/{channel_connection_id}/accounts` | Connect the picked accounts **(new, RC-3)** | `channel-account:manage` | req |
| 4 | GET | `/social/channel-connections` | The organization's connections **(new, RC-4)** | `channel-account:read` | |
| 42 | GET | `/social/channel-connections/{channel_connection_id}` | One connection **(new, RC-112 — MC8)** | `channel-account:read` | |
| 5 | DELETE | `/social/channel-connections/{channel_connection_id}` | Disconnect business **(new, RC-5)** | `channel-account:manage` | |
| 41 | GET | `/social/channel-connections/{channel_connection_id}/ad-accounts` | Its ad accounts, for the ad picker **(new, RC-114 — MC13)** | `channel-account:read` | |
| 15 | GET | `/social/channel-connections/{channel_connection_id}/ads` | One ad account's ads, for ad automations **(new, RC-15; moved from the account in rev 2)** | `channel-account:read` | |
| 16 | POST | `/social/channel-connections/{provider}/deauthorize` | Meta: the app was removed **(changed, RC-17; moved in rev 2)** | PUBLIC (Meta signed request) | none (K3) |
| 17 | POST | `/social/channel-connections/{provider}/data-deletion` | Meta: delete the data **(changed, RC-18; moved in rev 2)** | PUBLIC (Meta signed request) | none (K3) |
| — | ~~POST~~ | ~~`/social/instagram/connect`~~ | **REMOVED (RC-6)** — Instagram Login goes (D24); replaced by 1 + 2 + 3 | — | — |

### 1.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 1, 40 | — | — (strict empty) | Channel connect start |
| 2 | — | `code*` (1–2000; a trailing `#_` stripped), `state*` (43 characters, base64url) | Channel connect result |
| 3 | — | `channel*` (`instagram`), `provider_account_ids*` (1–10, digits, no repeats) | Channel account pick result |
| 4 | `include_revoked` (`true` \| `false`, default `false`) | — | Channel connection[] |
| 42 | — | — | Channel connection |
| 5 | — | — | 204 |
| 41 | — | — | Meta ad account[] |
| 15 | `ad_account_id*` (digits), `limit` (1–50, default 25), `after` (Meta's cursor, 1–1000) | — | Meta ad[] |
| 16 | — | form `signed_request*` | `{ data: null, meta }` |
| 17 | — | form `signed_request*` | Meta data-deletion answer |

### 1.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 1, 2, 16, 17 | `400` · `provider` | not `meta` |
| 2, 3 | `400` · `code` / `state` / `channel` / `provider_account_ids` | missing, empty, too long, a repeat, more than 10, not digits, an unknown channel or field |
| 2 | `400` · `channel_connect_state_invalid` | the state is missing, used, older than 10 minutes, or another user's, organization's or provider's (nothing saved) |
| 2 | `422` · `provider_code_invalid` | Meta refuses the code |
| 2 | `422` · `provider_permissions_missing` | `instagram_basic`, `instagram_manage_messages` or `instagram_manage_comments` not granted |
| 2 | `409` · `instagram_connect_restart_required` | Meta failed after the one-time code was spent (launch D56) — start again |
| 2 | `409` · `channel_connection_business_mismatch` | a reconnect started by route 40 came back from another business (nothing saved) |
| 3 | `409` · `plan_account_limit` | not-revoked accounts + the picks exceed the plan's `channel_accounts_max` (nothing saved) |
| 3 | `409` · `channel_connection_not_connected` | the connection is `error` or `revoked` — reconnect first |
| 3 | `409` · `trial_used_by_account` | during a trial, a picked account already had a trial in an organization (sub-domain 8's trial port, BL18; nothing saved) |
| 3 | `409` · `instagram_account_connected_elsewhere` | as built (R3, [P113](decisions.md)): a pick raced another organization for the same account at the same moment (nothing saved) |
| 3 | `409` · `channel_connection_not_connected` | as built (R3, [P113](decisions.md)): also when Meta refuses the connection's token on the pick |
| 3, 5, 15, 40–42 | `404` · `channel_connection_not_found` | not in the organization, another organization's; routes 5 and 40 also a revoked one |
| 15, 41 | `404` · `instagram_reconnect_required` | the connection is `error` (as built, R4 [P402](decisions.md): or `revoked`), or Meta just refused the token (code 190) |
| 15 | `400` · `ad_account_id` / `limit` / `after` | missing, not digits, out of range, too long, an unknown field |
| 15 | `404` · `ad_account_not_found` | `ad_account_id` is not one of the connection's |
| 1, 2, 3, 5, 40 | `422` | a personal organization; or the idempotency key missing, malformed or reused (2, 3) |
| 4, 15, 41, 42 | `404` · `team_organization_required` | a personal organization |
| signed-in | `403` · `missing_permission` | the caller lacks the gate |
| 1–3, 15, 40, 41 | `503` · `instagram_unavailable` / `instagram_not_configured` | Meta down or throttling (`Retry-After`) / a `META_*` setting unset |
| 16, 17 | `400` · `instagram_signed_request_invalid`; `413`; `415`; `429`; `503` · `instagram_not_configured` | as built (launch § 1.D.9), now `META_APP_SECRET` |

### 1.10 Rules worth knowing

- **What the later sub-domains take from here, never a copy**: the Meta client and adapter (MC2) and the token path (MC9);
  `markConnectionBroken` (MC11) for every 190 in sub-domains 2 and 6; the connection of an account for the sender (channel
  account → connection → token); the signature check for sub-domain 5's receiver.
- **No Meta call inside a database context** (`rls-context-network-isolation.global.test.ts`): routes 2, 3, 5, 15, 41 and
  the token check read, close the unit of work, call Meta, then write in a new one.
- **Status moves only these ways**: `connected → error` (MC11, the one guarded change); `error → connected` (a callback,
  MC5); any → `revoked` (route 5, or the last account leaving — route 8, Meta's callbacks); `revoked → connected` only by a
  callback of the same business in the same organization.
- **An unmatched id on 16–17 is `200` and a team email, never a `404`** — Meta must not retry.
- **Frontend (meepzo-fe, later iteration, P30)**: the login page sends `state` back unchanged with the key
  `channel-connect:<state>`; `error=access_denied` shows "You stopped the connection. Nothing changed." and calls nothing;
  the connections screen's Reconnect calls route 40.

### 1.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| MCC1 | **Built R3** (the token on the connection through a bridge on `app.instagram_accounts.channel_connection_id` until R5 — [P111](decisions.md); prefix `chc`; `createWorkerChannelConnectionRepository`; the usage child table — [P112](decisions.md)). MC1, MC9: `channel-connection/` folder; `channel-connection.schema.ts` + `channel-connection-token.schema.ts` (columns, keys, checks, policies as 1.3) in the account migration changed in place (D1); `EXPECTED_FORCE_RLS_TABLES` +2 −1; `PUBLIC_ID_PREFIXES.channelConnection`, `PARAM_NAME_TO_ENTITY.channel_connection_id`; repository (`createWorkerChannelConnectionRepository(databaseHandle)` for the token check), token repository and service; the renamed token-isolation policy test; `encrypted_access_token` kept in the response-secret and log-redaction lists; the secrets-key rotation's table list; OpenAPI tag `Channel connection`; `channel-connection.overview.md`; `src/domains/CLAUDE.md`'s app row |
| MCC2 | **Built R2** (the Instagram Login calls kept until R3 — [P106](decisions.md); circuit `meta`, integration `meta-graph` — [P108](decisions.md); `appsecret_proof` needs the secret — [P110](decisions.md)). MC2, MC3: `src/infrastructure/social/instagram.client.ts` **moved** to `channel-connection/channel-connection-meta/meta-graph.client.ts` (with `meta-graph-error.util.ts`, `meta-login.ts`, `meta-signature.ts`; every import updated, no copy left) on `graph.facebook.com` with `META_GRAPH_VERSION` (code constant), `appsecret_proof`, the Unified Login and ad calls; `instagramCircuit` → `metaGraphCircuit`; Instagram Login functions, their URL redaction and their contract fixtures removed; `src/tests/contract/instagram.contract.test.ts` → `meta-graph.contract.test.ts`, re-recorded (exchange, `/me`, assigned accounts, ad accounts, ads, a 190 body, a throttled body); env `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN` in, the four `INSTAGRAM_*` out (be-env-schema-add: schema with the 32-character secret refine, `.env.example`, fake values, credentials fill, GitHub Environments); `CONNECT_STATE_MINUTES`, `PROFILE_READ_TIMEOUT_MILLISECONDS` in the app settings file (P4); `channel-connection-meta.overview.md` |
| MCC3 | **Built R2: the state** (routes 1 and 40 in R3 — [P109](decisions.md)). MC4, MC17: the one-use state helper lifted from `oauth-state.ts` (both callers use it); routes 1 and 40 |
| MCC4 | **Built R3** (accounts through `ChannelConnectionAccountPort` over the launch table until R5, lanes and trial behind `ChannelConnectionLanePort` / `ChannelConnectionTrialPort` for R18 / R24, the pick's account summary, two extra 409s — [P111](decisions.md), [P113](decisions.md)). MC5–MC7: routes 2–3 (`config: { idempotencyRequired: true }` merged into the rate-limit config), controller, service (the callback steps, reconnect, the pick under `pg_advisory_xact_lock`), DTOs (strict), serializers; the channel account rows (1B), the Instagram extension and settings rows (2) and lanes (6) through their services; reasons `channel_connect_state_invalid`, `provider_code_invalid`, `provider_permissions_missing`, `channel_connection_business_mismatch`, `plan_account_limit`, `channel_connection_not_connected`, `channel_connection_not_found` with `errors:` keys in `src/shared/locales/en/` and in `response-codes.md`; the launch reasons `instagram_code_invalid`, `instagram_account_not_professional`, `instagram_scopes_missing`, `organization_already_has_instagram_account` retired with RC-6 |
| MCC5 | **Built R3** (the lane stop behind the port for R18 — [P113](decisions.md)). MC8: routes 4, 42 and 5, the disconnect-business service over sub-domain 1B's disconnect |
| MCC6 | MC10, MC11: `channel-connection/queues/channel-connection-token-check.{queue,job.schema}.ts` (`organizationPublicId`, `channelConnectionPublicId`), `workers/channel-connection-token-check.{worker,processor}.ts` (on `instagram-tasks`, never paused; the hourly sweep as a second job name under `runGlobalRetentionWorkerJob`), registry, `WORKER_QUEUE_NAMES`, scheduler; the launch's `instagram-account-daily-check` queue, worker and tests removed (WC-35); `markConnectionBroken` on the connection; tests: due / not due, OK clears the error, a missing account → `error`, 190 → connection and every account `error` with one notice each, Meta down changes nothing, twice = once |
| MCC7 | **Built R3** (the bulk seed in `channel-connection/seed/`; the RLS lane by `pnpm test:rls-role`). MC12, tests and seeds: the audit actions; integration tests for every success and error of 1.9, two first connects racing (the advisory lock), a pick over the limit, one pick elsewhere while the others connect, a reconnect that moves an account; RLS test as `meepzo_be_app`; bulk seed — each demo team organization gets one connection with a fake encrypted token (`channel-connection/seed/`); `pnpm routes:catalog`, success statuses, `docs:generate` |
| MCC8 | **Built R4** (the break of MC11 built with it, the account read first, `instagram_user_id` — [P401](decisions.md), [P402](decisions.md)). MC13: routes 41 and 15 (client calls for ad accounts and ads, DTO, serializer, `meta.ad_access`, the match of an ad to a channel account by Instagram id); reason `ad_account_not_found`; nock tests — paging passed through, no `ads_read` → empty lists, the break on 190, an `error` connection `404` |
| MCC9 | **Built R9** (the callbacks at the folder root as `channel-connection-meta-callback.*`, not a nested sub-domain; resolver (1) over `app.channel_accounts` joined to the connection's `provider` with `idx_channel_accounts_provider_account`; a business match also revokes a connection of that business left with no account; audit `app.channel_connection.*` with `match` — [P211](decisions.md); the team email behind `ChannelConnectionMetaCallbackTeamAlertPort` until R53, an error-level log meanwhile — [P212](decisions.md); the reached accounts' lanes stopped through `ChannelConnectionLanePort.stopLanes` in each organization's erase unit, as route 8 — the R9 × R18 fix in [AS-BUILT](../AS-BUILT.md)). MC14–MC16: the `signed_request` plugin on `META_APP_SECRET` at the two new paths; the two new resolvers (account, then business — P56) and `idx_channel_connections_provider_business` in the account migration (the app-user resolver dropped), their security tests as `meepzo_be_app`; the disconnect through CA8's path (token kept while another account uses the connection); the unmatched-id team email; integration tests — an account-id match, a business-id match that reaches every account of its connection, an unmatched id still `200` with a code and one team email, a connection's last account deletes its token, another organization's live account untouched |
| MCC10 | **Built R3** (the shared segment works in Fastify's router — the integration suite drives every path; the frontend map row at R63). MC1, MC17: a router test that `{provider}` and `{channel_connection_id}` resolve on the same segment (`meta/start`, `meta/deauthorize` vs `<id>/accounts`, `<id>/ads`, `DELETE <id>`); the route catalog and frontend map rows of routes 40–42 |
| MCC11 | **Built R3**. MC18: the token schema and migration — `encrypted_refresh_token`, `token_type` `oauth_user`, the two checks; the token service writes `system_user` for Meta and never a refresh token; the isolation policy test covers the new column (read only on the client path); a unit test that a refresh token is stored encrypted |
| MCC12 | **Built R2 behind the store ports** (the store in R3, callers in R20/R39/R41/R42 — [P107](decisions.md)). MC19: the Meta client parses `X-Business-Use-Case-Usage` and the app usage header on every answer and writes the connection's three usage columns in its own unit (an older reading dropped); `readConnectionUsage` and `channel-connection-usage.cache.ts` under be-read-cache-guard (key from the verified scope, tombstone after the write, fail open, TTL ≤ 60 s, the five tests); callers in 4.C, 5 and 6 switched to it; nock tests — 80 % slows, 95 % waits until Meta's time or 15 minutes, a missing header changes nothing |

### 1.12 Nested sub-domains

None with sections. One nested folder, `channel-connection-meta/` (the Meta adapter — MC2, MCC2): the client, its error
map, the login calls and the two signature checks; no table, no route of its own (routes 15–17, 41 and 42 are served at the folder root through it). A later provider adds a sibling folder (`channel-connection-<provider>/`).

---

## 1B. Channel account — rev 5 (2026-11-24) — no nested sub-domains; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (P31; new in rev 2, [P42](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`channel-account` sub-domain folder** — `app/sub-domains/channel-account/` (**new**, P42), the channel account
at the folder root; no nested sub-domains. Numbered 1B so that sub-domains 2–12 keep their numbers (M9).

1B.1 Decisions (whole sub-domain) · 1B.2 Open questions · 1B.3 Tables and relations · 1B.4 Permissions · 1B.5 Common to every
route · 1B.6 Objects returned · 1B.7 Routes · 1B.8 Request details · 1B.9 Errors · 1B.10 Rules worth knowing · 1B.11 Code
changes (whole sub-domain) · 1B.12 Nested sub-domains (none).

**Ids are new in rev 2**: decisions `CA1`…, code changes `CAC1`…, questions `CAQ1`… — most moved from rev 1's sub-domain 2
(IA1–IA5, IA9–IA11, IAC1, IAC2, IAC4, IAC7; the map is in M9).

The common part of every connected inbox, whatever its channel: an organization now holds **many** accounts (Free 1, Creator 3,
Studio 10 — D26), each brought in by a channel connection (sub-domain 1); `channel` is `instagram` this iteration (a
Facebook Page later, D27). This sub-domain lists and reads them, disconnects one, pauses and resumes its sending, swaps which
accounts are active within the plan (D57), and holds the account's status, display name, its pause / suspend / plan-stop
state and the automation switch (P42). The Instagram-only part — user id, username, profile, settings, posts — is sub-domain
2's extension, reached through `channel_account_id`. Every product and sending table now points at `app.channel_accounts`
(`channel_account_id`, P47). Design read: plan §15.4, §15.8, §18.1, §25.5–25.12 (plan:L2593–L2684, L4590–L4705);
`db-changes.md` › channel_account, instagram_account; `route-changes.md` RC-7–RC-11, RC-60; `worker-changes.md` WC-37, WC-38, WC-56 (the plan stop),
WC-46. Builds on 1 (the connection); routes 9–11 and the lane part of route 8 are **built with sub-domain 6** (the lanes'
owner — CA5). Route numbers run 6–11.

### 1B.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90).

**rev 2 changes** (new sub-domain, P42, P47): the common account table `app.channel_accounts` split out of
`app.instagram_accounts`; routes 6–11 moved from `/social/instagram/accounts/{instagram_account_id}…` to
`/social/channel-accounts/{channel_account_id}…`; the list filters by `channel`; pause, suspend and plan stop and the
automation switch now live on the account (CA3) instead of the lanes and the settings; the limit is `channel_accounts_max`.

**rev 3 changes** (P48, P50, M10): 1B now holds the per-channel **capability list** `CHANNEL_CAPABILITIES` and the **one feature check** "can this channel account use feature X" (CA11) that go-live (4), settings (2), broadcasts (7) and the engine (6) call instead of three separate checks; the shared product tables (contacts, automations, broadcasts, segments — P48) point at `app.channel_accounts` as before; new question CAQ2 (the refusals' statuses). Routes 6–11 unchanged.

**rev 4 changes** (P59, P60, P61, P76, P83, M12): routes 6–11 gated by `channel-account:*` (P59); the feature check reads the plan's own switch for each feature (P83) and also guards segments (routes 78, 80, 82 — P76); CAQ1 and CAQ2 answered as recommended (P60, P61).

**rev 5 changes** (P99, M13): **the plan stop lives on the account** — `plan_stop_reason` `plan_limit` · `plan_ended` · `plan_downgrade` with `plan_stopped_at` (`plan_limit` holds slow, fast and broadcast, the reply lane goes on — D62; the other two hold all four), its order of reasons, index and check (CA3, CA9, 1B.3, 1B.6, 1B.9, CAC2); the lanes keep only their error stops (sub-domain 6, SN12). Routes 6–11 unchanged; route 7 adds `plan_stop_reason` (additive).

| # | Decision |
| --- | --- |
| CA1 | **Folder, table, ids (P42, P47).** Today: the account is `instagram-account/`'s root (`app.instagram_accounts`, `iga_…`). After: a new sub-domain `app/sub-domains/channel-account/` with `channel-account.{routes,controller,service,repository,schema,dto,validator,serializer,types,constants}.ts`, owning `app.channel_accounts`; the Instagram columns stay on `app.instagram_accounts`, now a 1:1 extension (sub-domain 2). Public-id entity `channelAccount` (prefix `cha` proposed, confirmed at kickoff — P22; the account's one public id, P47: Instagram routes take `{channel_account_id}` too, no second Instagram id); path param `{channel_account_id}` in `PARAM_NAME_TO_ENTITY` (`instagram_account_id` leaves it). Every pointer that was `instagram_account_id` on a product or sending table becomes `channel_account_id` → `app.channel_accounts` (P47), and every job payload's `instagramAccountPublicId` becomes `channelAccountPublicId`. Paths under `/api/v1/app/social/channel-accounts/…`. OpenAPI tag `Channel account`. Other option: keep one Instagram table — a later channel would copy every column and route. |
| CA2 | **Many accounts: path ids, the singular routes go (P1, D26; was IA1).** Today: one not-revoked account per organization (launch D5), so the account routes are singular with no path id — `GET` / `DELETE /social/instagram/account`, `PATCH …/account/settings`, `GET …/media`, `…/stories`. After: the common routes nest under `/social/channel-accounts/{channel_account_id}` (6–11) and the Instagram ones under `/social/instagram/accounts/{channel_account_id}` (12–14, 63); the five singular routes are **moved** (CHANGED in route-changes), never kept beside the new ones. The unique index "one per organization" is dropped; one organization per account stays (`idx_channel_accounts_provider_account_live`, CAQ1). Other option: singular routes plus an active-account claim or query — rejected in P1. |
| CA3 | **The account holds its pause, suspend and plan stop (P42, D57, P18; was IA2, which kept them on the lanes).** Today: the account has only `connection_status`. After: `app.channel_accounts` holds `paused_at` (the owner's pause, route 9), `suspended_at` (the team's suspend, P18 — no route this iteration) and **the plan stop** — `plan_stop_reason` with `plan_stopped_at` (P42; rev 5 moved the organization-wide reasons here from the lanes — [P99](decisions.md)): **`plan_limit`** (the organization's month limit, D34 — set on every not-revoked account of the organization at the 100 % crossing, WC-56; cleared by the month wake or an upgrade, WC-37) holds the **slow, fast and broadcast** lanes and the reply lane goes on (P3, D62); **`plan_ended`** (a cancelled paid plan or a grace that ended — WC-38) and **`plan_downgrade`** ("not in your plan", D57 — route 11, the pick's limit and WC-38) hold **all four**. One reason at a time: `plan_downgrade` is never replaced by the other two (it already holds every lane), `plan_ended` replaces `plan_limit`, and ending `plan_ended` re-derives `plan_limit` from the month count (WC-37, WC-38), so a weaker stop is never forgotten. Plus `is_automation_enabled` (the automation switch, moved from the Instagram settings, P42). These are **the** copy: the Instagram lanes carry no pause, suspend or plan stop — a lane turn reads its account's columns in the same unit of work (sub-domain 6, SN12); only the error stops stay on the lanes (6). The object shows `is_paused`, `is_suspended`, `is_in_plan` (no `plan_downgrade`), `plan_stop_reason`, `is_automation_enabled` from the row and `active_stop` through sub-domain 6's lane service in the same unit of work. Other option: rev 1's IA2 — the state on four lane rows per account, which a second channel would have to copy. |
| CA4 | **Status loses `expired`; the connection breaks accounts (D24; was IA3).** Today: `connection_status` `connected` · `expired` · `error` · `revoked`; `expired` = the 60-day token ended (subcode 463); one account breaks alone (launch IA9). After: `connected` · `error` · `revoked`. An account goes `connected → error` either with its connection (sub-domain 1, MC11) or alone (missing from the assigned list, became personal, §25.9 — plan:L4660–L4672), through this service's guarded `markAccountBroken`; the winner enqueues the reconnect notice (WC-46, the Instagram `instagram-reconnect-notice` worker of sub-domain 2 — every job but the token check is Instagram's, P47 — addressed to Owners and Admins, `channel-account:manage`). `error → connected` only by a reconnect (sub-domain 1). |
| CA5 | **Routes that act on lanes are built with sub-domain 6 (was IA4).** Pause, resume, activate (routes 9–11) and the "lanes stopped" part of disconnect (route 8) and pick (sub-domain 1, route 3) wake or stop `app.instagram_send_lanes` through sub-domain 6's lane service in the caller's transaction. The lanes table comes with sub-domain 6, so these three routes are built in 6's ROUTE row and route 8's lane step lands then (the launch's CT5 pattern). Other option: build the lane table early — it then has no reader for several rows. |
| CA6 | **Team-only and personal organizations (launch IA3 kept; was IA5).** Writes 8–11 → `422` through `assertTeamOrganization({ capability: 'INSTAGRAM' })`; reads 6, 7 → `404 team_organization_required`; `403 missing_permission` first. Another organization's account or a revoked one → `404 channel_account_not_found` (new reason, P47 — the launch's `instagram_not_connected` meant "this organization has none"; it stays only as automation create's `409`, sub-domain 4). |
| CA7 | **List, read, pause, resume (routes 6, 7, 9, 10, plan:L2599–L2600; was IA9).** Route 6: every not-revoked account, oldest-connected first (the account menu; at most 10), filter `channel` (one or more; default every channel), each a Channel account summary. Route 7: one account with its Instagram extension and settings (`instagram`, through sub-domain 2's service) and sending state (CA3) — database only, never Meta. Route 9: `paused_at` = now (and `paused_by_user_id`); comments and taps are still saved, nothing goes; an already paused account answers the same. Route 10: clears only the owner's pause — error stops, a team suspend and a plan stop stay; each lane with waiting messages gets one turn again and fast tickets come back in pieces of 500 over 5 minutes (sub-domain 6). Both answer the Channel account. A repeat lands in the same state, so neither takes an idempotency key. Pausing a `revoked` account is a `404`; an `error` account may be paused and resumed (the owner may stop it before reconnecting). |
| CA8 | **Disconnect one account (route 8, plan:L4683–L4693; was IA10).** Today (launch IA14): best-effort unsubscribe, then `revoked`, token row deleted, `token_expires_at` and `webhook_subscribed_at` emptied. After: before the transaction, best-effort removal of its starter questions and `DELETE /{instagram_user_id}/subscribed_apps` (sub-domain 2's Instagram step; logged, never blocks); one commit: `revoked`, `disconnected_at`; the extension's `webhook_subscribed_at` and `starter_questions_set_at` emptied (sub-domain 2's service); its four lanes `stopped` with no turn (sub-domain 6); **the connection's token is deleted only when no other not-revoked account uses that connection** — then the connection is `revoked` too (sub-domain 1); after commit its Redis keys go (`cnt:*`, `acct:`, `auto:`, `banner:`, `estimate:`, `tags:` — each owner's cache module invalidates its own). Automations stay `live`, contacts and history stay; waiting messages stay waiting and expire by the 7-day rule, or go on if the same account reconnects (launch IQ1 kept). The organization frees one slot of its plan. |
| CA9 | **Choose active accounts (route 11, D57, plan:L2631; was IA11).** An account is "not in your plan" while its `plan_stop_reason` is `plan_downgrade` (CA3). Route 11 makes such an account active: under `pg_advisory_xact_lock` on the organization (the same lock as the pick, MC7), count the active accounts (not revoked, not `plan_downgrade`); at the plan's `channel_accounts_max` the body must name `stop_channel_account_id` — an active account of the same organization — which gets `plan_downgrade` in the same commit; below the limit (an active account was disconnected) none is needed. The activated account's `plan_downgrade` clears (to `plan_limit` when the organization is at its month limit, or `plan_ended` when its plan ended — CA3) and its lanes wake after commit. Already active → `409 channel_account_already_active`; at the limit with no account named → `409 plan_account_limit`; the named account not active or another organization's → `400 stop_channel_account_id`. `X-Idempotency-Key` required: a network retry must replay the swap's answer, not a `409`. A pending move-down's kept list is billing's (sub-domain 8, RC-59) and is not changed here. |
| CA10 | **Audit (launch K9; from IA7).** `app.channel_account.connect` (WARNING, written by sub-domain 1's pick — MC12), `.disconnect` (WARNING), `.pause`, `.resume` (INFO), `.activate` (WARNING, `metadata.stopped_channel_account_public_id`). All after commit. |
| CA11 | **The capability list and the one feature check (P48, P50).** Today (rev 2): what an automation may use is checked three ways in three places — the plan's PRO parts (`assertPlanFeature`, 4 and 7), Meta's untested features (`APP_UNTESTED_META_FEATURES`, 4's go-live and 2's settings) and nothing for the channel or the connection's permissions. After: (1) **`CHANNEL_CAPABILITIES`** — a code constant (P4) in `channel-account/channel-account-capabilities.constants.ts`, one entry per channel, `instagram` the only one now: its ways to start (the 15 `trigger_type` values, AU8), its steps (`hello`, `follow`, `email`, `phone`, `messages`, `tags`, `public_reply`, `hide_comment`), its message kinds (`text`, `image`, `cards`, `quick_replies`, `audio`, `file`, `post`) and its features (`email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `broadcasts`, `segments`, `past_comments`, `extra_delay`, `mark_seen`, `starter_questions`, …); a later channel adds its entry and nothing else changes. Beside it, **`CHANNEL_FEATURES`** maps each feature to what it needs: the capability, the connection's permission (e.g. `ads_read` for an ad start), the plan switch it reads — one per feature, the PRO ones off on Free (P83; D35, D57) and whether Meta's test must have passed (P36). (2) **One check**, `canChannelAccountUseFeature({ databaseHandle, organizationId, channelAccountId, feature })` → allowed, or the first failing reason in this order: **`channel_lacks_feature`** (the account's channel does not list it), **`permission_not_granted`** (the connection's `scopes` lack it — the answer is route 40's reconnect, which asks for the missing permission, MC17), **`plan_lacks_feature`** (the plan's own switch for that feature, read from sub-domain 8's `getPlanAccess` — P83; was `plan_feature_required`), **`feature_not_offered`** (still on `APP_UNTESTED_META_FEATURES`, owned by 6's settings file). It reads Postgres and constants only (no Meta call) inside the caller's unit; `listChannelAccountFeatureProblems` checks a whole automation or broadcast in one read of each input. (3) **Callers**: go-live lists every refusal as a problem item (AU13, AU34); a save that turns a part on, route 38, routes 71, 75, 78, 80 and 82 (P76) and route 12 refuse outright with the statuses of CAQ2; the run engine and the lanes skip a part the account can no longer use, never refuse it (D57, SN22). `assertPlanFeature` stays only as the plan input of this check. Other option: keep three checks — three places to update for every new channel. |

### 1B.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| CAQ1 | Where does "one organization per account" live, now that the status is on `app.channel_accounts` and the Instagram user id on the extension (a partial unique index cannot read two tables)? | `provider_account_id` on the channel account (unique per channel while not revoked) · keep the id only on the extension and add a status copy there | **`provider_account_id` on the channel account** — the provider's own id is common to every channel (Instagram user id, Page id), written once at the pick in the same commit as the extension's `instagram_user_id`; the service keeps the two equal and a DB test pins it | **P60** — on `app.channel_accounts` (as recommended, CAC5) |
| CAQ2 | P50's one feature check answers four reasons — which status does a route give each when it refuses outright (go-live lists them as `errors[]` items instead)? | `422 channel_lacks_feature`, `409 permission_not_granted`, `403 plan_lacks_feature`, `422 feature_not_offered` · `403` for all four | **The first** — `channel_lacks_feature` asks for something the channel can never do (`422`, like a bad field); `permission_not_granted` is the connection's state and the same call passes after a reconnect (`409`); `plan_lacks_feature` keeps the PRO refusal's `403` (was `plan_feature_required`); `feature_not_offered` keeps route 12's `422` (M2, M10) | **P61** — split: `422` · `409` · `403` · `422` (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 1B.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.channel_accounts` | one connected inbox of an organization (an Instagram professional account now) | many per organization (the plan's limit, checked at the pick); one not-revoked row per provider account across organizations (CAQ1); status by actions only (CA4); no soft delete — `revoked` |

```text
tenancy.organizations
   │
   └──< app.channel_connections (1) ──< app.channel_accounts ──┬──── app.instagram_accounts (2, 1:1) ──< settings (1:1) · stored posts
                                                              ├──< app.instagram_send_lanes (6)    4 per account
                                                              ├──< contacts, automations, broadcasts, segments, messages … (3–7)
                                                              └──> auth.users (connected by, paused by)
```

Pointing at it from other sub-domains: `instagram_accounts.channel_account_id` (2, 1:1), and every
`channel_account_id` of sub-domains 2–7 — `instagram_account_settings`, `instagram_media`, `contacts`,
`contact_tag_events`, `automations`, `automation_backfills`,
`automation_reply_states`, `segments`, `broadcasts`, the webhook events and keys, and sub-domain
6's lanes, stops, minute counts, attachments and messages — composite `(organization_id, channel_account_id)`, `ON DELETE
RESTRICT` (an account is never deleted, only `revoked`), or by value on the split tables. Branch rule: none. Membership
pointers: none; `connected_by_user_id`, `paused_by_user_id` → users `ON DELETE SET NULL` (K6).

**PostgreSQL design**

The launch's standard columns (launch § 1.3). A new table in the account migration `20261121064529_app_instagram_account.sql`
changed in place (D1, P29; db-changes decides the file).

`app.channel_accounts`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `public_id` | `varchar(28)` | no | | `generatePublicId('channelAccount')` (prefix `cha` proposed, P22) — moved from the Instagram account |
| `channel` | `varchar(20)` | no | `'instagram'` | `instagram` (`chk_channel_accounts_channel`; Facebook later, D27) |
| `channel_connection_id` | `bigint` | no | | composite `(organization_id, channel_connection_id)` → `app.channel_connections (organization_id, id)` `ON DELETE RESTRICT`; a reconnect from another portfolio moves it (MC6) |
| `provider_account_id` | `varchar(64)` | no | | the account's id at the provider — for Instagram its `instagram_user_id` (CAQ1); digits |
| `display_name` | `varchar(100)` | no | | what the app shows (Instagram: `@username`); refreshed with the profile (P17) |
| `connection_status` | `varchar(20)` | no | `'connected'` | `connected` · `error` · `revoked` (moved from the Instagram account) |
| `is_automation_enabled` | `boolean` | no | `true` | the automation switch (moved from `instagram_account_settings`, P42): off = new events skipped, not saved for later |
| `paused_at` | `timestamptz` | yes | | the owner's pause (route 9); moved from the lanes (CA3) |
| `paused_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL`; only while `paused_at` is set |
| `suspended_at` | `timestamptz` | yes | | the team's suspend (P18); moved from the lanes |
| `plan_stop_reason` | `varchar(14)` | yes | | **rev 5 (P99)**: `plan_limit` (holds slow, fast and broadcast — the reply lane goes on, D62) · `plan_ended` · `plan_downgrade` ("not in your plan", D57) — both hold all four lanes (CA3); rev 4 had `plan_stopped_at` alone here and `plan_limit` / `plan_ended` on the lanes |
| `plan_stopped_at` | `timestamptz` | yes | | set exactly with `plan_stop_reason` |
| `connected_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL` (moved) |
| `connected_at` | `timestamptz` | no | `now()` | the latest pick or reconnect; starts the new-account limit (150 an hour for 7 days unless the owner set `opening_hour_limit`, D5) (moved) |
| `disconnected_at` | `timestamptz` | yes | | `(connection_status = 'revoked') = (disconnected_at IS NOT NULL)` (moved) |

Indexes: unique `idx_channel_accounts_public_id`; unique `idx_channel_accounts_organization_id_id` `(organization_id, id)` —
the parent key of every `channel_account_id`; unique `idx_channel_accounts_provider_account_live` `(channel,
provider_account_id) WHERE connection_status <> 'revoked'` (one organization per account — was
`idx_instagram_accounts_instagram_user_live`); `idx_channel_accounts_organization_channel` `(organization_id, channel,
connected_at) WHERE connection_status <> 'revoked'` (route 6); `idx_channel_accounts_connection` `(organization_id,
channel_connection_id)` — the composite key's index and "the accounts of a connection" (reconnect, break, disconnect
business); `idx_channel_accounts_connected_check` `(id) WHERE connection_status = 'connected'` — the 10-minute subscription
check pages it across organizations (sub-domain 2); `idx_channel_accounts_connected_by_user_id` and
`idx_channel_accounts_paused_by_user_id` (`WHERE … IS NOT NULL`); `idx_channel_accounts_plan_stop` `(organization_id, plan_stop_reason) WHERE plan_stop_reason IS NOT NULL` — the month wake and the plan change (rev 5). Checks: `chk_channel_accounts_channel`,
`_connection_status` (three values), `_disconnected`, `_paused_by` (`paused_by_user_id IS NULL OR paused_at IS NOT NULL`),
`_provider_account_id`, `_plan_stop` (the three reasons; `(plan_stop_reason IS NULL) = (plan_stopped_at IS NULL)`, rev 5), `_updated`. RLS: enabled and forced, the organization policy with `USING` + `WITH CHECK`, the
maintenance arm in `USING` (the 10-minute check and the plan-change sweep read across organizations); in
`EXPECTED_FORCE_RLS_TABLES` (+1).

### 1B.4 Permissions

The two codes of 1.4 ([P59](decisions.md)) — `channel-account:read` · `:manage`, held by the same roles the Instagram codes are (TN12).

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `channel-account:read` | Automations · See automations and their numbers | the accounts | 6, 7 | Owner, Admin, Editor, Viewer |
| `channel-account:manage` | Workspace · Connect and remove Instagram accounts | disconnect, pause, resume, choose active accounts; receives the reconnect notice | 8, 9, 10, 11 | Owner, Admin |

Pause and resume stay with `channel-account:manage` (P59) (plan §45.5 row 7 names connecting and removing; the plan names no
other holder — an Editor cannot stop an account's sending).

### 1B.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1), under `/social/channel-accounts` |
| Auth | `Authorization: Bearer`, the active organization from the token |
| Organization | team-only (CA6): writes 8–11 → `422`; reads 6, 7 → `404 team_organization_required` |
| Path id | `{channel_account_id}` (`cha_…`); another organization's or a revoked account → `404 channel_account_not_found` |
| Writes | route 11 needs `X-Idempotency-Key` (it swaps two accounts); 8–10 take none — a repeat lands in the same state |
| Success | `200` with `{ data, meta }`; route 8 → `204` |
| Lists | route 6: all accounts, no paging (at most 10 not revoked) |
| Errors | as 1.5, plus `404 channel_account_not_found` |

### 1B.6 Objects returned

**Channel account summary** (route 6): `id` (`cha_…`), `channel`, `display_name`, `profile_picture_url` (from the extension),
`connection_status`, `channel_connection_id`, `is_paused`, `is_suspended`, `is_in_plan`, `is_automation_enabled`,
`has_sending_stop`, `connected_at`.

**Channel account** (routes 7, 9–11): the launch's Instagram account object (launch § 1.A.6) re-cut — `id`, `channel`,
`display_name`, `connection_status`, `channel_connection` (`{ id, provider, status }`), `is_automation_enabled`, `is_paused`,
`paused_at`, `is_suspended`, `is_in_plan`, `plan_stop_reason` (**added in rev 5**, CA3), `plan_stopped_at`, `active_stop` (`{ lane, reason, stop_until }` of the stop that
holds most lanes, or null — the banners read sub-domain 6's sending status, RC-35), `new_account_limit_ends_at`
(`connected_at` + 7 days, null once the owner set `opening_hour_limit` or the 7 days passed), `connected_by_user_id`,
`connected_at`, `disconnected_at`, and `instagram` — the Instagram extension (2.A.6) with its `settings` (2.B.6) when
`channel` is `instagram`. Gone against the launch: `access_expires_at`, `scopes`.

### 1B.7 Routes (6–11)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 6 | GET | `/social/channel-accounts` | The organization's accounts — the account menu **(new, RC-7)** | `channel-account:read` | |
| 7 | GET | `/social/channel-accounts/{channel_account_id}` | One account **(moved from `/social/instagram/account`, RC-8)** | `channel-account:read` | |
| 8 | DELETE | `/social/channel-accounts/{channel_account_id}` | Disconnect one account **(moved, RC-9)** | `channel-account:manage` | |
| 9 | POST | `/social/channel-accounts/{channel_account_id}/pause` | Pause its sending **(new, RC-10)** | `channel-account:manage` | none (CA7) |
| 10 | POST | `/social/channel-accounts/{channel_account_id}/resume` | Resume it **(new, RC-11)** | `channel-account:manage` | none (CA7) |
| 11 | POST | `/social/channel-accounts/{channel_account_id}/activate` | Choose active accounts — swap one in **(new, RC-60)** | `channel-account:manage` | req |

### 1B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 6 | `channel` (comma-separated: `instagram`; default every channel) | — | Channel account summary[] |
| 7, 9, 10 | — | — (strict empty on 9, 10) | Channel account |
| 8 | — | — | 204 |
| 11 | — | optional `stop_channel_account_id` (`cha_…`, required at the plan's limit) | Channel account |

### 1B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 6 | `400` · `channel` | not a known channel, an unknown field |
| 7–11 | `400` · `channel_account_id` | not a well-formed public id |
| 7–11 | `404` · `channel_account_not_found` | not in the organization, another organization's, or `revoked` |
| 11 | `409` · `channel_account_already_active` | its `plan_stop_reason` is not `plan_downgrade` (CA3) |
| 11 | `409` · `plan_account_limit` | at the plan's limit and no `stop_channel_account_id` |
| 11 | `400` · `stop_channel_account_id` | not well formed, the same account, not active, or not in the organization |
| 8–11 | `422` | a personal organization; route 11's idempotency key missing, malformed or reused |
| 6, 7 | `404` · `team_organization_required` | a personal organization |
| 6–11 | `403` · `missing_permission` | the gate |

### 1B.10 Rules worth knowing

- **What the other sub-domains take from here**: the account's status, connection, pause / suspend / plan stop and the
  automation switch for every event (5) and every lane turn (6); the guarded `markAccountBroken` (1, 5, 6); the accounts
  port for billing (`listActiveChannelAccounts`, `countConnectedChannelAccounts`, route 108); the account id every product
  table points at; **the capability list and the one feature check** (CA11) for 2, 4, 6 and 7.
- **A disconnect never starts a plan-stopped account by itself** (D57) — only route 11 does.
- **No Meta call inside a database context**: route 8 reads, closes, calls (sub-domain 2's Instagram step), then writes; a
  Meta failure before it is logged and the disconnect goes on.
- **Frontend (later, P30)**: the account menu reads route 6 and switches the whole app; every list in sub-domains 3, 4 and
  7 takes the chosen `channel_account_id`.

### 1B.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| CAC1 | CA1, CA2: `channel-account/` folder; `channel-account.schema.ts` (columns, indexes, checks, policy as 1B.3) in the account migration changed in place; `PUBLIC_ID_PREFIXES.channelAccount`, `PARAM_NAME_TO_ENTITY.channel_account_id` (the `instagram_account_id` entry removed); every route file under the new paths; the singular routes removed from the route catalog, `route-organization-scope.json`, `route-success-statuses.json`, OpenAPI examples and the frontend route map; `EXPECTED_FORCE_RLS_TABLES` +1; OpenAPI tag `Channel account`; `channel-account.overview.md`; `src/domains/CLAUDE.md`'s app row (was IAC1) |
| CAC2 | CA3, CA4: `connection_status` values without `expired` (constants, the check, the serializer); `markAccountBroken` (guarded `connected → error`); the pause, suspend and plan-stop columns (`plan_stop_reason` + `plan_stopped_at` and the order of its reasons — rev 5, P99) and the automation switch read by intake (5) and the lane turn (6) — the lane columns they replace removed with sub-domain 6; the reconnect-notice recipients (`channel-account:manage`) and copy keys ("@account is no longer shared", "Switch @account back to Creator or Business") (was IAC2) |
| CAC3 | CA6, CA10: the audit actions; reasons `channel_account_not_found`, `channel_account_already_active` (`errors:` keys, `response-codes.md`); `instagram_not_connected` kept for automation create only (was IAC4) |
| CAC4 | CA7–CA9: routes 6–11 with schemas (`idempotencyRequired` on 11), controller, service, DTOs (strict), serializers (summary and full, the Instagram part through sub-domain 2's serializer); repository — accounts of a connection, active count under the lock, the guarded break, revoke; the lane calls through sub-domain 6's service (built with 6, CA5); integration tests — every success and error of 1B.9, a pause that leaves error stops, a disconnect that keeps the token while another account uses the connection and deletes it with the last, a swap at the limit, two swaps racing (the lock), the `channel` filter, the `test:rls-role` lane (was IAC6, IAC7) |
| CAC5 | CAQ1: the pick writes `provider_account_id` and the extension's `instagram_user_id` in one commit; a DB test that the two stay equal and that a second live row of one account in another organization is refused |
| CAC6 | CA11, CAQ2: `channel-account-capabilities.constants.ts` (`CHANNEL_CAPABILITIES`, `CHANNEL_FEATURES`, checked by `validate:constants`); `canChannelAccountUseFeature` and `listChannelAccountFeatureProblems` in the channel-account service, exposed to 2, 4, 6 and 7 through `app.container.ts`; reasons `channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature` (renamed from `plan_feature_required`), `feature_not_offered` with their `errors:` keys and `response-codes.md` rows; unit tests — each reason alone, the order when several fail, a channel without the entry, a connection without the scope, Free vs Creator on each PRO switch (P83), segments refused on Free (P76), an untested feature |

**As built at ROUTE row R5** ([P116–P119](decisions.md)): `app.channel_accounts` as 1B.3, plus the unique
`idx_channel_accounts_organization_provider_account` `(organization_id, channel, provider_account_id)` (the pick's upsert
target, AC-2.5) and `chk_channel_accounts_display_name`; `app.instagram_accounts` gains `channel_account_id` and loses
`channel_connection_id`, and keeps a mirrored copy of the moved columns until R6 (2.A IAC6). The feature check is
`canChannelAccountUseFeature({ scope, organizationId, channelAccountId, feature })`; `CHANNEL_FEATURES` = billing's
`PLAN_FEATURE_KEYS`, `APP_UNTESTED_META_FEATURES` = `mark_seen` (in the capabilities file until R18). The lane steps of
routes 8–11 and the plan stop an activated account takes are behind `ChannelAccountLanePort` (R18) and
`ChannelAccountPlanStopPort` (R18, R24). Audit metadata carries `old_value` / `new_value` (AC-2.11).

### 1B.12 Nested sub-domains

None — one table, no persistence parts.

---

## 2. Instagram account — rev 4 (2026-11-24) — nested sub-domains 2.A–2.C; final (rev 4, confirmed 2026-11-24)

**Status: final (rev 4, confirmed 2026-11-24)** (P31). Confirmed with your answers ([P54–P90](decisions.md), M12).

**Ids restart for this iteration**: decisions `IA1`…, code changes `IAC1`…, questions `IAQ1`… are this iteration's; the
frozen launch's ids are cited as "launch IA5" (its § 1). Rev 2 moved IA1–IA5, IA9–IA11 and their code changes to 1B
(CA…), and IA16, IA18–IA20 and their code changes to 1 (MC13–MC16); the ids left here keep their numbers (M9).

Code: the **`instagram-account` sub-domain folder** — `app/sub-domains/instagram-account/` (the Instagram extension at the
folder root; its token left for sub-domain 1, its common part for 1B) with `instagram-account-settings/` and
`instagram-media/`, as built; `instagram-account-meta-callback/` goes (its routes moved to sub-domain 1).

2.1 Decisions (whole sub-domain) · 2.2 Open questions · 2.3 Tables and relations · 2.4 Permissions · 2.5 Common to every route ·
2.6 Objects returned · 2.7 Routes · 2.8 Request details · 2.9 Errors · 2.10 Rules worth knowing · 2.11 Code changes (whole sub-domain) ·
2.12 Nested sub-domains · then **2.A Instagram account · 2.B Instagram account settings · 2.C Instagram media** — each with
the same eleven sections.

The Instagram extension of a channel account (P42): one `app.instagram_accounts` row per channel account whose channel is
`instagram` — its Instagram user id, username, account type, private flag, followers, picture and starter-question time —
plus each account's sending limits and behaviour (settings v8, D64–D67), the stored posts and the post and story pickers.
It owns the Instagram background work around an account (set-up, the webhook subscription check, the starter-question
sync, the reconnect notice). Every Instagram route takes the account's one id, `{channel_account_id}` (P47). Design read:
plan §15.4, §15.8, §18.1–18.3 (plan:L2593–L2684, L2895–L2958); `db-changes.md` › instagram_account,
instagram_account_setting, instagram_media; `route-changes.md` RC-12–RC-14; `worker-changes.md` WC-25, WC-30, WC-31,
WC-34 (profile part), WC-46. Builds on 1 (the connection, the Meta client, the token path) and 1B (the account). Route
numbers run 12–14.

### 2.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). A decision that
belongs to one table is in its nested sub-domain.

**rev 2 changes** (P42, P46, P47): the sub-domain is now the **Instagram extension** — the common account and routes 6–11
moved to 1B, the ad picker (route 15) and Meta's callbacks (routes 16–17, nested 2.D) moved to 1; routes 12–14 under
`/social/instagram/accounts/{channel_account_id}/…`; `app.instagram_accounts` 1:1 with `app.channel_accounts` (2.A); the
automation switch moved from the settings to the channel account (IA12); every job payload carries
`channelAccountPublicId`; IAQ1 and IAQ2 moved to 1 (MCQ3, MCQ4).

**rev 3 changes** (P50, M10): route 12's PRO and Meta-test refusals go through 1B's one feature check (CA11) — `403 plan_lacks_feature` (was `plan_feature_required`) and `422 feature_not_offered` (was `instagram_feature_not_offered`; one name since M10); a feature the connection lacks the permission for answers `409 permission_not_granted`. Everything else of the extension stays Instagram's (P48). Routes 12–14 unchanged.

| # | Decision |
| --- | --- |
| IA6 | **Background work owned here, all pull-based on `instagram-tasks` (D3, P45), one job per organization and account (`organizationPublicId`, `channelAccountPublicId` in the payload), safe to repeat.** (1) **Account set-up** (WC-30): after a connect or reconnect commit — `POST /{instagram_user_id}/subscribed_apps` with the six fields (`comments`, `live_comments`, `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions`, plan:L4627–L4646) → `webhook_subscribed_at`; the account's starter questions (WC-31); one read-only "Allow access to messages" probe (plan:L4725–L4730); retried after 1, 5, 15, 60 minutes, then a banner and one owner email. (2) **Webhook subscription check** (WC-25): every 10 minutes per connected Instagram account, spread; a field off → the set-up again and the missed-comment look (WC-26, sub-domain 5). (3) **Starter-question sync** (WC-31): after a go-live, pause, delete or question change of a starter-question automation (sub-domain 4 enqueues it after commit) — rewrite the account's whole ice-breaker list (`messenger_profile`) from its live starter-question automations, set `starter_questions_set_at`. (4) **Profile refresh** inside the connection's token check (P17, sub-domain 1) — it also writes 1B's `display_name`. (5) **Reconnect notice** (WC-46, kept; called by 1 and 1B). Every Meta call through sub-domain 1's adapter (MC2). The launch's daily check (renewal, WC-35) goes. |
| IA7 | **Audit (launch K9).** `app.instagram_account_settings.update` (INFO, the changed field names). The account's own actions are 1B's (CA10); the callbacks' are 1's (MC12). After commit. |

### 2.2 Open questions

None — rev 1's IAQ1 and IAQ2 moved to sub-domain 1 (MCQ3, MCQ4).

### 2.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_accounts` | the Instagram part of one channel account (P42) | exactly one per Instagram channel account (1:1); no public id of its own — reached through `channel_account_id`; written only through this sub-domain's service (the pick, the profile refresh, set-up, erasure) |
| `app.instagram_account_settings` | its limits, stop words and behaviour | one per account; made at the first pick with every owner value empty, kept on a reconnect |
| `app.instagram_media` | a post an automation ran on, and its missed-comment watch | one per organization and Instagram media id; written through the media service |
| ~~`app.instagram_account_tokens`~~ | removed (sub-domain 1, D24) | |

```text
tenancy.organizations
   │
   └──< app.channel_accounts (1B) ──── app.instagram_accounts (1:1)
                                   ├──< app.instagram_account_settings (1:1) ──> auth.users (updated by)
                                   └──< app.instagram_media                      stored posts, comment watch
```

Pointing at these from other sub-domains: nothing points at `app.instagram_accounts` — every product and sending table
points at `app.channel_accounts` (1B, P47) and reaches the extension through `channel_account_id`. These three point at
1B: composite `(organization_id, channel_account_id)` → `app.channel_accounts (organization_id, id)`, `ON DELETE RESTRICT`.
Branch rule: none. Membership pointers: none; `updated_by_user_id` → users `ON DELETE SET NULL` (K6).

**PostgreSQL design**

The launch's standard columns (launch § 1.3). Changed in place in `20261121064529_app_instagram_account.sql` and
`20261121094404_app_instagram_media.sql` (D1, P29). Each table's design is in its nested sub-domain. RLS unchanged in kind:
enabled and forced, the organization policy with `USING` + `WITH CHECK`, the maintenance arm in `USING` on the extension,
settings and media (the 10-minute subscription check and the missed-comment watch read across organizations).

### 2.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `instagram-account:read` | Automations · See automations and their numbers | posts, stories | 13, 14 | Owner, Admin, Editor, Viewer |
| `instagram-account:manage` | Workspace · Connect and remove Instagram accounts | change settings | 12 | Owner, Admin |

### 2.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1), under `/social/instagram/accounts/{channel_account_id}` |
| Auth | `Authorization: Bearer`, the active organization from the token |
| Organization | team-only (CA6): write 12 → `422`; reads 13, 14 → `404 team_organization_required` |
| Path id | `{channel_account_id}` (`cha_…`, P47); another organization's, a revoked one, or one whose channel is not `instagram` → `404 channel_account_not_found` |
| Writes | route 12 takes no key — a repeat lands in the same state; an optional `expected_updated_at` (`409 record_changed`) |
| Success | `200` with `{ data, meta }` |
| Lists | routes 13–14: Meta's cursor, `limit` 1–50 (default 25), `after`, no `estimated_total` |
| Errors | as 1.5, plus `404 channel_account_not_found`, `404 instagram_reconnect_required` |

### 2.6 Objects returned

| Object | Where |
| --- | --- |
| Instagram account (the extension, inside the Channel account of 1B.6) | 2.A.6 |
| Instagram account settings | 2.B.6 |
| Instagram media item · Instagram story | 2.C.6 |

### 2.7 Routes (12–14)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 12 | PATCH | `/social/instagram/accounts/{channel_account_id}/settings` | Limits, stop words, behaviour **(moved + changed, RC-12)** | `instagram-account:manage` | |
| 13 | GET | `/social/instagram/accounts/{channel_account_id}/media` | Posts and reels, live **(moved, RC-13)** | `instagram-account:read` | |
| 14 | GET | `/social/instagram/accounts/{channel_account_id}/stories` | Live stories **(moved, RC-14)** | `instagram-account:read` | |

The account's sending status (route 63, `…/{channel_account_id}/sending-status`) shares the path and is sub-domain 6's.

### 2.8 Request details

In each nested sub-domain (2.B and 2.C, section .8; 2.A has no routes).

### 2.9 Errors

Every route can answer the errors in 2.5; each route's own errors are in its nested sub-domain (2.B and 2.C, section .9).

### 2.10 Rules worth knowing

- **What the other sub-domains take from here**: the Instagram user id and settings for every event (5) and every send (6);
  `InstagramMediaService.upsertFromInstagram` and the comment-watch fields (4, 5); the starter-question sync (4); the account
  set-up (1); the profile refresh and the Instagram erasure step (1's callbacks); the disconnect's Instagram step (1B).
- **No Meta call inside a database context**: routes 13–14 and every job read, close, call, then write.

### 2.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| IAC3 | IA6: `instagram-account/queues/` + `workers/` for `instagram-account-setup`, `instagram-webhook-subscription-check`, `instagram-starter-question-sync`, `instagram-reconnect-notice` on `instagram-tasks` (payloads with `channelAccountPublicId`; registry, `WORKER_QUEUE_NAMES`, scheduler for the 10-minute check, DLQ); the launch's `instagram-account-daily-check` removed (sub-domain 1 takes the profile refresh); tests: retries 1/5/15/60, a field off re-runs set-up, a sync writes the whole list, twice = once |
| IAC5 | `instagram-account-erasure.service.ts` (team delete, launch D54) loops every Instagram account of the organization and erases each connection's token through sub-domain 1; `instagram-account.overview.md` and the two nested overviews (the `instagram-account-meta-callback` one removed); `src/FLOWS.md` (connect with Meta, pick, reconnect, choose active accounts — across 1, 1B and 2) |

**As built at ROUTE row R40** ([P409](decisions.md)): IAC3's three jobs are task handlers on `instagram-tasks` — `instagram-account-setup` (six fields, starter questions, the message-access probe; tries after 1, 5, 15, 60 minutes then hourly, one owner email after the 60-minute try, `instagram.reconnect_required` type), `instagram-webhook-subscription-check` (a 10-minute sweep on the daily-check queue adds one per connected account, spread by id; a field off on a stamped account → set-up again, team alert log, the missed-comment port R39 fills) and `instagram-starter-question-sync` (whole list; `starter_questions_set_at` set or emptied). The launch daily check stays until R51 (the profile refresh), carrying the sweep; the reconnect notice keeps its own queue. Banners are `is_webhook_subscribed` false and an empty `starter_questions_set_at`; the probe's "off" is logged only. Route 8 removes the starter questions before its unsubscribe.

**As built at ROUTE row R6** ([P121](decisions.md)): the team delete unsubscribes every live account, revokes every account (channel account + extension) and erases each profile and stored posts, then `ChannelConnectionTokenService.revokeOrganizationConnections` revokes every connection still live with its token. The `instagram-account-meta-callback` folder and overview stay until R9 moves the callbacks to sub-domain 1.

### 2.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/instagram-account/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 2.A Instagram account | folder root | `app.instagram_accounts` | — (background work, IA6) | final (rev 4, confirmed 2026-11-24) |
| 2.B Instagram account settings | `instagram-account-settings/` | `app.instagram_account_settings` | 12 | final (rev 4, confirmed 2026-11-24) |
| 2.C Instagram media | `instagram-media/` | `app.instagram_media` | 13–14 | final (rev 4, confirmed 2026-11-24) |

Rev 1's 2.D Meta callbacks (`instagram-account-meta-callback/`, routes 16–17) moved to sub-domain 1 (MC14–MC16).

---

### 2.A Instagram account — `instagram-account/` (folder root) — final (rev 4, confirmed 2026-11-24)

#### 2.A.1 Decisions

| # | Decision |
| --- | --- |
| IA8 | **Fields — the 1:1 extension (P42).** Today (`instagram-account.schema.ts`): `public_id`, `instagram_user_id`, `instagram_app_user_id`, the profile, `scopes`, `connection_status` (4 values), `token_expires_at`, `webhook_subscribed_at`, `connected_by_user_id`, `connected_at`, `disconnected_at`, `profile_synced_at`, `profile_erased_at`. After (plan:L2922–L2944, P42): **added** `channel_account_id` (required, unique, composite → `app.channel_accounts` `RESTRICT`) and `starter_questions_set_at` (emptied when a starter-question automation goes live, pauses or changes its questions — WC-31 sets it); **moved to 1B** `public_id`, `connection_status`, `connected_by_user_id`, `connected_at`, `disconnected_at` and the display name (`name` → `display_name`); **removed** `instagram_app_user_id` (+ check, index — Unified Login has none), `scopes` (+ check — on the connection), `token_expires_at` (the token is the connection's and never ends). **Kept** (the Instagram part): `instagram_user_id` — now from `assigned_instagram_accounts`, the id the webhooks send, used for API paths, webhook routing and the resolvers, equal to 1B's `provider_account_id` (CAQ1) — `username`, `account_type`, `is_private`, `followers_count`, `profile_picture_url`, `webhook_subscribed_at`, `profile_synced_at`, `profile_erased_at`. |

#### 2.A.2 Open questions

None (CAQ1, 1B.2 — answered P60: the one-live-row rule is on `app.channel_accounts`).

#### 2.A.3 Tables and relations

`app.instagram_accounts` — changes only (launch § 1.A.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_account_id` | `bigint` | no | | **added**; composite `(organization_id, channel_account_id)` → `app.channel_accounts (organization_id, id)` `ON DELETE RESTRICT`; unique (1:1) |
| `starter_questions_set_at` | `timestamptz` | yes | | **added**; the last send of its starter questions to Meta (D42) |
| ~~`public_id`~~ · ~~`connection_status`~~ · ~~`connected_by_user_id`~~ · ~~`connected_at`~~ · ~~`disconnected_at`~~ · ~~`name`~~ | | | | **moved** to `app.channel_accounts` (1B.3) |
| ~~`instagram_app_user_id`~~ · ~~`scopes`~~ · ~~`token_expires_at`~~ | | | | **removed** (IA8) |

Indexes: **dropped** `idx_instagram_accounts_public_id`, `idx_instagram_accounts_organization_live` (one per organization),
`idx_instagram_accounts_instagram_app_user_id`, `idx_instagram_accounts_instagram_user_live` (now 1B's
`idx_channel_accounts_provider_account_live`) and the `connected_by_user_id` index; **added** unique
`idx_instagram_accounts_channel_account` `(organization_id, channel_account_id)` — the 1:1 and the composite key's index;
kept: `(organization_id, id)`, `(organization_id, instagram_user_id)`. Checks: `chk_instagram_accounts_connection_status`,
`chk_instagram_accounts_disconnected`, `chk_instagram_accounts_instagram_app_user_id` and `chk_instagram_accounts_scopes`
dropped; the profile checks kept. RLS: as 2.3. The resolver `app.resolve_organization_public_id_for_instagram_user(text)`
(webhook routing — sub-domain 5) stays, joining the channel account for "not revoked"; the app-user resolver is replaced
in sub-domain 1 (MC15).

#### 2.A.4 Permissions

None — no routes; the extension is read inside 1B's routes 7, 9–11 (their gates).

#### 2.A.5 Common to every route

No routes.

#### 2.A.6 Objects returned

**Instagram account** (the `instagram` part of 1B's Channel account): `instagram_user_id`, `username`, `account_type`,
`is_private`, `followers_count`, `profile_picture_url`, `starter_questions_set_at`, `is_webhook_subscribed`,
`profile_synced_at`, `settings` (2.B.6).

#### 2.A.7 Routes

None — the account's routes are 1B's (6–11).

#### 2.A.8 Request details

None.

#### 2.A.9 Errors

None of its own.

#### 2.A.10 Rules worth knowing

- Written only through `InstagramAccountExtensionService` — by 1's pick (create or bring back), the profile refresh, the
  set-up job and the erasure; never by 1B's repository.

#### 2.A.11 Code changes

| # | Change |
| --- | --- |
| IAC6 | IA8: `instagram-account.schema.ts` and its migration changed in place (columns, indexes, checks as 2.A.3; the moved columns dropped with 1B's table in the same migration — no data, P29); repository and service for the extension (create at the pick, refresh, erase); the serializer of the `instagram` part used by 1B |

**As built at ROUTE row R6** ([P120](decisions.md), [P121](decisions.md)): columns, indexes and checks as 2.A.3, with
`account_type` nullable (`business` · `creator`) and `is_private` `NOT NULL DEFAULT false` — Meta's profile read does not
carry them yet, so the pick writes `null` / `false`; `name` and `connection_status_changed_at` dropped too;
`chk_instagram_accounts_username_unless_revoked` → `_username_unless_erased`, `_profile_erased` dropped (the erase is
guarded on the revoked channel account). `InstagramAccountExtensionService` (`instagram-account-extension.service.ts`)
is the one writer; `serializeInstagramAccountExtension` (`instagram-account.serializer.ts`) builds 2.A.6 for 1B. The
status writes moved onto `ChannelAccountRepository`; the reconnect notice's key is the channel account's `updated_at` at
the break. The `iga_` prefix is gone — the account's one id is `cha_…` everywhere. Settings and media keep
`instagram_account_id` until R7 / R8.

---

### 2.B Instagram account settings — `instagram-account/instagram-account-settings/` — final (rev 4, confirmed 2026-11-24)

#### 2.B.1 Decisions

| # | Decision |
| --- | --- |
| IA12 | **The settings v8 (D22, D64–D68, plan:L2895–L2920).** Today: `is_automation_enabled` plus five public-reply-safety columns (`is_public_reply_safety_enabled`, `public_reply_chance_percent` 0–100, `public_reply_hour_limit` 1–1000, gap min / max 5–3600). After: the five reply columns **go** (per automation now — D14, D32; sub-domain 4); `is_automation_enabled` **moves to the channel account** (P42, 1B.3) — route 12 still accepts it and writes it through 1B's service in the same commit (no channel-account `PATCH` this iteration); **added** — every number nullable, empty = the settings file's value (D22, P4): `opening_hour_limit` (database 1–750, API 1–700), `opening_day_limit` (API from the hour limit to 24 × it; read only while `DAY_LIMIT_ENABLED` is on — accepted and stored when it is off, the answer says `is_day_limit_enabled: false`), `fast_hour_limit` (1–20,000), `person_hour_limit` (5–100), `broadcast_hour_limit` (1–2,000), `is_automatic_notice_enabled` (off), `extra_stop_words` (0–50, each 1–50 characters, trimmed, lowercased, no repeats — added to `STOP_WORDS`, D49), `is_comment_reply_trigger_enabled` (on, D64), `is_once_per_person_per_post_enabled` (on, D65), `is_mark_seen_after_reply_enabled` (off, D66), `extra_delay_seconds_min` / `_max` (1–20, both or neither, min ≤ max on the merged result, D67). Names take the `is_` form (P21; the plan's `trigger_on_comment_replies` …). The settings row's key is `channel_account_id` (P47). |
| IA13 | **What a save refuses.** A bound outside the API range → `400` naming the field; min above max on the merged result → `400 extra_delay_seconds_max`. **PRO** (D35, D67): setting the extra delay on a plan whose `extra_delay` switch is off (P83) → `403 plan_lacks_feature` (1B's feature check over sub-domain 8's plan read, CA11; clearing it is always allowed). **Meta-test-gated** (P36): turning `is_mark_seen_after_reply_enabled` on while the untested-feature list holds `mark_seen` → `422 feature_not_offered` (a deploy changes the list, not the request). A read-only plan does not refuse a save (P10). Optional `expected_updated_at` → `409 record_changed` (launch IA15 kept). Works on an `error` account; `revoked` → `404`. |
| IA14 | **What a save sets off (plan:L2610–L2611, L2673–L2684).** A limit change: after commit, the slow and reply lanes get a new turn (a working lane keeps going and moves the turn at its save — sub-domain 6); the behaviour switches and stop words count for new events only — messages already waiting keep their time. The worker reads every number again and uses the settings-file value for a bad one (plan:L1991). Event processing (sub-domain 5) reads the settings through this service on every event; no cache (launch IA15). The answer shows each limit's owner value and its effective value. |

#### 2.B.2 Open questions

None.

#### 2.B.3 Tables and relations

`app.instagram_account_settings` — changes only (launch § 1.B.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_account_id` | `bigint` | no | | **renamed** from `instagram_account_id`; composite → `app.channel_accounts` `RESTRICT`; one per account |
| `opening_hour_limit` | `smallint` | yes | | 1–750 (`chk_…_opening_hour_limit`); API ≤ 700 |
| `opening_day_limit` | `integer` | yes | | `> 0` |
| `fast_hour_limit` | `integer` | yes | | `> 0`; API ≤ 20,000 |
| `person_hour_limit` | `smallint` | yes | | `> 0`; API 5–100 |
| `broadcast_hour_limit` | `smallint` | yes | | 1–2,000 |
| `is_automatic_notice_enabled` | `boolean` | no | `false` | |
| `extra_stop_words` | `text[]` | no | `'{}'` | `cardinality <= 50`, no null element (service: lowercase, 1–50, no repeats) |
| `is_comment_reply_trigger_enabled` | `boolean` | no | `true` | D64 |
| `is_once_per_person_per_post_enabled` | `boolean` | no | `true` | D65 |
| `is_mark_seen_after_reply_enabled` | `boolean` | no | `false` | D66 |
| `extra_delay_seconds_min` | `smallint` | yes | | 1–20 |
| `extra_delay_seconds_max` | `smallint` | yes | | 1–20; `(min IS NULL) = (max IS NULL)` and `min <= max` |
| ~~`is_automation_enabled`~~ | | | | **moved** to `app.channel_accounts` (P42) |
| ~~`is_public_reply_safety_enabled`~~ · ~~`public_reply_chance_percent`~~ · ~~`public_reply_hour_limit`~~ · ~~`public_reply_gap_min_seconds`~~ · ~~`public_reply_gap_max_seconds`~~ | | | | **removed** with their five checks (D32) |

Checks added: `chk_instagram_account_settings_opening_hour_limit`, `_opening_day_limit`, `_fast_hour_limit`,
`_person_hour_limit`, `_broadcast_hour_limit`, `_extra_stop_words`, `_extra_delay` (both or neither, range, order).
Indexes: the account key re-led on `channel_account_id`. RLS unchanged. Branch: none.

#### 2.B.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:manage` | 12 |

#### 2.B.5 Common to every route

As 2.5.

#### 2.B.6 Objects returned

**Instagram account settings**: `is_automation_enabled` (the channel account's, P42), `opening_hour_limit`,
`opening_day_limit`, `fast_hour_limit`, `person_hour_limit`, `broadcast_hour_limit` (each the owner value or null),
`effective_limits` (`{ opening_hour_limit, opening_day_limit, fast_hour_limit, person_hour_limit, broadcast_hour_limit }` —
what the lanes use now, the new-account limit included), `is_day_limit_enabled` (the settings file),
`is_automatic_notice_enabled`, `extra_stop_words`, `is_comment_reply_trigger_enabled`,
`is_once_per_person_per_post_enabled`, `is_mark_seen_after_reply_enabled`, `extra_delay_seconds_min`,
`extra_delay_seconds_max`, `updated_by_user_id`, `updated_at`. The five reply fields leave.

#### 2.B.7 Routes (12)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 12 | PATCH | `/social/instagram/accounts/{channel_account_id}/settings` | Limits, stop words, behaviour **(moved + changed, RC-12)** | `instagram-account:manage` | |

#### 2.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 12 | — | at least one of the 14 fields of 2.B.6 after `is_automation_enabled`, or `is_automation_enabled` itself (numbers nullable — `null` = the settings file); optional `expected_updated_at` | Instagram account settings |

#### 2.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 12 | `400` · the field's name | out of the API range, not a whole number, a stop word empty, too long or repeated, more than 50, an empty body, an unknown field (the five removed fields included), max below min |
| 12 | `403` · `plan_lacks_feature` | the extra delay set on a plan without PRO |
| 12 | `422` · `feature_not_offered` | mark as seen turned on while untested (P36) — 1B's feature check (CA11); the same reason is a go-live problem item for an automation (4.A, AU13) |
| 12 | `409` · `permission_not_granted` | a setting whose feature needs a permission the connection was not granted (CA11) — reconnect (route 40) |
| 12 | `409` · `record_changed` | `expected_updated_at` older than the saved settings |
| 12 | `404` · `channel_account_not_found` | as 2.5 |
| 12 | `422` | a personal organization |

#### 2.B.10 Rules worth knowing

- The settings row is made by sub-domain 1's pick through this sub-domain's service, never by the account repository.

#### 2.B.11 Code changes

| # | Change |
| --- | --- |
| IAC8 | IA12–IA14: schema and migration changed in place (2.B.3, the key renamed, `is_automation_enabled` moved); DTO (the 14 optional fields + `is_automation_enabled`, nullable numbers, strict, at least one), validator (merged min ≤ max; PRO and the untested list through 1B's feature check, CA11), serializer with `effective_limits` (the settings file's defaults, sub-domain 6's new-account rule), service (the switch through 1B's service in the same commit, lane wake after commit), the audit's changed fields; reasons `plan_lacks_feature`, `feature_not_offered` (`errors:` keys, `response-codes.md`); integration tests for every error of 2.B.9, the null-clears-to-default case and the switch landing on the channel account |


**As built at ROUTE row R7** ([P122](decisions.md)): route 12 at `PATCH /api/v1/app/social/instagram/accounts/{channel_account_id}/settings`; the table changed in place as 2.B.3; the five public-reply columns dropped and the launch engine's account-level reply safety off until R13's per-automation pacing; the channel account reached through `InstagramAccountSettingsChannelAccountPort` (implemented by `ChannelAccountService`: `requireLiveInstagramAccount`, `setAutomationEnabled`, the one feature check) and the lane wake through `InstagramAccountSettingsLanePort` (R18); the settings-file values in `instagram-account-settings.constants.ts` until R18; the feature check only for what a save turns on; the audit entry (IA7) carries the changed fields with their old and new values (AC-3.11); the day limit judged against the owner hour limit, else 600; event processing reads the switch from the channel account.

---

### 2.C Instagram media — `instagram-account/instagram-media/` — final (rev 4, confirmed 2026-11-24)

#### 2.C.1 Decisions

| # | Decision |
| --- | --- |
| IA15 | **Pickers on Unified Login (routes 13–14).** Today (launch IA16): the one account's posts and stories read live through `graph.instagram.com` with its own token; `404 instagram_reconnect_required` when not `connected`; `503 instagram_unavailable` with `Retry-After`. After: the same live read for the named account, through sub-domain 1's Meta client with the connection's token (`/{instagram_user_id}/media`, `/stories` on `graph.facebook.com`); `instagram_reconnect_required` when the channel account **or its connection** is `error`, and a 190 calls sub-domain 1's `markConnectionBroken`; each media item gains `kind` (`post` · `reel` · `ad_post`, from `media_product_type`), and a missing `media_url` falls back to `thumbnail_url`, then `permalink` (plan:L811, L2946–L2958). Stories: unchanged in shape; a story way to start is refused at go-live while untested (P36, sub-domain 4) — the picker itself is open. The ad picker is the connection's now (routes 41, 15 — MC13). |
| IA17 | **Stored posts gain the missed-comment watch (D40, plan:L2946–L2958).** `app.instagram_media` adds `comments_checked_at`, `comments_next_check_at` (empty = not watched), `last_comment_at`, `live_ended_at`; `media_product_type` adds Meta's Live value (a §43 test names it; Live comments are gated, P36); its account key is `channel_account_id` (P47). Written only through `InstagramMediaService` — the missed-comment look (WC-26, sub-domain 5), the Live check (WC-16, sub-domain 6), "next post" linking (WC-43, sub-domain 4); routes 13–14 never write it (launch IA17 kept). |

#### 2.C.2 Open questions

None.

#### 2.C.3 Tables and relations

`app.instagram_media` — changes only (launch § 1.C.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_account_id` | `bigint` | no | | **renamed** from `instagram_account_id`; composite → `app.channel_accounts` `RESTRICT` |
| `comments_checked_at` | `timestamptz` | yes | | when the watch last read its comments |
| `comments_next_check_at` | `timestamptz` | yes | | empty = not watched |
| `last_comment_at` | `timestamptz` | yes | | the newest comment known |
| `live_ended_at` | `timestamptz` | yes | | a Live's end (D40) |
| `media_product_type` | `varchar(20)` | yes | | **changed**: `feed` · `reels` · `story` · `ad` · the Live value |

Index added: `idx_instagram_media_comments_next_check` `(comments_next_check_at) WHERE comments_next_check_at IS NOT NULL` —
the watch reads it across organizations (maintenance arm). Check changed: `chk_instagram_media_media_product_type`. RLS as
2.3.

#### 2.C.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:read` | 13, 14 |

#### 2.C.5 Common to every route

As 2.5.

#### 2.C.6 Objects returned

**Instagram media item** (route 13): the launch's (launch § 1.C.6) **plus** `kind` (`post` · `reel` · `ad_post`);
`media_url` never empty when Meta gives a thumbnail or link.

**Instagram story** (route 14): unchanged.

#### 2.C.7 Routes (13–14)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 13 | GET | `/social/instagram/accounts/{channel_account_id}/media` | Posts and reels **(moved, RC-13)** | `instagram-account:read` | |
| 14 | GET | `/social/instagram/accounts/{channel_account_id}/stories` | Live stories **(moved, RC-14)** | `instagram-account:read` | |

#### 2.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 13, 14 | `limit` (1–50, default 25), `after` (Meta's cursor, 1–1000) | — | Instagram media item[] / Instagram story[] |

#### 2.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 13, 14 | `400` · `limit` / `after` | out of range, empty, too long, an unknown field |
| 13, 14 | `404` · `channel_account_not_found` | as 2.5 |
| 13, 14 | `404` · `instagram_reconnect_required` | the account or its connection is `error`, or Meta just refused the token |
| 13, 14 | `404` · `team_organization_required` | a personal organization |
| 13, 14 | `503` · `instagram_unavailable` | Meta down or throttling (`Retry-After`) |

#### 2.C.10 Rules worth knowing

- Routes 13–14 read Meta only; the stored posts are written by sub-domains 4–6 through the media service.

#### 2.C.11 Code changes

| # | Change |
| --- | --- |
| IAC9 | IA15: routes 13–14 under the new paths, `kind` and the picture fallback in the serializer; nock tests — paging passed through, both 404s, the break on 190 (the ad picker's part moved to MCC8) |
| IAC10 | IA17: the four columns, the Live value, the renamed key and the watch index in the media migration changed in place; `InstagramMediaService` methods for the watch and the Live end (used by sub-domains 5, 6) |

**As built at ROUTE row R8** ([P210](decisions.md)): routes 13–14 as written; the Live value is `live` (pending the §43 test); `kind` — `reels` → `reel`, `ad` → `ad_post`, anything else `post`; only Meta's code 190 breaks the connection (a refused permission answers `404 instagram_reconnect_required` without a break), through `InstagramMediaConnectionBreakPort` — R4's `ChannelConnectionService.markConnectionBroken` once the lanes merge, until then the channel account's `markAccountsOfConnectionBroken`; the watch's methods are `updateCommentWatch` and `recordLiveEnded`, the cross-organization due read is WC-26's (R39); the media key is `ON DELETE RESTRICT` to `app.channel_accounts`.

---

## 3. Contacts — rev 5 (2026-11-24) — nested sub-domains 3.A–3.B; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (P31). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`contact` sub-domain folder** — `app/sub-domains/contact/` (the launch's `contact/`, kept and shared by every channel — P48; the contact at the folder root) with a
new nested `contact-tag-event/` (a table, its service and two workers; no routes — the launch's `automation-run/` shape).

3.1 Decisions (whole sub-domain) · 3.2 Open questions · 3.3 Tables and relations · 3.4 Permissions · 3.5 Common to every route ·
3.6 Objects returned · 3.7 Routes · 3.8 Request details · 3.9 Errors · 3.10 Rules worth knowing · 3.11 Code changes (whole sub-domain) ·
3.12 Nested sub-domains · then **3.A Contacts · 3.B Contact tag events** — each with the same eleven sections.

The people who wrote to or commented on one of the organization's accounts — of any channel (P48; Instagram the only one now). The launch lists them and erases one (launch
§ 2); now the team also opens one, writes a private note, tags them (one or many), pauses automations for one person
(D71), sees "What happened" (P13), and retries her failed messages (D72); a stop word she writes opts her out (D49), and
every tag change is an event that can start a tag automation (D45). Design read: plan §14.4, §14.7, §15.4, §18.4, §19.16
(plan:L2416–L2508, L2593–L2633, L2960–L2993, L3685–L3717); `db-changes.md` › contact, contact_tag_event;
`route-changes.md` RC-20–RC-25, RC-36, RC-39, RC-40; `worker-changes.md` WC-4, WC-27, WC-36, WC-42, WC-54. Builds on 1B (the account) and 2 (its stop words); 4 and 6 register steps it runs (pause, erase) and give it runs and messages for "What happened" and the
retry. Route numbers run 18–26.

### 3.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). The launch's
review is the "before" ([launch routes-final § 2](../../launch-2026-11-20-ujai/plans/routes-final.md)).

**rev 2 changes** (P44, P47, M9): renamed Contacts → **Instagram contacts** — folder `instagram-contact/` (+ `instagram-contact-tag-event/`), tables `app.instagram_contacts`, `app.instagram_contact_tag_events`; routes under `/social/instagram/contacts…` (route 22 at `/social/instagram/accounts/{channel_account_id}/contact-tags`); the account filter, body field and pointer `instagram_account_id` → `channel_account_id` (→ `app.channel_accounts`, 1B); `{contact_id}` and the `contact_id` columns keep their names; audit `app.instagram_contact.*`; job payloads `channelAccountPublicId`.

**rev 3 changes** (P48, M10): **Contacts again — shared by every channel.** Folder `contact/` (+ `contact-tag-event/`), tables `app.contacts`, `app.contact_tag_events` (P44's `instagram_` prefix dropped; indexes `idx_contacts_…`, checks `chk_contacts_…`), each row keyed by `channel_account_id` with `channel` (CT3); routes back to `/contacts…`; route 22 at **`/contact-tags?channel_account_id=`** (CTQ4); audit `app.contact.*`; the entry points Instagram's intake calls take normalized event kinds — the inbound seam (CT18, WH27). Route numbers, gates and objects unchanged.

**rev 5 changes** (P97, M13): markers only — CT3, CT8 and route 18's `q` point at the scale review's kickoff defaults S5 (`contact_activities`), S7 (`contact_tag_counts`) and S6 (search of ≥ 3 characters). Routes 18–26 unchanged.

**As built (ROUTE R10, [P123](decisions.md), [AS-BUILT](../AS-BUILT.md))**: S5 — `app.contact_activities` (1:1) holds every activity time and count (the launch's three message times included); CT3's `idx_contacts_chat_open` / `idx_contacts_last_comment` are `idx_contact_activities_chat_open` / `_last_comment` (no opt-out / pause predicates); the erase deletes the activity row. S7 — `app.contact_tag_counts`, kept in the tag commit, serves route 22; CT8's 60 s Redis copy and its cache tests (CTC8) are not built. S6 — `q` 3–200, a 2 s statement timeout, the trigram and tags indexes led by the account (`btree_gin`). Route 21 answers `503 contact_bulk_action_unavailable` until the bulk job (R46) is wired; tag events go through the `ContactTagEventRecorder` port (R11). `first_automation_id`'s key stays with sub-domain 4 (R13); the provider id column keeps `instagram_user_id`.

| # | Decision |
| --- | --- |
| CT1 | **Folder, the new code, names.** Today: `contact/` with list and erase only (`contact:read`, `contact:delete`); writes come only from event processing (launch CT2). After: the folder stays `contact/` and its table `app.contacts`, shared by every channel (P48 — rev 2's `instagram-contact/` and `app.instagram_contacts`, P44, are undone), plus `contact/contact-tag-event/` (3.B); **one new code** `contact:update` (P20 — note, tags, pause, retry for a contact), Owner, Admin and Editor (plan §45.5 row 5); the constant in `app.permissions.ts`, its catalog row and grants by sub-domain 9's role change (Editor, Viewer). Route-level writes now exist, so the launch's "only event processing writes contacts" (launch CT2) becomes "only this service writes contacts" — the owner's routes and event processing both call it; sub-domains 4–6 still never import the contact repository or schema. Public id `con_…`, `{contact_id}` as built. |
| CT2 | **Contacts belong to one account and every list names it (D26, P1, CTQ2).** Today: `instagram_account_id` is an optional filter (default every account); the sort indexes lead with `organization_id` alone. After: `channel_account_id` is **required** on route 18 (and on the bulk action and tag list) — the app is switched per account (plan:L2527) — and the four sort indexes lead with `(organization_id, channel_account_id, …)` (plan:L2982). Other option: keep it optional and keep organization-wide indexes beside the per-account ones. |
| CT3 | **New columns, each set in the commit of the event that moves it (plan:L2960–L2993).** `last_opening_message_at` (an opening DM `sent` or `unknown` — sub-domain 6), `opted_out_at` (CT6), `channel` (`instagram`, D27), `first_automation_id` + `came_in_via` (a `trigger_type`) + `came_in_ref` (ref code or ad id, ≤ 64) — set once by her first run (4.B), `note` (CT5), `first_message_at` (her first DM in the chat, set once — the "first message" start reads it), `automations_off_at` + `automations_off_by_user_id` (CT5), `last_comment_at` and `comment_count` (each comment's intake commit), `last_story_activity_at` (a story reply or mention), `last_broadcast_at` (a broadcast message `sent` — sub-domain 7). They are written through new contact-service operations (3.A.10), never by another sub-domain's repository. → S5, P97: the fast-changing activity fields go to a narrow 1:1 `contact_activities` table. |
| CT4 | **Personal data and the log (launch CT12, D38).** `note` joins `phone`, `full_name`, `username`, `profile_picture` in the contact log-redaction list; the audit never carries the note text or a tag list (field names only). `automations_off_by_user_id` → users `ON DELETE SET NULL` (K6) — the first user pointer on contacts. |
| CT5 | **The owner's changes on one contact (route 20, D46, D71).** `note` (1–2,000 characters, `CONTACT_NOTE_MAX_CHARACTERS` (P6: the plan's `_CHARS`); `null` clears; nothing is sent); `add_tags` / `remove_tags` (each 1–20 tags, 1–50 characters, a comma becomes a space; at most 50 held — past 50 → `422 contact_tag_limit`); `is_automations_paused` — `true` sets `automations_off_at` and `_by_user_id` and, **in the same commit**, runs the registered pause steps: her waiting messages `skipped` (`contact_excluded`, sub-domain 6) and her open runs `cancelled` (`contact_excluded`, 4.B); `false` clears both and restarts nothing — her next own action starts normally. Each tag change writes one tag event (3.B, `source` `owner`) in that commit; after commit the events are handed to intake (WC-4, sub-domain 5) and the account's tag-list copy is invalidated (CT8). Optional `expected_updated_at` → `409 record_changed`. An opted-out contact can be noted, tagged and paused; her opt-out cannot be changed by anyone but her (CT6). |
| CT6 | **Stop words (D49, plan:L2416–L2439).** Today: none. After: intake (sub-domain 5) calls `recordContactOptOut` when her whole cleaned message equals a stop word (`STOP_WORDS` plus the account's `extra_stop_words`, 2.B) — `opted_out_at` = now and, in the same commit, the pause steps with reason `opted_out` (messages `skipped`, runs `cancelled`). `clearContactOptOut` is called only by intake on her own new action of the kinds D49 lists (a keyword comment, a keyword DM, a starter-question tap, an ig.me link) in the commit that starts that run. No route sets or clears it — the owner can't (D49). The contact object shows `is_opted_out` and `opted_out_at`. |
| CT7 | **Many contacts at once (route 21, D45, plan:L1039, L2615, L2625).** One action — `add_tag`, `remove_tag`, `pause_automations`, `resume_automations` — on contacts of one account named by `contact_ids` (1–500) **or** by `filter` (the list's filters, every match — CTQ3). The route counts the matches (capped at 100,000 → `422 contact_bulk_too_many`), then enqueues one bulk job (WC-36, extended from tags to pause and resume) with `organizationPublicId`, `channelAccountPublicId`, the action and the selection; the job works in pieces of 500, one short commit per piece, each change as on route 20 (tag events, pause steps). Answers `matched_count`. Safe to repeat: a piece re-run finds the tag in place or the pause set and writes nothing twice. `X-Idempotency-Key` required (it starts background work). |
| CT8 | **The tag list with counts (route 22, D45, P5).** Today: none. After: the account's tags with how many live contacts carry each (`unnest(tags)`, `count(*)`), sorted by count then name, all of them (an account holds few distinct tags; capped at 1,000 rows). Cached 60 s in a `contact-tags.cache.ts` under be-read-cache-guard: key `app:contact_tags:<organization public id>:<channel account public id>`, the account id taken from the row the service read inside the organization's scope, never from the raw query parameter (CTQ1); invalidated by tombstone after every tag commit — routes 20, 21, the tag step (4.B) and the erase; fails open to Postgres. → S7, P97: a `contact_tag_counts` table kept in the tag commit serves the counts. |
| CT9 | **Field rules, before → after.** Tags: launch 1–255 (an automation's name became the tag when it had none) → **1–50** (the tag step names its tags, `steps.tags`, and the go-live check refuses an empty one — sub-domain 4; the plan's tag limit, plan:L1029); at most 50 per contact, as built. Email: plus addresses refused (launch) → **accepted** (P19); `chk_contacts_email` becomes the plan's strict shape, ≤ 254 (plan:L2976). Phone: unchanged. |
| CT10 | **Audit (K9).** `app.contact.update` (INFO; `changed_fields`, never values), `app.contact.automations_pause` and `.automations_resume` (WARNING — D71 asks for each change), `app.contact.bulk_action` (INFO; action, `matched_count`), `app.contact.failed_messages_retry` (INFO), `app.contact.delete` as built. |
| CT18 | **Shared contacts and the inbound seam (P48, rev 3).** Today (rev 2): `app.instagram_contacts`, called by Instagram's intake by name. After: `app.contacts` holds the people of every channel — one row per channel account and person (the provider's person id unique per `(organization_id, channel_account_id)`, as built), `channel` copied from the account (CT3); every list, the bulk action and the tag list name one `channel_account_id` (CT2, CTQ4). A channel's intake reaches contacts only through the entry points of 3.A.10, which take **channel-neutral inputs** — `organizationId`, `channelAccountId`, the provider's person id, a **normalized event kind** (WH27: `comment`, `live_comment`, `message`, `postback`, `starter_question`, `story_reply`, `story_mention`, `shared_post`, `referral`, `reaction`, `owner_message`) and its time; `recordInboundContactEvent` is the one front door (find or create her, the interaction and her window, then the kind's own counter — comment, story, first message), and the stop-word decision stays with the channel (Instagram reads its settings' `extra_stop_words`, 2.B) and arrives as `recordContactOptOut`. Contacts never import a channel's sub-domain. Other option: keep a contact table per channel — rev 2's P44, superseded. |

### 3.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| CTQ1 | be-read-cache-guard rule 1 says a cache key comes from the verified scope, never a request parameter; the tag list is per account. | key `…:<organization>:<account>` with the account id read back from Postgres inside the scope (CT8) · one key per organization holding every account's list | **The first** — the organization segment is the tenant boundary and comes from the scope; the account segment is a row the scope already proved is the organization's, so it can never reach another tenant; the second recomputes ten lists on every tag change | **P64** — organization + account, the account read back inside the scope (as recommended, CT8) |
| CTQ2 | Must every contact list name its account? | required (CT2) · optional, default every account | **Required** — the app is switched per account and the indexes lead with it; the launch is unreleased (P29), so the breaking change costs nothing | **P65** — required (as recommended) |
| CTQ3 | Bulk actions select by ids only, or also "every contact matching these filters"? | ids and filter (CT7) · ids only (1–500) | **Both** — "select all 12,000" is the case pieces of 500 exist for (plan:L1039) | **P66** — ids (1–500) or a filter, in pieces of 500 (as recommended) |
| CTQ4 | Route 22 now that contacts are shared: `GET /contact-tags?channel_account_id=` or under the account (`/social/channel-accounts/{channel_account_id}/contact-tags`)? | the shared path with the account as a query (CT18) · a 1B path served by 3 | **The shared path** — every other contact read is a shared path filtered by `channel_account_id`, and a route lives in the sub-domain whose path it has (M6); the cache key still reads the account back inside the scope (CTQ1) | **P67** — `GET /contact-tags?channel_account_id=` (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 3.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.contacts` | one person of one account | as built (launch § 2.3) + the 14 columns of CT3; erased in place (CT11) |
| `app.contact_tag_events` | one tag added to or removed from a contact | written in the tag change's commit; kept 8 days; no public id (3.B) |

```text
tenancy.organizations
   │
   └──< app.channel_accounts (1B) ──< app.contacts ──┬──< app.contact_tag_events (3.B)
                                                               ├──> app.automations (4)          first_automation_id — lands with 4
                                                               ├──> auth.users                   automations_off_by_user_id
                                                               ├──< app.automation_runs (4)      RESTRICT
                                                               └──< app.instagram_messages (6)   contact_id copy, no key (P33)
```

Pointing at it from other sub-domains: `automation_runs.contact_id` (4, RESTRICT), `automation_comment_logs.contact_id`
(4), `broadcast_recipients.contact_id` (7), the messages' copy (6, no foreign key into a split table). It points at
`app.channel_accounts` (1B, RESTRICT), `app.automations` (4 — `first_automation_id`, composite, `ON DELETE SET NULL
(first_automation_id)`; **the constraint is added by sub-domain 4's migration**, since 3 comes before 4 and 4's runs point
back at 3 — the launch's CT5 pattern) and `auth.users` (`SET NULL`). Branch rule: none.

**PostgreSQL design**

Changed in place in `20261121094503_app_contacts.sql` (D1). Each table's design is in its nested sub-domain. RLS as built:
enabled and forced, the organization policy (`USING` + the maintenance arm; `WITH CHECK` the organization only).

### 3.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `contact:read` | Contacts · See contacts | list, open, tags, what happened, the failed count | 18, 19, 22, 24, 25 | Owner, Admin, Editor, Viewer |
| `contact:update` **(new, P20)** | Contacts · Tag contacts, write notes | note, tags, pause automations, bulk, retry | 20, 21, 26 | Owner, Admin, Editor |
| `contact:delete` | Contacts · Erase a contact's data | erase one | 23 | Owner, Admin |

### 3.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1) |
| Auth | `Authorization: Bearer`; the active organization from the token |
| Organization | team-only: writes 20, 21, 23, 26 → `422`; reads 18, 19, 22, 24, 25 → `404 team_organization_required` |
| Path id | `{contact_id}` (`con_…`); `channel_account_id` (`cha_…`) is a query on routes 18 and 22 and a body field on 21 (CTQ4); another organization's or an erased contact → `404 contact_not_found` |
| Writes | routes 21 and 26 need `X-Idempotency-Key` (they start background work); route 20 takes an optional `expected_updated_at` |
| Success | `200` with `{ data, meta }`; route 23 → `204` |
| Lists | routes 18, 24: `limit` (1–100, default 25), `after`; route 18 `estimated_total` on page one (as built) |
| Errors | `400`, `401`, `403 missing_permission`, `404`, `409`, `422`, `429` |

### 3.6 Objects returned

| Object | Where |
| --- | --- |
| Contact · Contact detail · Contact tag count · Contact bulk action result · Contact activity item · Failed messages summary · Failed messages retry | 3.A.6 |
| — (tag events are never returned) | 3.B |

### 3.7 Routes (18–26)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 18 | GET | `/contacts` | One account's contacts **(changed, RC-20)** | `contact:read` | |
| 19 | GET | `/contacts/{contact_id}` | Open one contact **(new, RC-21)** | `contact:read` | |
| 20 | PATCH | `/contacts/{contact_id}` | Note, tags, pause automations for her **(new, RC-22)** | `contact:update` | |
| 21 | POST | `/contacts/bulk-actions` | One tag or pause on many **(new, RC-23)** | `contact:update` | req |
| 22 | GET | `/contact-tags` | The account's tags with counts **(new, RC-24)** | `contact:read` | |
| 23 | DELETE | `/contacts/{contact_id}` | Erase one contact **(changed, RC-25)** | `contact:delete` | |
| 24 | GET | `/contacts/{contact_id}/activity` | What happened **(new, RC-36)** | `contact:read` | |
| 25 | GET | `/contacts/{contact_id}/failed-messages/summary` | Her failed messages, counted **(new, RC-39)** | `contact:read` | |
| 26 | POST | `/contacts/{contact_id}/failed-messages/retry` | Retry them **(new, RC-40)** | `contact:update` | req |

### 3.8 Request details

In 3.A.8 (3.B has no routes).

### 3.9 Errors

Every route can answer the errors in 3.5; each route's own errors are in 3.A.9.

### 3.10 Rules worth knowing

- **Steps other sub-domains register** (the launch's `ContactErasureStep` pattern, wired in `app.container.ts`, so contacts
  never import them): **erasure** (route 23) — 4.B's run and comment-log copies (as built), 6's waiting messages
  cancelled, 3.B's tag events deleted; **pause** (route 20, 21, CT6's opt-out) — 4.B's open runs cancelled, 6's waiting
  messages skipped, each with the reason it is given (`contact_excluded` or `opted_out`).
- A contact is locked (`lockLiveContact`, launch D46) before any of these, as built — the owner's routes and event
  processing never deadlock.
- Routes 24–26 read and write through sub-domains 4 (runs) and 6 (messages, the retry job WC-42); this sub-domain owns
  only the path and the gate.

### 3.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| CTC1 | CT1, CT10: `CONTACT_UPDATE` in `app.permissions.ts`, its catalog row and grants with sub-domain 9; the routes' gates; the audit actions; `contact.overview.md`, `contact-tag-event.overview.md` |
| CTC2 | CT2: `channel_account_id` required in `listContactsQueryDto` (and the OpenAPI query map); the four sort indexes re-led with the account |
| CTC3 | CT4: `note` in the contact log-redaction list with its unit test |
| CTC4 | The pause-step type beside `ContactErasureStep`; both lists filled in `app.container.ts` by sub-domains 3.B, 4 and 6 |

### 3.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/contact/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 3.A Contacts | folder root | `app.contacts` | 18–26 | final (rev 5, confirmed 2026-11-24) |
| 3.B Contact tag events | `contact-tag-event/` | `app.contact_tag_events` | — | final (rev 5, confirmed 2026-11-24) |

---

### 3.A Contacts — `contact/` (folder root) — final (rev 5, confirmed 2026-11-24)

#### 3.A.1 Decisions

| # | Decision |
| --- | --- |
| CT11 | **Erase also cancels her messages and her tag events (RC-25, plan:L2628).** Today (launch CT7, CT8): lock, run the erasure steps (4's run copies), clear every personal column, keep the row; `chk_contacts_erased`. After: the same, with two more steps (3.10) and more columns cleared — `note`, `opted_out_at`, `last_opening_message_at`, `automations_off_at`, `automations_off_by_user_id`, `came_in_ref`, `first_message_at`, `last_comment_at`, `last_story_activity_at`, `last_broadcast_at` emptied and `comment_count` 0 (her activity is personal data too); `first_automation_id`, `came_in_via` and `channel` stay (they name the organization's own automation, not her). `chk_contacts_erased` lists them. No body, no key, a repeat `404` — as built. |
| CT12 | **The list (route 18).** Today: `q` over username, full name, email; `tags`, `has_email`, `has_phone`, `is_following_account`, `first_seen_from` / `_to`, `automation_id`, `instagram_account_id`; sorts `last_message_received_at` · `first_seen_at` · `username`. After: `channel_account_id` required (CT2); `q` also over `phone` (the trigram expression adds `coalesce(phone, '')`, plan:L2980); new filters `is_opted_out`, `is_automations_paused`, `came_in_via` (one or more `trigger_type` values), `first_automation_id` (`aut_…`); the sorts as built. Each row is a Contact (no note). |
| CT13 | **Open one contact (route 19).** A Contact detail: the row plus `note`, `automations_paused_by_user_id`, `last_opening_message_at`, `first_automation` `{ id, name }` (a deleted automation shows its name until purged, then null), `open_run_count`. Database only. |
| CT14 | **What happened (route 24, D46, D50, P13).** Our messages to her (sub-domain 6, kept about 30 days — split by run-start week, P13) and her runs' history (4.B run events, 90 days: started, step changes, `email_received`, `phone_received`, `hello_tapped`, `follow_tapped`, ended), merged newest first. Never her own free text, never the email or phone values (they are on the contact, launch AU23). Paging by keyset `(occurred_at, source, id)` — each source reads `limit + 1` after the cursor, the service merges and `finishKeysetPage` cuts. `meta.message_horizon_days` = 30 tells the screen why older entries show only run history. |
| CT15 | **Her failed messages (routes 25–26, D72).** Route 25 counts her `failed` messages of about the last 30 days: how many can go again now and why the others cannot (too old, chat closed, final for her, text still refused, broadcast, already retried once) — sub-domain 6's retry service, the same rules as an automation's (sub-domain 4, routes 36–37). Route 26 enqueues the `retry-failed` job (WC-42) for her and answers the count it expects; the job puts each allowed one back to `waiting` at most once (`owner_retry_at`), and the result banner follows. An opted-out or paused contact: every one counts as "final for her", and route 26 queues nothing. |

#### 3.A.2 Open questions

CTQ1 (3.2, the cache key), CTQ2 (the required account), CTQ3 (bulk by filter), CTQ4 (route 22's path, rev 3) — all answered as recommended (P64–P67).

#### 3.A.3 Tables and relations

`app.contacts` — changes only (launch § 2.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `last_opening_message_at` | `timestamptz` | yes | | the 24-hour private-reply rule (D8) |
| `opted_out_at` | `timestamptz` | yes | | CT6 |
| `channel` | `varchar(10)` | no | `'instagram'` | `instagram` (D27) |
| `first_automation_id` | `bigint` | yes | | composite → automations `ON DELETE SET NULL (first_automation_id)` — added with sub-domain 4 |
| `came_in_via` | `varchar(20)` | yes | | one of the 15 `trigger_type` values; set with `first_automation_id` |
| `came_in_ref` | `varchar(64)` | yes | | ref code or ad id |
| `note` | `text` | yes | | 1–2,000 characters (`chk_contacts_note`) |
| `first_message_at` | `timestamptz` | yes | | set once |
| `automations_off_at` | `timestamptz` | yes | | D71 |
| `automations_off_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL`; set with `automations_off_at`; check `automations_off_by_user_id IS NULL OR automations_off_at IS NOT NULL` (a deleted user empties the pointer, so the two are not tied both ways) |
| `last_comment_at` | `timestamptz` | yes | | |
| `comment_count` | `integer` | no | `0` | `>= 0` |
| `last_story_activity_at` | `timestamptz` | yes | | |
| `last_broadcast_at` | `timestamptz` | yes | | the 24-hour broadcast gap (D68) |

Checks changed: `chk_contacts_email` (the strict shape, ≤ 254 — CT9), `chk_contacts_erased` (CT11); added
`chk_contacts_channel`, `chk_contacts_came_in_via`, `chk_contacts_note`, `chk_contacts_comment_count`,
`chk_contacts_automations_off`. Indexes: the four sort indexes **re-led** `(organization_id, channel_account_id, <sort>,
id) WHERE deleted_at IS NULL`; `idx_contacts_search_trgm` adds `coalesce(phone, '')` (the repository's search uses the
expression verbatim); **added** `idx_contacts_first_automation` `(organization_id, first_automation_id) WHERE
first_automation_id IS NOT NULL` (the key), `idx_contacts_chat_open` `(organization_id, channel_account_id,
last_direct_message_received_at) WHERE deleted_at IS NULL AND opted_out_at IS NULL AND automations_off_at IS NULL`
(broadcasts, 7), `idx_contacts_last_comment` `(organization_id, channel_account_id, last_comment_at) WHERE
last_comment_at IS NOT NULL AND deleted_at IS NULL` (segments, 7), `idx_contacts_automations_off_by_user_id` `WHERE
automations_off_by_user_id IS NOT NULL` (the user key). No index for the two new yes/no filters — they narrow one
account's rows already reached by the sort index (launch CT10's rule).

#### 3.A.4 Permissions

| Code | Routes |
| --- | --- |
| `contact:read` | 18, 19, 22, 24, 25 |
| `contact:update` | 20, 21, 26 |
| `contact:delete` | 23 |

#### 3.A.5 Common to every route

As 3.5.

#### 3.A.6 Objects returned

**Contact** (route 18): the launch's object (launch § 2.6) plus `channel`, `is_opted_out`, `opted_out_at`,
`is_automations_paused`, `automations_paused_at`, `came_in_via`, `came_in_ref`, `first_automation_id` (`aut_…` or null),
`first_message_at`, `last_comment_at`, `comment_count`, `last_story_activity_at`, `last_broadcast_at`, `is_chat_open`
(derived: her last DM, story reply or tap + 24 h − 15 min is still ahead).

**Contact detail** (routes 19, 20): Contact plus `note`, `automations_paused_by_user_id` (`usr_…` or null),
`last_opening_message_at`, `first_automation` (`{ id, name }` or null), `open_run_count`.

**Contact tag count** (route 22): `tag`, `contact_count`.

**Contact bulk action result** (route 21): `action`, `matched_count`, `is_queued` (always `true`).

**Contact activity item** (route 24): `id` (the message's public id; `null` for a run event, which has none — [P136](decisions.md)), `source` (`message` · `run_event`),
`occurred_at`, `automation` (`{ id, name }` or null for a broadcast), `automation_run_id` (`run_…` or null),
`broadcast_id` (or null), and per source — `message`: `message_type`, `message_number`, `status`, `reason`, `channel`;
`run_event`: `event_type`, `status`.

**Failed messages summary** (routes 25 and 4's 36): `failed_count`, `retryable_count`, `not_retryable` (`{ too_old,
chat_closed, final_for_person, text_refused, broadcast, already_retried }`), `horizon_days` (30).

**Failed messages retry** (routes 26 and 4's 37): `expected_retry_count`, `is_queued`.

#### 3.A.7 Routes (18–26)

As 3.7.

#### 3.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 18 | `channel_account_id*`, `q` (1–200; username, name, email, phone — → S6, P97: ≥ 3 characters), `tags`, `has_email`, `has_phone`, `is_following_account`, `is_opted_out`, `is_automations_paused`, `came_in_via` (comma-separated), `first_automation_id`, `automation_id`, `first_seen_from` / `_to`, `sort`, `order`, `limit`, `after` | — | Contact[] |
| 19 | — | — | Contact detail |
| 20 | — | at least one of `note` (1–2,000 or `null`), `add_tags` (1–20), `remove_tags` (1–20), `is_automations_paused`; optional `expected_updated_at` | Contact detail |
| 21 | — | `channel_account_id*`, `action*` (`add_tag` \| `remove_tag` \| `pause_automations` \| `resume_automations`), `tag` (1–50, required for the tag actions, absent otherwise), exactly one of `contact_ids` (1–500 `con_…`, no repeats) or `filter` (the filters of 18 except `sort`, `order`, `limit`, `after`) | Contact bulk action result |
| 22 | `channel_account_id*`, `limit` (1–1000, default 1000) | — | Contact tag count[] |
| 23 | — | — | 204 |
| 24 | `limit` (1–100, default 50), `after` | — | Contact activity item[] |
| 25 | — | — | Failed messages summary |
| 26 | — | — (strict empty) | Failed messages retry |

#### 3.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 18 | `400` · `channel_account_id` | missing or not well formed; an unknown one is an empty page |
| 18, 21 | `400` · a filter's name | as built, plus the new filters |
| 20 | `400` · `note` / `add_tags` / `remove_tags` | out of range, a tag in both lists, an empty body, an unknown field |
| 20, 21 | `422` · `contact_tag_limit` | the tag would make more than 50 (route 21: those contacts are skipped and counted in the job's log, never a 422) |
| 20 | `409` · `record_changed` | `expected_updated_at` older than the contact |
| 21 | `400` · `contact_ids` / `filter` / `tag` | both or neither selection, a repeat, a tag for a pause action |
| 21 | `422` · `contact_bulk_too_many` | more than 100,000 matches |
| 21 | `503` · `contact_bulk_action_unavailable` | the bulk job is not wired yet (until ROUTE R46, P123) — valid and counted, nothing queued |
| 19, 20, 23–26 | `404` · `contact_not_found` | not in the organization, another organization's, or erased |
| 22 | `400` · `channel_account_id` | missing or not well formed |
| 22 | `404` · `channel_account_not_found` | not an account of the organization (as 1B.5) |
| 20, 21, 23, 26 | `422` | a personal organization; the idempotency key missing, malformed or reused (21, 26) |
| reads | `404` · `team_organization_required` | a personal organization |
| all | `403` · `missing_permission` | the gate (a Viewer on 20, 21, 26; an Editor on 23) |

#### 3.A.10 Rules worth knowing

**What the other sub-domains call**, added to the launch's list (launch § 2.10, which stays). The rows called by 5 are the
**inbound seam** (CT18): any channel's intake calls them with channel-neutral inputs and a normalized event kind (WH27).

| Operation | Called by | What it does |
| --- | --- | --- |
| `recordInboundContactEvent({ organizationId, channelAccountId, providerUserId, kind, occurredAt, profile })` **(new, rev 3)** | 5 — every saved event of a person (any channel's intake) | find or create her (as built), her interaction and window, then the kind's counter below; answers her contact id and send state |
| `recordContactComment({ contactId, occurredAt })` | 5 — each comment's intake | `last_comment_at = greatest(…)`, `comment_count + 1` |
| `recordContactStoryActivity({ contactId, occurredAt })` | 5 — a story reply or mention | `last_story_activity_at = greatest(…)` |
| `recordContactFirstMessage({ contactId, occurredAt })` | 5 — her first DM | `first_message_at` once |
| `recordContactFirstRun({ contactId, automationId, cameInVia, cameInRef })` | 4.B — a run's start | the three "via" columns, once |
| `recordContactOpeningMessage({ contactId, sentAt })` | 6 — an opening DM `sent` or `unknown` | `last_opening_message_at = greatest(…)` |
| `recordContactBroadcastSent({ contactId, sentAt })` | 7 | `last_broadcast_at = greatest(…)` |
| `recordContactOptOut` / `clearContactOptOut` | 5 | CT6 |
| `addContactTags` (changed) | 4.B — the tag step | now also writes a tag event per added tag (`source` `automation`, `source_automation_id`, the chain number it was given) and invalidates the tag-list copy after commit |
| `findContactSendState({ contactId })` | 5, 6, 7 | opted out, paused, erased, `last_direct_message_received_at` — every send's gate re-reads it |

#### 3.A.11 Code changes

| # | Change |
| --- | --- |
| CTC5 | CT3, CT9, CT11, CT12: `contact.schema.ts` and its migration changed in place (columns, checks, indexes as 3.A.3); the `first_automation_id` constraint with sub-domain 4; DTO filters; the trigram expression with phone (schema and repository verbatim); `INTERNATIONAL_PHONE_NUMBER_PATTERN` kept; the plus-address refusal removed from the contact email path (P19) |
| CTC6 | CT5, CT13: routes 19–20 (schemas, controller, service, DTO strict, validator, serializer), the pause steps in the same commit; reasons `contact_tag_limit`; integration tests — note set and cleared, tags added and removed with their events, a pause cancels her runs and skips her messages, an off restarts nothing, a Viewer `403` |
| CTC7 | CT7: route 21 (`idempotencyRequired`), the selection count, the WC-36 job extended to pause and resume (`contact/queues/`, `contact/workers/contact-bulk-action.*`, `instagram-tasks`, registry, DLQ), its tests (pieces of 500, a re-run writes nothing twice); reason `contact_bulk_too_many` |
| CTC8 | CT8: `contact-tags.cache.ts` (key, 60 s, tombstone after commit, fail open, `read_cache_requests_total`), route 22, and the five cache tests be-read-cache-guard asks for |
| CTC9 | CT14, CT15: routes 24–26 over sub-domain 4's run-event reader and 6's message reader and retry service (built with 6); keyset merge tests |
| CTC10 | The erasure (CT11): the two new steps, `chk_contacts_erased`, the erase test extended to every new column; the data-lifecycle doc row; seeds — demo contacts with notes, tags, a paused and an opted-out one |

---

### 3.B Contact tag events — `contact/contact-tag-event/` — final (rev 5, confirmed 2026-11-24)

#### 3.B.1 Decisions

**As built (ROUTE R11, [P406](decisions.md), [AS-BUILT](../AS-BUILT.md))**: the table, its repository and `ContactTagEventService` (the recorder R10's contact service calls, and the erase step); `queued_at` is stamped in the tag commit when intake is wired, and the after-commit hand-over names contacts by public id, at most 500 a job, through `ContactTagEventIntakeQueue` (R38); the two workers of CT17 are built at R47 (pick-up) and R50 (retention); `source_automation_id`'s key comes with R13's automations migration; a fifth index `idx_contact_tag_events_channel_account` backs the account key; `_source_automation` reads "null or `automation`". CTC12's `recordInboundContactEvent` is R38's.

| # | Decision |
| --- | --- |
| CT16 | **One event per tag change, in the change's commit (D45, plan:L3685–L3717).** Today: none — tags change only inside a run's completion. After: every tag added or removed — by the tag step (4.B, `source` `automation`, `source_automation_id`) or by the owner (routes 20, 21, `source` `owner`) — writes one `app.contact_tag_events` row in the same commit, so a tag start is never lost; `chain_number` is how many tag starts led to it (intake starts nothing at 3 or more — the loop guard, sub-domain 5); its `id` is part of a tag start's once key (`tag:<tag>:<event id>`). After commit the service hands the event to intake (WC-4, sets `queued_at`); intake sets `done_at`. A nested sub-domain (not a persistence part) because it has its own service and two workers. No routes, no public id. |
| CT17 | **Its two workers (pull-based, `retention` and `instagram-tasks` families).** (1) **Pick-up** (WC-27): every minute a scan across organizations (maintenance scope) finds events not handed over after 1 minute, or handed over 1 hour ago, not done and under 24 hours old; per organization it hands them to intake again (`organizationPublicId` in the job) — intake's once key makes a second hand-over start nothing twice. (2) **Retention** (WC-54, its tag part): events older than 8 days deleted in batches (`deleteInBatchesByCondition`). An erased contact's events go with the erase (CT11). |

#### 3.B.2 Open questions

None.

#### 3.B.3 Tables and relations

`app.contact_tag_events` (no public id; append-only except `queued_at` / `done_at`)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | no | | primary key; part of the tag start's once key |
| `organization_id` | `bigint` | no | | → organizations `ON DELETE CASCADE` |
| `channel_account_id` | `bigint` | no | | composite → accounts `RESTRICT` (a copy of the contact's) |
| `contact_id` | `bigint` | no | | composite → contacts `ON DELETE CASCADE` |
| `tag` | `varchar(50)` | no | | 1–50, trimmed, no comma |
| `kind` | `varchar(10)` | no | | `added` · `removed` |
| `source` | `varchar(12)` | no | | `automation` · `owner` |
| `source_automation_id` | `bigint` | yes | | composite → automations `ON DELETE SET NULL (source_automation_id)` — added with sub-domain 4; `source = 'automation'` or null |
| `chain_number` | `smallint` | no | `0` | `>= 0` |
| `created_at` | `timestamptz` | no | `now()` | |
| `queued_at`, `done_at` | `timestamptz` | yes | | |

Indexes: `idx_contact_tag_events_contact` `(organization_id, contact_id)` — the erase and the composite key;
`idx_contact_tag_events_pickup` `(created_at) WHERE done_at IS NULL` — the pick-up scan; `idx_contact_tag_events_created`
`(created_at)` — retention; `idx_contact_tag_events_source_automation` `(organization_id, source_automation_id) WHERE
source_automation_id IS NOT NULL` — the key. Checks: `chk_contact_tag_events_kind`, `_source`, `_source_automation`,
`_chain_number`, `_tag`. RLS: enabled and forced, organization policy (`USING` + the maintenance arm for the scan and
retention, `WITH CHECK` the organization). In `EXPECTED_FORCE_RLS_TABLES`. Plain table, batch deletes (P33).

#### 3.B.4 Permissions

None — no routes; written through the contact service by routes 20–21 (`contact:update`) and the tag step.

#### 3.B.5 Common to every route

No routes.

#### 3.B.6 Objects returned

None — never returned (the owner sees tag changes in "What happened" only through the run history).

#### 3.B.7 Routes

None.

#### 3.B.8 Request details

None.

#### 3.B.9 Errors

None of its own.

#### 3.B.10 Rules worth knowing

- Tag starts need her chat window open (plan:L503) and never start themselves (`source_automation_id` = the automation →
  that automation is not started by its own event) — sub-domain 5 applies both.

#### 3.B.11 Code changes

| # | Change |
| --- | --- |
| CTC11 | CT16, CT17: `contact-tag-event.{schema,repository,service,types}.ts` in the contacts migration (the automation key with sub-domain 4); `createWorkerContactTagEventRepository(databaseHandle)`; the hand-over after commit (`runEnqueueAfterCommit`); `contact-tag-event/workers/` pick-up and retention (registry, scheduler, `WORKER_QUEUE_NAMES`, the scan in the maintenance-confinement allowlist); tests — written in the tag's commit, a rollback writes none, a re-hand-over starts nothing twice, 8-day retention |
| CTC12 | CT18 (rev 3, P48): the shared names — `contact/` and `contact/contact-tag-event/`, `app.contacts`, `app.contact_tag_events`, `idx_contacts_…`, `chk_contacts_…`, `contact-tags.cache.ts`, audit `app.contact.*`; route 22 at `/contact-tags` with `channel_account_id` required (DTO, OpenAPI query map, `PARAM_NAME_TO_ENTITY` unchanged); `recordInboundContactEvent` over the existing operations, typed with `ChannelInboundEventKind` from `app.channel-ports.ts`; a policy test that `contact/` imports no `instagram-*` folder |

---

## 4. Automations — rev 5 (2026-11-24) — nested sub-domains 4.A–4.C; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (P31). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`automation` sub-domain folder** — `app/sub-domains/automation/` (the launch's `automation/`, kept and shared by every channel — P48; the automation, its counters and its
public-reply pacing at the folder root) with `automation-run/` (as built) and a new `automation-backfill/` (past comments,
nested under automation — P38).

4.1 Decisions (whole sub-domain) · 4.2 Open questions · 4.3 Tables and relations · 4.4 Permissions · 4.5 Common to every route ·
4.6 Objects returned · 4.7 Routes · 4.8 Request details · 4.9 Errors · 4.10 Rules worth knowing · 4.11 Code changes (whole sub-domain) ·
4.12 Nested sub-domains · then **4.A Automations · 4.B Automation runs · 4.C Automation backfills** — each with the same
eleven sections.

An automation of one account: `draft` → `live` ⇄ `paused` (D28), started by one of 15 ways (D37, the untested ones
refused at go-live — P36), with one `steps` object for what it sends (hello, follow, email, phone, 1–10 messages, tags —
D29–D31) and its own public-reply pacing (D32). Its runs carry a once key, the 7-day clock and the step versions; at most
one open run per automation and person, and an allowed new comment replaces it (P35); a send whose result is unknown is
never sent again by itself (D17); PRO parts are read from the plan at run time (D57). Past comments of the last 1–7 days
can be answered too (D69). Design read: plan §4–§5 (plan:L448–L1131), §15.4–15.5, §15.10–15.11 (plan:L2593–L2733),
§18.5–18.8 (plan:L2995–L3205), §19.12–19.13, §19.20; `db-changes.md` › automation, automation_count,
automation_reply_state, automation_backfill, automation_run, automation_run_event, automation_comment_log;
`route-changes.md` RC-26–RC-34, RC-37, RC-38, RC-54, RC-55; `worker-changes.md` WC-41, WC-43–WC-45 (WC-45 CHANGED — P99), WC-47, WC-51, WC-52, WC-55 (the shared part upkeep — P96).
Builds on 1B (the account), 2 (its media), 3 (contacts — and it adds 3's two keys into automations); sends nothing itself
(sub-domain 6 sends, WC-9 removed). Route numbers run 27–39.

### 4.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). The launch's
review is the "before" ([launch routes-final § 3](../../launch-2026-11-20-ujai/plans/routes-final.md)).

**rev 2 changes** (P44, P47, M9): renamed Automations → **Instagram automations** — folders `instagram-automation/` (+ `instagram-automation-run/`, `instagram-automation-backfill/`), tables `app.instagram_automations`, `app.instagram_automation_runs`, `app.instagram_automation_run_events`, `app.instagram_automation_comment_logs`, `app.instagram_automation_counts`, `app.instagram_automation_reply_states`, `app.instagram_automation_backfills`; routes under `/social/instagram/automations…`; `instagram_account_id` → `channel_account_id` (→ `app.channel_accounts`, 1B); `{automation_id}`, `{automation_backfill_id}` and the `automation_id` columns keep their names; audit `app.instagram_automation.*`; go-live reads the account state from 1B and media and starter questions from 2.

**rev 3 changes** (P48, P50, P51, M10): **Automations again — shared by every channel.** Folders `automation/` (+ `automation-run/`, `automation-backfill/`), tables `app.automations`, `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.automation_counts`, `app.automation_reply_states`, `app.automation_backfills` (indexes `idx_automation…`, checks `chk_automation…`), keyed by `channel_account_id` with `channel`; routes back to `/automations…`; audit `app.automation.*`, `app.automation_backfill.*`. Go-live checks every part through 1B's one feature check (AU34, CA11); the run engine sends through **`ChannelSendingPort`** and takes results at `recordMessageResult` (AU35 — the outbound seam) and takes events with normalized kinds (4.B.10 — the inbound seam); the past-comments read uses the connection's Meta usage (P51). Route numbers, gates and objects unchanged.

**rev 5 changes** (P92, P96, P99, M13): runs and run events split by month of the run's start, comment logs by month (P96 — AU36, AUC14, 4.3, 4.B.3; AU22 and AU23 follow) — expiry by dropping a month part, so WC-51 and WC-52 drop parts instead of deleting in batches (P92, AU30, AUC11); WC-45 cited as CHANGED (P99); one open run per automation and person is the key table `app.automation_run_open_keys` again (P100 — AU37, AUC15, AU23; AUQ4's P71 superseded). Routes 27–39 unchanged.

| # | Decision |
| --- | --- |
| AU1 | **Folders, names, ids (P38).** Today: `automation/` (routes 11–15 of the launch) and `automation-run/` (no routes; runs, run events, comment logs, the engine). After: both stay `automation/` and `automation/automation-run/`, their tables shared by every channel (P48 — rev 2's `instagram-automation/` and `app.instagram_*`, P44, are undone); a new nested `automation-backfill/` (routes 38–39, `app.automation_backfills`, the past-comments worker); `app.automation_counts` and `app.automation_reply_states` are persistence parts at the folder root (`automation-count.*`, `automation-reply-state.*` — schema, repository, a small service each; no controller). The plan's singular `automation_reply_state` becomes the plural table name (db-changes). Public id of a backfill: prefix at kickoff (P22); **its path id is `{automation_backfill_id}`** (the table's singular — the template's rule), not route-changes' `{backfill_id}`, registered in `PARAM_NAME_TO_ENTITY`. |
| AU2 | **Codes — no new ones (P20, D55).** `automation:read` · `create` · `update` · `delete` as built; past comments and the automation's failed-message retry reuse them (D69, D72). The Member role becomes **Editor** and gains `automation:delete` (D55, sub-domain 9) — Editors may create, edit, go live, pause and delete. Viewer reads. |
| AU3 | **Status by actions only (P8, D28).** Today: `live` · `inactive`, set by `PATCH status`. After: `draft` · `live` · `paused` (`inactive` → `paused` in the migration changed in place — no data, P29); `PATCH` saves content only; route 32 goes live from `draft` or `paused`, route 33 pauses a `live` one; delete from any status. Going live when already `live`, or pausing an already `paused` automation with the same mode, answers `200` and changes nothing (a repeat is safe, so neither takes a key); pausing a `draft` → `409 transition_not_allowed`. An automatic stop (`stopped_reason` `bad_text` · `post_deleted`, set by sub-domains 5–6) keeps it `live` and sends nothing until fixed (route 30). A plan change never stops one (D57). |
| AU4 | **Plans: read-only, PRO, untested features (P10, D35, D57, P36).** Today: `app-plan-access.ts`'s preHandler refuses create, edit and delete with `403 organization_read_only` while `BILLING_READ_ONLY_ENFORCED` is on; no PRO, no feature list. After: (1) **plan ended or organization suspended** → only go-live is refused (`403 organization_read_only`, the same reason; the preHandler moves from create / edit / delete to route 32); create, edit, pause, duplicate and delete stay open (P10); (2) **PRO** — since P83 each part its own plan switch (`email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `past_comments`; 2.B's extra delay is `extra_delay`): a draft may hold them; going live with one whose switch the plan lacks is a go-live problem; a save of a live or paused automation that turns one on (off in the saved row) → `403 plan_lacks_feature`; past comments → `403 plan_lacks_feature`; PRO parts already on before a move down stay saved and the engine ignores them (4.B); (3) **untested Meta features** — the code list `APP_UNTESTED_META_FEATURES` in the app domain's settings file (P4, owned by sub-domain 6): `story_repost`, `live_comment`, `ad_comment`, the 7-day ad window, `quick_replies` and `cards` on Unified Login, `mark_seen` — a go-live that uses one is a problem (`feature_not_offered` — one item of `409 automation_not_ready`'s `errors[]`; the settings field's `422` has the same name since rev 3, 2.B, M10); drafts may hold them; removing an item is a deploy after its §43 test. Plan features come from sub-domain 8's plan read. |
| AU5 | **Idempotency.** `X-Idempotency-Key` required on 28 (create), 34 (duplicate), 37 (retry) and 38 (past comments) — each makes a row or background work; routes 32, 33 (state no-ops, AU3) and 35 (saves nothing) take none. |
| AU6 | **Background work owned here** (all pull-based, `organizationPublicId` in every job, safe to repeat): **next-post linking** (WC-43, changed — every 15 minutes, per account with a live waiting "my next post" automation, read the posts published since its go-live and link the first, once; no window, no dates); **next-post expiry** (WC-44) **removed** — "my next post" never expires (P12); **deleted-automation purge** (WC-47, changed — counters, reply state and backfills go by cascade, file links through sub-domain 6); the run workers (4.B) and the past-comments read (4.C). After a go-live, pause, delete or question change of a starter-question automation, it enqueues sub-domain 2's starter-question sync (IA6) after commit. |
| AU7 | **Audit (K9).** As built `app.automation.create` · `.update` (changed fields) · `.delete`; new `app.automation.go_live`, `.pause` (`metadata.mode`), `.duplicate` (`metadata.source_automation_public_id`), `.failed_messages_retry`, `app.automation_backfill.start` — all after commit. |
| AU34 | **Shared automations and the capability list at go-live (P48, P50, rev 3).** Today (rev 2): `app.instagram_automations` and its run tables, Instagram's by name; PRO and the untested list checked separately (AU4). After: `app.automations` and its six tables hold every channel's automations, each row keyed by `channel_account_id` with `channel` copied from the account; create and save check shapes against the union of every channel's values (AU9, AU11 — a draft may hold anything); **go-live** asks 1B's one feature check (CA11) for the way to start, every step, every message kind and every PRO or Meta-tested part, and lists each refusal as an `errors[]` item of `409 automation_not_ready` — `channel_lacks_feature` (not in `CHANNEL_CAPABILITIES` for the account's channel), `permission_not_granted` (reconnect, route 40), `plan_lacks_feature`, `feature_not_offered` (P36's gate on top of the capability). The engine's channel-only steps (the starter-question sync, next-post linking, public reply and hide) run only where the channel lists them and reach Instagram's 2 through wired ports, never by import. Other option: a set of automation tables per channel — P44, superseded. |
| AU35 | **The outbound seam — `ChannelSendingPort` (P48, rev 3; the contract the channel's sending sub-domain implements, SN22).** The run engine (4.B) and broadcasts (7) never send and never name a lane. The port type lives in the app kernel (`app.channel-ports.ts`); `app.container.ts` wires one implementation per channel (`channelSendingPorts.instagram` = sub-domain 6's message service) and the caller picks it by the account's `channel`. **What is passed** — `saveWaitingMessage({ databaseHandle, organizationId, channelAccountId, contactId, source, step, messageKind, content, notBefore, triggerOccurredAt, answersEventId })`: `source` = `{ automationId, automationRunId, automationRunStartedAt }` for a run or `{ broadcastId, broadcastRecipientId }` for a broadcast; `step` = `hello` · `follow` · `follow_check` · `email` · `phone` · `nudge` · `messages` · `public_reply` · `hide_comment` · `broadcast` with `messageNumber`, `versionNumber`, `wordingNumber`; `messageKind` from the channel's capability list (CA11); `content` **by reference only** — the step path (`steps.messages.2`) and the files' upload public ids, never the text (read at send, 6.B.10); `answersEventId` the comment or message a private or public reply answers. It writes the row in the **caller's transaction** and answers `{ messagePublicId, status: 'waiting' }`, or `skipped` with its reason when the message can never go (her window already closed for a list message). **Who chooses the lane**: the channel's sending sub-domain — Instagram's 6 maps the step, her window and the comment's age to `slow` · `reply` · `fast` · `broadcast`, sets the delivery channel (`private_reply` · `direct` · `comment_reply` · `comment_hide`) and whether it counts in the month, and wakes the lane after commit. Also on the port: `cancelWaitingMessages({ by: run · automation · contact · broadcast, id, reason })` and `skipWaitingMessages` (pause, erase, delete, live edits, P35's `replaced`), `readMonthUsage` (go-live check 4), and the failed-message summary and retry (routes 25–26, 36–37). **How results come back**: the sending sub-domain calls the engine's one save-result entry point `recordMessageResult({ databaseHandle, organizationId, channelAccountId, automationRunId, automationRunStartedAt, messagePublicId, step, messageNumber, result, reason, occurredAt })` in the **same commit** as the message's final status — `result` = `sent` · `failed` · `skipped` · `unknown` (`expired` arrives as `skipped` with its reason; `cancelled` is never reported — the engine or the owner caused it); the engine moves the run on (next step, completion, an `unknown` waits for `any` — AU25) and the counts in that commit; a repeat call for a settled message does nothing. A broadcast's results go to 7.C's `recordMessageResult` the same way (BC18). A tap is not a result: it arrives through the inbound seam (`handleButtonClick`). |

### 4.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| AUQ1 | Go-live answers a list of problems, each with its step (plan §5.1). Which status? | `409 automation_not_ready` with `errors[]` · `422` with `errors[]` | **409** — the request (no body) is fine; the automation's saved state conflicts with going live and the same call passes once it is fixed (response-codes' 409 vs 422 rule); `errors[]` on this one 409 is new and is documented in `response-codes.md` | **P68** — `409 automation_not_ready` with `errors[]` (as recommended) |
| AUQ2 | A save of a live or paused automation "runs the same full check" (plan:L670) — does that include the account, plan and month checks? | content checks only (AU12) · the full list | **Content only** — a month-limit or plan-ended organization must still be able to fix a refused text (P10); the account, plan and month checks run at go-live | **P69** — content checks only (as recommended) |
| AUQ3 | A draft "needs only a name" (D28) — is the way to start chosen at create? | `trigger_type` required at create · optional until go-live | **Required** — the editor opens on a chosen way, a later change must stay in the same group (plan:L687), and every database check keys on it | **P70** — required at create (as recommended) |
| AUQ4 | Drop the plan's `app.automation_run_open_key` (db-changes' proposal under P35)? | drop — the launch's one-open-run index does it · keep the key table | **Drop** — with P35 a new allowed start cancels the open run in the same commit, so the partial unique index `idx_automation_runs_one_open` was enough while runs were one table; WC-45 then frees no key | **P71** — drop (as recommended); **superseded by P100** (rev 5): runs split by month need the key table `app.automation_run_open_keys` (AU37) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 4.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.automations` | one automation of one account | status by actions (AU3); go-live rules as `status = 'draft' OR (…)` checks (4.A); soft delete, reason optional (AU16) |
| `app.automation_counts` | all-time counters in 16 slots | primary key `(organization_id, automation_id, slot)`; written in the event's commit (AU19) |
| `app.automation_reply_states` | the "Reply like a person" pacing | one per automation, made at its first public reply |
| `app.automation_runs` | one person going through one automation | one open run per automation and person (AU23); once key (AU22); **split by month of its start** (P96, AU36) — a part dropped once every run in it ended 90 days ago |
| `app.automation_run_events` | a run's append-only history | + two tap events; cascades with its run; **split by month of its run's start** (P96, AU36), dropped with its run's part |
| `app.automation_comment_logs` | one comment an automation saw | the message-list and hide steps; **split by month** of `created_at` (P96, AU36) — a part dropped 90 days after its month |
| `app.automation_run_open_keys` | the open run of each automation and person | the rule of AU23 (P100, AU37): unique (organization, automation, contact); written and deleted in its run's commits |
| `app.automation_backfills` | one past-comments read | one queued or reading per automation (4.C) |

```text
tenancy.organizations
   │
   └──< app.channel_accounts (1B) ──< app.automations ──┬──< app.automation_counts (16 slots)
                                                                  ├──< app.automation_reply_states (1:1)
                                                                  ├──< app.automation_backfills (4.C)
                                                                  ├──< app.automation_runs (4.B) ──┬──< app.automation_run_events
                                                                  │        └──> app.contacts (3)   └──< app.automation_comment_logs
                                                                  ├──< app.contacts.first_automation_id (3, SET NULL)
                                                                  └──< app.contact_tag_events.source_automation_id (3.B, SET NULL)
```

Pointing at these from other sub-domains: the messages' copies (6, no keys into a split table), broadcasts' "start
automation X" button (7), `contacts.first_automation_id` and `contact_tag_events.source_automation_id` (3 — **their two
constraints are added by this sub-domain's migration**). Branch rule: none. Membership pointers: none; `created_by_user_id`,
`updated_by_user_id`, `requested_by_user_id` → users `ON DELETE SET NULL` (K6).

**PostgreSQL design**

Changed in place in `20261121150135_app_automations.sql` and `20261121170217_app_automation_runs.sql` (D1, P29); the
backfill, counts and reply-state tables join the automations migration. **Partitioned since rev 5** (P96, superseding P33's plain list) — runs and run events by month of the run's start, comment
logs by month; each expires by dropping a part through the shared upkeep (AU36), not by batch deletes. Every table: enabled and forced RLS, the organization policy (`USING` +
the maintenance arm on automations, runs, logs and backfills for the sweeps; `WITH CHECK` the organization only), listed
in `EXPECTED_FORCE_RLS_TABLES` (+3, and +1 for the open-run keys, AU37).

### 4.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `automation:read` | Automations · See automations and their numbers | list, read, try a keyword, the failed count, a past-comments read | 27, 29, 35, 36, 39 | Owner, Admin, Editor, Viewer |
| `automation:create` | Automations · Create, edit, duplicate, go live, pause | add a draft, duplicate | 28, 34 | Owner, Admin, Editor |
| `automation:update` | (same row) | edit, go live, pause, retry failed, answer past comments | 30, 32, 33, 37, 38 | Owner, Admin, Editor |
| `automation:delete` | Automations · Delete automations | delete | 31 | Owner, Admin, Editor (D55) |

### 4.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app` (K1) |
| Auth | `Authorization: Bearer`; the active organization from the token |
| Organization | team-only: writes 28, 30–34, 37, 38 → `422`; reads 27, 29, 35, 36, 39 → `404 team_organization_required` (route 35 is a `POST` that saves nothing — it answers like a read) |
| Path id | `{automation_id}` (`aut_…`); `{automation_backfill_id}` (AU1); another organization's or a deleted automation → `404 automation_not_found` |
| Writes | AU5; route 30 takes an optional `expected_updated_at` (`409 record_changed`) |
| Plan | AU4: `403 organization_read_only` on route 32 only; `403 plan_lacks_feature` where a PRO part is turned on |
| Success | `200` with `{ data, meta }`; route 31 → `204`; routes 30 and 32 put warnings in `meta.warnings` (`[{ reason, field, detail }]`) |
| Errors | `400`, `401`, `403`, `404`, `409` (`automation_not_ready` carries `errors[]` — AUQ1), `422`, `429` |

### 4.6 Objects returned

| Object | Where |
| --- | --- |
| Automation · Automation list row · Keyword test result | 4.A.6 |
| Failed messages summary · Failed messages retry | 3.A.6 (shared) |
| — (runs are never returned on their own; the contact's "What happened" shows their history, 3.A) | 4.B |
| Automation backfill | 4.C.6 |

### 4.7 Routes (27–39)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 27 | GET | `/automations` | One account's automations **(changed, RC-26)** | `automation:read` | |
| 28 | POST | `/automations` | Save a draft **(changed, RC-27)** | `automation:create` | req |
| 29 | GET | `/automations/{automation_id}` | One automation, new shape **(changed, RC-28)** | `automation:read` | |
| 30 | PATCH | `/automations/{automation_id}` | Save content **(changed, RC-29)** | `automation:update` | |
| 31 | DELETE | `/automations/{automation_id}` | Delete, reason optional **(changed, RC-30)** | `automation:delete` | |
| 32 | POST | `/automations/{automation_id}/go-live` | Go live **(new, RC-31)** | `automation:update` | none (AU3) |
| 33 | POST | `/automations/{automation_id}/pause` | Pause, keep or cancel **(new, RC-32)** | `automation:update` | none (AU3) |
| 34 | POST | `/automations/{automation_id}/duplicate` | A draft copy **(new, RC-33)** | `automation:create` | req |
| 35 | POST | `/automations/{automation_id}/keyword-test` | Try it **(new, RC-34)** | `automation:read` | none (saves nothing) |
| 36 | GET | `/automations/{automation_id}/failed-messages/summary` | Its failed messages, counted **(new, RC-37)** | `automation:read` | |
| 37 | POST | `/automations/{automation_id}/failed-messages/retry` | Retry them **(new, RC-38)** | `automation:update` | req |
| 38 | POST | `/automations/{automation_id}/backfills` | Also answer past comments **(new, RC-54)** | `automation:update` | req |
| 39 | GET | `/automations/{automation_id}/backfills/{automation_backfill_id}` | One past-comments read **(new, RC-55)** | `automation:read` | |

### 4.8 Request details

In each nested sub-domain (4.A and 4.C, section .8; 4.B has no routes).

### 4.9 Errors

Every route can answer the errors in 4.5; each route's own errors are in 4.A.9 and 4.C.9.

### 4.10 Rules worth knowing

- **Who calls whom**: sub-domain 5's intake calls the run engine (4.B) for every event, with a normalized kind (the inbound seam); 4.B saves waiting messages through
  `ChannelSendingPort` (AU35 — Instagram's 6 today) and never sends; 6 reports a sent, failed, skipped or unknown result to
  `recordMessageResult`, and calls back for the reply pacing (`AutomationReplyState`
  service); 3 runs 4.B's erase and pause steps; 2 gives the media and the starter-question sync.
- **Live edits** (plan:L679–L683): a message reads its text from the automation when it is sent (the row keeps none), so
  waiting messages get the new text; a waiting row whose step or message number is gone becomes `cancelled`
  (`cancelled_by_owner`, sub-domain 6, in the save's commit); a missing version uses version 1.
- **No Meta call inside a database context**: routes 32 (starter sync after commit) and 38 (the read in its job).

### 4.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| AUC1 | AU1: `automation-backfill/` folder; `automation-count.*`, `automation-reply-state.*` at the root; `PUBLIC_ID_PREFIXES.automationBackfill` (at kickoff), `PARAM_NAME_TO_ENTITY.automation_backfill_id`; the two contact constraints in this migration; OpenAPI tag `Automation backfill`; overviews |
| AUC2 | AU3, AU4: status values and the action routes; `app-plan-access.ts` preHandler moved to route 32; `plan_lacks_feature` and the untested-feature check over sub-domain 8's plan read and 6's settings file; reasons `transition_not_allowed` (reused), `automation_not_ready`, `plan_lacks_feature`, `feature_not_offered` in `errors:` keys and `response-codes.md` (with `errors[]` on `automation_not_ready`, AUQ1) |
| AUC3 | AU6: WC-43 rewritten as the 15-minute linking sweep (`automation/workers/automation-next-post-linking.*`, scan then per organization); `automation-next-post-expiry` queue, worker, scheduler entry and tests removed; WC-47 purge extended; the starter-sync enqueue |
| AUC4 | AU7: the five new audit actions |

### 4.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/automation/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 4.A Automations | folder root | `app.automations`, `app.automation_counts`, `app.automation_reply_states` | 27–37 | final (rev 5, confirmed 2026-11-24) |
| 4.B Automation runs | `automation-run/` | `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.automation_run_open_keys` | — | final (rev 5, confirmed 2026-11-24) |
| 4.C Automation backfills | `automation-backfill/` | `app.automation_backfills` | 38–39 | final (rev 5, confirmed 2026-11-24) |

---

### 4.A Automations — `automation/` (folder root) — final (rev 5, confirmed 2026-11-24)

#### 4.A.1 Decisions

| # | Decision |
| --- | --- |
| AU8 | **The new shape (plan:L2995–L3145).** Today: the launch's columns — `opening_message`, `is_follow_required`, `follow_request_message`, email / phone switches and messages, one `final_message`, `tags`, `is_dm_keyword_trigger_enabled`, `next_post_starts_at` / `_ends_at`, `completed_run_count`, three trigger types. After: flat start fields — `trigger_type` (15: `comment`, `live_comment`, `story_reply`, `story_mention`, `story_repost`, `dm_keyword` (was `dm`), `first_message`, `shared_post`, `starter_question`, `ref_link`, `default_reply`, `ad_comment`, `ad_message`, `tag_added`, `tag_removed`), `channel`, `also_start_from` (`story_reply`, `dm`, at most 2 — replaces the DM switch, D38), `target_scope` (+ `between`), `target_starts_at` / `target_ends_at`, `next_post_status` (`waiting` · `linked`), `ref_code`, `starter_questions`, `ad_id`, `trigger_tag`, `default_reply_mode`, `keywords` (as built); the public reply per automation — `is_public_reply_enabled` (kept, P21), `public_reply_texts` (kept), `is_public_reply_mention_enabled` (on, D63), `is_reply_like_person_enabled` (D59), `public_reply_hour_limit` (10 · 20 · 30 · 60 · 100, empty = 60), `is_hide_comment_after_direct_message_enabled` (D33); **`steps`** — one object (≤ 64 KB) with `hello`, `follow`, `email`, `phone`, `messages[]` (7 kinds, 1–10, waits 0 or 1–1,380 minutes), `tags` — validated by one zod schema (`automation-steps.dto.ts`), files by upload public id in the same organization that passed the type and content checks (P34, P25); `stopped_reason` / `stopped_at`; `cancelled_before_at`. The 13 launch message columns, the DM switch, `tags`, `completed_run_count` (+ its check and index) and the two next-post dates go. |
| AU9 | **Two levels of database checks (plan:L3096–L3120).** Every save (drafts too): lists, lengths, counts, ranges, `steps` is an object under 64 KB. Go-live rules written `status = 'draft' OR (…)`, so a `live` or `paused` row must pass them: `chk_automations_live_trigger_fields`, `_live_target`, `_live_also_start_from`, `_live_next_post`, `_live_between`, `_live_public_reply`, `_live_hide`, `_live_messages`, `_live_hello_next_button` (replaces `chk_automations_comment_opening_button`; P2 — a hello always has a "sends your next step" button, since the message list always has one). The API checks the rest (the full `steps` shape, PRO, starter-question totals, `nudge` only where she messaged first, `trigger_tag` not in `steps.tags`, one live catch-all, the comment-without-hello rule, the month limit, warnings). |
| AU10 | **The list (route 27).** Today: every automation of the organization, `instagram_account_id` optional, sorts `created_at` · `name` · `last_triggered_at` · `completed_run_count`. After: `channel_account_id` **required** (CT2's reason); filters `status` (several), `trigger_type` (several), `q` (name); sorts `created_at` · `name` · `last_triggered_at` (the run-count sort goes — the plan shows counts, it does not sort by them, plan:L3042); each row with its all-time `runs_started` and `tapped_percent` ((taps + typed answers) / runs, D61 — the sum of its 16 count slots, at most 400 small rows for a page of 25); a draft shows `updated_at` ("edited 1h ago"). `meta.totals` = `{ live_count, runs_started }` for the account (the top bar, plan:L2527). The launch's follow-up — an index for `last_triggered_at` descending — lands here. |
| AU11 | **Create a draft (route 28, D28).** Today: a complete automation, every rule checked, the account implied (the one connected). After: `name*` (1–255), `channel_account_id*` (an account of the organization that is not revoked — an `error` one is fine for a draft), `trigger_type*` (AUQ3); everything else optional and checked for shape only (AU9's every-save level); `status` `draft`; `is_reply_like_person_enabled` defaults to `true` when the plan's `reply_like_person` switch is on (D59, P83); a `ref_link` draft gets a free `ref_code` when none is given. Nothing is sent, nothing else is checked. A read-only plan may create (P10). |
| AU12 | **Save content (route 30, RC-29).** A draft saves anything that passes AU9's every-save level. A `live` or `paused` one must also pass the go-live **content** checks (AU13's 1, 5–17 — AUQ2) on the merged result; problems → `400` with one `errors[]` item per problem, its `field` the step path (`body.steps.hello.versions.0.buttons`) so the editor jumps there; turning a PRO part on without PRO → `403 plan_lacks_feature`. `trigger_type` may change only inside its group (plan §4.1) → else `400 trigger_type`. Side effects in the same commit (sub-domain 6): waiting rows of a removed step or message cancelled (`cancelled_by_owner`); a fixed text clears `stopped_reason` and puts its bad-text failures under 7 days back to `waiting`; a reply-step change empties the reply state's box (it starts again). New runs use the new steps. Optional `expected_updated_at`. |
| AU13 | **Go live (route 32, D28, P2, P36).** From `draft` or `paused`. The checks, all run, answered together as `409 automation_not_ready` with `errors[]` (AUQ1), each `{ field, reason, detail }`: 1 name · 2 the account `connected` and its connection not `error` / `revoked` · 3 plan not ended, organization not suspended (`403 organization_read_only` instead of a list item — AU4) · 4 the month limit not reached (sub-domain 6's month count) · 5 every part it uses — the way to start, each step and message kind, each PRO and Meta-tested part — through 1B's one feature check (CA11, AU34: `channel_lacks_feature`, `permission_not_granted`, `plan_lacks_feature`, `feature_not_offered`, one item each) · 6 the way to start complete · 7 keywords where needed · 8 starter questions 1–4 and the account's live total ≤ 4, counted under `FOR UPDATE` on the account row · 9 `ref_code` valid and free on the account · 10 one live `first_message` and one live `default_reply` per account · 11 the hello (text ≤ 640, 1–3 buttons, `https://` links, a next-step button — P2) · 12 the comment-without-hello rule · 13 follow · 14 email / phone wordings · 15 messages complete, files checked · 16 public reply lines (≥ 3 with "Reply like a person") · 17 tags. Warnings, never refusals, in `meta.warnings`: a keyword another live automation of the account uses; a private account on a comment kind. All good → `live`; a `next` automation gets `target_starts_at` = now and `next_post_status` `waiting`; from `paused`, its waiting DMs under 7 days go on; its lanes wake (6); a starter-question one enqueues the sync (IA6). |
| AU14 | **Pause (route 33).** `mode*` = `keep` (waiting DMs stay, people in the middle finish) or `cancel` (`cancelled_before_at` = now: its waiting messages count as cancelled from now and the helper marks them, 500 a round — WC-19, sub-domain 6; the lanes already skip them). A starter-question one enqueues the sync. `paused` with `keep` then `cancel` sets `cancelled_before_at`; the same mode again is a no-op (AU3). No undo route — the client replays (P15). |
| AU15 | **Duplicate (route 34).** A `draft` named "<name> (copy)" (cut to 255) on the same account; `steps` and settings copied (files by the same upload ids); counters, reply state, backfills, `stopped_*`, `next_post_*` and `cancelled_before_at` not copied; a `ref_link` one gets a new free `ref_code` (the old one plus `-` and 4 random characters, ≤ 64). Allowed from any status. |
| AU16 | **Delete (route 31, P11).** Today: `reason` and `note` required in the query (`recordDeleteQuerySchema`). After: `reason` optional (`mistake` · `duplicate` · `not_needed` · `other`; `other` needs `note`) — an `isReasonOptional` option on the shared `recordDeleteQuerySchemaOf` factory (`record-fields.util.ts`, reuse rule), not a second schema; stops at once in one commit: open runs `cancelled` (`automation_deleted`, 4.B), waiting messages `cancelled` (`automation_deleted`, 6); contacts it collected stay; a starter-question one enqueues the sync after commit; purged later (WC-47). |
| AU17 | **Read one and try it (routes 29, 35).** Route 29: the full Automation (4.A.6) with its counters per version, its stop, its `link_url` for a `ref_link` (`https://ig.me/m/<username>?ref=<ref_code>`), its open past-comments read. Route 35 (D39, plan:L845, L5008–L5027): `text*` (1–1,000) and an optional `source` (`comment` · `dm` · `story_reply`, default from its way to start) run through the **same** matching function intake uses (4.B, `automation-run-matching.util.ts` — contains, plus one wrong letter in words of 5+ letters, several-word keywords together and in order) over this automation and the account's live ones; answers whether it matches, the word and `exact` / `close`, and which automation would answer first by the match order. Saves and sends nothing; the organization rate limit. |
| AU18 | **Its failed messages (routes 36–37, D72).** As the contact's (CT15), for this automation: `failed` messages of about the last 30 days, never `unknown`, `skipped`, `expired`, `cancelled` or broadcast; route 37 enqueues WC-42 (sub-domain 6) — not while its text is still refused (those count as `text_refused`). |
| AU19 | **Counters (D36, D61) and the reply pacing (D32).** `app.automation_counts`: 16 slot rows per automation (slot = the run's id mod 16, `AUTOMATION_COUNT_SLOTS`), `runs_started`, `taps`, `typed_answers` and the same per step version (`{"hello.1": 650}`), each `+1` with `INSERT … ON CONFLICT DO UPDATE` in the event's own commit, last in the lock order (4.B writes through this root's count service); they survive the 90-day run delete; `last_triggered_at` moves only when over 60 s old (`LAST_TRIGGERED_UPDATE_SECONDS`) and never moves `updated_at` (launch D30 kept). `app.automation_reply_states`: one per automation — `box_start`, `last_text_number`, `waiting_count` — written by sub-domain 6's reply lane and result save through this root's reply-state service. |
| AU20 | **"My next post" never expires (P12).** Today: a 24-hour start grace and an end date; WC-6 expires an ended window; sub-domain 4 links on each comment; `409 next_post_window_overlap` keeps keyword clashes apart. After: no window — `target_starts_at` is the go-live time; WC-43 links the first post published after it (AU6); `next_post_status` loses `expired`; the overlap `409` is retired (the shared-keyword warning covers it); `409 next_post_already_linked` stays (a save that changes a linked one's target). |

#### 4.A.2 Open questions

AUQ1 (the go-live status), AUQ2 (save checks), AUQ3 (way to start at create) — answered as recommended (P68–P70).

#### 4.A.3 Tables and relations

`app.automations` — changes only (launch § 3.A.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `status` | `varchar(10)` | no | `'draft'` | **changed**: `draft` · `live` · `paused` |
| `trigger_type` | `varchar(20)` | no | | **changed**: the 15 kinds (AU8) |
| `channel` | `varchar(10)` | no | `'instagram'` | `instagram` |
| `also_start_from` | `text[]` | no | `'{}'` | ⊆ {`story_reply`, `dm`}, ≤ 2 |
| `target_scope` | `varchar(10)` | no | `'any'` | **changed**: + `between` |
| `target_starts_at`, `target_ends_at` | `timestamptz` | yes | | `between`: both, end after start; `next`: start only |
| `next_post_status` | `varchar(10)` | yes | | **changed**: `waiting` · `linked` |
| `ref_code` | `varchar(64)` | yes | | `^[A-Za-z0-9_=-]{1,64}$` |
| `starter_questions` | `text[]` | no | `'{}'` | ≤ 4, each 1–80 |
| `ad_id` | `varchar(64)` | yes | | digits |
| `trigger_tag` | `varchar(50)` | yes | | 1–50 |
| `default_reply_mode` | `varchar(12)` | yes | | `once_a_day` · `every_time` |
| `is_public_reply_mention_enabled` | `boolean` | no | `true` | D63 |
| `is_reply_like_person_enabled` | `boolean` | no | `false` | the API sets `true` on paid plans (D59) |
| `public_reply_hour_limit` | `smallint` | yes | | `IN (10, 20, 30, 60, 100)` |
| `is_hide_comment_after_direct_message_enabled` | `boolean` | no | `false` | D33 |
| `steps` | `jsonb` | no | `'{}'` | an object, `octet_length(steps::text) <= 65536` |
| `stopped_reason` | `varchar(20)` | yes | | `bad_text` · `post_deleted` |
| `stopped_at` | `timestamptz` | yes | | `(stopped_reason IS NULL) = (stopped_at IS NULL)` |
| `cancelled_before_at` | `timestamptz` | yes | | Pause + Cancel |
| `delete_reason` | `varchar(20)` | yes | | **changed**: optional once deleted; `other` needs `delete_note` |
| ~~13 message columns~~, ~~`is_dm_keyword_trigger_enabled`~~, ~~`tags`~~, ~~`completed_run_count`~~, ~~`next_post_starts_at`~~, ~~`next_post_ends_at`~~ | | | | **removed** (AU8) |

Indexes: **removed** `idx_automations_organization_id_completed_run_count_id`, `idx_automations_next_post_expiry`;
**changed** `idx_automations_next_post_waiting` (no end date — the linking sweep's `(organization_id, channel_account_id)
WHERE next_post_status = 'waiting' AND status = 'live' AND deleted_at IS NULL`); the three sort indexes re-led
`(organization_id, channel_account_id, <sort>, id) WHERE deleted_at IS NULL`, `last_triggered_at` both directions
(launch follow-up 2); **added** unique `idx_automations_account_ref_code` `(organization_id, channel_account_id, ref_code)
WHERE ref_code IS NOT NULL AND deleted_at IS NULL` (drafts included — D43); `idx_automations_live_triggers` kept (intake;
sub-domain 5 may copy it in Redis under P5). Checks: AU9's two levels, each `chk_automations_<rule>`.

`app.automation_counts` (no public id)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `organization_id`, `automation_id` | `bigint` | no | | composite → automations `ON DELETE CASCADE` |
| `slot` | `smallint` | no | | 0–15 |
| `runs_started`, `taps`, `typed_answers` | `bigint` | no | `0` | `>= 0` |
| `runs_by_version`, `taps_by_version`, `typed_by_version` | `jsonb` | no | `'{}'` | flat objects |
| `updated_at` | `timestamptz` | no | `now()` | |

Primary key `(organization_id, automation_id, slot)`. RLS: organization policy, enabled and forced.

`app.automation_reply_states` (no public id)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `organization_id`, `automation_id` | `bigint` | no | | primary key; composite → automations `ON DELETE CASCADE` |
| `channel_account_id` | `bigint` | no | | composite → accounts `RESTRICT` (a copy: the reply pick reads the account's rows) |
| `box_start` | `timestamptz` | yes | | |
| `last_text_number` | `smallint` | yes | | the plan's `last_text_no` (P6) |
| `waiting_count` | `integer` | no | `0` | `>= 0` |
| `updated_at` | `timestamptz` | no | `now()` | |

Index `(organization_id, channel_account_id)`. RLS: organization policy, enabled and forced.

#### 4.A.4 Permissions

| Code | Routes |
| --- | --- |
| `automation:read` | 27, 29, 35, 36 |
| `automation:create` | 28, 34 |
| `automation:update` | 30, 32, 33, 37 |
| `automation:delete` | 31 |

#### 4.A.5 Common to every route

As 4.5.

#### 4.A.6 Objects returned

**Automation** (routes 28–30, 32–34): `id` (`aut_…`), `channel_account_id` (`cha_…`), `name`, `status`, `channel`,
`trigger_type`, `also_start_from`, `target_scope`, `target_instagram_media_id`, `target_instagram_story_id`,
`target_starts_at`, `target_ends_at`, `next_post_status`, `next_post_linked_at`, `keywords`, `ref_code`, `link_url`
(`ref_link` only), `starter_questions`, `ad_id`, `trigger_tag`, `default_reply_mode`, `is_public_reply_enabled`,
`public_reply_texts`, `is_public_reply_mention_enabled`, `is_reply_like_person_enabled`, `public_reply_hour_limit`,
`is_hide_comment_after_direct_message_enabled`, `steps`, `stopped_reason`, `stopped_at`, `cancelled_before_at`,
`counts` (`{ runs_started, taps, typed_answers, tapped_percent, by_version: { "hello.1": { runs_started, taps,
typed_answers } } }`), `pro_parts_off` (the PRO parts the plan ignores now — the editor's "PRO, off on your plan"),
`open_backfill` (Automation backfill or null), `last_triggered_at`, `created_by_user_id`, `updated_by_user_id`,
`created_at`, `updated_at`. The launch's message fields, `tags` and `completed_run_count` leave.

**Automation list row** (route 27): `id`, `channel_account_id`, `name`, `status`, `trigger_type`, `stopped_reason`,
`runs_started`, `tapped_percent`, `last_triggered_at`, `updated_at`, `created_at`; list `meta.totals`.

**Keyword test result** (route 35): `is_match`, `matched_keyword`, `match_kind` (`exact` · `close` · null),
`first_answering_automation` (`{ id, name }` or null), `reason` (when no match: `no_keyword`, `not_live`, `other_answers_first`).

#### 4.A.7 Routes (27–37)

As 4.7, rows 27–37.

#### 4.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 27 | `channel_account_id*`, `status` (comma-separated), `trigger_type` (comma-separated), `q` (1–200), `sort` = `created_at` (default) \| `name` \| `last_triggered_at`, `order`, `limit`, `after` | — | Automation list row[] |
| 28 | — | `name*`, `channel_account_id*`, `trigger_type*`; optional: every other writable field of the Automation and `steps` | Automation |
| 29 | — | — | Automation |
| 30 | — | any writable field (never `status`, `channel_account_id`); optional `expected_updated_at` | Automation (+ `meta.warnings`) |
| 31 | optional `reason` (`mistake` \| `duplicate` \| `not_needed` \| `other`), `note` (up to `RECORD_DELETE_NOTE_MAX_LENGTH`, required for `other`) | — | 204 |
| 32 | — | — (strict empty) | Automation (+ `meta.warnings`) |
| 33 | — | `mode*` (`keep` \| `cancel`) | Automation |
| 34 | — | — (strict empty) | Automation |
| 35 | — | `text*` (1–1,000); optional `source` (`comment` \| `dm` \| `story_reply`) | Keyword test result |
| 36 | — | — | Failed messages summary |
| 37 | — | — (strict empty) | Failed messages retry |

#### 4.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 27 | `400` · `channel_account_id` | missing or not well formed; unknown → an empty page |
| 28 | `400` · `channel_account_id` | not an account of the organization |
| 28 | `409` · `instagram_not_connected` | the account is `revoked` (as built, launch AU27) |
| 28, 30 | `400` · a field's name / a `steps` path | shape, lengths, lists; on 30 for a live or paused one the content checks (AU12) |
| 30 | `400` · `trigger_type` | a change to another group |
| 28, 30 | `409` · `automation_ref_code_exists` | another automation of the account holds the `ref_code` |
| 30 | `403` · `plan_lacks_feature` | a PRO part turned on without PRO |
| 30 | `409` · `record_changed` / `next_post_already_linked` | stale save / a linked next-post's target changed |
| 31 | `400` · `note` | `other` without a note |
| 32 | `409` · `automation_not_ready` (with `errors[]`) | any go-live check fails (AU13) |
| 32 | `403` · `organization_read_only` | the plan ended or the organization is suspended |
| 33 | `409` · `transition_not_allowed` | pausing a draft |
| 29–37 | `404` · `automation_not_found` | not in the organization, another organization's, or deleted |
| writes | `422` | a personal organization; the key missing, malformed or reused (28, 34, 37) |
| reads | `404` · `team_organization_required` | a personal organization |
| all | `403` · `missing_permission` | the gate (a Viewer on any write) |

#### 4.A.10 Rules worth knowing

- The go-live starter-question count locks the account row `FOR UPDATE` — the lock order is contact → automation → runs
  (launch D46) with the account first for this one route.

#### 4.A.11 Code changes

| # | Change |
| --- | --- |
| AUC5 | AU8, AU9: `automation.schema.ts` and its migration changed in place (4.A.3's columns, checks at both levels, indexes); `automation-steps.dto.ts` (one zod schema for `steps`, each kind's fields — plan:L3060–L3092); constants (15 kinds, scopes, statuses, limits with full names — P6) |
| AUC6 | AU10–AU18: routes 27–37 (`idempotencyRequired` on 28, 34, 37), controller, service, validator (the go-live list, content-only on save), serializers; the shared delete-query schema with an optional reason (P11) and its unit test; `automation_ref_code_exists` and the other reasons; integration tests — each success and each error of 4.A.9, every go-live check alone, a warning that does not refuse, pause keep and cancel, a duplicate's new `ref_code`, a live edit cancelling a removed step's waiting rows (with 6) |
| AUC7 | AU19: `automation-count.*` and `automation-reply-state.*` (schemas, repositories with `createWorker…Repository`, services); the list's slot sums; tests — 16 slots sum, a run delete keeps the counts |
| AUC8 | AU20: the next-post columns, `expired` removed; seeds — demo automations across the 15 kinds, drafts, a paused one, counts |

**As built (ROUTE row R13, [P124](decisions.md)–[P129](decisions.md)):** `app.automation_counts` and
`app.automation_reply_states` carry an `id` primary key with the keys above as unique indexes; the go-live CHECKs ask
each way to start for its own field (one-way) and "Reply like a person" for 3 lines only while the public reply is on;
`steps` is checked for types at every save and for counts, lengths, bytes, waits and files at go-live; the month check
reads sub-domain 6's month count (the port's `readMonthUsage` lands with R19–R20); the feature part is
`ChannelAccountService.listChannelAccountAutomationProblems` (`errors[].field` `trigger_type`, `steps.<part>`,
`steps.messages`, `features.<feature>`); `409 automation_not_ready` carries `errors[]` items with `field`, `reason`,
`message`; a `next` automation waits from its first go-live (`target_starts_at`); the run engine keeps a launch step view
until R14; the next-post expiry worker left with its columns (WC-44).

---

### 4.B Automation runs — `automation/automation-run/` — final (rev 5, confirmed 2026-11-24)

#### 4.B.1 Decisions

| # | Decision |
| --- | --- |
| AU21 | **Run columns (plan:L3147–L3173).** Added `trigger_occurred_at` (the 7-day clock — a comment's `entry.time`, its own `timestamp` when the webhook came over 1 h late), `once_key` (the plan's `post_key`, ≤ 255, D13), `direct_message_sent_at` (first DM `sent` or `unknown`), `last_message_number` (1–10), `version_numbers` (`{"hello": 2}`); removed `trigger_text` (her free text is never kept — D46; the erase step loses that part), `sending_message_kind`, `sending_started_at` (+ `chk_automation_runs_sending` — the claim moves to the message row, sub-domain 6). `trigger_type` = how this run started (the 15 kinds; may differ through "also start from"); `current_step` `final_dm` → `messages`; `waiting_for` + `any`; `cancel_reason` + `expired` · `opted_out` · `window_closed` · `contact_excluded` · `replaced`. Kept 90 days after it ends (was 180, D16). |
| AU22 | **The once rule (D13, D65).** Each way to start has its once key (plan:L478–L498: the media id, `live:…`, `story:…`, `dm:<date>`, `first`, `share:…`, `starter:<date>`, `ref:<date>`, `default:<date>` or `default:<message id>`, `ad:<ad id>`, `tag:<tag>:<event id>`; `<date>` the organization's day). A start whose `(automation, contact, once_key)` already had a DM is logged `ignored` · `once_per_post` (comment log) or its message `skipped` · `once_per_post`. The account switch "once per person per post" off makes the key the event's own id (D65). It frees itself when the old run's month part is dropped (about 90–120 days, AU36). Today: once per person per automation, ever (`previous_run_final`). |
| AU23 | **One open run per automation and person; an allowed comment replaces it (P35, P100).** Since rev 5 the rule is the key table `app.automation_run_open_keys` (AU37, [P100](decisions.md) — runs are split by month, AU36, and a unique index on a split table holds only inside one part): the new run and its key in one commit, the key deleted in the commit that ends the run. A comment (or an ad or Live comment) that may start a new run — another post, or "every time" — cancels her open run of that automation (`cancelled` · `replaced`; its waiting messages `cancelled` · `replaced` through 6; its comment log `cancelled`) and starts the new run **in the same commit**. A second comment on the same post with "once" on → `ignored` · `once_per_post`. Every other way to start while her run is open → `ignored` · `run_in_progress`. The replacement deletes the old run's key and inserts the new one in the same commit (AU37). |
| AU24 | **The engine decides; it never sends (WC-9 removed, D3).** Today: the run engine sends inline from the event job (claim on the run, 200–1,000 ms pauses, reply safety counted from comment logs). After: each step saves a waiting message (`not_before` for a list wait) through `ChannelSendingPort` (AU35) — the channel's sending sub-domain (Instagram's 6) picks its lane and sends it; it reports the result (`sent`, `failed`, `skipped`, `unknown`) to `recordMessageResult`, a tap comes back through the inbound seam, and the engine moves the run on in that commit. Step order (plan §5.2): hello → (comments: public reply → hide) → wait for a tap or any text (one nudge after 60 min, D30) → follow → email → phone → messages 1–N (a window check before each; closed → that message `skipped` `window_closed`, no rows for the rest, the run `cancelled` `window_closed`, D29) → tags (with tag events, 3.B) → `completed`. The run, the contact's "via" columns (3) and the counts (4.A) move in the same commits. |
| AU25 | **A result we cannot know (D17).** Today: an unknown outcome fails the step (launch AQ5). After: an `unknown` message is never sent again by itself; its run waits for `any`; only her next message or tap may send that step once more (the same row back to `waiting`, sub-domain 6); a tap proves only the message that carries that button. |
| AU26 | **PRO at run time (D57).** Each step reads the plan's PRO features (sub-domain 8, read once per job): email and phone steps are skipped (a run waiting for her email or phone moves on), "Reply like a person" works as off, only the first reply line, only version A of the hello and the follow ask; v2+ versions are picked only on PRO. Nothing is deleted; a move up works again by itself. |
| AU27 | **Taps, typed answers and versions (D36, D61).** At a run's start a version per step is picked at random (PRO only beyond 1) into `version_numbers`; the start commit adds `runs_started` and `runs_by_version`; a hello or follow tap writes a `hello_tapped` / `follow_tapped` run event and `taps` (+ by version); her first text while the run waits for `opening_message_button` adds `typed_answers` (+ by version). Email and phone answers: the plus-address rule goes (P19); a wrong one is asked again up to 3 times with another wording, then the run stops asking and keeps waiting (plan:L2378–L2388). |
| AU28 | **Comment logs (plan:L3184–L3205).** Added `comment_occurred_at`, `hide_status` (a step status, `off` by default), `hidden_at`; `final_dm_status` / `_at` → `messages_status` / `_at`; step statuses + `expired` · `unknown`; `current_step` / `failed_step` `final_dm` → `messages` + `hide_comment`; `waiting_for` + `any`; `ignored_reason` `previous_run_final` → `once_per_post`, + `thread_reply_off` · `own_comment` · `contact_excluded` (`run_in_progress`, `comment_already_answered`, `waiting_for_other_email`, `already_waiting` kept — P23); `public_reply_skip_reason` `duplicate` · `random` · `hour_limit` · `deleted_comment` (`gap` goes); Live and ad comments get logs (a Live's reply and hide stay `off`). The duplicate-reply rule reads the last two months under the contact lock; the unique `(automation, comment)` index becomes plain. Kept 90 days. |
| AU29 | **Steps it registers for contacts (3.10).** Erase: as built (open runs `cancelled` · `contact_deleted`, comment-log copies cleared — `trigger_text` no longer exists). Pause: open runs `cancelled` with the given reason (`contact_excluded` or `opted_out`), in the caller's commit. Its run-event reader serves the contact's "What happened" (CT14). |
| AU30 | **Its workers** (as built, changed): waiting-run cancel (**WC-45, CHANGED** — P99: hourly, `wait_expired` after 7 days; its run's open key deleted in the same commit, P100) — its scan under the maintenance scope, then per organization in its job scope; run retention (WC-51) and comment-log retention (WC-52) **drop month parts** instead of deleting in batches (rev 5: P96, P92 — AU36; the shared upkeep, WC-55), with the "oldest row past its keep time" gauge per table (P92). |
| AU36 | **Split by month while empty (P96, rev 5; supersedes P33's plain runs, run events and comment logs).** Today: three plain tables with 90-day batch deletes — at target about 180 M runs, 540 M run events and 180 M comment logs, deleted at most 250,000 rows a day (scale review S3, S4). After: (1) `app.automation_runs` `PARTITION BY RANGE (started_at)`, one part per calendar month (UTC); primary key `(id, started_at)`, unique `(public_id, started_at)` and the parent key `(organization_id, id, started_at)`. (2) `app.automation_run_events` gains `automation_run_started_at` (a copy of its run's start — the plan's column) and is split by its month; its foreign key `(organization_id, automation_run_id, automation_run_started_at)` → runs `ON DELETE CASCADE`. (3) `app.automation_comment_logs` split by month of `created_at`; its run pointer becomes `automation_run_id` + `automation_run_started_at` copies with no foreign key (its parts drop on their own clock, like the messages' copies). (4) Every index is local to its part; `idx_automation_runs_one_open` stays as a local index of each part (a look-up of her open run, no longer the rule — the rule is the key table, AU37, P100); `idx_automation_runs_once` is read across the kept parts. (5) Keep: a runs part and its run-event part are dropped once their month ended more than 98 days ago — 90 days after the last run in it can have ended (WC-45 ends every wait within 7 days, plus a day); a comment-log part 90 days after its month; a part that still holds an open run is kept and the team alerted. The messages' parts (about 30 days, SN17) always go first, so their foreign key into runs never blocks a drop. (6) The shared upkeep (WHC13, WC-55) gets three specs — same function, same maintenance scope as the other split tables; no batch delete remains on these tables. Other option: P33's plain tables with batch deletes — refused by P96 (S3, S4). |
| AU37 | **The open-run key table ([P100](decisions.md), rev 5 — reverses P71 / AUQ4).** Today (rev 4): the partial unique index `idx_automation_runs_one_open` was the whole rule; with runs split by month (AU36) a unique index holds only inside one part. After: `app.automation_run_open_keys` — one row per open run, primary key `(organization_id, automation_id, contact_id)`, pointing at the run by `automation_run_id` + `automation_run_started_at` (its start month). The new run and its key are written in **one commit** — the key's insert is the guard: a second start meets the conflict and is `ignored` · `run_in_progress`, or replaces per P35. The key is **deleted in the commit that ends the run** (`completed`, `failed`, `cancelled` — `replaced`, `wait_expired` by WC-45, `contact_deleted`, `opted_out`, …); P35's replacement deletes the old key and inserts the new one in the same commit. A repair duty (`repair-open-run-keys` (WC-67), its own repeat job on sub-domain 6's repair queue with a 40 s budget — P94) removes keys whose run has ended, so a missed delete never blocks her for good. RLS enabled and forced like every tenant table. Other option: the check under the contact lock alone (rev 5's first draft) — no database guarantee. |

**As built at ROUTE row R14** ([AS-BUILT](../AS-BUILT.md), [P130](decisions.md)–[P135](decisions.md)): one unit of work
per event (no channel call inside it — `failRunsOfFailedEvent` answers none); `ChannelMessageResultInput` carries the
sending job's `scope`; a follow check is a waiting message of step `follow_check` whose `sent` result carries `reason`
`following` / `not_following`; an `unknown` step sent once more is a new save of the same step; `queued_automations` and
`trigger_text` are dropped (another automation's email wait logs `waiting_for_other_email`), `version_numbers` also holds
`email_asks`, `phone_asks` and `tag_chain`; the public reply's `duplicate` and 80 % draw are the engine's, the box, gap, 500
cap and line are 6's reply lane; WC-51 / WC-52 retired now (the part drops are R49's), WC-67's work built (its schedule
R47); runs' `started_at` is whole milliseconds (`chk_automation_runs_started_at_milliseconds`) so every copy of the run key
matches; the month parts come from `app.fn_create_monthly_partitions`.

#### 4.B.2 Open questions

AUQ4 (4.2) — answered P71 (dropped), **superseded by P100**: the key table `app.automation_run_open_keys` (AU37).

#### 4.B.3 Tables and relations

`app.automation_runs` — changes only (launch § 3.B.3 is the rest)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `trigger_occurred_at` | `timestamptz` | no | | the 7-day clock |
| `once_key` | `varchar(255)` | no | | D13 |
| `direct_message_sent_at` | `timestamptz` | yes | | |
| `last_message_number` | `smallint` | yes | | 1–10 |
| `version_numbers` | `jsonb` | no | `'{}'` | an object |
| `started_at` | `timestamptz` | no | `now()` | **the partition key since rev 5** (AU36): one part per month; primary key `(id, started_at)`, parent key `(organization_id, id, started_at)` |
| `trigger_type`, `current_step`, `waiting_for`, `cancel_reason` | | | | **changed** value lists (AU21) |
| ~~`trigger_text`~~ · ~~`sending_message_kind`~~ · ~~`sending_started_at`~~ | | | | **removed** |

Indexes: kept `idx_automation_runs_one_open` (a look-up since rev 5 — the rule is AU37), `_automation_contact`, `_contact`, `_contact_waiting`,
`_waiting_since`; **added** `idx_automation_runs_once` `(organization_id, automation_id, contact_id, once_key) WHERE
direct_message_sent_at IS NOT NULL` (AU22); `idx_automation_runs_ended` **dropped** — the parts are dropped, not batch-deleted (AU36, P96).
Checks: the value lists, `chk_automation_runs_trigger_targets` per kind, `chk_automation_runs_last_message_number`.

`app.automation_run_events` — `event_type` adds `hello_tapped`, `follow_tapped`; **adds `automation_run_started_at`**, the split key and part of its run's foreign key (AU36 — P96 reverses P33's "no copy").

`app.automation_comment_logs` — columns and value lists of AU28; index `idx_automation_comment_logs_automation_comment`
unique → plain; `(contact_id)` kept (the erase); **split by month of `created_at`**, adds `automation_run_started_at` (a copy; the run
pointer has no foreign key — AU36).

`app.automation_run_open_keys` — **NEW** (rev 5, [P100](decisions.md), AU37), plain

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `organization_id` | `bigint` | no | | → organizations `ON DELETE CASCADE` |
| `automation_id` | `bigint` | no | | composite (`organization_id`, `automation_id`) → `app.automations` `ON DELETE CASCADE` |
| `contact_id` | `bigint` | no | | composite (`organization_id`, `contact_id`) → `app.contacts` `ON DELETE RESTRICT` (contacts are erased in place) |
| `automation_run_id`, `automation_run_started_at` | `bigint`, `timestamptz` | no | | composite → `app.automation_runs` (`organization_id`, `id`, `started_at`) `ON DELETE CASCADE` — the open run and its month |
| `created_at` | `timestamptz` | no | `now()` | |

Primary key `(organization_id, automation_id, contact_id)` — one open run per automation and person; index `(organization_id,
automation_run_id, automation_run_started_at)` — the foreign key and the end-of-run delete. No public id, no `updated_at`. RLS:
enabled and forced, the organization policy `USING` + `WITH CHECK`, the maintenance arm in `USING` for the repair duty's
cross-organization read; in `EXPECTED_FORCE_RLS_TABLES`. Branch rule: none. User pointers: none.

RLS unchanged: enabled and forced, the organization policy with the maintenance arm for the sweeps.

#### 4.B.4 Permissions

None — no routes.

#### 4.B.5 Common to every route

No routes.

#### 4.B.6 Objects returned

None of its own; its run events appear in the contact's "What happened" (3.A.6).

#### 4.B.7 Routes

None.

#### 4.B.8 Request details

None.

#### 4.B.9 Errors

None of its own.

#### 4.B.10 Rules worth knowing

**Entry points** — the **inbound seam** (rev 3, WH27): every channel's intake calls them with channel-neutral inputs (`organizationId`, `channelAccountId`, the contact, a **normalized event kind** — `comment`, `live_comment`, `message`, `postback`, `starter_question`, `story_reply`, `story_mention`, `shared_post`, `referral`, `reaction`, `owner_message` — its time and payload ids), and `recordMessageResult` is the outbound seam's way back (AU35). They are (called by sub-domain 5's intake and 6's result save, each safe to run twice, outside any database
context, with the organization scope and the account): `startCommentRun` (comments, ad and Live comments, past comments),
`handleDirectMessage` (DMs, story replies, mentions, shared posts, the match order of plan §4.3), `handleButtonClick`
(taps, starter questions, ig.me links, ad "Send message"), `startTagRun` (tag events), `recordMessageResult` (6 — sent,
failed, skipped, unknown; AU35), plus the erase and pause steps (AU29). Every unit locks the contact first (`lockLiveContact`).

#### 4.B.11 Code changes

| # | Change |
| --- | --- |
| AUC9 | AU21, AU28: the run, run-event and comment-log schemas and their migration changed in place (columns, value lists, indexes as 4.B.3) |
| AUC10 | AU22–AU27: the engine rewritten around message rows (no sends; the claim and the pause go to 6), the once key per kind, the replace rule in one commit, `any` waits for unknowns, PRO read per job, versions and counts; the matching util with close spellings (D60) shared with route 35; tests — the once key of each kind, a new comment on another post replacing her open run, a same-post comment ignored, a DM while open `run_in_progress`, an unknown not resent, a move down skipping email and phone |
| AUC11 | AU29, AU30: the pause step; WC-45 (CHANGED) deleting the run's open key (P100); the run and comment-log retention workers (WC-51, WC-52) retired as batch jobs — their 90-day keep becomes the upkeep's part specs (AU36) |
| AUC14 | AU36 (P96, rev 5): the three tables created partitioned in their launch migrations changed in place (D1, P29 — no data yet); the Drizzle parent declarations, keys and local indexes of AU36; `automation_run_started_at` on run events and comment logs; the three upkeep specs added to sub-domain 5's function (WHC13); `EXPECTED_FORCE_RLS_TABLES` lists the parents; `docs/reference/data/data-lifecycle-deletion.md` rows; DB tests — a run event lands in its run's part, two starts for one contact racing across a month line leave one open run, a part with an open run is not dropped, the messages' parts drop first |
| AUC15 | AU37 ([P100](decisions.md)): `automation-run-open-key.schema.ts` and `.repository.ts` in `automation-run/` (a persistence part, no routes) in the runs migration; the key's insert in every start's commit and its delete in every end's commit (the engine, WC-45, the erase and pause steps, P35's replacement); the `repair-open-run-keys` (WC-67) duty on sub-domain 6's repair queue; `EXPECTED_FORCE_RLS_TABLES`; DB tests — two starts racing for one person leave one key and one open run, a replacement swaps the key in one commit, an ended run's leftover key is removed by the duty, an RLS test as `meepzo_be_app` |

---

### 4.C Automation backfills — `automation/automation-backfill/` — final (rev 5, confirmed 2026-11-24)

#### 4.C.1 Decisions

| # | Decision |
| --- | --- |
| AU31 | **Start (route 38, D69, plan:L1098–L1131, L2694–L2698).** "Also answer comments from the last N days", N = 1–7 (`PAST_COMMENTS_MAX_DAYS`), on a `live` `comment` or `ad_comment` automation (never `live_comment`). 1B's feature check `past_comments` (CA11) → else `403 plan_lacks_feature`, `422 channel_lacks_feature` or `409 permission_not_granted` (CAQ2); not live → `409 automation_not_live`; another kind → `422 automation_backfill_not_supported`; one `queued` or `reading` per automation (a partial unique index) → `409 automation_backfill_in_progress` ("Past comments are already being read"). Writes a `queued` row (`requested_by_user_id`), enqueues the read after commit, answers it. A new press after a `failed` one makes a new row. |
| AU32 | **The read (WC-41, `instagram-tasks`).** One read at a time per account — the next `queued` starts when none runs. Posts: the automation's target post(s), or for "any post" the newest 50 posts (`PAST_COMMENTS_POSTS_MAX`) with comments in those days; each comment is saved as an "old" comment event and goes through sub-domain 5's normal intake (the 7-day rule per comment, the once rule, its low priority); `posts_read`, `found`, `matched`, `queued_count` move as it reads; 1 read a second, reading the connection's Meta usage before each call (≥ 80 % slows, ≥ 95 % waits — P51, MC19); Meta errors retried (`META_TASK_RETRY_MINUTES`), then `failed` · `meta_error` with codes only; a move down ends an unfinished one `failed` · `plan_feature_off` (sub-domain 6's WC-38) — DMs it queued still go. A watch every 10 minutes restarts a read with no new page for 30 minutes. At the end an in-app notice `automation.backfill_done` (email off by default, D54). |
| AU33 | **Read one (route 39).** By `{automation_backfill_id}` under its own automation only (another automation's → `404`); the automation's open one is also on its object (4.A.6). No list route (route-changes finding 7). |

#### 4.C.2 Open questions

None.

#### 4.C.3 Tables and relations

`app.automation_backfills`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `public_id` | `varchar(28)` | no | | prefix at kickoff (P22) |
| `channel_account_id` | `bigint` | no | | composite → accounts `RESTRICT` (a copy — one read at a time per account) |
| `automation_id` | `bigint` | no | | composite → automations `ON DELETE CASCADE` |
| `days` | `smallint` | no | | 1–7 |
| `status` | `varchar(10)` | no | `'queued'` | `queued` · `reading` · `done` · `failed` |
| `posts_read`, `found`, `matched`, `queued_count` | `integer` | no | `0` | `>= 0` |
| `fail_reason` | `varchar(30)` | yes | | `meta_error` · `plan_feature_off`; set exactly when `failed` |
| `last_error` | `varchar(500)` | yes | | codes only, never Meta's text |
| `requested_by_user_id` | `bigint` | yes | | → users `ON DELETE SET NULL` |
| `started_at`, `done_at` | `timestamptz` | yes | | |

Indexes: unique `idx_automation_backfills_public_id`; unique `idx_automation_backfills_open` `(organization_id,
automation_id) WHERE status IN ('queued', 'reading')`; `idx_automation_backfills_watch` `(status, updated_at) WHERE status
IN ('queued', 'reading')` (the 10-minute watch across organizations); `idx_automation_backfills_account_queued`
`(organization_id, channel_account_id, created_at) WHERE status = 'queued'` (the next read of an account);
`idx_automation_backfills_requested_by_user_id` `WHERE requested_by_user_id IS NOT NULL`; as built (R15, [P311](decisions.md)) also the plain `idx_automation_backfills_automation_created_at` `(organization_id, automation_id, created_at)` and `idx_automation_backfills_organization_id_channel_account_id` — every foreign key needs a non-partial index (index hygiene). Public id prefix `abf_` (P22). Checks: days, status,
`fail_reason` set exactly when `failed`, counters, `_updated`. RLS: enabled and forced, organization policy with the
maintenance arm (the watch). Kept with its automation (a few rows each).

#### 4.C.4 Permissions

| Code | Routes |
| --- | --- |
| `automation:update` | 38 |
| `automation:read` | 39 |

#### 4.C.5 Common to every route

As 4.5.

#### 4.C.6 Objects returned

**Automation backfill**: `id`, `automation_id` (`aut_…`), `days`, `status`, `posts_read`, `found`, `matched`, `queued_count`,
`fail_reason`, `requested_by_user_id` (`usr_…` or null), `created_at`, `started_at`, `done_at`, `updated_at`. Never
`last_error` (support reads it in the logs).

#### 4.C.7 Routes (38–39)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 38 | POST | `/automations/{automation_id}/backfills` | Also answer past comments **(new, RC-54)** | `automation:update` | req |
| 39 | GET | `/automations/{automation_id}/backfills/{automation_backfill_id}` | One read **(new, RC-55)** | `automation:read` | |

#### 4.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 38 | — | `days*` (1–7) | Automation backfill |
| 39 | — | — | Automation backfill |

#### 4.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 38 | `400` · `days` | not 1–7, an unknown field |
| 38 | `403` · `plan_lacks_feature` | the plan has no PRO (1B's feature check, CA11) |
| 38 | `422` · `channel_lacks_feature` / `409` · `permission_not_granted` | the account's channel cannot read past comments / the connection lacks the permission (CA11, CAQ2) |
| 38 | `409` · `automation_not_live` | the automation is a draft or paused |
| 38 | `422` · `automation_backfill_not_supported` | not a `comment` or `ad_comment` automation |
| 38 | `409` · `automation_backfill_in_progress` | one is `queued` or `reading` |
| 39 | `404` · `automation_backfill_not_found` | not this automation's, another organization's |
| 38, 39 | `404` · `automation_not_found` | as 4.5 |
| 38 | `422` | a personal organization; the key missing, malformed or reused |

#### 4.C.10 Rules worth knowing

- The read never sends: it saves events, and intake and the lanes do the rest — the month limit, the 7-day rule and the
  slow lane's order hold as for any comment.

#### 4.C.11 Code changes

| # | Change |
| --- | --- |
| AUC12 | AU31–AU33 (routes, table and the enqueue port built at R15 — [P311](decisions.md); the read job, the watch and the notice at R41): `automation-backfill/` — schema (4.C.3) in the automations migration, repository, service, controller, routes with schemas (`idempotencyRequired` on 38), DTO, serializer; `automation-backfill/workers/automation-backfill-read.*` and the 10-minute watch (`instagram-tasks`, provider-pausable, registry, scheduler, DLQ); the `automation.backfill_done` notification type with copy keys (with sub-domain 11); reasons `automation_not_live`, `automation_backfill_not_supported`, `automation_backfill_in_progress`, `automation_backfill_not_found`; tests — one open per automation, one read per account at a time, a stuck read restarted, a move down → `failed` `plan_feature_off`, a repeat key replays |
| AUC13 | AU34, AU35 (rev 3, P48, P50): the shared names — `automation/` (+ `automation-run/`, `automation-backfill/`), the seven `app.automation…` tables, `idx_automation…`, `chk_automation…`, `automation-steps.dto.ts`, audit `app.automation.*`; `chk_automations_channel`; the go-live list over 1B's `listChannelAccountFeatureProblems` (the separate PRO and untested checks removed); `app.channel-ports.ts` — `ChannelSendingPort`, `SaveWaitingMessageInput`, `ChannelMessageResult`, `ChannelInboundEventKind` — and its per-channel wiring in `app.container.ts`; the engine writes only through the port; tests — a fake second channel's port receives the engine's waiting messages, a result `skipped` / `unknown` moves the run as AU25, a repeat result does nothing, go-live lists each feature-check reason; a policy test that `automation/` imports no `instagram-*` folder |

---

## 5. Instagram webhook — rev 5 (2026-11-24) — nested sub-domains 5.A–5.B; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`instagram-webhook` sub-domain folder** — `app/sub-domains/instagram-webhook/` (the receiver and intake at the
folder root) with `instagram-webhook-event/` (the events, their keys, the list).

5.1 Decisions (whole sub-domain) · 5.2 Open questions · 5.3 Tables and relations · 5.4 Permissions · 5.5 Common to every route ·
5.6 Objects returned · 5.7 Routes · 5.8 Request details · 5.9 Errors · 5.10 Rules worth knowing · 5.11 Code changes (whole sub-domain) ·
5.12 Nested sub-domains · then **5.A Instagram webhook · 5.B Instagram webhook events** — each with the same eleven sections.

**CHANGED** against the launch (`iterations/launch-2026-11-20-ujai/plans/routes-final.md` § 4, as built; AS-BUILT ›
Standing deviations "Store before answering", "Event keys", "Skip reasons", "Queues, workers and order", "Retries"). Meta
still calls two public routes and the team still reads one list; what changes is behind them: Meta's six webhook fields
and their new kinds, a key table for repeats, an 8-day day-split events table whose body is cleared when done, and an
**intake that decides and saves only** — three jobs per account by kind plus the tag-event job, never a send (sending moves
to sub-domain 6). Design read: plan §26 (plan:L4732–L4815), §27 (plan:L4817–L5175), §18.9 (plan:L3207–L3225), §19.5
(plan:L3453–L3461), §24.2 (plan:L4392–L4406), §9.2 (plan:L1856–L1876); D13, D15, D24, D64, D65; P24, P32, P33, P35.
Builds on: channel-account (account state, the automation switch), instagram-account (resolver, posts, settings), channel-connection (the Meta app secret, verify token and the signature check of its adapter), contact (`recordContactInteraction`, the tag events), automation (the run engine — match order, once keys,
P35), and sub-domain 6 for the message rows intake writes and the own-message lookup. Route numbers run 60–62.

### 5.1 Decisions (whole sub-domain)

Taken on the standing answer "go with the recommendation", confirmed with the answers of 2026-11-24 (P54–P90) (P31: reviewed with every sub-domain in one pass). A decision that
belongs to one part is in its nested sub-domain.

**rev 2 changes** (P45–P47, M9): stays Instagram's — `/social/channel-connections/meta/webhooks/instagram`, `app.instagram_webhook_events` + keys, the `instagram-webhook` queue; Meta's deauthorize and data-deletion callbacks are sub-domain 1's (M5); the account pointer `channel_account_id` (→ `app.channel_accounts`), payloads `channelAccountPublicId`; account state and the automation switch read from 1B, the signature check from 1's adapter; the webhook review's F3 and F5 adopted (WH25, WH26).

**rev 3 changes** (P48, P51, M10): stays Instagram's (P45 unchanged), but contacts, the run engine and broadcasts are now shared, so intake reaches them only through the **inbound seam** — it turns Instagram's kinds into normalized event kinds and calls their shared entry points (WH27); the message rows a start makes go through the engine and `ChannelSendingPort` (AU35), while the own-message lookup and a tap's `unknown` → `sent` stay Instagram to Instagram (5 → 6); the missed-comment look reads the connection's Meta usage (P51, MC19). Routes 60–62 unchanged.

**rev 5 changes** (P92, P93, P96, P97, P99, M13): event keys split by Meta's event day (P96 — WH20, WH24, 5.3, 5.B.3, WHC12, WHC13, WHC15) — the key clean-up drops day parts and the batch job is retired (P92); the missed-comment full pass keeps the normal round's limits and every round fans out one job per account (P93 — WH17, WHC10); markers for the kickoff defaults S9, S10, S11, S17, S20, S25 (P97); route 60's RC cell cites RC-115 (P99). Routes 60–62 unchanged.

| # | Decision |
| --- | --- |
| WH1 | **Folders stay; intake grows at the root.** Today (launch WH1): `instagram-webhook/` holds the receiver and the per-account processing (`workers/instagram-webhook.processor.ts`, 856 lines, which also sends through the run engine); `instagram-webhook-event/` owns the events table, the list and the clean-up. → Same two folders. The root keeps the receiver (routes 60–61) and becomes **intake**: `workers/instagram-webhook-intake.processor.ts` (the three kind jobs), `workers/instagram-tag-event-intake.processor.ts` (tag events), the stuck-event pick-up and the missed-comment check. The nested `instagram-webhook-event/` also owns the new **`app.instagram_webhook_event_keys`** — a persistence part with no routes (schema + repository, written through the event service). No new folder: intake has no route of its own (`src/domains/CLAUDE.md`: flatten a folder with no distinct routes). Other option: a nested `instagram-webhook-intake/` folder — it would hold workers only. |
| WH2 | **Store first; Postgres down answers 500 / 503 — no Redis buffer (P32).** Today (launch WH10): events are stored before the answer; a store failure is `500`/`503` and Meta delivers again. The plan (§26.3, plan:L4799–L4807) pushes events to a Redis `webhook-buffer` when Postgres is down or slow. → **Launch behaviour kept** (P32): nothing Postgres does not have lives in Redis. New: the store unit runs with `SET LOCAL statement_timeout` = 3 s (plan `WEBHOOK_SAVE_TIMEOUT_MS`), so a slow Postgres answers `503` inside Meta's 5-second budget instead of timing out. **No webhook pool of its own** (plan §26.4 rule 1; → S10, P97: its own pool slice or service, the UI sheds first): the API and the workers already run in separate processes (AS-BUILT "Queues, workers and order"), so busy workers never hold the receiver's connections. **As built (R17, [P304](decisions.md)):** S10 is the route flag `overloadShedLast` — the overload guard sheds the delivery only at twice each threshold, so the UI sheds first. What Meta does not redeliver (a tap after its "few more times") is caught for comments by the missed-comment check (WH17); taps are lost only when Postgres is down longer than Meta retries — the risk P32 accepted. Other option: a 5-connection pool for the receiver (plan `WEBHOOK_DB_POOL_SIZE`). |
| WH3 | **Which accounts' events are saved.** Today: an unknown or `revoked` account → nothing stored (launch WH4); `expired`/`error` → stored `skipped account_disconnected`; the automation switch off → `skipped automation_disabled`. → Unknown or `revoked`: unchanged (200, a log line, the metric). **An `error` account, a paused, suspended or stopped account, an organization at its month limit or whose plan ended: saved `received` and taken in by intake** — its messages wait in its stopped lanes (plan:L4744–L4746, RC-16), so the owner's comments are answered once she reconnects or the stop ends. `expired` no longer exists (the Meta token never expires — channel-connection's change). The switch off still stores `skipped automation_disabled` (the plan keeps `is_automation_enabled`, plan:L2912 — now on the channel account, P42). `account_disconnected` stays only for intake: an account `revoked` between store and intake. |
| WH4 | **Meta's proofs and settings.** Today: route 61's HMAC key is `INSTAGRAM_APP_SECRET` and route 60's token `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (env-schema.ts:330–360). → the **Meta app secret** and the **Meta webhook verify token** — the env rename (`META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, plan §36.26) is channel-connection's change; this sub-domain only reads them through its existing config accessor. Everything else of the launch's proof stays: the ingress plugin, the shared raw-body registry, nothing parsed before the signature, 5 MB, `INSTAGRAM_WEBHOOK_RATE_LIMIT` 1,200 a minute (→ S9, P97: validly signed requests not counted — **as built (R17, [P304](decisions.md))**: the route opts out of every route limiter and the ingress plugin counts each refused signature against a 1,200-a-minute per-IP limiter), `400 invalid_webhook_signature` / `invalid_webhook_verify_token`, `503 instagram_webhook_not_configured`. |
| WH5 | **Intake layout (D3, plan §24.2).** Today (launch WH5): one queue `instagram-webhook`, one deduplicated job per account working through **all** its events in order, built with `createProviderPausableWorker` (an Instagram outage pauses it). → Same queue, four job names: `intake-messages`, `intake-live`, `intake-comments` (one per account each, deduplicated per kind and account with `keepLastIfActive`, the launch's pattern; → S11, P97: several comment-intake jobs per account, `SKIP LOCKED`) and `intake-tag-events` (one per contact, WH15; → S20, P97: one per 500 contacts); priorities 1 · 1 · 5, and **10** for an account with more than 500 waiting comment events or for comments a past-comments read added (plan `INTAKE_LOW_PRIORITY`) — **taps and typed answers never wait behind comments**. Each job takes the account's oldest waiting event **of its kind group** (5-minute lease, as today), handles it, and after 25 events (`INSTAGRAM_WEBHOOK_EVENTS_PER_JOB`, kept) adds one follow-up job. **No longer provider-pausable** (plan:L4477–L4478): intake calls Meta only for a new contact's profile and a late comment's time, each 3 s and failing open. Job data: `organizationPublicId`, `channelAccountPublicId` (or `contactPublicId` for tags), `intakeKind`, `requestId`, trace fields — public ids only (K8). |
| WH6 | **Personal data and logs.** Today (launch WH6): the payload is never logged; the list masks it; a contact erase leaves the person's events to the 30-day clean-up. → Unchanged rules, shorter life: the body is **cleared when the event is done** (WH22) and the whole row goes after 8 days (WH24), so no erasure step is needed now either. A story mention's media link is never copied out of the body (plan:L4791). The new flood count (WH16) and own-message check (WH9) carry ids only. |
| WH7 | **Who it calls (through services, never repositories).** Today: processing calls instagram-account, contact and the run engine, and the run engine sends. → Intake calls: channel-account (account state, the switch), instagram-account (resolver, posts, settings), contact (`recordContactInteraction`, profile save, the tag events' reads), the **run engine** (automation-run: match, once keys, P35 replacement — WH13, WH14), **sub-domain 6** for Instagram-only work (the own-message lookup of WH9, a tap's `unknown` → `sent`, a lane move when her chat opens — the message rows a start or an answer makes go through the run engine and `ChannelSendingPort`, AU35) and **sub-domain 7** (`BroadcastService.handleChatOpened` — "when her chat opens", plan §27.15). Every write of one event happens in **one** organization transaction (WH12). Build order: the receiver and the events table first; the new intake lands after sub-domain 6's message table (it writes there). |
| WH25 | **Intake is never paused by a provider outage (P47, the webhook review's F3).** Today (launch): the intake worker is built with `createProviderPausableWorker`, so an Instagram outage pauses the whole queue although most events need no Meta call. → Intake is a plain tenant worker (WH5) and is **never** paused: an outage only fails the two optional Meta reads intake may make (a new contact's profile, a late comment's time — 3 s, failing open), each checking `metaGraphCircuit` per call (sub-domain 1's adapter, MC2); events keep being saved and decided, and their messages wait in the lanes, which stop by their own rules (sub-domain 6). The same holds for the tag-event job and the missed-comment check. |
| WH26 | **One lock order in every intake path, tested racing (P47, the webhook review's F5).** Today: the plan's order (contact → automation → runs, plan §35) is written for the comment path. → Every intake path — `intake-messages`, `intake-live`, `intake-comments`, `intake-tag-events`, the missed-comment and past-comment events — takes its locks in that one order inside the event's transaction (`lockLiveContact` first, then the automation's row, then the open runs), so her DM and her comment handled by two jobs at once never deadlock and never start two runs. A DB test runs two intake jobs (messages and comments) for one contact at the same time and checks one open run, no deadlock and no lost event; a code-review rule and the intake overview name the order. |
| WH27 | **The inbound seam — normalized event kinds (P48, rev 3).** Today (rev 2): intake called `instagram-contact` and `instagram-automation` by name with Instagram's kinds. → Intake stays Instagram's; after classifying (WH8) it maps each saved kind to a **normalized event kind** (`ChannelInboundEventKind` in `app.channel-ports.ts`) and calls only the shared entry points — contacts' `recordInboundContactEvent`, `recordContactOptOut` / `clearContactOptOut` (3.A.10, CT18), the run engine's `startCommentRun`, `handleDirectMessage`, `handleButtonClick`, `startTagRun` (4.B.10), broadcasts' `handleChatOpened` and the recipients' reply and tap (7). The map: `comment` → `comment` (an ad's carries its `ad_id`) · `live_comment` → `live_comment` · `message` → `message` · `postback` → `postback` · `ice_breaker` → **`starter_question`** · `story_reply` → `story_reply` · `story_mention` → **`story_mention`** · `shared_post` → `shared_post` · `referral` → `referral` (its `ref` code or `ad_id`) · `reaction` → `reaction` · `echo` of a message the owner typed → **`owner_message`** (quiet time only, WH10); `edit` and `unknown` never cross (skipped here). Every call carries `organizationId`, `channelAccountId`, the provider's person id, the kind, its time and the item's ids (comment id, `mid`, media id, button payload) — never Instagram's body. The match order, once keys and P35 (WH13, WH14) key on the normalized kind, so a later channel's intake (WhatsApp, TikTok) maps its own events to the same list and reuses them. |

### 5.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| WHQ1 | How is "our own sent message" recognised before saving (plan step 3, the Redis `mid:` note)? | **a Postgres lookup** of the echo's `mid` in `app.instagram_messages` inside the store unit · the plan's Redis `mid:` note (10 min; with P5's 60-second cap) | **Postgres** — the message row already holds `instagram_message_id` (sub-domain 6); one index probe per echo, no data only Redis has (P32). An echo that arrives before the send's result is saved is stored `received` and intake matches it within 10 minutes (plan §27.13), which can also turn an `unknown` message `sent` | **P62** — a Postgres lookup (as recommended) |
| WHQ2 | The inbound flood count (`inbound:{account}:{contact}`, 1 minute, plan §26.4 rule 5) | **intake counts her message events of the last minute in Postgres** · the webhook adds 1 to a Redis counter | **Postgres** — the events are saved anyway; an index on (`channel_account_id`, `contact_instagram_user_id`, `created_at`) answers "more than 20 in the last minute" (plan §27.6 rule 1) without a second store; the webhook only saves | **P63** — Postgres at intake (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

Until answered, the plan follows the recommendation and every row that rests on it says so.

### 5.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_webhook_events` | one saved event of a Meta delivery (or of the missed-comment check / a past-comments read) and what intake did with it | **split by day** of `created_at`, kept 8 days (P33, D15); body cleared when done (WH22); `received` → `queued` (→ S25, P97: no `queued` step) → `processed` · `skipped` · `failed` (failed ones retried hourly while under 7 days); no soft delete |
| `app.instagram_webhook_event_keys` | every event key seen per account, so a repeat saves nothing | **split by Meta's event day** (rev 5, P96 — was a plain table, P33), one row per organization, account, key and day; a day part dropped after 8 days (WH20, WH24) |

```text
tenancy.organizations
   │
   └──< app.channel_accounts ──┬──< app.instagram_webhook_events        every event saved for the account (by day)
                               └──< app.instagram_webhook_event_keys    every key seen (by Meta's event day, 8 days)

   app.instagram_webhook_events ┄┄ app.instagram_messages (6)   echo mid matched by value (WHQ1), no foreign key
   app.instagram_webhook_events ┄┄ app.contacts                 by contact_instagram_user_id, no foreign key

A ──< B   one A has many B     ┄┄  matched by value, no foreign key
```

Pointing at these from other sub-domains: nothing (a partitioned table takes no foreign key from outside here).

**PostgreSQL design**

Standard columns (launch K5): `organization_id bigint` → organizations `ON DELETE CASCADE`, the composite key
(`organization_id`, `channel_account_id`) → `app.channel_accounts` `ON DELETE CASCADE`; RLS enabled and forced,
organization policy with `USING` and `WITH CHECK`. No `*_by_user_id`, no soft delete, no branch rule. Each table's design
is in 5.B.3.

### 5.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `instagram-webhook-event:read` | Instagram webhook events · View | the received-events list — the debugging view | 62 | Owner, Admin — not Editor, not Viewer (launch D4; the Member → Editor rename keeps it out) |

Routes 60 and 61 are PUBLIC: Meta proves itself with the verify token (60) and `X-Hub-Signature-256` (61). No new code.

### 5.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app`, mounted under `/social/instagram` (unchanged) |
| Meta routes (60, 61) | PUBLIC: no `Authorization`, no organization, no `X-Idempotency-Key` (launch K3 — Meta's keys make a repeat safe); Meta's names pass through (`hub.mode`, `object`, `entry`); success `200 text/plain` (the challenge, or `OK`), not `{ data, meta }` |
| Signed-in route (62) | `Authorization: Bearer <access token>`, organization from the token, team only (a personal organization → `404 team_organization_required`); `{ data: [...], meta: { request_id, pagination: { per_page, next, has_more, estimated_total } } }` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `413`, `415`, `429`, `500`, `503` |

### 5.6 Objects returned

| Object | Where |
| --- | --- |
| Plain text: the echoed challenge (60), `OK` (61) | 5.A.6 — Instagram webhook |
| Instagram webhook event | 5.B.6 — Instagram webhook events |

### 5.7 Routes

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 60 | GET | `/social/channel-connections/meta/webhooks/instagram` | Meta's subscription check (path moved, P53 / RC-115; reads the renamed verify token) | PUBLIC (verify token) | — | RC-115 |
| 61 | POST | `/social/channel-connections/meta/webhooks/instagram` | Receive Meta's six fields **(changed)** | PUBLIC (`X-Hub-Signature-256`) | — (K3) | RC-16 |
| 62 | GET | `/social/instagram/webhook-events` | List saved events and what intake did — 8 days **(changed)** | `instagram-webhook-event:read` | — | RC-19 |

### 5.8 Request details

In each nested sub-domain (5.A to 5.B, section .8).

### 5.9 Errors

Every route can answer the errors in 5.5; each route's own errors are in its nested sub-domain (5.A to 5.B, section .9).

### 5.10 Rules worth knowing

What one action sets off (same request or transaction unless marked worker):

```text
61 receive ──────────────► per entry: account check → keys insert (repeats drop) → new events insert → commit
                           → intake job of each kind that got events → rows `queued` (→ S25) → 200 OK
   [worker] intake-messages ► taps, typed answers, DMs, story replies/mentions, shared posts, starter questions,
                              links, ad messages, reactions, echoes        (priority 1)
   [worker] intake-live ────► Live comments                                  (priority 1)
   [worker] intake-comments ► comments, ad comments                          (priority 5; 10 when flooded or past)
            each event, ONE transaction: mark processed (guarded) → contact → run engine (match, once key,
            P35) → message rows `waiting` (6) → counts → commit; lanes woken after the commit (6)
   [worker] intake-tag-events ► tag automations of one contact (WH15)
   [worker] every minute ───► events `received`/`queued` over 1 minute → intake again; `failed` → hourly while < 7 days
   [worker] every 30 minutes ► missed comments of watched posts → saved as events (same keys) → intake
                              (one job per account; after an outage one full pass, same limits — P93)
   [worker] daily ──────────► day parts over 8 days dropped — events and event keys (WC-55, P96)
```

- Intake **never sends**: it saves `waiting` messages and sub-domain 6 sends them. An event's status tells how intake went,
  never how a send went.
- A skipped event is never taken in later — not even when the switch is turned back on (launch rule, plan:L2912).
- No route writes an event; only Meta's delivery, the missed-comment check (WH17) and a past-comments read (automation's
  backfill, through this sub-domain's store function) create one.

### 5.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| WHC1 | WH1, WH7: `instagram-webhook.overview.md` and `instagram-webhook-event.overview.md` rewritten (receiver → keys → events → intake per kind → sub-domain 6; the lifecycle diagram with `next_attempt_at`); the `app` row of `src/domains/CLAUDE.md`'s sub-domain map; TSDoc on every export; the launch's "sends inline" wording removed from `src/FLOWS.md` |
| WHC2 | WH2: the store unit's `SET LOCAL statement_timeout` (3 s constant in the app-domain constants file, P4); a statement timeout or lost connection mapped to `503` (test: a slow insert answers `503`, stores nothing, Meta's repeat stores once); no Redis buffer, no drain job. **As built (R17, [P304](decisions.md))**: `INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS`; the timeout (and a cancelled lock wait) is mapped to `503` by the receiver, not the global error handler (other routes keep `504` / `409`) |
| WHC3 | WH4: the receiver and route 60 read the Meta app secret and verify token through channel-connection's config accessor (`isMetaConfigured()` replaces `isInstagramConfigured()` in the worker's `isEnabled`); tests and `src/tests/setup.ts` values follow the rename. **As built (R17)**: the accessor is `readMetaWebhookSettings` in `channel-connection-meta/meta-signature.ts` |
| WHC4 | WH5: four job names on `instagram-webhook` (`queues/instagram-webhook.queue.ts`, `.job.schema.ts` with `intakeKind` and `contactPublicId`); per-kind deduplication ids `intake-<kind>-<cha_…>`, tag ids `intake-tag-events-<con_…>`; priorities from the constants file; the worker moves from `createProviderPausableWorker` to the plain tenant worker; `worker-registration.registry.unit.test.ts` and `scheduler.unit.test.ts` pinned counts; `workers-and-events.md`, `worker-scaling.md` |
| WHC16 | WH25, WH26: no `createProviderPausableWorker` on `instagram-webhook` (a registry test pins it); the two Meta reads through `metaGraphCircuit` with their fail-open path tested (circuit open → event processed without the profile or with the received time); the lock helper used by every intake path in the order contact → automation → runs; the racing test of two intake jobs on one contact; `instagram-webhook.overview.md` names the order |
| WHC17 | WH27 (rev 3): the kind → normalized-kind map in `instagram-webhook-event-dispatch.util.ts` with a unit test per row; intake's calls switched to the shared entry points (`recordInboundContactEvent`, the run engine's four) typed with `ChannelInboundEventKind`; the missed-comment look and the comment-time read through `readConnectionUsage` (MC19); a policy test that `contact/`, `automation/` and `broadcast/` import nothing from `instagram-webhook/` |

### 5.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/instagram-webhook/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 5.A Instagram webhook | folder root | — (stores through 5.B) | 60–61, intake, stuck-event pick-up, missed-comment check | final (rev 5, confirmed 2026-11-24) |
| 5.B Instagram webhook events | `instagram-webhook-event/` | `app.instagram_webhook_events`, `app.instagram_webhook_event_keys` | 62, the day parts of the events and the keys | final (rev 5, confirmed 2026-11-24) |

---

### 5.A Instagram webhook — `instagram-webhook/` (folder root) — final (rev 5, confirmed 2026-11-24)

#### 5.A.1 Decisions

| # | Decision |
| --- | --- |
| WH8 | **Six fields, new kinds (D24, D64, plan §26.2).** Today: the classifier (`instagram-webhook-event-classifier.util.ts`) knows `comments` and `messages`/`messaging[]` — kinds `comment`, `message`, `postback`, `story_reply`, `echo`, `read`, `reaction`, `edit`, `unknown`; the account's own comment is `skipped echo`. → It reads the six subscribed fields `comments`, `live_comments`, `messages`, `messaging_postbacks`, `messaging_referral`, `message_reactions` (plan:L4631) and adds `live_comment`, `story_mention`, `shared_post`, `ice_breaker` (a tap whose payload starts `starter:`), `referral` (a ref link or source ADS); `read` leaves (read receipts are never saved). Our button payload grows to `<aut_…>::<run_…>::<igm_…>` (plan:L4782). The account's own comment is `skipped own_comment` (P24); `echo` stays for DM echoes. Story repost stays `unknown` until its Meta test passes (plan:L4790, P36). The full table is 5.A.10. |
| WH9 | **The receive steps, in this order (plan §26.1, P32).** Today (launch WH8–WH10): signature → split → account → one insert `ON CONFLICT` on the events' key. → (1) signature over the raw bytes; (2) split and classify; (3) **drop** read receipts, and **echoes of our own sent messages** — the echo's `mid` found in `app.instagram_messages` of that account through sub-domain 6's lookup (WHQ1); (4) account check (WH3); (5) **replay guard**: an event whose Meta time is older than 8 days is dropped (its key may already be gone); (6) in one unit, organization `VERIFIED` scope, 3 s: insert the keys into `app.instagram_webhook_event_keys` `ON CONFLICT DO NOTHING`, then insert the events of **only the new keys** in one statement; (7) commit; (8) one intake job per kind that got events, then those rows turn `queued` (a failed add is logged; the pick-up catches it, WH17; → S25, P97: no `queued` update); (9) `200 OK`. The plan's Redis `seen:` note (step 6) is not used: the key table already makes a repeat a no-op (P32). A delivery holding entries of several organizations stores each entry in its own scope; one bad entry never stops the others (launch D53). |
| WH10 | **Echoes and the owner's quiet time (plan §27.13, D15).** Today: every echo is `skipped echo` (launch WQ4: a hand-sent DM does not reset anything). → An echo that is not ours (WH9 step 3) is saved **`received`** with kind `echo` and taken in by `intake-messages`: it matches one of our messages sent in the last 10 minutes with the same text (exactly one → that message `sent`, no quiet time), else it starts the owner's **6-hour quiet time** for that one contact (`OWNER_CHAT_QUIET_HOURS`). An echo never starts or answers a run. Its body is cleared when done (WH22). Other option: keep the launch's skip — then the quiet time and "no other automation answered" ignore the owner typing by hand. |
| WH11 | **Intake per kind; taps before comments (plan §24.2).** Today: one job per account, all kinds in one order (launch WQ3: a failing event holds back the account's later events). → three kind groups (5.A.10): `messages`, `live`, `comments`, each with its own job and its own order (`created_at`, `id`) inside the group; a stored `intake_group` column (generated from `event_kind`, 5.B.3) lets each job claim only its own rows. A failing event holds back only its own group, and only until its 5th try (WH12). Order across groups is not kept — a tap can only follow a message intake already saved. An account with more than 500 waiting comment events (`INTAKE_ACCOUNT_SOFT_LIMIT`) runs its `comments` job at priority 10; its messages and Live keep priority 1. |
| WH12 | **One event, one transaction (plan §27.1, §27.16).** Today (launch WH12–WH14): claim, then each step in its own short unit because sends ran between them; 5 attempts then a final `failed`. → Intake makes no send, so one event's writes are **one transaction**: (1) claim the oldest waiting row of the group (lease 5 minutes, `attempt_count` + 1); (2) **outside any transaction**, the two Meta reads it may need — a new contact's profile (→ S11, P97: moved to a low-priority task), a comment's own time when its webhook came over 1 hour late — 3 s each, failing open (plan:L4478); (3) one organization transaction whose **first statement** marks the event `processed` only while it is `received`/`queued` (0 rows → done already, stop), then contact, run engine, message rows, counts, comment log, in the one lock order (contact → automation → run → message → counts slot, plan §35); (4) after the commit, wake the lanes and add fast tickets (sub-domain 6). Failures: a database error or a lost connection tries again **without using a try**; a deadlock or lock timeout retries 3 times; any other error uses a try; the **5th** failed try marks the event `failed` with `next_attempt_at` = 1 hour later, and the pick-up tries it again hourly while its comment (or message) is under 7 days old (WH17). A permanent refusal (the run engine rejects it) fails it at once with no `next_attempt_at`. `error_message` keeps a code only, never text. |
| WH13 | **Match order and once keys (plan §27.2–27.5, §9.2, D13, D65).** Today (launch AU16, WH13): a comment matches one automation (post-linked first, then any post); a DM goes to a waiting email/phone run first, else the first DM keyword automation; a story reply to the first story-reply automation; a tap continues its run; no once key — a second start is ignored while a run exists. → **Chat events** in this order, the first hit ends the search: (1) her own waiting run takes it (a tap by its payload; a typed email or phone only while a run waits for it; a stop word opts her out first); (2) the exact source — a starter question's payload, a link's `ref` code, an ad's `ad_id`; (3) kind and keyword (+ "also start from", D38; contains, plus one-edit spelling for words of 5+ letters); (4) her first message ever; (5) "no other automation answered" (never on a reaction, a read receipt, a deleted message, or within the owner's quiet time). **Comments**: the live comment automation of this account whose keywords match, post-linked first then any post; an ad comment by its ad. **A match stopped by its once key still ends the search** (logged `ignored` · `once_per_post`). The once key per way to start is in 5.A.10 (D13); with the account's `once_per_person_per_post` OFF it becomes the event's own id (D65). Where it lives: the kind → operation dispatch here (`instagram-webhook-event-dispatch.util.ts`); the match, the keys and the run rows in the run engine (automation-run), which must state the same table. |
| WH14 | **One open run per automation and person — a new comment replaces it (P35).** Today: `idx_automation_runs_one_open` allows one `running`/`waiting` run per automation and contact; a second comment is logged `run_in_progress`. → When a **comment** (or a Live comment) may start a new run — a different post, or "every time" mode (D13 / D65 decide) — her open run of that automation is **cancelled** (`cancel_reason` `replaced`, its `waiting` messages `cancelled` · `replaced`) and the new run starts, **in the same intake transaction**, the old run's open key deleted and the new one inserted (AU37, P100). A second comment on the same post with "once" ON is still `ignored` · `once_per_post`. **Every other way to start** is ignored while her run is open (`run_in_progress`). The plan's `automation_run_open_keys` table (§19.6) is back since rev 5 — runs are split by month, so a partial unique index cannot be the rule (P100, AU37). |
| WH15 | **Tag events into intake (plan §24.2 rule 5, §27.9, D45).** Today: nothing — tags start nothing. → A tag added or removed (by an automation or the owner) writes an `app.contact_tag_events` row in the same commit (contact's table). After that commit the contact's `intake-tag-events` job is added (one per contact, deduplicated; → S20, P97: one job per 500 contacts — the row has no public id, so the job names the contact and reads her undone rows oldest first). Its first statement sets `done_at` only while empty; it starts the account's tag automations (`tag:<tag>:<event id>`, `untag:<tag>:<event id>`), only while her window is open, a chain of tag starts stopping at 3 (`chain_number`), ignored while her run of that automation is open (`run_in_progress`). Priority 5 for one change, 10 for the rows of a bulk change. Tag events are **never** saved as webhook events. The 1-minute / hourly pick-up of rows not queued or not done is WC-27 (5.A.10). |
| WH16 | **Inbound flood guard (plan §26.4 rule 5, §27.6 rule 1).** Today: none. → Per WHQ2's recommendation: intake counts her message events of the last minute in `app.instagram_webhook_events` (the index of 5.B.3); more than 20 (`INBOUND_FLOOD_PER_MINUTE`) → that event is `skipped` · `flood` (new reason) and starts nothing; a stop word still opts her out. The webhook does not count. Other option: the plan's Redis counter written by the webhook. |
| WH17 | **Pick-ups and missed comments (WC-12, WC-26).** Today (launch WH15): every minute, events still waiting 5 minutes after arrival and not claimed in 5 minutes → their account's job again. → every minute: waiting over **1 minute** and not leased → the job of that kind again; `failed` with `next_attempt_at` due → back to `received` and its job (the 5 tries start again), until its comment is 7 days old — read ids across organizations under `runGlobalRetentionWorkerJob`, jobs added after the context closes (launch pattern). **Missed comments** every 30 minutes, and one full pass after an outage (webhook off, Redis or Postgres down, a server starting after downtime): for each connected account's watched posts (a live comment or ad-comment automation, post or last comment under 7 days), read comments newest first until one is older than the last seen minus 10 minutes (replies only when comment replies are on, D64); new ones saved through **the same store function** with key `comment:<id>`, so a comment Meta also delivers is saved once. Every round — the 30-minute one and the full pass — **fans out one job per account** (its job id per account and round, spread over the interval), at most 25 posts per account, 1 call a second, skipped while the connection's Meta usage is ≥ 80 % (P51, MC19). **The full pass keeps the normal round's limits** ([P93](decisions.md), rev 5): only comments of the last 7 days (an older one can never get a private reply, D9) and at most 25 posts, at the lowest priority, stopping at 60 % usage so sending keeps its share. |

#### 5.A.2 Open questions

WHQ1 (5.2) — WH9 step 3 and WH10; WHQ2 (5.2) — WH16; both answered as recommended (P62, P63).

#### 5.A.3 Tables and relations

None of its own — the receiver, intake and the pick-ups write `app.instagram_webhook_events` and
`app.instagram_webhook_event_keys` only through 5.B's service (WH1). Intake writes contacts through contact's service and runs through
the run engine (the inbound seam, WH27); the engine's message rows go through `ChannelSendingPort` (AU35) — all in the event's one transaction (WH12).
Branch rule: none. User pointers: none.

#### 5.A.4 Permissions

| Code | Routes |
| --- | --- |
| — PUBLIC, proved by the verify token | 60 |
| — PUBLIC, proved by `X-Hub-Signature-256` (Meta app secret) | 61 |

#### 5.A.5 Common to every route

As 5.5 (Meta routes).

#### 5.A.6 Objects returned

Route 60: the `hub.challenge` value as received, `text/plain`. Route 61: `OK`, `text/plain`. Both bypass the envelope
(`raw_response`), unchanged.

#### 5.A.7 Routes (60–61)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 60 | GET | `/social/channel-connections/meta/webhooks/instagram` | Meta's subscription check | PUBLIC (verify token) | — |
| 61 | POST | `/social/channel-connections/meta/webhooks/instagram` | Receive the six fields **(changed)** | PUBLIC (`X-Hub-Signature-256`) | — (K3) |

#### 5.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 60 | `hub.mode*` = `subscribe`, `hub.verify_token*`, `hub.challenge*` (1–256, no spaces) — unchanged | — | the challenge, `text/plain` |
| 61 | — | Meta's body as received: `object` = `instagram`, `entry[]` with `id`, `time`, `changes[]` (fields `comments`, `live_comments`, `messages`), `messaging[]` (messages, postbacks, referrals, reactions); header `X-Hub-Signature-256*`; `application/json`; up to 5 MB (Meta may batch 1,000 changes) | `OK`, `text/plain` |

#### 5.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 60 | `400` · `invalid_field` / `invalid_webhook_verify_token` | a `hub.*` parameter missing or too long; a wrong mode or token (unchanged) |
| 60, 61 | `503` · `instagram_webhook_not_configured` | the Meta verify token (60) or app secret (61) is not set |
| 61 | `400` · `invalid_webhook_signature` | header missing, malformed, or not the raw body's HMAC (unchanged) |
| 61 | `413` / `415` / `429` | over 5 MB / not JSON / over 1,200 a minute per IP (→ S9, P97: unsigned traffic only — a refused signature is counted, a valid one never; R17) |
| 61 | `500` / `503` | Postgres down, or the store unit over its 3 s (WH2) — nothing stored, Meta delivers again **(changed: the 3 s)** |
| 61 | `200 OK` — not an error | an unknown or revoked account, a read receipt, our own echo, an event over 8 days old, a repeat key, a signed body that is not readable or not `instagram`: nothing stored |

#### 5.A.10 Rules worth knowing

**What counts as one event** (WH8; key ≤ 512 characters, else `<prefix>:sha256:<64 hex>` — unchanged rule).

| Meta item | Kind | Key (per account) | Group | Saved as |
| --- | --- | --- | --- | --- |
| `comments` change by another user (feed, reel, ad; a reply under a comment carries `parent_id`) | `comment` | `comment:<comment id>` | comments | `received` |
| `comments` change by the account itself | `comment` | `comment:<comment id>` | comments | `skipped` · `own_comment` **(was `echo`, P24)** |
| `live_comments` change | `live_comment` **(new)** | `live_comment:<comment id>` | live | `received` |
| message with `reply_to.story.id` | `story_reply` | `message:<mid>` | messages | `received` |
| message with a `story_mention` attachment | `story_mention` **(new)** | `message:<mid>` | messages | `received` |
| message sharing a post (`share` / `ig_post`, Meta test) | `shared_post` **(new)** | `message:<mid>` | messages | `received` |
| message — text, quick reply, other media | `message` | `message:<mid>` | messages | `received` |
| postback whose payload is ours (`<aut_…>::<run_…>::<igm_…>`) | `postback` | `postback:<mid>`, else `postback:<sender>:<time>:<SHA-256 of payload>` | messages | `received` |
| postback whose payload starts `starter:` | `ice_breaker` **(new)** | as postback | messages | `received` |
| `messaging_referral`, or a `referral` in her message (Meta test) | `referral` **(new)** | `referral:<sender>:<time>:<SHA-256 of ref and source>` | messages | `received` |
| reaction | `reaction` | `reaction:<mid>:<action>:<time>` | messages | `received` — refreshes her window only **(was skipped)** |
| echo (`is_echo`, `is_self`, sent by the account) of **our** message | — | — | — | **dropped, never saved (new)** |
| echo of a message the owner typed | `echo` | `echo:<mid>` | messages | `received` — quiet time only (WH10) **(was skipped)** |
| `message_edit` | `edit` | `edit:<mid>:<num_edit>` | — | `skipped` · `edit` |
| read receipt | — | — | — | **dropped, never saved (was `skipped read_receipt`)** |
| deleted message, story repost, anything else | `unknown` | as the launch | — | `skipped` · `unsupported` |

A row this table saves `received` is born `skipped automation_disabled` when the account's switch is off (WH3).

**What each kind group does** (WH12–WH14; every call carries public ids; one transaction per event).

| Group · kind | Contact | Then (run engine, sub-domain 6) |
| --- | --- | --- |
| comments · `comment` | `recordContactInteraction` (comment numbers, `last_comment_at`); profile read when new | post stored; "next post" link; the once rule; **P35** (cancel her open run → `replaced`, start the new one); window open → the opening as a fast DM, closed → attach to her unanswered opening on that post, else a slow private reply (24 h gap per person); public reply and hide wait for the reply lane until the DM went |
| live · `live_comment` | as comment | the Live automation; a fast private reply only while the Live is on; P35 as comments |
| messages · `postback`, `ice_breaker` | interaction (opens her window) | her run by the payload (`unknown` → `sent`, next step fast, nudge cancelled, tap counts); a starter tap matches by payload (WH13 level 2) |
| messages · `message`, `story_reply`, `story_mention`, `shared_post`, `referral` | interaction (window, `last_story_activity_at`, `first_message_at`) | flood guard (WH16); stop word → opted out, waiting skipped, runs cancelled; the match order of WH13; "when her chat opens" broadcasts (sub-domain 7) |
| messages · `reaction` | refreshes her window time | nothing else — never an answer, never cancels a nudge |
| messages · `echo` | — | 10-minute match to our message (→ `sent`), else the 6-hour quiet time (WH10) |
| tag events (WH15) | — | the account's tag automations; chain ≤ 3; window open; `run_in_progress` while open |

**Once keys** (D13; "every time" mode replaces them by the event's id, D65; `<date>` = the day in the organization's time zone).

| Way to start | Once key | Way to start | Once key |
| --- | --- | --- | --- |
| post or reel comment, ad comment | media id | DM keyword | `dm:<date>` |
| Live comment | `live:<media id>` | first message ever | `first` (once ever) |
| story reply | `story:<story id>` | shared post | `share:<media id>` |
| story mention | `mention:<story id>` | starter question | `starter:<date>` |
| link or QR | `ref:<date>` | ad "Send message" | `ad:<ad id>` |
| no other automation answered | `default:<date>` | tag added / removed | `tag:<tag>:<event id>` / `untag:<tag>:<event id>` |

**Background work here** (worker-changes rows): WC-1 chat intake · WC-2 comment intake · WC-3 Live intake · WC-4 tag-event
intake · WC-12 stuck-event pick-up · WC-26 missed comments · WC-27 tag events not started (with contact: the rows are
contact's, the job is intake's) · WC-48 event and key clean-up — part drops since rev 5 (5.B, P96) · WC-55 the events' day parts (5.B, shared upkeep).

#### 5.A.11 Code changes

| # | Change |
| --- | --- |
| WHC5 | WH8: the classifier — six fields, five new kinds, `own_comment`, the new payload shape, `read` dropped; a unit test per row of the 5.A.10 table (the launch's three key gaps kept) |
| WHC6 | WH9, WH10: the receive steps in `instagram-webhook.service.ts` — the own-message lookup through `InstagramMessageService.findOwnSentMessageIds` (WHQ1; **as built (R17, [P304](decisions.md))**: behind the port `InstagramOwnSentMessageLookup`, wired at R19 — until then no echo is known as ours), the 8-day replay guard (constant `INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS` = 8 in the app-domain constants file), keys first then new events; integration tests: our echo stores nothing, a hand-typed echo is `received`, an event 9 days old stores nothing, a repeat stores once, an `error` account's comment is `received` |
| WHC7 | WH11, WH12: `workers/instagram-webhook-intake.processor.ts` replaces `instagram-webhook.processor.ts` — claim by group, the two fail-open reads outside a transaction, the guarded first statement, the lock order, try accounting (database error no try, deadlock ×3, 5th try → `failed` + `next_attempt_at`); DB tests: a repeat intake changes nothing, a deadlock is retried, a failing comment does not hold back taps |
| WHC8 | WH13, WH14: the dispatch util's new kinds and order; the run engine's entry points it calls (automation-run's change) — a test per level of the match order, a once-key stop ending the search, P35's replacement in one transaction with the open-run key swap (AU37), `run_in_progress` for a DM while a run is open |
| WHC9 | WH15, WH16: `workers/instagram-tag-event-intake.processor.ts` (job per contact, `done_at` guard, chain ≤ 3, window check); the flood count read in the event repository; skip reason `flood` (constants, check, i18n label for route 62) |
| WHC10 | WH17: the pick-up's 1-minute and hourly `failed` passes (`workers/instagram-webhook-reclaim.processor.ts`); `workers/instagram-missed-comment-check.processor.ts` on the existing scheduler (every 30 minutes, `*/30 * * * *`) — a sweep that adds one job per account, jittered over the interval — and its full pass after an outage with the same limits (7 days, 25 posts, the lowest priority, stop at 60 % usage — P93); tests: the full pass reads no comment over 7 days old and no 26th post, and stops at 60 %; nock tests for the comment read; the store function shared with automation's past-comments read |

---

### 5.B Instagram webhook events — `instagram-webhook/instagram-webhook-event/` — final (rev 5, confirmed 2026-11-24)

#### 5.B.1 Decisions

| # | Decision |
| --- | --- |
| WH18 | **Fields (plan §18.9).** Today (launch WH16, `instagram-webhook-event.schema.ts`): kinds `comment` … `unknown` with `read`; skip reasons `automation_disabled` · `account_disconnected` · `echo` · `read_receipt` · `reaction` · `edit` · `unsupported`; `payload` required. → `event_kind` adds `live_comment`, `story_mention`, `shared_post`, `ice_breaker`, `referral` and drops `read` (13 values; `varchar(20)` holds them); `skip_reason` drops `read_receipt` and `reaction`, adds `own_comment` and `flood` (WH16); **added** `next_attempt_at` (a failed event's next try) and `intake_group` (generated from `event_kind`: `comments` · `live` · `messages`, WH11); `payload` becomes nullable (WH22). Everything else stays (`contact_instagram_user_id`, `attempt_count`, `last_attempted_at`, `occurred_at`, `request_id`, `created_at` = received time). |
| WH19 | **Split by day, kept 8 days (P33, D15).** Today: one plain table, a unique key `(organization_id, instagram_account_id, event_key)` and a 30-day batch delete (launch WH19: "no partitioning — the repeat key must hold across the whole table"). → `PARTITION BY RANGE (created_at)`, **one part per UTC day**; the repeat key moves to the key table (WH20), which is what makes the split possible. Primary key `(id, created_at)`; unique `(public_id, created_at)` (no route reads an event by id; `generatePublicId` makes a clash negligible). Parts are made 3 days ahead (→ S17, P97: ≥ 14 days ahead, a short lock timeout on drops, an explicit DEFAULT part with an alert) and dropped after 8 days by the shared partition upkeep (WC-55), under a maintenance scope, never the migration login (P33): a `SECURITY DEFINER` function owned by the table owner, `EXECUTE` granted to the maintenance role only, called under a new `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP`. RLS on the parent, enabled and forced (`EXPECTED_FORCE_RLS_TABLES` lists partitioned parents, as `audit.logs`); app code reads only through the parent and the app roles get no grant on the parts. Other option: stay plain with 8-day batch deletes — simpler, but P33 chose the split for this table. |
| WH20 | **The key table, split by Meta's event day (plan §19.5; [P96](decisions.md), rev 5 — supersedes P33's plain table).** Today: the event row's unique key. → `app.instagram_webhook_event_keys` `PARTITION BY RANGE (event_day)`, one part per UTC day: primary key **`(organization_id, channel_account_id, event_key, event_day)`** — organization first, as the launch's child keys (AS-BUILT "Index and key names"; db-changes draws `(channel_account_id, event_key)`), so it also serves the composite foreign key's cascade. `event_day` is the UTC day of **Meta's own time** for the item (a change's `time`, a message's `timestamp`), so a redelivery lands on the same day and the dedupe rule holds; **the missed-comment check and the past-comments read take the same day** from the comment's own time (the §43 test checks the two times agree; if they can fall on different days, the store function also probes the day before for a `comment:` key). `received_at` kept. Inserted `ON CONFLICT DO NOTHING` before the events (WH9). An event whose Meta day is older than the oldest kept part never reaches the insert — the 8-day replay guard drops it (WH9 step 5). A day part is dropped once its day is more than 8 days old (WH24, the shared upkeep WC-55) — no batch delete (P92). The plan's 16 hash parts are not used. |
| WH21 | **Retry of a failed event.** Today: `failed` is final after 5 attempts. → `next_attempt_at` set on the 5th failed try (WH12); the pick-up (WH17) puts it back to `received` hourly (attempt count from 0) until its trigger is 7 days old; then `next_attempt_at` empties and it stays `failed` until its day part is dropped. Index `(next_attempt_at) WHERE status = 'failed' AND next_attempt_at IS NOT NULL` (plan:L3219). |
| WH22 | **Body cleared when done (D15, plan:L3215).** Today: the payload stays 30 days, masked only in the list. → the guarded update that makes an event `processed` or `skipped` sets `payload` to **null** in the same statement; rows born `skipped` (own comment, edit, unsupported, the switch off) are **stored without a body**. Check: `(status IN ('received', 'queued', 'failed')) = (payload IS NOT NULL)`. So only waiting and failed events keep a body, and they are masked in route 62 as today. Other option: `{}` as the plan writes — keeps the `NOT NULL` but leaves an empty object that means nothing. |
| WH23 | **Route 62 — 8 days, many accounts (RC-19).** Today (launch WH17): newest first, filters `status`, `event_kind`, `received_from`/`received_to`, `include_total`; payload masked. → the same list over at most 8 days, plus **`channel_account_id`** (a filter and a field — an organization now holds many accounts, D26), `next_attempt_at` and the new kinds and reasons; `payload` is `null` once the event is done. A `received_from` older than 8 days is accepted and simply finds nothing. |
| WH24 | **Clean-up (WC-48, WC-55).** Today: daily 03:00 UTC batch delete of events older than 30 days (`instagram-webhook-event-retention`). → the events **and, since rev 5, their keys** go by **dropping day parts** older than 8 days (WC-55; P96) — WC-48 becomes two specs of the shared upkeep and the 03:00 batch job is retired, so no batch delete is left here (P92). A contact erase still registers no erasure step (launch WH18) — her events go within 8 days, their bodies earlier (WH22). |

#### 5.B.2 Open questions

None.

#### 5.B.3 Tables and relations

`app.instagram_webhook_events` — **CHANGED**, split by day (rows listed only where they change; launch columns as 4.B.3 of
the launch review)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigint` (bigserial) | no | identity | primary key **`(id, created_at)`** (was `id`) |
| `public_id` | `varchar(28)` | no | | `iwe_…`; unique **`(public_id, created_at)`** (was `(public_id)`) |
| `event_kind` | `varchar(20)` | no | | `comment` · `live_comment` · `message` · `story_reply` · `story_mention` · `shared_post` · `postback` · `ice_breaker` · `referral` · `reaction` · `echo` · `edit` · `unknown` (**`read` removed**) |
| `intake_group` | `varchar(8)` | | generated | **new** — stored: `comments` for `comment`, `live` for `live_comment`, else `messages` |
| `skip_reason` | `varchar(30)` | yes | | `automation_disabled` · `account_disconnected` · `own_comment` · `edit` · `unsupported` · `flood` (**`echo`, `read_receipt`, `reaction` removed; `own_comment`, `flood` added**) |
| `payload` | `jsonb` | **yes** | | `jsonb_typeof(payload) = 'object'` when set; `(status IN ('received','queued','failed')) = (payload IS NOT NULL)` (WH22) |
| `next_attempt_at` | `timestamptz` | yes | | **new**; set only while `failed` |
| `created_at` | `timestamptz` | no | `now()` | **the partition key** — one part per UTC day |

Indexes (each declared in the schema file; local to every part):

- unique `(public_id, created_at)`.
- `(organization_id, created_at DESC, id DESC)` and `(organization_id, channel_account_id, created_at DESC, id DESC)` — route 62, all accounts or one (**new**).
- `(organization_id, status, created_at DESC, id DESC)` — route 62 by status (kept).
- `(channel_account_id, intake_group, created_at, id) WHERE status IN ('received', 'queued')` — the claim and the pick-up, per group (**was without `intake_group`**).
- `(next_attempt_at) WHERE status = 'failed' AND next_attempt_at IS NOT NULL` — the hourly retry (**new**).
- `(channel_account_id, contact_instagram_user_id, created_at) WHERE intake_group = 'messages'` — the flood count (**new**, WHQ2).
- **Removed:** `idx_instagram_webhook_events_organization_account_event_key` (moves to the key table) and `idx_instagram_webhook_events_created_at` (parts are dropped).

Checks: the kind, skip-reason and payload checks above; the launch's `status`, `skipped`, `failed`, `final`,
`attempt_count`, `instagram_ids`, `updated` checks kept. Foreign keys: organization `ON DELETE CASCADE`; composite
(`organization_id`, `channel_account_id`) → `app.channel_accounts` `ON DELETE CASCADE` (kept; allowed from a
partitioned table). RLS: the launch policy kept on the parent — `USING` the organization GUC or the
`app.global_retention_cleanup` arm (the pick-up's cross-organization id read), `WITH CHECK` the organization GUC only;
enabled and forced. Migration: the launch's `20261121094626_app_instagram_webhook_events.sql` changes in place (D1, P29) —
the table is created partitioned from the start.

`app.instagram_webhook_event_keys` — **NEW**, split by Meta's event day (rev 5, P96)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `organization_id` | `bigint` | no | | → organizations `ON DELETE CASCADE` |
| `channel_account_id` | `bigint` | no | | composite (`organization_id`, `channel_account_id`) → `app.channel_accounts` `ON DELETE CASCADE` |
| `event_key` | `varchar(512)` | no | | the same key as the event's |
| `event_day` | `date` | no | | **the partition key** (rev 5, WH20): the UTC day of Meta's own time for the item; one part per day |
| `received_at` | `timestamptz` | no | `now()` | |

Primary key `(organization_id, channel_account_id, event_key, event_day)`; no `(received_at)` index any more (its parts are dropped, WH24). No public id, no `updated_at` (never
changed). RLS: organization policy `USING` + `WITH CHECK`, plus the `app.global_retention_cleanup` arm in `USING` only (the
upkeep's oldest-part check); enabled and forced; in `EXPECTED_FORCE_RLS_TABLES`. Branch rule: none. User pointers: none.

#### 5.B.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-webhook-event:read` | 62 |

#### 5.B.5 Common to every route

As 5.5 (signed-in route).

#### 5.B.6 Objects returned

**Instagram webhook event**: `id` (`iwe_…`), `channel_account_id` (`cha_…`, **new**), `instagram_user_id`,
`contact_instagram_user_id`, `event_kind` (the 13 values of 5.B.3), `event_key`, `status`, `skip_reason` (the 6 values, or
null), `error_message`, `attempt_count`, `next_attempt_at` (**new**), `payload` (masked; **null once done**), `occurred_at`,
`received_at`, `processed_at`. Internal ids, `intake_group`, `last_attempted_at` and `request_id` are never returned.

#### 5.B.7 Routes (62)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 62 | GET | `/social/instagram/webhook-events` | List saved events — 8 days **(changed)** | `instagram-webhook-event:read` | — |

#### 5.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 62 | `channel_account_id` (**new**), `status`, `event_kind` (one value each), `received_from` / `received_to` (ISO 8601 with an offset; `to` exclusive), `limit` (1–100, default 25), `after`, `include_total` | — | Instagram webhook event[] |

#### 5.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 62 | `400` · `status` / `event_kind` / `channel_account_id` | not one of its values, or not an `cha_…` id |
| 62 | `400` · `received_from` / `received_to` / `limit` / `after` / `include_total` | as the launch |
| 62 | `403` · `missing_permission` | no `instagram-webhook-event:read` (Editor, Viewer) |
| 62 | `404` · `team_organization_required` | a personal organization |

An `channel_account_id` of another organization finds nothing (an empty page, not a `404` — a filter, not a path id).

#### 5.B.10 Rules worth knowing

- Rows are created by the store function only (5.A: the webhook, the missed-comment check, a past-comments read), changed
  by intake and the pick-up only, and go with their day part (WH19) — route 62 never changes one.
- The masking runs in the serializer only; what is stored stays as received until the event is done, then it is cleared.

#### 5.B.11 Code changes

| # | Change |
| --- | --- |
| WHC11 | WH18, WH19, WH21, WH22: the launch migration changed in place — partitioned parent, new columns and checks, the index set above; `instagram-webhook-event.schema.ts` (Drizzle declares the parent; the part DDL lives in the upkeep function); constants (kinds, skip reasons, groups); repository: insert of new keys' events, claim by group, guarded marks that clear the body, `failed` with `next_attempt_at`, the list with the account filter; the composite-key test list; DB tests: a done event has no body, a failed one keeps it |
| WHC12 | WH20: `instagram-webhook-event-key.schema.ts` (a parent split by `event_day` — rev 5, P96) and `.repository.ts` in the nested folder (no routes); its migration beside the events'; the day computed once in the store function for all three paths (webhook, missed comments, past comments) and a test that a redelivery and a missed-comment read of one comment save it once; `EXPECTED_FORCE_RLS_TABLES`; an RLS test as `meepzo_be_app` (another organization's keys never seen or blocking) |
| WHC13 | WH19, WH24: the shared partition upkeep (worker-changes WC-55) — `app.fn_manage_time_partitions` (`SECURITY DEFINER`, fixed `search_path`, `REVOKE … FROM PUBLIC`, `EXECUTE` to `meepzo_be_maintenance`), `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP` in `database-context.ts`, the worker `src/domains/app/workers/app-partition-upkeep.*` (daily at a quiet hour and at worker start; a missing part made at once and the team told) with the events' and, since rev 5, the keys' specs (day, 3 ahead — → S17, P97: ≥ 14 — keep 8); sub-domain 6 adds its two specs and sub-domain 4 its three (AU36 — P96); a gauge per split table for the oldest part past its keep time (P92); `context-directory-standard` and `verified-scope-usage` policy tests updated |
| WHC14 | WH23: route 62's DTO (`channel_account_id`), validator, serializer (new kinds and reasons, `next_attempt_at`, null payload), the masking util's new kinds; the route schema description; `pnpm routes:catalog`, `docs:generate` |
| WHC15 | WH24: `instagram-webhook-event-retention` retired — events and keys both expire by part drops (P96), so no batch delete and no 03:00 run remain (P92); `INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS` 30 → the 8-day constant (one constant for the replay guard, the keys and the parts); seeds (`seed/instagram-webhook-event.bulk.seed.ts`: the new kinds, bodies null when done, keys); `docs/reference/data/data-lifecycle-deletion.md` row; i18n labels for the new kinds and reasons |

**As built (R16, [P303](decisions.md)):** WHC11, WHC12 and WHC14 built; the key table sits in the events' migration; the
first day parts (8 back, 14 ahead) and a DEFAULT part per table come from `app.fn_create_daily_partitions`, which
WHC13's upkeep (R49) builds on; the replay guard (WH9 step 5) and the key day live in the store function
(`recordReceivedEvents`) shared by all three paths, an item without a Meta time filed under its received day; until
WHC5 (R17) the launch classifier saves read receipts `unknown` · `unsupported` and reactions and DM echoes
`unsupported`; WHC15's seed part is done (every kind, status and reason).

**As built (R49, [P410](decisions.md)):** WHC13 and WHC15 built. `app.fn_manage_time_partitions(parent, make_ahead_days,
keep_days, drop_parts)` (migration `20261125190000_app_partition_upkeep.sql`) is SECURITY DEFINER with EXECUTE for
`meepzo_be_maintenance` **only** — the role-taxonomy gate lists it as the one maintenance-only definer (the app role never
reaches a part-dropping function); it makes the parts 14 days ahead through R16 / R19 / R14's part makers, drops an expired
part by DETACH then DROP (2 s lock timeout, 3 tries, else the next hour), keeps a runs / run-events part holding an open
run, moves the DEFAULT part's rows into a new part for a table nothing points into (runs: reported blocked), and reports
ready days, DEFAULT rows and the oldest kept part's overdue seconds. Scope `MAINTENANCE_SCOPE.APP_PARTITION_UPKEEP` (no
GUC); worker `src/domains/app/workers/app-partition-upkeep.*` on queue `app-partition-upkeep` (family `retention`): the
daily make at 02:23 UTC and at worker start, the hourly make-and-drop at :37, the seven tables in the order events, keys,
attempts, messages, comment logs, run events, runs; gauges `app_partition_ready_days`, `app_partition_default_rows`,
`app_partition_oldest_overdue_seconds` with logger + Sentry alerts. WHC15: the launch's retention queue, worker, schedule
and `INSTAGRAM_WEBHOOK_EVENT_RETENTION_DAYS` are gone; `INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS` (8) is the one constant.

---
## 6. Instagram sending — rev 5 (2026-11-24) — nested sub-domains 6.A–6.C; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`instagram-sending` sub-domain folder** — `app/sub-domains/instagram-sending/` (the lanes, gates, counts, stops,
the global sending state and the repair duties at the folder root) with `instagram-message/` and `instagram-attachment/`.

6.1 Decisions (whole sub-domain) · 6.2 Open questions · 6.3 Tables and relations · 6.4 Permissions · 6.5 Common to every route ·
6.6 Objects returned · 6.7 Routes · 6.8 Request details · 6.9 Errors · 6.10 Rules worth knowing · 6.11 Code changes (whole sub-domain) ·
6.12 Nested sub-domains · then **6.A Instagram sending · 6.B Instagram messages · 6.C Instagram attachments** — each with the same eleven sections.

**NEW** (P38). Today the launch sends inside event processing: the run engine claims a send on the run
(`automation_runs.sending_message_kind`, `sending_started_at`), waits a fixed 200–1,000 ms and calls Instagram
(`automation-run-message.service.ts`; AS-BUILT "Sending again on a retry", "Reply safety order, counts and memory"). Here
intake only saves `waiting` messages (sub-domain 5) and this sub-domain **sends them**: four lanes per account (slow,
reply, fast, broadcast), two gates and the month count in the claim's commit, one shared result save, the Instagram error
groups and stops, and an every-minute repair that never sends. It is mostly background work — 6.10 maps every piece to its
worker-changes row. Two routes read it: the account's sending status (banners and estimates) and the organization's
DM meter; the summary and retry of failed messages per automation and per contact are sub-domains 4's and 3's routes
(36–37, 25–26), over this sub-domain's retry service (Merge notes M6). Design read: plan §24 (L4344–L4480),
§28–§35 (L5177–L6168), §19.1–19.16 (L3226–L3640), §15.2–15.3 (L2530–L2591), §15.11 (L2700–L2733), §39 (L7044–L7091); D3–D9,
D16–D21, D34, D35, D50, D57, D62, D68, D72; P3–P7, P13, P14, P16, P25, P32–P34. Builds on: channel-account (accounts, pause, suspend, plan stop), instagram-account (
settings, the Instagram client), channel-connection (the token, `appsecret_proof`), contact, automation (runs, counts, reply
state), billing (the plan's features and DM limit), upload (message files). Route numbers run 63–64 (65–68 left unused — Merge notes M6).

### 6.1 Decisions (whole sub-domain)

Taken on the standing answer "go with the recommendation", confirmed with the answers of 2026-11-24 (P54–P90) (P31). A decision that belongs to one table is in its nested
sub-domain.

**rev 2 changes** (P43, P47, M9): `meta_attachments` → `app.instagram_attachments` (`instagram-attachment/`); `direct_message_month_counts` → the shared `app.message_month_counts`, the limit `message_month_limit`, the account count `channel_accounts_max`; `app.sending_states` shared; pause, suspend and the account's plan stop moved from the lanes to the channel account (1B — SN9, SN12); the account pointer `channel_account_id`; route 63 under `…/{channel_account_id}/sending-status`; the Meta client from 1's adapter. Everything else stays Instagram's.

**rev 3 changes** (P48, P50, P51, M10): stays Instagram's (P43 unchanged); its message service is now **Instagram's implementation of `ChannelSendingPort`** — the shared run engine and broadcasts save waiting messages through it, it picks the lane, and it reports each result back to the run engine's `recordMessageResult` or the recipient service (SN22, AU35); PRO and Meta-tested parts at run time come from 1B's one feature check (P50); Meta's usage is no longer kept per lane — every lane and gate 1 read the connection's usage (SN23, MC19); table names it points at are the shared ones (`app.automation_runs`, `app.broadcasts`, …). Routes 63–64 unchanged.

**rev 5 changes** (P91, P92, P94, P95, P96, P97, P99, M13): the in-process database limiter and the send service (SN24, SNC17; SN2, SNC2 — P91); one repeat job per repair duty with a 40 s budget and bulk re-adds (SN6, SNC5, 6.10 — P94, refining P73's text); the hourly, time-budgeted clean-ups with an oldest-row gauge (SN6, 6.3, 6.10 — P92); `minimum_compatible_settings_version` (SN7, SNC6, 6.A.3 — P95); the plan stop moved off the lanes to the channel account (SN8, SN9, SN12, 6.3, 6.A.3, 6.A.6, 6.10, SNC10 — P99); messages point at the month-split runs (SN17 — P96); markers for S8, S13, S18, S19, S21, S29 (P97). Routes 63–64 unchanged.

| # | Decision |
| --- | --- |
| SN1 | **Folder and names (P38).** Today: nothing. → `instagram-sending/` at the root holds the engine — `app.instagram_send_lanes`, `app.instagram_send_stops`, `app.instagram_send_minute_counts`, `app.message_month_counts` (P6 name), `app.sending_states` — none with routes of its own, so persistence parts of the root (launch layout rule); routes 63–64. Nested `instagram-message/` owns `app.instagram_messages` and `app.instagram_send_attempts` (an attempt belongs to its message) and the retry service behind 3's routes 25–26 and 4's 36–37 (M6). Nested `instagram-attachment/` is a persistence module with no routes (the `auth/verification-token` precedent) owning `app.instagram_attachments`. Folder names carry the resource's name like the launch's `instagram-account/instagram-media/`; `app.message_month_counts` and `app.sending_states` are shared by every channel (P43) but live here while Instagram is the only sender. Public id: only the message has one (proposal `igm`, P22 — kickoff confirms); path params are the existing `channel_account_id`, `automation_id`, `contact_id`. Other option: one flat folder — nine tables and four lanes' workers in one place. |
| SN2 | **Queues (D3, plan §24).** Today: one Instagram queue (`instagram-webhook`, family `instagram`), concurrency `WORKER_CONCURRENCY_INSTAGRAM` (max 20). → three new queues — the two send queues in their own family **`instagram-send`** (their own service — SN24, [P91](decisions.md)), `instagram-tasks` in family `instagram`: **`instagram-send-slow`** (one ticket per lane turn of `slow`, `reply`, `broadcast`; job id `<lane>-<cha_…>-<turn_number>`, broadcast at priority 10), **`instagram-send-fast`** (one ticket per fast message, `fast-<igm_…>-<tries>`, up to 20 at once per account; → S21, P97: plus an in-flight cap per organization), **`instagram-tasks`** (→ S19, P97: split into Meta-calling and database-heavy, capped per organization) (the jobs around sending, D3 — defined here, its job names registered by their owners: account set-up and starter questions by channel-connection / instagram-account, file upload and retry-failed here, segment count and broadcast audience by sub-domain 7, past comments by automation). Tickets carry ids only (`organizationPublicId`, account public id, lane and turn, or message public id + its run's start time + try) — text and person are read from Postgres at the last moment (plan §24.4). BullMQ rules (plan §24.6): no worker ever waits (a delay or `moveToDelayed`), 1 attempt per ticket, `removeOnComplete`/`removeOnFail` on, never BullMQ's rate limiter, **not paused by the `instagram` circuit** (our stops decide). Concurrency: `WORKER_CONCURRENCY_INSTAGRAM_SEND_SLOW`, `_SEND_FAST`, `_TASKS` (env, deploy-varying, be-env-schema-add) **with their own maximum** (≈ 200 — rev 4 fell back to the 20-capped `WORKER_CONCURRENCY_INSTAGRAM`, P91); the Postgres budget (`worker-connection-budget.ts`) counts their database slots, not these places (SN24). |
| SN3 | **The gates (D18, plan §31).** Today: reply safety counted from comment logs in Postgres; no send limit. → before a send: **gate 1**, an advisory Redis count per account and count group (a sorted set per minute, organization-scoped keys, 100 ms timeout, skipped for 30 s after 3 timeouts — never inside a transaction); then **one** Postgres commit that (a) checks **gate 2**, the account's `app.instagram_send_minute_counts` summed over the last 61 minutes against the group's hour limit, (b) checks the **month count** (D34), (c) adds 1 to both, (d) marks the message `sending` with a 120 s lease and writes its attempt row. Postgres decides; Redis only saves a wasted claim. Count groups: `open` (slow), `reply`, `fast`, `broadcast`; `none` for follow checks. The person limit (60 an hour) is read from Postgres (her `sent` messages of the last hour). |
| SN4 | **One shared result save, retried inside the send — no save-result jobs (P32, plan §28.4).** Today: the run engine books its own send result. → one function `saveSendResult` (6.B) owns every effect of an answer: the message's status and Instagram id, give-backs of counts on a sure "not sent", the run's next step and its fast ticket, the opening DM's bookkeeping (`last_opening_message_at`, the run's `direct_message_sent_at`), the public reply / hide / nudge rows, list message N+1, tags, completion, the stop rules, and the lane's release (only while `working_turn` is this turn). It is called by the four lanes, the repair duties and intake (a tap's `unknown` → `sent`). **After Meta answered, a failed save is retried inside the same job** — deadlock or lock timeout 3 times, a lost connection after 1, 2, 4, 8 s — while the message keeps its lease; if it still fails, the message stays `sending`, its lease runs out and WC-14 settles it `unknown` (never sent again by itself, D17). The Instagram message id is logged (an id, never text), so an echo or a tap can still prove it `sent`. Other option: the plan's Redis save-result jobs — refused by P32. |
| SN5 | **Instagram errors and stops (D19, plan §33).** Today: auth errors set the account `error`/`expired` (AS-BUILT "Instagram auth errors"); other errors only fail that send. → every answer maps to **one group** (6.A.10): `too_fast` stops that lane (Meta's time, else 15 → 360 minutes; a broadcast lane twice as long), `blocked` all lanes with tests after 24, 48, then every 72 hours, `account_flagged` that lane, `login_expired` every account of the channel connection (no end, reconnect notice), `account_not_shared` / not business that account, `access_off` and `app_not_approved` all lanes with hourly tests, `app_limit` all accounts when 2 accounts get it within 5 minutes; per-message groups (`person`, `window_closed`, `bad_text`, `wrong_permission`, `comment_gone`, `live_ended`, `attachment_failed`, `try_later`, `no_answer`, `never_connected`, `already_sent`). A stop never fails a DM: it goes back to `waiting` with no try used. "In a row" and "30 % bad" are counted from `app.instagram_send_attempts`, never Redis. **Sending starts again by itself** when a stop ends (D19). Every stop is a row in `app.instagram_send_stops`. The code lists come from constants (P4); codes Meta tests must still name (`CODES_ALREADY_SENT`, `CODES_LIVE_ENDED`, `CODES_ATTACHMENT_GONE`) start empty and their features stay refused at go-live (P36). |
| SN6 | **Repair duties on the existing scheduler (P7).** Today: one cron per job in `scheduler.ts` (minute granularity, `upsertJobScheduler` with `pattern`). → one queue **`instagram-sending-repair`** (family `instagram`, `retentionDefinition`-style, `holdsConnectionDuringExternalIo: false`) with **one repeat job per duty** ([P94](decisions.md), rev 5 — refines P73's "one repeat job per rule group"), all running in parallel: every minute `repair-lost-turns` (WC-13), `repair-stuck-sends` (WC-14), `repair-expiry` (WC-15), `repair-closed-windows` (WC-17), `repair-reply-trim` (WC-18), `repair-paused-cancel` (WC-19), `repair-counts` (WC-20), `repair-month-wake` (WC-37's check), `repair-month-notice` (WC-56's backup), `repair-owner-emails` (WC-57); 7's `repair-broadcast-start`, `repair-broadcast-end` (WC-28, WC-29) and 4's `repair-open-run-keys` (WC-67) (AU37, P100); `outage-check` every **10 seconds** (WC-22), `waiting-estimate` every 10 minutes (WC-24), `live-check` every minute (WC-16, calls Meta); and the **hourly** clean-ups (WC-53, 54 — [P92](decisions.md): each run until a ≈ 10-minute budget is spent, capped per table from the plan's rows a day × 2, with an "oldest row past its keep time" gauge that alerts after 1 day). Each duty **works until a 40 s budget is spent** (no fixed 500 cap), re-adds tickets in bulk (`addBulk`), records its round time and backlog (a metric per duty), is safe to run twice, reads ids across organizations under the `app.global_retention_cleanup` arm and changes each organization in its own `runOrganizationScopedWorkerJob`. The 10-second repeat needs **`every`** in the scheduler: `ScheduledJob` takes `cronPattern` **or** `everyMilliseconds` (one change, `scheduler.ts` and its unit test). Two duties cannot ride BullMQ and run **in each worker process** instead: the clock check (WC-23 — every server's own clock) and the "Redis lost or emptied" watch (SN10). So the plan's 16 helper slots are not needed — `app.sending_helper_slots` is dropped (SNQ1 → [P73](decisions.md)). |
| SN7 | **The global switch and the environment id (D20, P4) and the settings version (D21).** Today: nothing stops a restored copy from sending. → (1) env **`SENDING_ENABLED`** (boolean, static default `false`; be-env-schema-add — the one flag for "this deployment may send"): `false` → the send workers, the tasks that call Meta and the repair duties are not registered (`isEnabled`); the webhook still saves. (2) env **`SENDING_ENVIRONMENT_ID`** (text, 1–64; a production `.refine()` requires it when `SENDING_ENABLED` is on): must equal `app.sending_states.environment_id`, read at worker start and once a minute — a mismatch stops this server's sending and alerts the team, so a Neon branch or restore of production (which carries production's id) never sends from a test server. The row is created by `prepareDatabase` with the server's id **only when missing**, never overwritten. (3) **`SENDING_SETTINGS_VERSION`** (a constant in the app-domain constants file, P4) and **`app.sending_states.minimum_compatible_settings_version`** ([P95](decisions.md), rev 5): each release writes its version (a newer one raises `settings_version`) and raises the minimum **only** when it is actually incompatible with older servers; a server older than the **minimum** takes no tickets, an older-but-compatible one keeps sending — so an image rollback, or an old server restarting during a rollout, no longer stops sending. be-path-to-production's rollback gains a step and a command (lower the minimum only when rolling back past an incompatible release), and how Railway rolls several replicas is written down beside it. Runtime code reads `env.SENDING_ENABLED` alone, never combined (CLAUDE.md env rule 2). |
| SN8 | **The month limit (D34, D62, P3).** Today: no limit. → every message into her chat counts (`is_counted_as_direct_message`: DMs, private replies, broadcast messages; not public replies, hides, follow checks), in `app.message_month_counts` per organization and calendar month **in the organization's time zone** (`tenancy.organizations.timezone`), 16 slots by account so accounts never wait on each other. The limit is the plan's `message_month_limit` (billing, P37 placeholders: Free 1,000, Creator 10,000, Studio 50,000). At 100 %: the plan stop `plan_limit` on every channel account of the organization (1B, CA3 — P42, P99), which holds the **slow, fast and broadcast** lanes — the reply lane goes on (P3, D62); a DM whose 7 days end behind it is `expired` · `plan_limit`. 80 % and 100 % send one notice and one email each per month (WC-56). The 1st of the month (her time zone) or an upgrade wakes them (WC-37). Intake never checks the limit; the claim does (plan:L4831). |
| SN9 | **Plan states and PRO at run time (D35, D57).** Today: the read-only plan refuses automation writes only (AS-BUILT "Read-only plan"). → the plan stop `plan_ended` (all four lanes) on every channel account of the organization for a cancelled paid plan at its period end or a grace that ended; an account the smaller plan does not keep carries `plan_downgrade` (all four lanes) — both on the channel account (1B, CA3 — P42, P99; rev 1 put them on the lanes, rev 4 kept `plan_limit` and `plan_ended` there); a suspended organization, or a team suspend (`suspended_at` on the channel account, P18), stops every lane. The engine reads the plan's features **at run time** (through 1B's one feature check since rev 3 — CA11, P50): PRO parts the plan lacks are ignored, never deleted (email and phone steps skipped, "Reply like a person" as OFF, one reply line, version A only, no extra delay). Plan stops sit **beside** an error stop and both must end (plan §33.2 rule 4) — the plan stop on the account, the error stop on the lane (SN12). |
| SN10 | **Redis lost, emptied or replaced (plan §31.5, WC-21).** Today: the scheduler registers its repeat jobs once at boot; an emptied Redis loses them until a restart. → each worker process watches its BullMQ connection (reconnect events and the server's `run_id`): when Redis comes back new or empty, it re-registers the job schedulers (`registerScheduledJobs` is an idempotent upsert), rebuilds the gate-1 counts from the minute counts under one rebuild lock, and the next repair round puts the lanes' turns back with a small spread. Postgres decides throughout, so gate counts stay safe (→ S18, P97: `REDIS_BULLMQ_URL` required when sending is on). The team is emailed after 1 minute down (through the mail outbox). |
| SN11 | **Short-lived Redis copies (P5, be-read-cache-guard).** Today: none here. → three copies, each organization-scoped, built from Postgres, fail-open to Postgres, TTL ≤ 60 s, tombstoned after the commit that changes them: the account's **sending status** (route 63, 10 s), the organization's **month count** (route 64 and the claim's quick look, 10 s — the claim itself always reads the slots), and the **waiting estimate** (WC-24, written every 10 minutes but kept 60 s and rebuilt on a miss by route 63; → S29, P97: stored by its 10-minute job). Nothing in Redis that Postgres does not have (P32). |
| SN22 | **Instagram's side of the outbound seam (P48, rev 3; the contract is AU35).** Today (rev 2): 4.B, 5 and 7 called `InstagramMessageService` by name. → `InstagramMessageService` implements `ChannelSendingPort` (`app.channel-ports.ts`), wired as `channelSendingPorts.instagram`. **It receives** `saveWaitingMessage` with the organization, the channel account, the contact, the source (run or broadcast, with `automationRunStartedAt` — the partition key, SN17), the step, the message kind, the content by reference (step path, upload public ids — never text), `notBefore`, `triggerOccurredAt` and the event a reply answers; it writes the `waiting` row in the caller's transaction. **It chooses the lane** — `slow` for an opening private reply or DM, `reply` for a public reply or hide, `fast` for answers, lists, nudges, follow checks and Live replies, `broadcast` for 7 — sets the delivery `channel` and `is_counted_as_direct_message`, and wakes the lane after commit; it answers `skipped` with its reason when the row can never go. Before a send it asks 1B's feature check for the message's parts (CA11): a part the account can no longer use is **skipped**, never refused (D57). **It reports back** from `saveSendResult` in the result's own commit: `recordMessageResult` (4.B) for a run's message, `BroadcastRecipientService.recordMessageResult` (7.C) for a broadcast's, with `sent` · `failed` · `skipped` · `unknown` (`expired` as `skipped` with its reason; `cancelled` never reported). Cancel, skip, the month read and the failed-message summary and retry are the port's other operations. A later channel's sending sub-domain implements the same port with its own lanes. |
| SN23 | **Meta's usage comes from the connection (P51).** Today (rev 2): the lanes read Meta's usage from their own answers (the reply lane's 80 % / 95 % rule, WC-6). → the shared Meta client keeps the usage per connection (MC19); every lane turn and the fast lane call `readConnectionUsage` (its Redis copy for gate 1, Postgres behind it) before a Meta call — ≥ 80 % slows (boxes doubled), ≥ 95 % waits until `usage_wait_until`; the lanes keep no usage of their own, and a Facebook or ads call of the same business now slows Instagram's sends too. A send's own answer updates it through the client, after the call. → S13, P97: kept per connection, asset and type; the app-level usage once in `sending_states`. |
| SN24 | **A database limiter, not job places — and the send service ([P91](decisions.md), rev 5; scale review S1).** Today (rev 4): each concurrent job counts as one Postgres connection in `worker-connection-budget.ts`, so the places the lanes need (the plan's intake 5 → 20, fast 40 → 100, slow 40 → 50 per server) cannot boot under `DATABASE_POOL_MAX` (80) or Neon's `max_connections`, although a send holds a connection only for its claim and its save (no transaction across the Meta call). → (1) **one in-process limiter** shared by the send, intake and task workers of a process (≈ 16–24 slots; env `WORKER_INSTAGRAM_DATABASE_SLOTS`, be-env-schema-add — kickoff confirms the name): every unit of work (the claim, `saveSendResult`, an intake event, a task piece) takes a slot first; no slot within **2 s** → the ticket goes back (re-delayed, no try used); (2) those workers' `resolvePostgresConcurrency` reports the limiter's size, so the budget counts slots, not job places; (3) the send concurrency settings get their own maximum (SN2); (4) the two send queues run as **their own service** (queue family `instagram-send`, `WORKER_QUEUE_FAMILIES`), so the API's, the workers' and the send service's pools are sized apart; (5) the arithmetic for now (2 servers, 20–200 accounts) and for 1,000 accounts goes into `resource-limits.md`. Other option: keep counting one connection per place — the boot check refuses the plan's places. |

### 6.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| SNQ1 | Keep `app.sending_helper_slots` (16 slots leased by servers, plan §34.1)? | **drop it** — the repair runs as scheduler repeat jobs, one worker per tick (P7) · keep it as the plan writes | **drop** — BullMQ already gives each repeat tick to one worker, so the slot lease has nothing left to share; the two per-server duties (clock, Redis watch) need no slot. db-changes would lose the table | **P73** — drop `app.sending_helper_slots` (as recommended) |
| SNQ2 | `.env.example`'s `SENDING_ENABLED` | **`true`** — the repository rule: the dev value ships active, the schema default stays `false` · `false` in the template too | **`true`** (CLAUDE.md "the dev value ships ACTIVE in `.env.example`"); safe because a hosted environment still needs its own `SENDING_ENVIRONMENT_ID` to match its database's row | **P74** — `true` in the template (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

Until answered, the plan follows the recommendation and every row that rests on it says so.

### 6.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.instagram_send_lanes` | one row per account and lane — its turn, lease, box, limits and error stop (pause, suspend and the plan stop are 1B's — CA3, P99) | four rows per account, made at connect (channel-connection writes them through this sub-domain's service); never deleted while the account lives |
| `app.instagram_send_stops` | the history of every stop of a lane or of all lanes | plain; deleted after 90 days by the hourly, time-budgeted clean-up (WC-53, P92) |
| `app.instagram_send_minute_counts` | messages sent per account, count group and minute — gate 2 | raised in the claim's commit; rows over 2 hours old deleted (WC-20) |
| `app.message_month_counts` | DMs sent per organization, month (its time zone) and slot | raised in the claim's commit; kept 13 months (WC-54); never recounted |
| `app.sending_states` | one row for the whole system — environment id, settings version, the all-accounts stop and test | **no organization** (P16): maintenance login only |
| `app.instagram_messages` | one message we send or plan to send, of a run or a broadcast | **split by week** of its run's start, about 30 days (P33, P13); public id |
| `app.instagram_send_attempts` | one call to Meta for a message | **split by day**, 8 days (P33, D16) |
| `app.instagram_attachments` | Meta's id for an uploaded file, per account | one per account and upload; the upload by public id only (P25) |

```text
tenancy.organizations ──< app.message_month_counts                      the month meter (16 slots)
   │
   └──< app.channel_accounts ──┬──< app.instagram_send_lanes (4)              slow · reply · fast · broadcast
                               ├──< app.instagram_send_stops                  every stop, 90 days
                               ├──< app.instagram_send_minute_counts          gate 2
                               ├──< app.instagram_attachments ┄┄ upload.uploads    by public id (P25)
                               └──< app.instagram_messages ──┬──> app.automation_runs (3)   or …
                                         (by week)           ├──> app.broadcasts (7)        … exactly one
                                                             └──< app.instagram_send_attempts ┄┄ (by day; copies, no key)
   app.sending_states (one row, no organization)

A ──< B   one A has many B     A ──> B   a column on A points at one B     ┄┄  by value, no foreign key
```

Pointing at these from other sub-domains: nothing (partitioned tables take no foreign key in). Copies kept without a
reference on messages and attempts: account, automation, contact (db-changes).

**PostgreSQL design**

Standard columns on every tenant table: `organization_id bigint` → organizations `ON DELETE CASCADE`, the composite
(`organization_id`, `channel_account_id`) → `app.channel_accounts` `ON DELETE CASCADE` where the row belongs to an
account; RLS enabled and forced, an organization policy with `USING` and `WITH CHECK`, plus the
`app.global_retention_cleanup` arm in `USING` only where a repair duty reads ids across organizations. No soft delete, no
`*_by_user_id` (nobody signed in writes here, except the retry's audit), no branch rule. Hot counter rows (`lanes`, minute
and month counts) take `fillfactor = 80` for HOT updates (plan §37.2). Every sending transaction sets `SET LOCAL
lock_timeout = '1s'` and `statement_timeout = '5s'` (plan §35.3). Each table's design is in its nested sub-domain.

### 6.4 Permissions

No new code. Its two routes reuse the launch's `instagram-account:read` and the existing `organization:read`; the
failed-messages routes it serves are gated in 4 (`automation:read` · `:update`) and 3 (`contact:read` · `:update`).

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `instagram-account:read` | Instagram account · View | an account's sending status | 63 | Owner, Admin, Editor, Viewer |
| `organization:read` | Workspace · View | the organization's DM meter and notices | 64 | Owner, Admin, Editor, Viewer |

### 6.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app`; every route team only (reads: personal organization → `404 team_organization_required`; writes → `422`) |
| Auth | `Authorization: Bearer <access token>`; organization from the token |
| Writes | none here — both routes are reads (the retry `POST`s are 3's route 26 and 4's route 37, each `req`) |
| Success | `200` with `{ data, meta }`; no lists here |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `409`, `422` (idempotency key missing or reused), `429` |

### 6.6 Objects returned

| Object | Where |
| --- | --- |
| Instagram sending status · App usage | 6.A.6 — Instagram sending |
| Failed messages summary · Failed messages retry | 3.A.6 — Contacts (routes 25–26, and 4's 36–37) |

### 6.7 Routes

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 63 | GET | `/social/instagram/accounts/{channel_account_id}/sending-status` | What the account's banners need **(new)** | `instagram-account:read` | — | RC-35 |
| 64 | GET | `/usage` | The organization's DM meter, accounts used and notices **(new)** | `organization:read` | — | RC-56 |

The failed-messages routes (RC-37–RC-40) live in the sub-domains whose paths they have — 4's routes 36–37
(`/automations/{automation_id}/failed-messages/…`) and 3's routes 25–26 (`/contacts/{contact_id}/failed-messages/…`) —
and call this sub-domain's summary query and retry service (6.B, SN18; Merge notes M6).

### 6.8 Request details

In each nested sub-domain (6.A to 6.C, section .8).

### 6.9 Errors

Every route can answer the errors in 6.5; each route's own errors are in its nested sub-domain (6.A to 6.C, section .9).

### 6.10 Rules worth knowing

**A lane turn** (slow, reply, broadcast; plan §28.1) — each ticket is one turn, one send at most:

```text
ticket <lane>-<cha>-<turn> ──► lock the lane row (skip locked) · this turn? lease free? · stops, the account's pause / suspend / plan stop (1B), test
   ──► box second reached? (else re-delay to it) ──► pick one message (6.A.10) ──► re-check her, the run, the automation
   ──► gate 1 (Redis, advisory) ──► ONE commit: gate 2 + month + `sending` + attempt + lease 120 s
   ──► Meta call (≤ 15 s, no transaction open) ──► saveSendResult (retried inside, SN4) ──► next ticket at the next box
fast message (plan §30): ticket fast-<igm>-<tries> at not_before ──► her lock · one of hers `sending` at a time ·
   window open? · fast lane row (stops, ≤ 20 sending, ≤ 5 audio) ──► the same commit ──► upload if needed (6.C) ──► call ──► save
```

**Every piece of background work and its worker-changes row** (the plan's helper rules in brackets):

| WC | Piece | Where (`instagram-sending/…`) | When |
| --- | --- | --- | --- |
| WC-5 | slow-lane turn — opening DMs, new : old 4 : 1 (3 : 2 under 12 h), ≤ 5 picks, box 3600 ÷ hour limit (600, ≤ 700; new account 150 for 7 days), ≥ 1.5 s apart, half speed ×2 | `workers/instagram-send-slow.processor.ts` (lane `slow`) | each box second |
| WC-6 | reply-lane turn — public replies and hides after their DM; OFF at once, ON 80 % chance, the automation's box (10–100), 20 s apart, ≤ 500 waiting; the connection's Meta usage (P51, SN23) at 80 % doubles the boxes, 95 % waits | same processor (lane `reply`) | each turn |
| WC-7 | fast messages — answers, lists (waits 1 min – 23 h), the 60-minute nudge, follow checks, email and phone questions, Live replies, mark as seen, the PRO extra delay | `workers/instagram-send-fast.processor.ts` | at `not_before` |
| WC-8 | broadcast-lane turn — 600 an hour (≤ 2,000), soonest-closing window first, once per person in 24 h, too-fast ×2 **As built (R45, [P413](decisions.md))**: the lane rules `instagram-broadcast-lane.service.ts`; the `owner_chat` re-check is intake's hook (no owner-typed time kept); `last_broadcast_at` also on `unknown`; a slow / fast too fast holds this lane too | slow processor (lane `broadcast`, priority 10) | each turn |
| WC-13 | lost turns put back; idle lanes with work; late fast messages; `sending_count` repaired; ended stops (fast spread over 5 min) [5–9] | `repair-lost-turns` | every minute |
| WC-14 | lease over / fast `sending` over 120 s → `unknown` through `saveSendResult` [2, 7] | `repair-stuck-sends` | every minute |
| WC-15 | waiting opening DMs, replies, hides past comment + 7 days − 30 min → `expired` (`plan_limit` when behind the month stop) [10] | `repair-expiry` | every minute |
| WC-16 | Live still on air? else its replies `expired` · `live_ended` [10] | `live-check` | every minute |
| WC-17 | window closed → waiting answers, lists, nudges `skipped` · `window_closed` [11] | `repair-closed-windows` | every minute |
| WC-18 | over 500 waiting replies on an ON automation → oldest `skipped` · `hour_limit` [12] | `repair-reply-trim` | every minute |
| WC-19 | an automation paused with Cancel → its waiting messages `cancelled` [23] | `repair-paused-cancel` | every minute |
| WC-20 | Redis vs minute counts, month count vs its slots; minute rows over 2 h deleted; daily month vs tried DMs [13, 27] | `repair-counts` | every minute / 24 h |
| WC-21 | Redis lost → schedulers, gate counts, turns rebuilt (SN10) | in each worker process | on Redis's return |
| WC-22 | Instagram down per account (3 in a row: 5, 10, 20, 40 min) and for all (30 % of 50 calls in 30 s, or 30 % of accounts); app limit 15, 30, 60 min [16] | `outage-check` | every 10 s |
| WC-23 | server clock vs Postgres, over 2 s → no tickets on this server [15] | in each worker process | every minute |
| WC-24 | "will go / may expire" estimate per account with waiting opening DMs [17] | `waiting-estimate` | every 10 min |
| WC-32 | upload a message file to Meta once per account (6.C) | `instagram-tasks` · `attachment-upload` | go-live, file change, or at send |
| WC-37 | month wake at the 1st (organization time zone) or an upgrade — clears the accounts' `plan_limit` (1B) [24] | found by `repair-month-wake`, job `month-wake` on `instagram-tasks` | every minute |
| WC-38 | plan change at period end: the accounts' plan stop on 1B (`plan_downgrade`, `plan_ended`), PRO parts off; backup every 15 min [29] | `instagram-tasks` · `plan-change` (billing reports it) | on billing's event |
| WC-42 | retry failed messages, 500 at a time, once each (6.B) | `instagram-tasks` · `retry-failed` | 4's route 37, 3's route 26 |
| WC-49 | send attempts' day parts past 8 days dropped | shared partition upkeep (5.B WHC13) | daily |
| WC-50 | messages' week parts past about 30 days dropped | shared partition upkeep | daily |
| WC-53 | stop history over 90 days deleted in batches (recipients: sub-domain 7) | hourly clean-up (time budget, P92) | every hour |
| WC-54 | month counts over 13 months deleted | hourly clean-up (time budget, P92) | every hour |
| WC-55 | the two split tables' parts made ahead (attempts by day, messages by week; with 4's three and 5's two — seven split tables since rev 5, P96) | shared partition upkeep (owned by 5) | daily, and at worker start |
| WC-56 | 80 % / 100 % notices and emails, once per month; the accounts' `plan_limit` stop (1B) [25] | the claim's commit (after it), backup in `repair-month-notice` | at the crossing / every minute |
| WC-57 | owner problem emails (one kind per account per 6 h; through `auth.mail_outbox` with a dedupe key) [14] | `repair-owner-emails` | every minute |

**As built (ROUTE row R43, [P411](decisions.md)).** WC-5 is `InstagramSlowLaneRules` and WC-6 `InstagramReplyLaneRules`
(`instagram-sending/instagram-slow-lane.service.ts`, `instagram-reply-lane.service.ts`), plugged into the send core's
lane rules — not separate processors: both lanes' tickets reach the one slow-queue processor and the core (R37, R42).
The lane's pace columns (`box_start`, `last_sent_at`, `pick_count`) are written in the turn's release; a pick's check
again ends a message through `InstagramMessageService.endWaitingMessage`; the reply box second is a hash of the
automation and its box start; the text is composed at the last moment by `InstagramSendComposeService` (the fast lane
reuses it, R44).

**As built (ROUTE row R44, [P412](decisions.md)).** WC-7 is `InstagramFastLaneRules`
(`instagram-sending/instagram-fast-lane.service.ts`), plugged into the core's lane rules: its `checkFastMessage` runs
§30.2 step 6 before the claim; the claim's one commit takes her contact (`NO KEY UPDATE SKIP LOCKED`), one of hers
`sending` at a time, and — on the locked fast lane row — the account's 20 (`sending_count`, given back by the result
save), 5 audio and **S21**'s 25 fast sends in flight per organization. The ticket `fast-<igm>-<tries>` is added by
the message service after the waiting save's commit, at a `not_before` of 500–2,000 ms (plus the PRO extra delay on her
event's first answer, cut at 25 s; at once after a follow check). Buttons carry `<aut>::<run>::<igm>`. "Seen" after a
reply is not sent while `mark_seen` is go-live-gated (P36).

Rules: no piece sends twice (the `sending` claim, `unknown` never sent again by itself, Instagram refuses a second
private reply); intake and the repair never send; Redis is never called inside a transaction; Meta is never called inside
one; every database unit of a send, intake or task worker takes a slot of the in-process limiter first (SN24).

### 6.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| SNC1 | SN1: folders `app/sub-domains/instagram-sending/`, `…/instagram-message/`, `…/instagram-attachment/`; `instagram-sending.overview.md` (the lane turn, the gates, the stop groups, the WC map) and one per nested folder; the app container wiring (`channelSendingPorts.instagram`, services exposed to sub-domain 5 and to channel-connection); `PUBLIC_ID_PREFIXES.instagramMessage` (`igm`, P22); OpenAPI tag `Instagram Sending`; `src/domains/CLAUDE.md` sub-domain map; `src/FLOWS.md` "a comment → a DM" rewritten |
| SNC2 | SN2: queues `instagram-send-slow`, `instagram-send-fast`, `instagram-tasks` (`queues/*.queue.ts`, `.job.schema.ts` — `organizationPublicId` in every payload); their workers in `worker-registration.registry.ts` (`criticality: 'throughput'`, `isEnabled: () => env.SENDING_ENABLED`, not provider-pausable; the two send queues in family `instagram-send`, their Postgres concurrency the limiter's size — SN24); env `WORKER_CONCURRENCY_INSTAGRAM_SEND_SLOW` / `_SEND_FAST` / `_TASKS` with their own maximum (P91) (env schema, `.env.example`, `src/tests/setup.ts`, be-env-schema-add); the pinned registry counts; `resource-limits.md`, `worker-scaling.md`, `redis-topology.md`, `workers-and-events.md` **As built (R37, [P408](decisions.md))**: the limiter is counted once per process through the registry's `databaseSlotLimiterName` (not per queue); the places default 50 / 100 / 20; the ticket work is `appDomain.instagramSendWork`, empty until R40–R46. |
| SNC3 | SN3, SN4: `instagram-send-gate.service.ts` (gate 1 with its timeout skip, gate 2, the month check — one commit), `saveSendResult` in 6.B; tests: two servers racing one minute never pass the hour limit; a failed save after Meta answered is retried and, when it keeps failing, ends `unknown` and is never sent again **As built (R42, [P138](decisions.md))**: `InstagramSendGateService` (gate 1 `app:instagram_send_gate:…`, the claim locks the lane row) and `InstagramSendCoreService` (the turn, the call, the save retried inside the send — a slot miss waits, never the ticket back after the call); the lanes plug in through `InstagramSendLaneRules` (R43–R45). |
| SNC4 | SN5: `instagram-send-error.util.ts` — the code → group table (6.A.10) as constants (P4), one group per code checked by `validate:constants`; the stop rules in the lane service; the `in a row` and `30 %` reads on the attempts; nock contract tests per group **As built (R42, [P138](decisions.md))**: the table is `INSTAGRAM_SEND_ERROR_CODE_GROUPS` in the sending settings file (one group per code proved by a unit test — `validate:constants` scans numeric literals only); the stop rules are the send core's; the app limit's second account is two columns on `app.sending_states` (`20261125174213_app_instagram_send_core.sql`); S14 stays one `meta` circuit, an open circuit reading `never_connected`. |
| SNC5 | SN6: `ScheduledJob.everyMilliseconds` in `scheduler.ts` (exactly one of `cronPattern` / `everyMilliseconds`), its unit test; queue `instagram-sending-repair` and its scheduler entries — **one per duty** (P94): the thirteen `repair-*` jobs `* * * * *`, `outage-check` 10,000 ms, `live-check` `* * * * *`, `waiting-estimate` `*/10 * * * *`, the hourly clean-ups (P92: a ≈ 10-minute budget, per-table caps); each duty a function that works until its 40 s budget is spent, re-adds tickets with `addBulk`, reports its round time and backlog, and has a DB test that running it twice changes nothing; the "oldest row past its keep time" gauge per cleaned table (P92); the `tenant-scoped-job-data` exemptions for the cross-organization reads |
| SNC6 | SN7: env `SENDING_ENABLED` (default `false`) and `SENDING_ENVIRONMENT_ID` (production `.refine()`: required when sending is on) — env schema, `.env.example` (SNQ2), `src/tests/setup.ts`, GitHub environments through `pnpm github:sync`; the environment-id and settings-version check at worker start and per minute; `prepareDatabase` creating the `app.sending_states` row when missing; a test that a copy with another id sends nothing; `minimum_compatible_settings_version` written by each release (raised only when incompatible), the take-no-tickets check against it, a test that an older-but-compatible server keeps sending, the rollback step and command in be-path-to-production (P95) |
| SNC7 | SN8, SN9: the month count in the claim; the plan's `message_month_limit` and features read through billing's service (cross-domain, a service import); the plan stops and their wake (WC-37, WC-38 handlers on `instagram-tasks`); PRO parts read at run time; tests at 79 %, 80 %, 100 % and across a time-zone midnight on the 1st **As built (R42, [P138](decisions.md))**: the month in the claim's commit; a full month refuses the claim and the filling DM starts `plan_limit` on every account of the organization (the reply lane goes on); the wake and plan change handlers stay R52, the notices R53, PRO parts at run time R43–R44. |
| SNC8 | SN10, SN11: the Redis watch in the worker bootstrap (`src/infrastructure/queue/bootstrap.ts`), its rebuild lock; the three copies as `*.cache.ts` files following be-read-cache-guard (keys from the verified scope, tombstone after commit, fail-open, TTL ≤ 60 s, the five tests each) |
| SNC17 | SN24 ([P91](decisions.md)): the in-process database limiter (one semaphore per worker process, a 2 s acquire, the ticket back on a miss) used by the send, intake and task processors; their `resolvePostgresConcurrency` reports its size; env `WORKER_INSTAGRAM_DATABASE_SLOTS` (env schema, `.env.example`, `src/tests/setup.ts`, be-env-schema-add); the send service in the deploy config (`WORKER_QUEUE_FAMILIES` = `instagram-send`) and its pool; `resource-limits.md` with the now and 1,000-account arithmetic; tests — the budget check passes at the plan's places, a ticket with no slot in 2 s goes back with no try used **As built (R37, [P408](decisions.md))**: `worker-database-slot-limiter.ts` (2 s, then the ticket back 5 s later, no try used); the send service is named `worker-send` in the runbooks — the deploy workflow's third service waits on the owner (a Railway service and its id); intake joins the limiter at R38. **Superseded ([P140](decisions.md), owner 2026-11-25)**: no send service — the send queues are family `instagram` and run in the existing, deployed `worker` service (no `instagram-send` family, no `worker-send`, no `RAILWAY_SEND_WORKER_SERVICE_ID`); `WORKER_INSTAGRAM_DATABASE_SLOTS` defaults to 3 so the one worker's `61 + slots` fits the default pool of 80 with burst headroom, and a deployment raises `DATABASE_POOL_MAX` with the slots (`resource-limits.md`). |
| SNC9 | `/health` readiness adds sending checks (repair age, late tickets, clock skew, settings version) — `health.middleware.ts` (plan §40.1); metrics for the alerts of plan §40.3 |

### 6.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/instagram-sending/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 6.A Instagram sending | folder root | `app.instagram_send_lanes`, `app.instagram_send_stops`, `app.instagram_send_minute_counts`, `app.message_month_counts`, `app.sending_states` | 63–64, the four lanes, the repair duties | final (rev 5, confirmed 2026-11-24) |
| 6.B Instagram messages | `instagram-message/` | `app.instagram_messages`, `app.instagram_send_attempts` | — (`saveSendResult`, the retry service behind 3's 25–26 and 4's 36–37) | final (rev 5, confirmed 2026-11-24) |
| 6.C Instagram attachments | `instagram-attachment/` | `app.instagram_attachments` | — (file upload task) | final (rev 5, confirmed 2026-11-24) |

---

### 6.A Instagram sending — `instagram-sending/` (folder root) — final (rev 5, confirmed 2026-11-24)

#### 6.A.1 Decisions

| # | Decision |
| --- | --- |
| SN12 | **Lanes (D4, plan §19.10).** Four rows per account made in channel-connection's connect commit (RC-3) through `InstagramSendLaneService.createLanesForAccount`, the reconnect reusing them. `state`: `ready` · `working` · `sleeping` · `stopped` (fast: `ready`, `stopped` only). The lane holds its **error stop** only (`stop_reason` one of the stop groups, `stop_until` — empty = the owner must act, `stop_count`, codes, `stop_cleared_at`). The **plan stop** (`plan_limit` · `plan_ended` · `plan_downgrade`), the owner's pause and the team's suspend live on the channel account (1B — `plan_stop_reason`, `plan_stopped_at`, `paused_at`, `suspended_at`; P42, [P99](decisions.md)) and a lane turn reads them in its unit of work — `plan_limit` holds the slow, fast and broadcast lanes and lets the reply lane go on (D62), the other two hold all four; the lanes carry no copy (rev 1 had `paused_at` and `suspended_at` here, rev 4 a `plan_stop_reason` — moved in rev 5). So a plan stop and an error stop both hold at once (SN9). The slow row also holds the account's one test claim (`testing_lane`, `testing_until`); the fast row its `sending_count` (≤ 20). |
| SN13 | **Stops history (plan §33.2 rule 9).** Every stop that starts writes an `app.instagram_send_stops` row (lane, or `all` for a plan stop or an account-wide one; reason; codes; `started_at`; `stop_until`) in the same commit, and its end sets `ended_at` and `ended_by` (`time` · `test` · `owner` · `team`). Route 63 shows each lane's current stop from the lane row; the history serves the team and the "stop over 1 hour" email (WC-57). |
| SN14 | **Route 63, the sending status (RC-35).** Today: none. → one object for the account's banners (plan §15.2): per lane the waiting count, state, wait reason, next send time and its current stops; paused, suspended, the new-account limit and its end (connect + 7 days), the estimate (about how many will go, how many may expire, done at about), today's line (sent, not sure, skipped and of those "chat closed", expired — in the organization's day; → S8, P97: from a per-account, per-day counter row), the per-automation "chat closed" lines, and the last broadcast, past-comments and retry results (read from `app.broadcasts`, `app.automation_backfills` and the messages' `owner_retry_at` — no table of results). Read through the 10-second copy (SN11). |
| SN15 | **Route 64, the DM meter (RC-56, P14).** Today: `GET /auth/me/context` carries plan access only. → `GET /usage`: the month's `used` (sum of the 16 slots), `limit` (the plan's `message_month_limit`), `resets_on` (the 1st of next month in the organization's time zone), `state` `ok` · `nearly` (80 %) · `reached` (100 %); channel accounts used against the plan's `channel_accounts_max`; and the organization notices to show (limit nearly reached, reached, payment failed, plan ended, trial ends soon, being set up, paused) — billing's and tenancy's states read through their services. Dismissing a notice is the browser's (P27). |

#### 6.A.2 Open questions

SNQ1 (6.2) — answered P73: `app.sending_helper_slots` dropped; SNQ2 (6.2) — answered P74: `true` in `.env.example`.

#### 6.A.3 Tables and relations

`app.instagram_send_lanes` (no public id)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigint` (bigserial) | no | identity | primary key |
| `lane` | `varchar(9)` | no | | `slow` · `reply` · `fast` · `broadcast`; unique (`organization_id`, `channel_account_id`, `lane`) |
| `state` | `varchar(8)` | no | `'ready'` | `ready` · `working` · `sleeping` · `stopped`; fast only `ready` · `stopped` |
| `next_run_at`, `lease_until`, `box_start`, `last_sent_at`, `half_speed_until` | `timestamptz` | yes | | `lease_until` set exactly while `working` |
| `wait_reason` | `varchar(12)` | yes | | `box` · `gap` · `hour_limit` · `day_limit` · `not_before` · `stop` · `test` |
| `turn_number`, `working_turn` | `bigint` | no / yes | `0` / | `working_turn` set exactly while `working` |
| `pick_count` | `smallint` | no | `0` | slow only: 1–5 in the new : old mix |
| `day_date`, `day_count` | `date`, `integer` | yes | | slow, day limit only (off by default) |
| `stop_reason` | `varchar(24)` | yes | | an error stop group; `stop_until`, `stop_count` (`smallint`, ≥ 0), `stop_error_code`, `stop_error_subcode` (`integer`), `stop_cleared_at` |
| ~~`plan_stop_reason`~~ · ~~`plan_stopped_at`~~ | | | | **removed in rev 5** (P99) — the plan stop is the channel account's (1B, CA3; SN12) |
| `testing_lane`, `testing_until` | `varchar(9)`, `timestamptz` | yes | | slow row only |
| `sending_count` | `smallint` | no | `0` | fast row only, 0–20 |
| `updated_at` | `timestamptz` | no | `now()` | |

Indexes: unique (`organization_id`, `channel_account_id`, `lane`); `(next_run_at) WHERE state IN ('ready', 'sleeping')` and
`(lease_until) WHERE state = 'working'` — the repair's cross-organization reads. `fillfactor = 80`.

`app.instagram_send_stops`: `id`; account (composite); `lane` `slow` · `reply` · `fast` · `broadcast` · `all`; `reason`
(`varchar(24)`); `error_code`, `error_subcode`; `started_at` (default `now()`), `stop_until`, `ended_at`; `ended_by` `time` ·
`test` · `owner` · `team` (set exactly with `ended_at`). Indexes `(organization_id, channel_account_id, started_at DESC)`,
`(started_at)` (the 90-day delete).

`app.instagram_send_minute_counts`: primary key (`organization_id`, `channel_account_id`, `count_group`, `minute_start`);
`count_group` `open` · `reply` · `fast` · `broadcast`; `minute_start` (Postgres clock, to the minute); `count integer ≥ 0`.
Index `(minute_start)`. `fillfactor = 80`.

`app.message_month_counts`: primary key (`organization_id`, `month_start`, `slot`); `month_start date` (the 1st in the
organization's time zone); `slot smallint` 0–15 (from the account's id); `count integer ≥ 0`; `updated_at`. No account
column (P6 name; db-changes). Index `(month_start)` (the 13-month delete). `fillfactor = 80`.

`app.sending_states` (**no organization**, P16): `id smallint` primary key, `CHECK (id = 1)`; `environment_id varchar(64)`;
`settings_version varchar(32)`, `settings_version_since`, **`minimum_compatible_settings_version varchar(32)`** (rev 5 — SN7, P95); `all_stop_until`, `all_stop_reason` (`app_limit` ·
`instagram_down`), `all_stop_count`; `testing_lane`, `testing_until`; `updated_at`. RLS enabled and forced with **one**
policy: `USING` and `WITH CHECK` = `maintenanceBypassArm('app.sending_state_access')` — readable and writable only under a
new `MAINTENANCE_SCOPE.SENDING_STATE` on the maintenance login (the `audit.outbox` pattern); no grant to `meepzo_be_app`; a
documented exemption in the RLS guard tests.

Every tenant table: organization policy, enabled and forced, in `EXPECTED_FORCE_RLS_TABLES`; lanes and stops also carry
the `app.global_retention_cleanup` arm in `USING`. Branch rule: none. User pointers: none.

#### 6.A.4 Permissions

| Code | Routes |
| --- | --- |
| `instagram-account:read` | 63 |
| `organization:read` | 64 |

#### 6.A.5 Common to every route

As 6.5.

#### 6.A.6 Objects returned

**Instagram sending status** (route 63): `channel_account_id`, `is_paused`, `is_suspended`, `new_account_limit_until`,
`lanes[]` (`lane`, `state`, `waiting_count`, `wait_reason`, `next_send_at`, `stop` `{ reason, until, started_at }` or null,
`plan_stop` `{ reason, since }` or null — the account's plan stop when its reason holds that lane, CA3), `all_accounts_stop` `{ reason, until }` or null, `estimate` `{ waiting, will_go,
may_expire, done_at }` or null, `today` `{ sent, unknown, skipped, skipped_window_closed, expired }`, `window_closed_by_automation[]`
(`automation_id`, `count`), `last_broadcast` `{ broadcast_id, name, status, sent, skipped, replies }` or null,
`last_backfill` `{ automation_id, status, found, matched, queued }` or null, `last_retry` `{ automation_id | contact_id,
retried, cannot, at }` or null, `as_of`.

**App usage** (route 64): `direct_messages` `{ used, limit, resets_on, state }`, `channel_accounts` `{ used, maximum }`,
`notices[]` (`kind` `direct_message_limit_nearly` · `direct_message_limit_reached` · `payment_failed` · `plan_ended` ·
`trial_ending` · `being_set_up` · `paused`, `ends_on` or null).

#### 6.A.7 Routes (63–64)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 63 | GET | `/social/instagram/accounts/{channel_account_id}/sending-status` | What the account's banners need **(new)** | `instagram-account:read` | — |
| 64 | GET | `/usage` | The DM meter, accounts used, notices **(new)** | `organization:read` | — |

#### 6.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 63 | — | — | Instagram sending status |
| 64 | — | — | App usage |

#### 6.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 63 | `400` · `channel_account_id` | not an `cha_…` id |
| 63 | `404` · `instagram_not_connected` | no account of this organization by that id, or it is `revoked` (the launch reason) |
| 63, 64 | `403` · `missing_permission` | no `instagram-account:read` / `organization:read` |
| 63, 64 | `404` · `team_organization_required` | a personal organization |

#### 6.A.10 Rules worth knowing

**Picking the next message of a turn** (plan §28.2, §29, §30.14): slow — per live automation its best waiting opening,
new (under 60 minutes, newest first) and old (oldest first) mixed 4 : 1, 3 : 2 when under 12 hours are left, ad-comment
private replies included; reply — oldest first after its DM went; broadcast — the soonest-closing window first. A message
of a paused, stopped or deleted automation, an opted-out or excluded contact, or one past `not_before` rules is passed over.

**The stop groups** (SN5; plan §33.1):

| Group | Stops | Ends |
| --- | --- | --- |
| `too_fast` (613, 17, 32, 80002, 80006, HTTP 429) | that lane (reply/hide: the reply lane; broadcast: ×2) | Meta's time, else 15 · 30 · 60 · 120 · 240 · 360 min |
| `blocked` (368, 10/1893063, 100/2534029, 613/2018338) | all lanes (reply/hide: the reply lane) | tests after 24 h, 48 h, then every 72 h |
| `account_flagged` (4 with a subcode) | that lane | as blocked |
| `login_expired` (190) | every lane of every account of the connection; connection and accounts `error` | the owner reconnects |
| `account_not_shared` / not business or creator | that account's lanes; account `error` | reconnect |
| `access_off` (200/2534041, 10/2534077), `app_not_approved` (200/2018028) | all lanes of the account | hourly test |
| `app_limit` (4 without subcode, 341; 2 accounts in 5 min) | all accounts (`app.sending_states`) | 15 · 30 · 60 min |
| `instagram_down` (3 bad in a row; 30 % of 50 calls in 30 s) | the account (5 · 10 · 20 · 40 min) or all | its time |
| `wrong_permission` (other 10, 200–299; 3 people in a row) | all lanes of the account | reconnect |
| per message: `person`, `window_closed`, `comment_gone`, `live_ended`, `attachment_failed`, `bad_text` (5 in a row stops the automation), `try_later`, `no_answer`, `never_connected`, `already_sent` | only that message | — |

#### 6.A.11 Code changes

| # | Change |
| --- | --- |
| SNC10 | SN12, SN13: the lane and stop schemas and repositories (guarded updates of turn, lease and the error stop; the plan stop is 1B's since rev 5); `createLanesForAccount` for channel-connection; the migration for the five root tables (new dated files after the launch's, in build order); `EXPECTED_FORCE_RLS_TABLES`; the `SENDING_STATE` maintenance scope; DB tests: a stronger stop wins, a plan stop (on the account) and an error stop (on the lane) both hold, `plan_limit` leaves the reply lane going, a lane is never worked by two turns |
| SNC11 | SN14, SN15: routes 63–64 — controller, serializer, the read service and its cache file; the route schemas (summary, description, tag); `pnpm routes:catalog` (O column `team`), success statuses, `docs:generate`; integration tests: every banner field from seeded rows, a personal organization `404`, another organization's account `404` (and as `meepzo_be_app`) |
| SNC12 | Seeds: `instagram-sending/seed/` — four lanes per seeded account, stops, minute and month counts for the meter; no reference seed |

**As built (ROUTE row R18, [P305](decisions.md)–[P308](decisions.md)).** The five root tables plus S8's
`app.instagram_send_day_counts` (an account's results of its organization's day) in
`20261124143012_app_instagram_sending.sql`; S29's estimate as `estimate_*` columns on the slow lane row; S13's
app-level usage as `app_usage_percent` / `app_usage_read_at` on `app.sending_states`, whose policy arms
`app.sending_state_access` (`MAINTENANCE_SCOPE.SENDING_STATE`). SN11 builds one Redis copy — the month count; route
63 has none (be-read-cache-guard: too many writers) and the estimate is read from Postgres. The lane steps: a wake gives
`stopped` / `sleeping` lanes without an error stop a new turn (no ticket — R37, R47); `stopLanes` records a plan stop
in the history; the break's stop is the lane port's `startBrokenAccountStop`. The sending settings file is
`instagram-sending.constants.ts`. The environment-id and settings-version check is `SendingStateService.mayTakeTickets`
(the workers that ask it are R37, R42, R47); `prepareDatabase`'s `sending state` step runs `pnpm ops:sending-state`
(`--minimum <n>` is the rollback command). SNC9's readiness part is `sending` in the verbose body; repair age, late
tickets and clock skew come with R47–R48, the Redis watch (SN10) with R48.

---

### 6.B Instagram messages — `instagram-sending/instagram-message/` — final (rev 5, confirmed 2026-11-24)

#### 6.B.1 Decisions

| # | Decision |
| --- | --- |
| SN16 | **One row per message, of a run or a broadcast (plan §19.1).** Today: the run holds a send claim and sends inline (launch D16). → `app.instagram_messages` — written through `ChannelSendingPort` — by the shared run engine (called by intake, 5) and the broadcast audience (7); `InstagramMessageService` is Instagram's implementation (SN22), sent by the lanes, finished by `saveSendResult`. Exactly one of `automation_run_id` / `broadcast_id` (`num_nonnulls = 1`; `message_type = 'broadcast'` exactly with a broadcast). **Moving between lanes** (an opening DM from slow to fast when her chat opens, plan §27.13) changes the same row while it is `waiting` (a conditional update). Status machine (plan §20.7): `waiting` → `sending` → `sent` · `unknown` · `failed`; `waiting` → `skipped` · `cancelled` · `expired`; `unknown` → `waiting` once, only on her next message or tap (D17); `failed` → `waiting` once by the owner's retry (SN18). `reason` (about 30 values, plan:L3287–L3317) adds `replaced` (P35). |
| SN17 | **Split by week of the run's start, about 30 days (P33, P13, D50).** `PARTITION BY RANGE (automation_run_started_at)`, one part per ISO week; a broadcast row puts its recipient's creation time there. Primary key `(id, automation_run_started_at)`, unique `(public_id, automation_run_started_at)`; tickets carry both, so every lookup prunes to one part. Foreign keys **out**: (`organization_id`, `automation_run_id`, `automation_run_started_at`) → `app.automation_runs` (`organization_id`, `id`, `started_at`) `ON DELETE CASCADE` (runs are split by month of their start since rev 5 — P96, AU36 — so the key carries the start; a run's part is dropped about 98 days after its month, long after its messages' part went); (`organization_id`, `broadcast_id`) → `app.broadcasts` `ON DELETE CASCADE` — **added by sub-domain 7's migration**, since broadcasts build after this table. Parts are dropped once their week ends more than 30 days ago (WC-50), so "what happened" and "retry" read about the last 30 days (P13). |
| SN18 | **Retry failed messages (D72) — the service behind 4's routes 36–37 and 3's routes 25–26.** Today: none. → the summary (36, 25) counts this automation's (or contact's) `failed` messages of the last 30 days: how many can go again now and how many cannot, by reason — `too_old` (an opening private reply past comment + 7 days − 30 min), `chat_closed` (any other DM while her window is closed), `final_for_person` (she blocked us, user not found, no consent, opted out, paused by the owner), `text_refused` (the automation still stopped `bad_text`), `already_retried` (`owner_retry_at` set), `broadcast` (never retried). The retry (37, 26) answers at once with the same counts and adds one `retry-failed` job on `instagram-tasks` (job id `retry-failed-<aut_… or con_…>`, so a second press while it runs adds nothing); the job moves the allowed ones back to `waiting` 500 at a time with `owner_retry_at` = now, re-checking each under its contact lock; they go through the normal lanes, gates, limits and the month count. One audit entry per press (`app.instagram_message.retry`, with the counts). Other option: retry inside the request — up to thousands of rows in one call. |
| SN19 | **Send attempts (plan §19.2, D16).** One row per call to Meta, written in the claim's commit (`started_at`, lane, count group) and finished by `saveSendResult` (`result_group`, HTTP status, codes, `duration_milliseconds`). The source of "in a row", "30 % bad" and the outage check (SN5). Split by day of `started_at`, 8 days (P33); primary key `(id, started_at)`; copies of message, automation and contact ids without a reference. |

#### 6.B.2 Open questions

None.

#### 6.B.3 Tables and relations

`app.instagram_messages` — split by week of `automation_run_started_at`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id`, `public_id` | `bigint`, `varchar(28)` | no | | `igm_…` (P22); keys as SN17 |
| `channel_account_id`, `automation_id`, `contact_id` | `bigint` | no / yes / no | | copies, no reference; `automation_id` empty only for a broadcast |
| `automation_run_id`, `broadcast_id` | `bigint` | yes | | exactly one (SN16) |
| `automation_run_started_at` | `timestamptz` | no | | the partition key |
| `message_type` | `varchar(16)` | no | | the 11 values of db-changes |
| `message_number`, `version_number`, `wording_number`, `text_number` | `smallint` | yes | | 1–10 (broadcast 1–3), 1–3, 1–10 |
| `message_kind` | `varchar(14)` | no | | `text` · `image` · `cards` · `quick_replies` · `audio` · `file` · `post` |
| `lane` | `varchar(9)` | no | | `slow` · `reply` · `fast` · `broadcast` |
| `channel` | `varchar(14)` | yes | | `private_reply` · `direct` · `comment_reply` · `comment_hide`; empty only for `follow_check` |
| `is_counted_as_direct_message` | `boolean` | no | | P21 name |
| `status` | `varchar(9)` | no | `'waiting'` | the 8 values (SN16) |
| `reason` | `varchar(30)` | yes | | the plan's list + `replaced` |
| `not_before`, `trigger_occurred_at`, `sending_at`, `sent_at`, `owner_retry_at` | `timestamptz` | yes | | `sending_at` set exactly while `sending`; `sent_at` exactly when `sent` |
| `tries`, `asks` | `smallint` | no | `0` | ≥ 0 |
| `instagram_message_id` | `varchar(128)` | yes | | Meta's `mid` |
| `error_code`, `error_subcode` | `integer` | yes | | codes only, never Meta's text |
| `created_at`, `updated_at` | `timestamptz` | no | `now()` | |

Indexes (local to each part): unique `(public_id, automation_run_started_at)`; the pick — `(channel_account_id, lane,
not_before) WHERE status = 'waiting'`; per run `(automation_run_id) WHERE automation_run_id IS NOT NULL`; per broadcast
`(broadcast_id, status) WHERE broadcast_id IS NOT NULL`; the own-message lookup (5, WHQ1) `(channel_account_id,
instagram_message_id) WHERE instagram_message_id IS NOT NULL`; the person limit `(contact_id, sent_at) WHERE status =
'sent'`; the retry summaries `(organization_id, automation_id, created_at) WHERE status = 'failed'` and, as built, `(organization_id,
contact_id, created_at)` for every status (route 24 and the contact's failed messages — [P136](decisions.md)); the
run place unique `(organization_id, automation_run_id, message_type, message_number, message_kind,
automation_run_started_at) NULLS NOT DISTINCT` (plan §19.1); the expiry `(trigger_occurred_at) WHERE status =
'waiting' AND lane IN ('slow', 'reply')`. RLS: organization policy + the retention arm in `USING`; enabled and forced.

`app.instagram_send_attempts` — split by day of `started_at`: `id`, `organization_id`, copies `channel_account_id`,
`instagram_message_id` (our message's id, not Meta's), `automation_id`, `contact_id`; `lane`; `count_group` (`open` ·
`reply` · `fast` · `broadcast` · `none`); `started_at`; `result_group` (`sent` or a group of 6.A.10; empty while the call
runs); `http_status`, `error_code`, `error_subcode`; `duration_milliseconds`. Indexes `(channel_account_id, started_at
DESC)` ("in a row", the outage check), `(started_at)`. RLS as messages.

**As built (ROUTE R19, [P136](decisions.md)):** migration `20261125090000_app_instagram_messages.sql` with
`app.fn_create_weekly_partitions` (ISO weeks); public id `igm`; `message_kind` NOT NULL, `trigger_occurred_at`
nullable; the reason list adds `wait_expired`, `following`, `not_following`. The retry runs in the request
(`is_queued: false`) until the `retry-failed` job lands (R46); route 24's run-event items carry `id: null`.

#### 6.B.4 Permissions

None — 6.B has no routes; the failed-messages routes are gated in 4.A and 3.A.

#### 6.B.5 Common to every route

As 6.5.

#### 6.B.6 Objects returned

None of its own — the **Failed messages summary** and **retry** objects are 3.A.6's (routes 25–26, 4's 36–37).

#### 6.B.7 Routes

None — the failed-messages routes are 4's 36–37 and 3's 25–26 (M6).

#### 6.B.8 Request details

None.

#### 6.B.9 Errors

None of its own — 3.A.9 and 4.A.9.

#### 6.B.10 Rules worth knowing

- Only `saveSendResult` changes a message once it was claimed; every other writer touches `waiting` rows only, with a
  guarded update.
- A message's text is never stored here: the lane reads it from the automation (or broadcast) at the last moment, with
  `{name}` filled at send.

#### 6.B.11 Code changes

| # | Change |
| --- | --- |
| SNC13 | SN16, SN17, SN19: the two schemas (Drizzle parent declarations; parts by the shared upkeep — two specs: messages weekly, 3 ahead, keep 30 days; attempts daily, 3 ahead, keep 8), repositories and `InstagramMessageService` — Instagram's `ChannelSendingPort` (create waiting rows for the run engine and 7, move lanes, cancel by run / automation / broadcast, the own-message lookup, `saveSendResult`); the run's send claim columns (`sending_message_kind`, `sending_started_at`) leave with automation-run's change; DB tests for every status move, the lane move, and `unknown` never re-sent by itself |
| SNC14 | SN18: the summary query and the retry service that 4's routes 36–37 and 3's routes 25–26 call, the `retry-failed` task handler on `instagram-tasks` (500 a piece, `owner_retry_at` once), the audit action `app.instagram_message.retry`, i18n for its banner; tests with 3's and 4's route tests: each `cannot` reason, a second press adds no job and retries nothing twice, a Viewer `403`, another organization's automation `404` (also as `meepzo_be_app`) |

---

### 6.C Instagram attachments — `instagram-sending/instagram-attachment/` — final (rev 5, confirmed 2026-11-24)

#### 6.C.1 Decisions

| # | Decision |
| --- | --- |
| SN20 | **Upload once per account; the upload by public id only (P25, D29).** Today: the launch sends text and links only. → a message file (image, audio, PDF) is uploaded to Meta **once per account** and Meta's id kept in `app.instagram_attachments` (one row per account and upload); at go-live or a file change of a live automation (WC-32 on `instagram-tasks`), or just before a send when the row is missing (3 tries, then the message `failed` · `attachment_failed`, not counted). The row names the upload by its **public id** (`upl_…`), read through `UploadService` — no foreign key into `upload.uploads` (P25). When Meta says the file is gone (`attachment_failed` group), the row is deleted, the counts given back and the message goes back to `waiting` to upload again. |
| SN21 | **Type and content checks now, the scan later (P34, D58 deviation).** Only an upload that is `confirmed` with the message-file purpose (upload's change, RC-61: image 8 MB, audio 25 MB, PDF 25 MB, type and magic-byte checks on confirm) may be sent. There is **no malware scan** this iteration — the D58 deviation recorded in AS-BUILT; "only files scanned clean" comes with the scan. |

#### 6.C.2 Open questions

None.

#### 6.C.3 Tables and relations

`app.instagram_attachments`: `id`; account (composite → `app.channel_accounts` `ON DELETE CASCADE`); **`upload_public_id`
`varchar(28)`** (db-changes calls it `upload_id` — renamed, since it holds a public id and no key); `attachment_id`
`varchar(128)` (Meta's id); `created_at`, `updated_at`. Unique (`organization_id`, `channel_account_id`,
`upload_public_id`). RLS: organization policy, enabled and forced; the retention arm in `USING` for the automation purge
(WC-47). No public id, no routes. Branch rule: none.

#### 6.C.4 Permissions

None — no routes.

#### 6.C.5 Common to every route

None — no routes.

#### 6.C.6 Objects returned

None.

#### 6.C.7 Routes

None.

#### 6.C.8 Request details

None.

#### 6.C.9 Errors

None of its own; a send that cannot upload ends its message `failed` · `attachment_failed` (6.B).

#### 6.C.10 Rules worth knowing

- The deleted-automation purge (WC-47, automation's) also deletes the file links of files no other live automation of
  that account uses.

#### 6.C.11 Code changes

| # | Change |
| --- | --- |
| SNC15 | SN20, SN21: schema, repository and `InstagramAttachmentService` (find or upload, delete on "gone"); the `attachment-upload` task handler (built at R20 as its body `uploadAttachments` and the queue port; the job on `instagram-tasks` is R46's — [P137](decisions.md)); the Instagram client's attachment upload (channel-connection's client, `appsecret_proof`); nock contract tests; a test that an unconfirmed or wrong-purpose upload is never sent |
| SNC16 | SN22, SN23 (rev 3) — built at R20 with `InstagramSendAccessService` (the send access, the pace over the account's and the business's usage entries, the recorder) ([P137](decisions.md)): `InstagramMessageService implements ChannelSendingPort` (the lane choice inside it, the results back through `recordMessageResult` and 7.C's), wired in `app.container.ts`; the lanes' usage read switched to `readConnectionUsage` (1, MCC12), no usage kept on the lanes; tests — the port's contract run against Instagram's implementation (each step's lane, a `skipped` answer, each result reaching the engine once), a usage of 95 % on the connection holds every lane of every account of that connection |

---
## 7. Broadcasts — rev 5 (2026-11-24) — nested sub-domains 7.A–7.C; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **`broadcast` sub-domain folder** — `app/sub-domains/broadcast/` (shared by every channel — P48) (the broadcast at the folder root) with
`broadcast-segment/` and `broadcast-recipient/`.

7.1 Decisions (whole sub-domain) · 7.2 Open questions · 7.3 Tables and relations · 7.4 Permissions · 7.5 Common to every route ·
7.6 Objects returned · 7.7 Routes · 7.8 Request details · 7.9 Errors · 7.10 Rules worth knowing · 7.11 Code changes (whole sub-domain) ·
7.12 Nested sub-domains · then **7.A Broadcasts · 7.B Broadcast segments · 7.C Broadcast recipients** — each with the same eleven sections.

**NEW** (P38, D68, PRO). Today nothing in the code sends to many people at once. A broadcast is 1 to 3 messages the owner
sends to the contacts of **one** channel account (Instagram the only channel now — P48) who match an audience — a saved segment or its own conditions — and
whose chat window is open (she wrote in the last 24 hours, minus 15 minutes): now, at a set time, or whenever her chat
opens in the next 1 to 7 days. It is not an automation: it has no way to start, but its button may start one. This
sub-domain owns the drafts, the audience (segments and the count), the lifecycle and the recipients; **sending** is the
broadcast lane of sub-domain 6 (D68). Design read: plan §8.10 (L1705–L1800), §15.9 (L2686–L2691), §19.17–19.19
(L3719–L3816), §20.9–20.10 (L4070–L4107), §30.14 (L5638–L5702), §27.15 (L5117–L5146); D35, D57, D68; P9, P20, P33.
Builds on: instagram-account, contact (the condition columns, the erasure step), automation (runs for conditions, the
button's automation, the message-list schema), sub-domain 6 (message rows, the broadcast lane), billing (PRO feature).
Route numbers run 70–82.

### 7.1 Decisions (whole sub-domain)

Taken on the standing answer "go with the recommendation", confirmed with the answers of 2026-11-24 (P54–P90) (P31).

**rev 2 changes** (P44, P47, M9): renamed Broadcasts → **Instagram broadcasts** — folders `instagram-broadcast/` (+ `instagram-broadcast-segment/`, `instagram-broadcast-recipient/`), tables `app.instagram_broadcasts`, `app.instagram_segments`, `app.instagram_broadcast_recipients`; routes under `/social/instagram/broadcasts…` and `/social/instagram/segments…`; `instagram_account_id` → `channel_account_id` (→ `app.channel_accounts`, 1B); `{broadcast_id}`, `{segment_id}` keep their names; audit `app.instagram_broadcast.*`, `app.instagram_segment.*`.

**rev 3 changes** (P48, P50, M10): **Broadcasts again — shared by every channel.** Folders `broadcast/` (+ `broadcast-segment/`, `broadcast-recipient/`), tables `app.broadcasts`, `app.segments`, `app.broadcast_recipients` (indexes and checks without the prefix), keyed by `channel_account_id` with `channel`; routes back to `/broadcasts…` and `/segments…`; audit `app.broadcast.*`, `app.segment.*`. Messages are saved through **`ChannelSendingPort`** and results come back to the recipient service (BC18 — the outbound seam); PRO and the channel's support come from 1B's one feature check (P50). Route numbers, gates and objects unchanged.

**rev 4 changes** (P75, P76, P83, M12): segments are PRO — segment create, edit and the audience count refuse Free with `403 plan_lacks_feature` (BCQ2 → P76: BC3, BC19, BCC11); the PRO checks read the plan's `broadcasts` and `segments` switches (P83); BCQ1 answered as recommended (P75).

**rev 5 changes** (P92, P94, P96, P99, M13): `broadcasts.channel` in 7.3 and 7.A.3 (P48, P99); the purge and the recipient clean-up hourly and time-budgeted (WC-62, WC-53 — P92: BC4, BC7, BC16, BCC3, BCC9); the start and end duties are their own repeat jobs with a 40 s budget (P94: BC7, BC11, BCC3, BCC7); recipients stay a plain table (P96). Routes 70–82 unchanged.

| # | Decision |
| --- | --- |
| BC1 | **Folder and names (P38).** Today: nothing. → `broadcast/` holds `app.broadcasts` and routes 70–76 at its root; nested `broadcast-segment/` owns `app.segments` and routes 77–82; nested `broadcast-recipient/` is a persistence module with no routes owning `app.broadcast_recipients` (written by the broadcast service, the audience job, intake and sub-domain 6). The segment table keeps the plan's name `app.segments` (P38) although its folder carries the parent's prefix. Paths: `/broadcasts`, and **`/segments` top-level**, because a segment is reused by many broadcasts — it is not one broadcast's child (RC-41–46). Path ids `{broadcast_id}`, `{segment_id}` in `PARAM_NAME_TO_ENTITY`; public-id prefixes proposed `brc`, `seg` (P22 — kickoff confirms; the broadcast's goes in its button payloads). Build order: segments, then broadcasts, then recipients; the foreign key from `app.instagram_messages.broadcast_id` lands in this sub-domain's migration (SN17). |
| BC2 | **Codes: the automation set (P20, D68).** Today: `automation:read` · `create` · `update` · `delete` (launch K4). → reused, no new code: `automation:read` lists and reads broadcasts and segments and counts an audience; `create` makes a draft or a segment; `update` edits, sends and cancels; `delete` deletes. Holders after the role change (Member → Editor, new Viewer): Owner, Admin and Editor make, send and cancel; Viewer only reads (plan:L2690). Other option: own `broadcast:*` codes — refused by D68 / P20. |
| BC3 | **PRO gate (D35, D57).** Today: `createAppPlanAccessPreHandler` refuses automation writes on a read-only plan with `403 organization_read_only`. → a **feature** check beside it — since rev 3 1B's one feature check `broadcasts` (CA11, P50: the channel's capability, the connection's permission, the plan — `assertPlanFeature` is its plan input — and Meta's test) — Free → **`403 plan_lacks_feature`** ("Broadcasts are on Creator and Studio", i18n) on **create (71) and send (75)**, and — since BCQ2 → [P76](decisions.md) — on **segment create (78), edit (80) and the audience count (82)** through the `segments` switch (BC19); reading, editing a draft, cancelling and deleting stay open, so drafts and segments survive a move down (D57) — a trial's segments stay saved, unusable until an upgrade. A plan ended (read-only) refuses send with the existing `403 organization_read_only`. Reuse: one helper in `app-plan-access.ts`, which the automation's PRO steps use too. |
| BC4 | **Soft delete, then purge (P9).** Today: automations soft-delete and are purged 180 days later (launch). → broadcasts and segments carry `deleted_at`; deleted rows leave every list and read (`404`). An **hourly, time-budgeted purge** (WC-62; P92) removes for good the ones deleted more than **90 days** ago (BCQ1) — a broadcast's recipients and messages go with it by cascade; a segment once no live broadcast points at it (`segment_id` is set null on its drafts at delete, BC17). No delete reason (the plan names none; P11 made the automation's optional). |
| BC5 | **One account each (D26).** A segment and a broadcast belong to one channel account, named in the create body (`channel_account_id`) and fixed; the lists require it as a filter (one account's screen, RC-41, RC-47). The conditions read only that account's contacts; a button may only start that account's automations. A `revoked` account's drafts stay; sending is refused (`409 instagram_not_connected`). |
| BC6 | **Audit (launch K9).** `app.broadcast.create` · `update` · `delete` · `send` · `cancel` and `app.segment.create` · `update` · `delete`, written after commit; the plan requires send and cancel (plan:L4088), the rest follow the automation's pattern. |
| BC7 | **Background work (be-workers-events).** On the task queue `instagram-tasks` (sub-domain 6): `broadcast-audience` (WC-40) and `segment-count` (WC-39), tenant jobs with `organizationPublicId`, safe to repeat. Two duties run on sub-domain 6's repair queue, each its own repeat job (P94 — `repair-broadcast-start`, `repair-broadcast-end`), their code here: start scheduled broadcasts (WC-28) and end broadcasts (WC-29). A new **purge** (BC4, WC-62 — hourly, time-budgeted, P92). Sending itself is sub-domain 6's broadcast lane (WC-8). |
| BC18 | **Shared broadcasts and the outbound seam (P48, rev 3).** Today (rev 2): `app.instagram_broadcasts`, `app.instagram_segments`, `app.instagram_broadcast_recipients`, writing messages through `InstagramMessageService` by name. After: `app.broadcasts`, `app.segments` and `app.broadcast_recipients` serve every channel, each keyed by `channel_account_id` with `channel` copied from the account; segments' conditions read the shared `app.contacts`. The audience job and intake's `when_chat_opens` save each recipient's messages with `saveWaitingMessage` on the account's channel's `ChannelSendingPort` (AU35 — source `{ broadcastId, broadcastRecipientId }`, step `broadcast`, the message kind from the channel's capability list, content by reference) and never pick a lane (Instagram's 6 puts them on its `broadcast` lane, SN22); cancel uses the port's `cancelWaitingMessages` (`by: broadcast`); results come back to `BroadcastRecipientService.recordMessageResult` in the result's commit. Send (75) refuses a message kind or feature the account's channel lacks through 1B's feature check (`422 channel_lacks_feature`, `409 permission_not_granted` — CAQ2). The jobs stay on `instagram-tasks` this iteration (M10). |

### 7.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| BCQ1 | How long a deleted broadcast or segment waits before its purge | **90 days** · 30 days · the automation's 180 | **90 days** — the same as recipients' keep (P33), so a purge never leaves numbers no row explains | **P75** — 90 days (as recommended) |
| BCQ2 | May a Free organization make segments and count audiences? | **yes** — only broadcast create and send are PRO (RC-48, RC-52) · no — segments are PRO too | **yes** — harmless, keeps a trial's segments after it ends, and the editor can show the count before an upgrade | **P76 — not the recommendation**: PRO only — segment create, edit and count need Creator or Studio (`403 plan_lacks_feature`, the `segments` switch, P83); Free sees the upsell; a trial's segments stay saved, unusable until an upgrade (BC3, BC19) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

Until answered, the plan follows the recommendation and every row that rests on it says so.

### 7.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `app.broadcasts` | one message set of one account and its audience | status by actions (BC9); mode chosen at send; soft delete + purge (BC4); `channel` copied from the account (P48) |
| `app.segments` | a saved audience of one account | conditions validated, ≤ 2 levels, ≤ 20 conditions; soft delete + purge |
| `app.broadcast_recipients` | one person a broadcast goes to and what happened | **plain** (P33): unique per broadcast and contact — "once per person" is a real key now; deleted 90 days after it was made by the hourly, time-budgeted clean-up (WC-53, P92); stays plain (P96 — about 120 M rows at target, revisited with S24) |

```text
tenancy.organizations
   │
   └──< app.channel_accounts ──┬──< app.segments
                               └──< app.broadcasts ──┬──> app.segments                  the saved audience (or none)
                                                               ├──< app.broadcast_recipients ──> app.contacts
                                                               └──< app.instagram_messages (6)   its messages (by week)
   auth.users ◄── created_by, updated_by (SET NULL)
```

Pointing at these from other sub-domains: `app.instagram_messages.broadcast_id` (6, `ON DELETE CASCADE`, added here);
contacts' `last_broadcast_at` (contact, set by sub-domain 6's result save).

**PostgreSQL design**

Standard columns: `id bigint` (identity), `public_id varchar(28)` unique where it has one, `organization_id` → organizations
`ON DELETE CASCADE`, composite (`organization_id`, `channel_account_id`) → `app.channel_accounts` `ON DELETE CASCADE`,
unique (`organization_id`, `id`) as the children's parent key, `created_at` / `updated_at`, `created_by_user_id` /
`updated_by_user_id` → `auth.users` `ON DELETE SET NULL`, `deleted_at` where it soft-deletes; RLS enabled and forced,
organization policy with `USING` and `WITH CHECK`, plus the `app.global_retention_cleanup` arm in `USING` for the
cross-organization reads of the duties and the purge. No membership pointers. Branch rule: none.

### 7.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `automation:read` | Automations · View | broadcasts, segments, audience counts | 70, 72, 77, 79, 82 | Owner, Admin, Editor, Viewer |
| `automation:create` | Automations · Create | a broadcast draft, a segment | 71, 78 | Owner, Admin, Editor |
| `automation:update` | Automations · Edit | edit a draft or a segment; send; cancel | 73, 75, 76, 80 | Owner, Admin, Editor |
| `automation:delete` | Automations · Delete | delete a broadcast or a segment | 74, 81 | Owner, Admin, Editor |

Plus the PRO feature on 71 and 75 (BC3).

### 7.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/app`; team only (reads: personal organization → `404 team_organization_required`; writes → `422`) |
| Auth | `Authorization: Bearer <access token>`; organization from the token |
| Writes | every `POST` needs `X-Idempotency-Key` (launch K3 — so 76 and 82 too); `PATCH` takes an optional `expected_updated_at` (a stale save → `409 record_changed`, launch) |
| Success | `200` with `{ data, meta }`; lists `{ data: [...], meta: { pagination: { per_page, next, has_more, estimated_total } } }` through `finishKeysetPage`; `DELETE` → `204` |
| Lists | `channel_account_id*`, `limit` (1–100, default 25), `after`, `q` (name, 1–200), `sort`, `order` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `409`, `422` |

### 7.6 Objects returned

| Object | Where |
| --- | --- |
| Broadcast | 7.A.6 — Broadcasts |
| Segment · Audience count | 7.B.6 — Broadcast segments |
| — (recipients are counted on the broadcast, never listed — route-changes finding 6) | 7.C.6 |

### 7.7 Routes

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 70 | GET | `/broadcasts` | One account's broadcasts with their numbers | `automation:read` | — | RC-47 |
| 71 | POST | `/broadcasts` | Make a draft (PRO) | `automation:create` | req | RC-48 |
| 72 | GET | `/broadcasts/{broadcast_id}` | One broadcast | `automation:read` | — | RC-49 |
| 73 | PATCH | `/broadcasts/{broadcast_id}` | Edit a draft | `automation:update` | — | RC-50 |
| 74 | DELETE | `/broadcasts/{broadcast_id}` | Delete one that is not active | `automation:delete` | — | RC-51 |
| 75 | POST | `/broadcasts/{broadcast_id}/send` | Send now, at a time, or when her chat opens (PRO) | `automation:update` | req | RC-52 |
| 76 | POST | `/broadcasts/{broadcast_id}/cancel` | Cancel | `automation:update` | req | RC-53 |
| 77 | GET | `/segments` | One account's saved segments | `automation:read` | — | RC-41 |
| 78 | POST | `/segments` | Save a segment | `automation:create` | req | RC-42 |
| 79 | GET | `/segments/{segment_id}` | One segment | `automation:read` | — | RC-43 |
| 80 | PATCH | `/segments/{segment_id}` | Change its name or conditions | `automation:update` | — | RC-44 |
| 81 | DELETE | `/segments/{segment_id}` | Delete it | `automation:delete` | — | RC-45 |
| 82 | POST | `/segments/audience-count` | Count conditions, saved or not | `automation:read` | req | RC-46 |

### 7.8 Request details

In each nested sub-domain (7.A to 7.C, section .8).

### 7.9 Errors

Every route can answer the errors in 7.5; each route's own errors are in its nested sub-domain (7.A to 7.C, section .9).

### 7.10 Rules worth knowing

What one action sets off (same transaction unless marked worker):

```text
75 send (now) ──────────► copy of the conditions · `sending` · audit ──► [task] broadcast-audience: recipients `waiting`
                          + their first messages (6), 500 a piece, open chats only ──► [6] broadcast lane sends
75 send (at a time) ────► copy · `scheduled` ──► [repair, every minute] at scheduled_at → `sending` → audience as above
75 send (when chat opens) ► copy · `waiting_for_chats`, ends_at = now + N days ──► [5] intake: she writes, matches, no run
                          open, no owner chat in 6 h → recipient + message ──► [6] lane
76 cancel ──────────────► `cancelled` · audit ──► [repair] waiting recipients `skipped`, waiting messages `cancelled`
                          (`broadcast_cancelled`), 500 a round; sent ones stay sent
[repair] every minute ──► `sending` with the audience built and nobody waiting → `done`; `waiting_for_chats` past
                          ends_at → `done`; in-app "broadcast done" notice
[5] her reply / tap ────► recipient `replied_at` once · broadcast `replies` + 1 / `taps` + 1 (same commit)
contact erased ─────────► her waiting recipients `skipped` · `contact_deleted`, her waiting messages cancelled (erasure step)
move down (billing) ────► scheduled and waiting-for-chats broadcasts `cancelled` · `plan_feature_off` (6's plan-change task)
```

- **Always left out of an audience**: opted-out, paused (`automations_off_at`) and deleted contacts, and anyone who got a
  broadcast in the last 24 hours (`contacts.last_broadcast_at`, a hard cap) — at build and again just before each send.
- Every broadcast message counts in the month count and the person limit (D68), through sub-domain 6's claim.

### 7.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| BCC1 | BC1: folders `app/sub-domains/broadcast/`, `…/broadcast-segment/`, `…/broadcast-recipient/` with their overviews (the status machine diagram in `broadcast.overview.md`); routes mounted by `app.routes.ts`; `PUBLIC_ID_PREFIXES` `broadcast` · `segment` and `PARAM_NAME_TO_ENTITY` `broadcast_id` · `segment_id`; OpenAPI tags `Broadcasts`, `Segments`; `tooling/openapi/query-schema-map.ts`; `src/domains/CLAUDE.md` map; migrations (new dated files after sub-domain 6's, in the order segments → broadcasts → recipients → the messages' foreign key) |
| BCC2 | BC2, BC3: gates on every route (the domain permissions file, no catalog change — the codes exist); `assertPlanFeature` in `app-plan-access.ts` reading billing's typed features, the new reasons `plan_lacks_feature`, `transition_not_allowed`, `broadcast_not_draft`, `broadcast_active`, `broadcast_incomplete`, `broadcast_not_found`, `segment_not_found` and `message_month_limit_reached` registered in `response-codes.md` (`AppError.withReason`) with their keys in `src/shared/locales/en/errors.json` first; tests: a Free organization `403` on 71, 75, 78, 80 and 82 and `200` on the rest, a Viewer `403` on every write, an ended plan `403 organization_read_only` on 75 |
| BCC3 | BC4, BC7: the purge (WC-62: hourly, each run until its time budget, P92; the oldest-row gauge) — **as built (R50, [P414](decisions.md))** the job `clean-up-app-tables` on the `app-partition-upkeep` queue (`src/domains/app/workers/app-table-clean-up.*`, family `retention`, no new queue under the pool budget) — with constant `BROADCAST_TOMBSTONE_RETENTION_DAYS` = 90 in `broadcast.constants.ts`; the two repair duties (WC-28, WC-29) registered as their own repeat jobs on sub-domain 6's repair queue (P94); the two task handlers (WC-39, WC-40); a DB test per duty that running it twice changes nothing |
| BCC4 | BC6: audit actions in the audit action list; i18n for the in-app "broadcast done" notice (notify's type, P28's notification kinds) |
| BCC5 | Seeds and docs: `broadcast/seed/` (segments, drafts and done broadcasts with recipients per seeded account); `pnpm routes:catalog`, success statuses (`200` ×11, `204` ×2), `validate:route-organization-scope`, `docs:generate`, Postman; `docs/reference/data/data-lifecycle-deletion.md` rows |

### 7.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/app/sub-domains/broadcast/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 7.A Broadcasts | folder root | `app.broadcasts` | 70–76, start and end duties, purge | final (rev 5, confirmed 2026-11-24) |
| 7.B Broadcast segments | `broadcast-segment/` | `app.segments` | 77–82, the segment count | final (rev 5, confirmed 2026-11-24) |
| 7.C Broadcast recipients | `broadcast-recipient/` | `app.broadcast_recipients` | — (the audience job, the recipient clean-up) | final (rev 5, confirmed 2026-11-24) |

---

### 7.A Broadcasts — `broadcast/` (folder root) — final (rev 5, confirmed 2026-11-24)

#### 7.A.1 Decisions

| # | Decision |
| --- | --- |
| BC8 | **Fields (plan §19.18).** `name` 1–255 after trim (duplicates allowed — the plan is silent); `messages` 1–3 in the **automation's message-list shape** (its DTO schema reused, not copied: kinds, versions A/B, `{name}`, files by confirmed upload public id; at most 64 KB) — a draft may hold 0; a button may **start an automation** (`start_automation_id`, a live automation of the same account); the audience is `segment_id` **or** `conditions` (one-off), never both, either may be empty in a draft; numbers `matched`, `sent`, `skipped`, `failed`, `replies` (once per recipient), `taps` — moved only in the commits of their results, one row is enough (≤ 2,000 sends an hour). |
| BC9 | **Status by actions only (plan §20.9).** `draft` → `sending` (send now) · `scheduled` (at a time) · `waiting_for_chats` (when her chat opens); `scheduled` → `sending` at `scheduled_at` (WC-28); `sending` → `done` once every recipient has a result and the audience is built; `waiting_for_chats` → `done` at `ends_at`; `draft`, `scheduled`, `sending`, `waiting_for_chats` → `cancelled` (owner, route 76; or `plan_feature_off` after a move down, only from `scheduled` and `waiting_for_chats`). Anything else → `409 transition_not_allowed`. `PATCH` only in `draft` (`409 broadcast_not_draft`). |
| BC10 | **Send (route 75, RC-52).** The mode is chosen **at send** in its body: `now`; `scheduled` with `scheduled_at` (in the future, at most 30 days ahead); `when_chat_opens` with `open_wait_days` 1–7 (`ends_at` = now + N days). In one transaction under the broadcast's row lock: PRO and plan checks (BC3); the account still connected; the month limit not reached (`409 message_month_limit_reached` — the reason sub-domain 6's meter uses); the draft complete (`422 broadcast_incomplete` with `errors[]` naming `messages` or the audience); the **copy of the conditions** taken (a segment's, so a later segment edit never changes it — plan:L3748); `started_at`; the status; audit. After the commit: `now` adds the `broadcast-audience` task; `when_chat_opens` adds a `segment-count` for `matched`. |
| BC11 | **Cancel and delete (RC-53, RC-51).** Cancel sets `cancelled`, `cancelled_at`, `cancel_reason` `owner`; the waiting recipients and messages are settled by the end duty in pieces of 500 until its 40 s budget (WC-29, P94), and until then sub-domain 6's lane skips a cancelled broadcast's messages. Delete is allowed for `draft`, `done` and `cancelled` only — an active one (`scheduled`, `sending`, `waiting_for_chats`) is `409 broadcast_active` ("cancel it first"). |

#### 7.A.2 Open questions

BCQ1 (7.2) — the purge horizon; answered P75: 90 days.

#### 7.A.3 Tables and relations

`app.broadcasts`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_account_id` | `bigint` | no | | composite → accounts `ON DELETE CASCADE`; fixed |
| `channel` | `varchar(10)` | no | `'instagram'` | the account's, copied at create (P48, P99, BC18 — as `app.segments`, [P309](decisions.md)); `chk_broadcasts_channel` (`instagram`) |
| `name` | `varchar(255)` | no | | 1–255 after trim |
| `status` | `varchar(17)` | no | `'draft'` | `draft` · `scheduled` · `sending` · `waiting_for_chats` · `done` · `cancelled` |
| `mode` | `varchar(15)` | no | `'now'` | `now` · `scheduled` · `when_chat_opens`; set by send |
| `segment_id` | `bigint` | yes | | composite (`organization_id`, `segment_id`) → `app.segments` `ON DELETE SET NULL (segment_id)` |
| `conditions` | `jsonb` | yes | | the one-off conditions, then the copy; set once sent (`status` not `draft` or `cancelled`) |
| `messages` | `jsonb` | no | `'[]'` | an array; 1–3 once sent (`status` not `draft` or `cancelled` — a draft may be cancelled, BC9); ≤ 64 KB |
| `start_automation_id` | `bigint` | yes | | the live automation of the same account its button starts (BC8); composite → `app.automations` `ON DELETE SET NULL (start_automation_id)` ([P213](decisions.md)) |
| `scheduled_at` | `timestamptz` | yes | | `(mode = 'scheduled') = (scheduled_at IS NOT NULL)` when not `draft` |
| `ends_at` | `timestamptz` | yes | | `(mode = 'when_chat_opens') = (ends_at IS NOT NULL)` when not `draft` |
| `started_at`, `finished_at`, `cancelled_at` | `timestamptz` | yes | | `(status = 'cancelled') = (cancelled_at IS NOT NULL)` |
| `cancel_reason` | `varchar(16)` | yes | | `owner` · `plan_feature_off`; set exactly with `cancelled_at` |
| `matched`, `sent`, `skipped`, `failed`, `replies`, `taps` | `integer` | no | `0` | `≥ 0` |
| `deleted_at` | `timestamptz` | yes | | soft delete (BC4); only in `draft`, `done`, `cancelled` |

Indexes: unique `public_id`; unique (`organization_id`, `id`); `WHERE deleted_at IS NULL`: (`organization_id`,
`channel_account_id`, `created_at DESC`, `id DESC`) — the list; `(scheduled_at) WHERE status = 'scheduled'` — the start
duty; (`organization_id`, `channel_account_id`) `WHERE status = 'waiting_for_chats'` — intake's "does a broadcast wait for
her"; `(ends_at) WHERE status = 'waiting_for_chats'` and `(organization_id, id) WHERE status IN ('sending', 'cancelled')` —
the end duty; `(deleted_at) WHERE deleted_at IS NOT NULL` — the purge; `(organization_id, segment_id) WHERE segment_id IS NOT NULL` — the
foreign key (its columns lead, index hygiene); as built also `(organization_id, channel_account_id)` (the account cascade), the
name sort, `(organization_id, start_automation_id)` and the user columns ([P213](decisions.md)). RLS as 7.3; in `EXPECTED_FORCE_RLS_TABLES`.

#### 7.A.4 Permissions

| Code | Routes |
| --- | --- |
| `automation:read` | 70, 72 |
| `automation:create` (+ PRO) | 71 |
| `automation:update` | 73, 76 |
| `automation:update` (+ PRO) | 75 |
| `automation:delete` | 74 |

#### 7.A.5 Common to every route

As 7.5.

#### 7.A.6 Objects returned

**Broadcast**: `id` (`brc_…`), `channel_account_id`, `name`, `status`, `mode`, `segment_id`, `conditions` (the one-off
conditions in a draft, the copy once sent), `messages`, `scheduled_at`, `ends_at`, `started_at`, `finished_at`,
`cancelled_at`, `cancel_reason`, `numbers` `{ matched, sent, skipped, failed, replies, taps }`, `start_automation_id` (`aut_…` or `null`, [P213](decisions.md)), `created_by_user_id`,
`created_at`, `updated_at`.

#### 7.A.7 Routes (70–76)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 70 | GET | `/broadcasts` | One account's broadcasts | `automation:read` | — |
| 71 | POST | `/broadcasts` | Make a draft (PRO) | `automation:create` | req |
| 72 | GET | `/broadcasts/{broadcast_id}` | One broadcast | `automation:read` | — |
| 73 | PATCH | `/broadcasts/{broadcast_id}` | Edit a draft | `automation:update` | — |
| 74 | DELETE | `/broadcasts/{broadcast_id}` | Delete one that is not active | `automation:delete` | — |
| 75 | POST | `/broadcasts/{broadcast_id}/send` | Send (PRO) | `automation:update` | req |
| 76 | POST | `/broadcasts/{broadcast_id}/cancel` | Cancel | `automation:update` | req |

#### 7.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 70 | `channel_account_id*`, `status` (several), `mode`, `q`, `sort` = `created_at` (default, newest first) \| `name`, `order`, `limit`, `after` | — | Broadcast[] |
| 71 | — | `channel_account_id*`, `name*`; optional: `segment_id` or `conditions`, `messages` (0–3), `start_automation_id` | Broadcast |
| 72 | — | — | Broadcast |
| 73 | — | optional: `name`, `segment_id` or `conditions` (sending one clears the other), `messages`, `start_automation_id` (`null` clears); `expected_updated_at` | Broadcast |
| 74 | — | — | 204 |
| 75 | — | `mode*` = `now` \| `scheduled` \| `when_chat_opens`; `scheduled_at` (exactly for `scheduled`); `open_wait_days` 1–7 (exactly for `when_chat_opens`) | Broadcast |
| 76 | — | — (empty object) | Broadcast |

#### 7.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 70, 71 | `400` · `channel_account_id` | missing, or not an `cha_…` id |
| 71, 73 | `400` · `name` / `messages` / `conditions` / `segment_id` | out of range; both audiences; a message's own errors (the automation's message checks); a `start_automation_id` that is not a live automation of this account; a segment of another account |
| 71 | `404` · `instagram_not_connected` | the account is not this organization's, or `revoked` |
| 71, 75 | `403` · `plan_lacks_feature` | a Free organization (BC3) |
| 75 | `403` · `organization_read_only` | the plan ended (read-only) |
| 73 | `409` · `broadcast_not_draft` / `record_changed` | it left `draft`; a stale `expected_updated_at` |
| 74 | `409` · `broadcast_active` | `scheduled`, `sending` or `waiting_for_chats` — cancel first |
| 75 | `400` · `mode` / `scheduled_at` / `open_wait_days` | not one of its values, the time in the past or over 30 days ahead, out of 1–7, or a field of another mode |
| 75 | `409` · `transition_not_allowed` | not a `draft` |
| 75 | `409` · `message_month_limit_reached` | the organization's DMs of this month are used up |
| 75 | `409` · `instagram_not_connected` | the account is `revoked` or `error` |
| 75 | `422` · `broadcast_incomplete` | no messages, or no audience (its segment was deleted) |
| 71, 75 | `422` · `channel_lacks_feature` / `409` · `permission_not_granted` | the account's channel cannot send broadcasts or one of its message kinds / the connection lacks the permission (1B's feature check, CA11, CAQ2) |
| 76 | `409` · `transition_not_allowed` | already `done` or `cancelled` |
| 72–76 | `404` · `broadcast_not_found` | absent, deleted or another organization's |

#### 7.A.10 Rules worth knowing

- A broadcast message carries the broadcast's public id in its button payload; a tap on its "start automation X" button
  starts that automation's run for her (intake, sub-domain 5) and adds 1 to `taps`.
- The end duty never ends a `sending` broadcast before its audience job is done (it reads that the last piece committed).

#### 7.A.11 Code changes

| # | Change |
| --- | --- |
| BCC6 | BC8–BC11: schema, repository, service, DTOs (the automation's message schema imported from its DTO — reuse, one schema), validators, serializer, controller and routes 70–76 with their schema blocks; the transitions in one guarded `UPDATE … WHERE status = <from>` each; the send transaction (copy, checks, audit after commit, the task add after commit); integration tests for every row of 7.A.9, a cursor across pages, and another organization's broadcast `404` (also as `meepzo_be_app` and in the `test:rls-role` lane) |
| R22 as built | [AS-BUILT](../AS-BUILT.md) row R22, [P213](decisions.md): prefix `brc`; `start_automation_id` column for the button; FK-led indexes (`(organization_id, segment_id)`, the account cascade, the name sort) and the messages' `idx_instagram_messages_broadcast` rebuilt as `(organization_id, broadcast_id, status)` with `instagram_messages_broadcast_fk` in the broadcasts' migration; `started_at` of a `scheduled` send set by the start duty (R47); the send's background work behind `BroadcastSendQueuePort` (R46); cancel settles nothing until the end duty (R47); seeds in `broadcast/seed/` |
| BCC7 | The repair duties: `workers/broadcast-start.duty.ts` (WC-28: due `scheduled` → `sending` + audience task) and `workers/broadcast-end.duty.ts` (WC-29: `done` and the cancelled settle, pieces of 500 until its 40 s budget — P94; the in-app notice); intake's hook `BroadcastService.handleChatOpened` for `when_chat_opens` (called by sub-domain 5 in its event transaction) |

---

### 7.B Broadcast segments — `broadcast/broadcast-segment/` — final (rev 5, confirmed 2026-11-24)

#### 7.B.1 Decisions

| # | Decision |
| --- | --- |
| BC12 | **Conditions (plan §19.17, D68).** A JSON tree validated by one zod schema (`segmentConditionsSchema`): a group `{ op: 'and' \| 'or', items: [...] }`, **at most 2 levels** and **at most 20 conditions** in all; each condition `{ field, … }` with snake_case keys, one of eight fields — `tags` (`match` any · all · none, `values`), `automation` (`automation_id`, `state` started · finished · in_progress · never · tapped_hello · got_message, `message_number`; runs of the last 90 days), `came_in` (`via` first_automation · ref · starter_question · ad · story_mention · first_message, `value`), `commented` (`post` a media id or `any`, `days`, `keyword`, `at_least`), `active` (`last_message_within_hours` or `_days`, `first_seen_within_days`), `details` (`has` email · phone · neither · follows_account), `story_activity` (`days`), `no_broadcast` (`days`). Ids inside are public ids (`aut_…`) or Instagram media ids, each checked to be this account's (`400`). Names 1–255 after trim, duplicates allowed. |
| BC13 | **The audience query.** One builder turns conditions into a query over the account's `app.contacts` (and, for `automation`, `app.automation_runs`; for `commented` keywords, `app.automation_comment_logs`) — the contact columns the plan names are kept in the same commits as the events (contact's change). Always left out: opted out, paused, deleted, a broadcast in the last 24 hours. "Can get it now" adds her open window (`last_direct_message_received_at` within 24 hours − 15 minutes). The builder lives in the segment repository (it may read the same domain's schemas for joins). |
| BC14 | **Audience count (route 82, RC-46).** For saved or unsaved conditions: counted inline under `SET LOCAL statement_timeout = '2s'`; on a timeout the `segment-count` task (WC-39) counts it in the background (deduplicated by account and a hash of the conditions) and writes a 60-second organization-scoped Redis copy (P5 — derived from Postgres); the answer then says `is_counting: true` and the client asks again. |
| BC15 | **Edit and delete (RC-44, RC-45).** `PATCH` changes name or conditions; drafts that use the segment follow it, sent broadcasts keep their copy. Delete is soft (BC4) and, in the same transaction, empties `segment_id` on this account's **drafts** that use it — they need a new audience before send (`422 broadcast_incomplete`); scheduled and later broadcasts already hold their copy. |
| BC19 | **Segments are PRO (BCQ2 → [P76](decisions.md)).** Today: nothing. After: segment create (78), edit (80) and the audience count (82) ask 1B's one feature check for `segments` (CA11 — the plan's `segments` switch, P83); Free → `403 plan_lacks_feature` ("Segments are on Creator and Studio", i18n) and the editor shows the upsell; listing (77), reading (79) and deleting (81) stay open, so segments made during a trial stay saved after a move down, unusable until an upgrade (D57). The count of a broadcast's one-off conditions is route 82 too, so counting is PRO wherever it is asked. Other option (the recommendation): segments and counts open on Free. |

#### 7.B.2 Open questions

BCQ2 (7.2) — answered [P76](decisions.md): segments are PRO (BC19).

#### 7.B.3 Tables and relations

`app.segments`

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `channel_account_id` | `bigint` | no | | composite → accounts `ON DELETE CASCADE`; fixed |
| `name` | `varchar(255)` | no | | 1–255 after trim |
| `conditions` | `jsonb` | no | | `jsonb_typeof(conditions) = 'object'`; the tree of BC12 (checked in the validator) |
| `deleted_at` | `timestamptz` | yes | | soft delete (BC4) |

Plus the standard columns of 7.3. Indexes: unique `public_id`; unique (`organization_id`, `id`); `WHERE deleted_at IS NULL`:
(`organization_id`, `channel_account_id`, `name`, `id`) — the list by name, (`organization_id`, `channel_account_id`,
`created_at DESC`, `id DESC`) — newest first; `(deleted_at) WHERE deleted_at IS NOT NULL` — the purge. RLS as 7.3.

#### 7.B.4 Permissions

| Code | Routes |
| --- | --- |
| `automation:read` | 77, 79, 82 |
| `automation:create` | 78 |
| `automation:update` | 80 |
| `automation:delete` | 81 |

#### 7.B.5 Common to every route

As 7.5.

#### 7.B.6 Objects returned

**Segment**: `id` (`seg_…`), `channel_account_id`, `name`, `conditions`, `condition_count`, `created_by_user_id`,
`created_at`, `updated_at`.

**Audience count** (route 82): `matched`, `can_receive_now` (both null while counting), `is_counting`, `counted_at`.

#### 7.B.7 Routes (77–82)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 77 | GET | `/segments` | One account's saved segments | `automation:read` | — |
| 78 | POST | `/segments` | Save a segment | `automation:create` | req |
| 79 | GET | `/segments/{segment_id}` | One segment | `automation:read` | — |
| 80 | PATCH | `/segments/{segment_id}` | Change its name or conditions | `automation:update` | — |
| 81 | DELETE | `/segments/{segment_id}` | Delete it | `automation:delete` | — |
| 82 | POST | `/segments/audience-count` | Count conditions, saved or not | `automation:read` | req |

#### 7.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 77 | `channel_account_id*`, `q`, `sort` = `name` (default) \| `created_at`, `order`, `limit`, `after` | — | Segment[] |
| 78 | — | `channel_account_id*`, `name*`, `conditions*` | Segment |
| 79 | — | — | Segment |
| 80 | — | optional: `name`, `conditions`; `expected_updated_at` | Segment |
| 81 | — | — | 204 |
| 82 | — | `channel_account_id*`; `segment_id` or `conditions` (exactly one) | Audience count |

#### 7.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 77, 78, 82 | `400` · `channel_account_id` | missing, or not an `cha_…` id |
| 78, 80, 82 | `400` · `conditions` | not the tree of BC12: an unknown field or key, over 2 levels, over 20 conditions, an id that is not this account's |
| 78, 80 | `400` · `name` | empty or over 255 after trim |
| 82 | `400` · `segment_id` / `conditions` | neither or both; a segment of another account |
| 78, 82 | `404` · `channel_account_not_found` | the account is not this organization's (a `revoked` one may still hold segments: allowed) — 1B's account error, as built at R21 ([P309](decisions.md)) |
| 80 | `409` · `record_changed` | a stale `expected_updated_at` |
| 79–82 | `404` · `segment_not_found` | absent, deleted or another organization's |
| 78, 80, 82 | `403` · `plan_lacks_feature` | a plan without the `segments` switch — Free (BC19, P76) |
| 82 | `503` · `segment_count_unavailable` | the inline count passed its 2 s and the background count (R46) is not wired yet — as built at R21 ([P309](decisions.md)) |

#### 7.B.10 Rules worth knowing

- A segment never sends anything; only a broadcast that copies it does.

#### 7.B.11 Code changes

| # | Change |
| --- | --- |
| BCC8 | BC12–BC15: schema, repository (with the audience builder and its statement timeout), service, the `segmentConditionsSchema` DTO (one schema for segments and broadcasts' one-off conditions), validator, serializer, controller, routes 77–82; the `segment-count` task handler and its cache file (be-read-cache-guard's five tests); unit tests: every field and the 2-level and 20-condition limits; DB tests: each condition against seeded contacts, the always-left-out rules, the open-window count; delete empties drafts' `segment_id` |
| R21 as built | [AS-BUILT](../AS-BUILT.md) row R21, [P309](decisions.md), [P310](decisions.md): prefix `seg`; the `segment-count` task and its cache behind `SegmentBackgroundCountPort` (R46); delete's draft step behind `SegmentDeleteStep` (R22); media ids checked by shape; `got_message` N reads the run's `last_message_number >= N` (since the R14 merge); seeds in `broadcast-segment/seed/` |
| BCC11 | BC19: the `segments` feature check on routes 78, 80 and 82 (through 1B's `canChannelAccountUseFeature`); the `errors:` copy (`src/shared/locales/en/` first); tests — Free `403` on 78, 80, 82 and `200` on 77, 79, 81; Creator `200`; a trial's segment still readable after a move down |

---

### 7.C Broadcast recipients — `broadcast/broadcast-recipient/` — final (rev 5, confirmed 2026-11-24)

#### 7.C.1 Decisions

| # | Decision |
| --- | --- |
| BC16 | **A plain table with a real "once per person" key (P33).** The plan splits recipients by month and checks "once per person per broadcast" under the contact lock because a split table cannot hold the unique key (plan:L3812). Plain (P33) → **unique (`organization_id`, `broadcast_id`, `contact_id`)**: a second row for her is impossible, and a `skipped · owner_chat` row is put back to `waiting` instead of a new one (plan §20.10). Deleted once made more than 90 days ago by the hourly, time-budgeted clean-up (WC-53, P92), whatever its broadcast's state; still a plain table (P96). |
| BC17 | **Who writes it.** The audience job (WC-40: rows and their first messages 500 a piece, only contacts whose chat is open, `INSERT … ON CONFLICT DO NOTHING`); intake for `when_chat_opens` (one row when she writes, after any run for her has finished, not within 6 hours of the owner typing to her); sub-domain 6's result save through the outbound seam — `BroadcastRecipientService.recordMessageResult` with `sent` · `failed` · `skipped` · `unknown` (status, `sent_at`, the broadcast's numbers in the same commit; BC18); intake again for her first reply (`replied_at` once, `replies` + 1); the end duty (cancelled → `skipped`); contact's erasure step (`skipped · contact_deleted`). Status machine as plan §20.10: `waiting` → `sent` · `skipped` · `failed` · `unknown`; `skipped · owner_chat` → `waiting` once while the broadcast is active. |

#### 7.C.2 Open questions

None.

#### 7.C.3 Tables and relations

`app.broadcast_recipients` (no public id, no soft delete, no `*_by_user_id`)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id` | `bigint` (bigserial) | no | identity | primary key |
| `organization_id` | `bigint` | no | | → organizations `ON DELETE CASCADE` |
| `channel_account_id` | `bigint` | no | | a copy for the lane's pick, no key of its own (the broadcast holds the account) |
| `broadcast_id` | `bigint` | no | | composite (`organization_id`, `broadcast_id`) → `app.broadcasts` `ON DELETE CASCADE` |
| `contact_id` | `bigint` | no | | composite (`organization_id`, `contact_id`) → `app.contacts` `ON DELETE RESTRICT` (contacts are erased in place, launch) |
| `status` | `varchar(7)` | no | `'waiting'` | `waiting` · `sent` · `skipped` · `failed` · `unknown` |
| `reason` | `varchar(30)` | yes | | `recent_broadcast` · `owner_chat` · `window_closed` · `opted_out` · `contact_excluded` · `broadcast_cancelled` · `plan_feature_off` · `contact_deleted`, plus the message reasons; set whenever `status IN ('skipped', 'failed')` |
| `version_number` | `smallint` | yes | | 1–3, the version picked for her |
| `sent_at` | `timestamptz` | yes | | set exactly when `sent` |
| `replied_at` | `timestamptz` | yes | | set once |
| `created_at`, `updated_at` | `timestamptz` | no | `now()` | |

Indexes: unique (`organization_id`, `broadcast_id`, `contact_id`) — once per person, also the broadcast's key and its
counts; (`organization_id`, `broadcast_id`, `status`) — the end duty and the numbers; (`organization_id`, `contact_id`) — the
contact key and her erasure; `(created_at)` — the 90-day delete. RLS: organization policy + the retention arm in `USING`;
enabled and forced; in `EXPECTED_FORCE_RLS_TABLES`. Branch rule: none.

#### 7.C.4 Permissions

None — no routes; read only through a broadcast's numbers.

#### 7.C.5 Common to every route

None — no routes.

#### 7.C.6 Objects returned

None (route-changes finding 6: no recipient list).

#### 7.C.7 Routes

None.

#### 7.C.8 Request details

None.

#### 7.C.9 Errors

None of its own.

#### 7.C.10 Rules worth knowing

- A recipient's first message is created in the same commit as the row, so a recipient never waits without a message.

#### 7.C.11 Code changes

| # | Change |
| --- | --- |
| BCC9 | BC16, BC17: schema, repository and `BroadcastRecipientService` (create on conflict, put back `owner_chat`, settle); the audience task handler (WC-40, 500 a piece, chained); the recipient clean-up in sub-domain 6's hourly clean-ups (WC-53, `deleteInBatchesByCondition` until the time budget, 90 days — P92) — as built (R50, [P414](decisions.md)) in the same `clean-up-app-tables` job; contact's erasure step registered by the app container; DB tests: a second audience build makes no second row, `owner_chat` comes back once, the 90-day delete |
| BCC10 | BC18 (rev 3): the shared names — `broadcast/` (+ `broadcast-segment/`, `broadcast-recipient/`), `app.broadcasts`, `app.segments`, `app.broadcast_recipients`, their indexes and checks, `BroadcastService`, `BroadcastRecipientService`, audit `app.broadcast.*`, `app.segment.*`, the seed folder `broadcast/seed/`; writes through `ChannelSendingPort` and `recordMessageResult` on the recipient service; route 75's feature check; tests — a fake second channel's port receives the audience's messages, a `skipped` result moves the recipient, a policy test that `broadcast/` imports no `instagram-*` folder |
| R23 as built | [AS-BUILT](../AS-BUILT.md) row R23, [P214](decisions.md): `app.broadcast_recipients` as 7.C.3 (`reason` shape-checked, not a value list — the message reasons are each channel's; `version_number` empty — broadcast messages have no versions); `BroadcastRecipientService` — `buildAudiencePiece` (one piece of 500, the task that chains them R46), `addChatOpenedRecipient` (create, or `owner_chat` back to `waiting` with a new message 1 — intake's hook R47), `recordMessageResult` (message 1 settles her and the numbers; a `sent` N saves N + 1), `skipContactWaitingRecipients` (erase and pause steps), `skipBroadcastWaitingRecipients` (the end duty's piece, R47), `recordContactReply` (intake, R38); the 90-day delete R50 |

---

## 8. Billing — Flowdm plans, plan states, trial — rev 4 (2026-11-24) — nested sub-domains 8.A–8.D; final (rev 4, confirmed 2026-11-24)

**Status: final (rev 4, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 4 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **billing domain's own sub-domains**, changed in place in `src/domains/billing/sub-domains/` — `plan/` (8.A),
`subscription/` (8.B subscriptions, plan states and the trial; 8.C cards — the payment-method code lives in the same
folder today), `stripe-webhook/` (8.D). The domain is in `main`, so every database change is a **new** billing migration
(D48, plan:L7913); the plan rows stay in `billing` (P38). No new folder.

8.1 Decisions (whole sub-domain) · 8.2 Open questions · 8.3 Tables and relations · 8.4 Permissions · 8.5 Common to every route ·
8.6 Objects returned · 8.7 Routes · 8.8 Request details · 8.9 Errors · 8.10 Rules worth knowing · 8.11 Code changes (whole sub-domain) ·
8.12 Nested sub-domains · then **8.A Plans · 8.B Subscriptions, plan states and the trial · 8.C Cards · 8.D Stripe webhook** — each
with the same eleven sections.

What the sending engine needs from billing: the three Flowdm plans with typed features (DMs a month, accounts, one switch per feature — P83,
priority support), one plan state per organization that the app reads and is told about when it changes, the move down at the
period end with the accounts kept, a 7-day no-card trial, and two card routes. Design read: plan §46 (plan:L7911–L8113), §47.8
(plan:L8214–L8236), §50.5 B3 (plan:L8441), §50.6 (plan:L8467–L8481), §53.3 item 4 (plan:L8805); `db-changes.md` › plan,
subscription, trial_account; `route-changes.md` RC-57–RC-59, RC-64–RC-69 (RC-60 is served by sub-domain 1B, route 11);
`worker-changes.md` WC-38 (app), WC-59, WC-65 (seat sync off). Builds on: organizations (tenancy), users, the app's Instagram accounts (read through
a port, 8.10). Route numbers run 100–108.

### 8.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). There is no launch review
for billing (the launch built the `app` domain only); every "today" is the code in `main`.

**rev 2 changes** (P47, M9): plan features `instagram_accounts_max` → `channel_accounts_max` and `direct_message_month_limit` → `message_month_limit`; the accounts port is 1B's (`listActiveChannelAccounts`, `countConnectedChannelAccounts`); `keep_channel_account_ids` (route 103), `channel_accounts_count` (route 108), `kept_channel_account_public_ids` on `PLAN_STATE_CHANGED`; route 11 is 1B's. No route or table of billing changes shape.

**rev 3 changes** (P77–P80, P83, M12): one on / off switch per feature replaces the `is_pro_enabled` bundle (BL12, P83); the switched-off Starter, Growth and Pro rows hold an organization to Free's features and limits until it picks Creator or Studio — a notice and an email, Stripe untouched (BLQ4 → P80: BL11, BL24, BLC13); BLQ1–BLQ3 answered as recommended (P77, P78, P79).

**rev 4 changes** (P99, M13): BL9 cites WC-65 (seat sync off); the move down's account stop is named — 1B's `plan_stop_reason` `plan_downgrade` (BL7, 8.B.10). No route or table of billing changes shape.

| # | Decision |
| --- | --- |
| BL1 | **Where things live (P38).** Today: `plan/`, `subscription/` (with the payment-method routes and the Stripe customer), `stripe-webhook/`, the seat-sync and seat-reconcile workers. After: the same folders; the trial's table is a persistence part of `subscription/` (`trial-account.{schema,repository}.ts`, no controller, no routes — the trial is started through `POST /billing/subscriptions`); the plan-state check (WC-59) is a new worker in `subscription/workers/`. No new sub-domain folder. Other option: a `subscription/subscription-trial/` nested folder — but it would own one table and no route. |
| BL2 | **One plan read for every decision (reuse).** Today: `SubscriptionService.getPlanAccess` answers `{ state, graceEndsAt }` and `assertOrganizationWritable` refuses product writes (`403 organization_read_only`); nothing reads `plan.features` (plan:L7918). After: `getPlanAccess` is extended in place (not a second reader) to answer the organization's **plan entitlement** — `state` (`active` · `grace` · `read_only`), `grace_ends_at`, `trial_ends_at`, the plan's public id and name, and its typed `features` (8.A) — the one read the app's checks use: the account limit (sub-domain 1 MC7, sub-domain 1B CA9), `assertPlanFeature` / the PRO gate (sub-domains 4, 6, 7), the month limit (sub-domain 6), the meter (RC-56). It reads Postgres only (one query, as today); P5's Redis copy is the app's concern. |
| BL3 | **Plan states (plan:L7951–L7985, D35).** Today: `resolvePlanAccess` gives a never-paid TEAM organization a 14-day grace from `created_at` (`NEW_ORGANIZATION_TRIAL_DAYS`), then `read_only`; a lapsed paid plan gets `current_period_end + BILLING_DUNNING_GRACE_DAYS`. After: **Free never ends** — no live paid subscription and no ended paid plan → `active` on Free; `NEW_ORGANIZATION_TRIAL_DAYS` and its POLICIES.md row go (reuse rule — not left beside the new rule). Paid or trialing → `active` (`trial_ends_at` while `TRIALING`). `PAST_DUE` / `UNPAID` → `grace` until `current_period_end + 14 days` (`BILLING_DUNNING_GRACE_DAYS` 14, as built), then `read_only`. A **cancelled paid plan** ends at its period end with no grace → `read_only` ("plan ended", plan:L7973). A move to Free or an unpaid trial end is not "plan ended" — both leave a live **local Free row** (BL5, BL7), so they read `active`. PERSONAL stays `active`. As built at R1 ([P104](decisions.md)): `INCOMPLETE` / `PAUSED` / `INCOMPLETE_EXPIRED` read `active` on Free; `grace` keeps the paid plan's features, `read_only` gives Free's; with the flag off the state is `active` but the plan and features are still read. |
| BL4 | **`BILLING_READ_ONLY_ENFORCED` default flips to `true` (plan:L7976).** Today: default `false`, because on, a never-paid organization locked itself after 14 days with no way to pay. After: with Free never ending (BL3) only a lapsed or cancelled **paid** plan reaches `read_only`, so on is the production-safe value — the env var stays (one flag, the env layer owns it), its default becomes `true`, `.env.example` and the test harness set it explicitly (the harness keeps `false` for the suites that do not test billing). Other option: keep the default `false` and set `true` in each hosted environment file. |
| BL5 | **Moving down at the period end (D57, plan:L7987–L8027).** Today: `change-plan` swaps the Stripe price at once (proration) and suspends members above the new seat count. After: **up** (a dearer plan) — at once, as built; **down** — at the period end: a paid → smaller paid move is a Stripe subscription schedule (the current phase to `current_period_end`, then the new price — Stripe stays the truth for payments), a paid → Free move is `cancel_at_period_end` on Stripe plus our scheduled Free; the row records `scheduled_plan_id`, `scheduled_change_at` and the owner's `downgrade_keep` (BLQ1 — two columns db-changes does not list yet). At the period end the Stripe webhook (8.D) applies it: the row's `plan_id` follows Stripe's price (paid → paid), or the Stripe row ends `CANCELED` and a **local `ACTIVE` Free row** (no Stripe id) is inserted in the same commit (paid → Free); `PLAN_STATE_CHANGED` (BL8) carries the kept accounts. A second `change-plan` before then replaces the pick or the target; a `change-plan` back to the current plan releases the schedule. The member suspension on downgrade goes (BL9). |
| BL6 | **The kept accounts (`downgrade_keep`, D57).** `keep_channel_account_ids` on `change-plan` (route 103): a list of `cha_…` of this organization's active accounts, at most the new plan's `channel_accounts_max`; saved with the scheduled change as a JSON list of public ids (db-changes); empty or absent → the oldest-connected stay (applied by the app at the period end, WC-38). Billing checks the ids through the **accounts port** (8.10) — never the app's tables. The pick is a hint the app applies at the end: an account disconnected meanwhile is skipped and the next oldest fills its place. The pick is also used by an unpaid trial end (BL7). |
| BL7 | **The 7-day no-card trial (D73, plan:L8081–L8113).** Today: `POST /billing/subscriptions` takes `plan_id`, `billing_cycle`; Stripe trials are not used (`trial_end` is only synced). After: the body takes `is_trial: true` (Creator or Studio, monthly or yearly). Refused `409 trial_already_used` when the organization ever had a trial (a subscription row of the organization with `trial_end` set — rows are never deleted, billing ledgers) or when one of its not-revoked Instagram accounts had one (`billing.trial_accounts`, 8.B). Stripe: `trial_period_days` 7 (`PAID_TRIAL_DAYS` 7, a billing constant — not environment-varying, P4), no payment method, `trial_settings.end_behavior.missing_payment_method = cancel`, the default card saved on the subscription when one is added (plan §53.3 item 4 — the exact settings checked when building, against the Stripe sandbox). In the same commit as the row: one `billing.trial_accounts` row per not-revoked account. Unpaid end: Stripe cancels; the webhook (8.D) ends the row `CANCELED` and inserts the local Free row — the moving-down rule (accounts above Free's 1 get the account plan stop `plan_downgrade` — 1B's `plan_stop_reason`, the pick of BL6 or the oldest). Paid end: the plan goes on. A plan change during the trial keeps its end date. |
| BL8 | **`PLAN_STATE_CHANGED` (plan:L7977).** Today: billing emits `subscription.created` / `.updated` / `.cancelled` (webhooks to customers, notify). After: a new event `subscription.plan_state_changed` in `SUBSCRIPTION_EVENT`, emitted **after commit** whenever the entitlement of BL2 changes: Stripe events (8.D), an upgrade (route 103), a trial start (route 102), a scheduled move applied (8.D), a grace that ended (WC-59). Payload: `organizationPublicId`, `change` (`upgraded` · `moved_down` · `plan_ended` · `resumed` · `trial_started` · `trial_ended`), the previous and current `{ state, plan_public_id }`, the current `features` (so WC-38 turns off exactly the switches the new plan lacks — P83), `kept_channel_account_public_ids` (on `moved_down` / `trial_ended`). The app's handler (sub-domain 6) only enqueues the plan-change task (WC-38, one per organization and change); billing never touches app tables. |
| BL9 | **Seats off (D55, plan:L7943).** Today: `included_seats` 1 / 5 / 15 / 25; the member add reserves a seat (`409 seat_limit_reached`); the seat-sync job pushes the member count to Stripe as the quantity; the seat-reconcile worker and the downgrade suspension follow it. After: `included_seats` empty on every plan (unlimited, the migration sets it); the seat sync is off — a billing **code constant** `BILLING_SEAT_SYNC_ENABLED = false` (not environment-varying, P4) read at the enqueue sites and the reconcile worker's registration; Stripe's quantity stays 1; `suspendExcessMembersForDowngrade` is removed from `changePlan` (unreachable with no seat ceiling); `seat_limit_reached` stays in the code (still thrown if a plan ever carries seats) but unreachable. Other option: remove the seat machinery now — a larger change with no product effect; left for a clean-up. Worker-changes row: **WC-65** (seat sync and reconcile off). |
| BL10 | **Audit (K9 form, after commit).** `billing.subscription.trial_start` (WARNING, `metadata.plan_public_id`, `channel_account_count`), `billing.subscription.change_plan` gains `metadata.is_scheduled`, `scheduled_change_at`, `kept_channel_account_count`; `billing.payment_method.delete`, `billing.payment_method.set_default` (WARNING) — never a card number, only brand and last 4. |

### 8.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| BLQ1 | How the move down waits for the period end | a Stripe subscription schedule + our two mirror columns `scheduled_plan_id`, `scheduled_change_at` · keep the target only on our row and change Stripe's price ourselves at renewal | **The Stripe schedule** — Stripe invoices the renewal itself, so changing the price "at renewal" from our side races the invoice; the two columns let route 103 and the billing screen show the change without a Stripe call. db-changes must add both columns to `subscription` | **P77** — the Stripe subscription schedule (as recommended) |
| BLQ2 | `{payment_method_id}` is Stripe's `pm_…` id, not one of our public ids | add it as the third non-entity param beside `{provider}` and `{slug}` · mint our own ids (a new table of cards) | **A third non-entity param** — cards live only in Stripe (no table, plan:L8069); the param is checked by shape (`pm_` + 1–250 letters and digits) and by ownership (the card's customer is the organization's); be-api-contract-guard's list and the param policy test name it | **P78** — Stripe's id, a third non-entity param (as recommended) |
| BLQ3 | The feature key `dm_month_limit` (db-changes open item) | `message_month_limit` (full names, P6) · the plan's `dm_month_limit` | **`message_month_limit`** — P6 already renamed the table to `message_month_counts`; "dm" is an abbreviation the naming rule refuses; sub-domain 6 (SN15, SNC7) follows — applied at merge (M1) | **P79** — `message_month_limit` (the recommendation, kept as the default — AMBER) |
| BLQ4 | The features of the turned-off rows Starter, Growth and Pro (a typed read refuses their old keys) | map them: Starter → Creator's, Growth and Pro → Studio's · give them Free's | **Map them up** — an organization still paying an old plan keeps paid powers until it moves; a typed read never meets an old key; no Stripe change | **P80 — not the recommendation**: Free's — an organization still on an old row is held to Free's features and limits until it picks Creator or Studio; Stripe untouched; a notice and an email (BL11, BL24) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 8.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `billing.plans` (changed) | the global plan catalog — Free, Creator, Studio active; Starter, Growth, Pro off (with Free's features — P80) | typed `features`: two limits, priority support and one switch per feature (8.A, P83); `included_seats` empty; no RLS (shared catalog, as built) |
| `billing.subscriptions` (changed) | an organization's subscription | + `downgrade_keep`, + `scheduled_plan_id`, `scheduled_change_at` (BLQ1); one non-terminal row per organization (as built) |
| `billing.trial_accounts` (new) | every Instagram account that had the trial, in any organization | one row per `instagram_user_id`, ever (BL7) |

```text
tenancy.organizations
   │
   ├──< billing.subscriptions ──┬──> billing.plans (plan_id)              what it pays for
   │                            └──> billing.plans (scheduled_plan_id)    what it moves to at the period end (BLQ1)
   │
   └──< billing.trial_accounts ──> billing.plans                          one trial per Instagram account, ever

app.instagram_accounts ·····> billing.trial_accounts.instagram_user_id    a copied Instagram id, no key (P25 form)
app.channel_accounts ·······> billing.subscriptions.downgrade_keep        public ids in a JSON list, no key

A ──< B   one A has many B     A ──> B   a column on A points at one B     A ·····> B   a copied value, no foreign key
```

Pointing at these from other sub-domains: none by key — the app reads the entitlement through BL2 and is told by BL8.

**PostgreSQL design**

`billing.plans` keeps its columns, checks and indexes; no RLS (a global catalog, as built). `billing.subscriptions` keeps its
standard columns and its `subscriptions_tenant_isolation` policy (organization `USING` with the retention arm, organization-only
`WITH CHECK`, enabled and forced — as built). `billing.trial_accounts` is new: standard columns minus soft delete (8.B.3). Each
table's design is in its nested sub-domain.

### 8.4 Permissions

No new codes. Held by default per the four roles (D55, sub-domain 9): billing is Owner and Admin (plan:L7881).

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| — (PUBLIC) | — | the plan catalog | 100, 101 | everyone |
| `subscription:read` | Workspace · Billing and plans | cards | 104 | Owner, Admin |
| `subscription:manage` | Workspace · Billing and plans | subscribe (and the trial), change plan, remove a card, the default card | 102, 103, 105, 106 | Owner, Admin |
| — (Stripe-Signature) | — | Stripe's events | 107 | Stripe |
| — (AUTH) | — | the caller's context with `plan_access` | 108 | every signed-in person |

### 8.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/billing` (routes 100–107); route 108 is `/api/v1/auth/me/context` (the auth domain's route; its `plan_access` part is billing's) |
| Auth | `Authorization: Bearer <access token>` on 102–106, 108; the active organization from the token; 100, 101 PUBLIC; 107 `Stripe-Signature` |
| Organization | the writes 102, 103, 105, 106 are team-only → `422` on a personal organization (`assertTeamOrganization`, capability `BILLING`, as built); 104 answers `[]` for a personal organization (no customer, as built) |
| Writes | `X-Idempotency-Key` required on 102, 103, 106 (`idempotencyRequired`, forwarded to Stripe as its idempotency key — be-idempotency-guard); 105 is a `DELETE` (none); 107 none (Stripe's event id dedupes, as built) |
| Success | `200` with `{ data, meta }`; route 105 → `204`; 107 `200` acknowledgement (as built) |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403 missing_permission`, `404`, `409`, `422`, `429`, `503` (`errors:paymentProviderUnavailable` — Stripe down or its circuit open) |

### 8.6 Objects returned

| Object | Where |
| --- | --- |
| Plan | 8.A.6 — Plans |
| Subscription · Plan access | 8.B.6 — Subscriptions, plan states and the trial |
| Payment method | 8.C.6 — Cards |
| Stripe acknowledgement | 8.D.6 — Stripe webhook |

### 8.7 Routes (100–108)

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | GET | `/billing/plans` | Free, Creator, Studio with typed features and the yearly price per month **(changed)** | PUBLIC | | RC-57 |
| 101 | GET | `/billing/plans/{plan_id}` | One plan **(changed)** | PUBLIC | | RC-58 |
| 102 | POST | `/billing/subscriptions` | Subscribe — or start the 7-day no-card trial **(changed)** | `subscription:manage` | req | RC-65 |
| 103 | POST | `/billing/subscriptions/{subscription_id}/change-plan` | Up at once; down at the period end with the accounts kept **(changed)** | `subscription:manage` | req | RC-59 |
| 104 | GET | `/billing/payment-methods` | The cards, each with `is_default` **(as built, BL19)** | `subscription:read` | | RC-67 |
| 105 | DELETE | `/billing/payment-methods/{payment_method_id}` | Remove a card **(new)** | `subscription:manage` | | RC-68 |
| 106 | POST | `/billing/payment-methods/{payment_method_id}/default` | Make it the default card **(new)** | `subscription:manage` | req | RC-69 |
| 107 | POST | `/billing/webhook` | Stripe's events — an unpaid trial and a scheduled move down end here **(changed)** | Stripe-Signature | | RC-66 |
| 108 | GET | `/auth/me/context` | `plan_access` adds `trial_ends_at`; the organization adds `channel_accounts_count` **(changed)** | AUTH | | RC-64 |

### 8.8 Request details

In each nested sub-domain (8.A to 8.D, section .8).

### 8.9 Errors

Every route can answer the errors in 8.5; each route's own errors are in its nested sub-domain (8.A to 8.D, section .9).

### 8.10 Rules worth knowing

- **Billing never reads app tables.** Two ports are wired in `src/routes.ts` (the launch's erase-step pattern, so no container
  cycle): the **accounts port** the app implements — `listActiveChannelAccounts(organizationPublicId)` → `[{ public_id,
  instagram_user_id, connected_at }]` (routes 102, 103; WC-59) and `countConnectedChannelAccounts` (route 108); and the
  **trial port** billing implements for the app — `assertInstagramAccountsMayJoinTrial` / `recordTrialAccounts` (sub-domain 1's
  pick writes a row for an account connected during a trial, `409 trial_used_by_account`, plan:L8102).
- **No Stripe call inside a database context** (as built): every route reads, closes the unit of work, calls Stripe, then writes.
- **Stripe is the truth for payments; Postgres for what the product does.** The plan state the app acts on is BL2's, from our rows
  (synced by 8.D); the app never calls Stripe.
- **Read only still lets the owner act** (plan:L7983): pause, delete, disconnect and choose a plan — billing's own routes are never
  behind `organization_read_only`.

### 8.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| BLC1 | BL1, BL9: one new billing migration per plan:L8462–L8464 sketch — `billing_flowdm_plans` (8.A), `billing_trial_accounts` (8.B), `billing_subscriptions_downgrade_keep` (+ `scheduled_plan_id`, `scheduled_change_at`, BLQ1); `EXPECTED_FORCE_RLS_TABLES` +1 (`billing.trial_accounts`); `PUBLIC_ID_PREFIXES.trialAccount` (prefix at kickoff, P22); the seat-sync constant and the removed downgrade suspension; `src/domains/billing/billing.overview.md`, `plan.overview.md`, `src/POLICIES.md` (`NEW_ORGANIZATION_TRIAL_DAYS` out, `PAID_TRIAL_DAYS`, `TRIAL_NOTICE_DAYS`, `PLAN_STATE_CHECK_MINUTES` in) |
| BLC2 | BL2, BL3, BL4: `resolvePlanAccess` rewritten (Free never ends, the local Free row, cancelled paid → `read_only`); `getPlanAccess` answers the entitlement; `PlanAccessOutput` + `trial_ends_at`; the env default flip (be-env-schema-add: schema, `.env.example`, `src/tests/setup.ts`, the refine comment); unit tests for every state of plan:L7966–L7973 |
| BLC3 | BL8: `SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED`, its payload type, emitted after commit from 8.B and 8.D and WC-59; an event test per `change` value; the app's handler is sub-domain 6's (WC-38) |
| BLC4 | BL10 and the ports of 8.10: the audit actions; `ChannelAccountsPort` / `TrialPort` types, wired in `src/routes.ts` and the worker bootstrap; i18n keys for every new reason (`src/shared/locales/en/errors.json`) and their rows in `docs/reference/api/response-codes.md` |
| BLC5 | Tests and seeds: the reference seed = the migration's rows (8.A); bulk seed — demo team organizations on Free, Creator (one trialing) and Studio (`subscription/seed/`); integration tests for every success and error in 8.A–8.D; contract tests (`src/tests/contract/stripe*`) for the schedule, the trial create, detach and default; `pnpm routes:catalog`, `validate:route-success-statuses`, `docs:generate` |

### 8.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/billing/sub-domains/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 8.A Plans | `plan/` | `billing.plans` | 100–101 | final (rev 4, confirmed 2026-11-24) |
| 8.B Subscriptions, plan states and the trial | `subscription/` | `billing.subscriptions`, `billing.trial_accounts` | 102, 103, 108 | final (rev 4, confirmed 2026-11-24) |
| 8.C Cards | `subscription/` (the payment-method service and serializer) | — (Stripe only) | 104–106 | final (rev 4, confirmed 2026-11-24) |
| 8.D Stripe webhook | `stripe-webhook/` | `billing.stripe_webhook_events` (unchanged) | 107 | final (rev 4, confirmed 2026-11-24) |

---

### 8.A Plans — `billing/sub-domains/plan/` — final (rev 4, confirmed 2026-11-24)

#### 8.A.1 Decisions

| # | Decision |
| --- | --- |
| BL11 | **The three plans (plan:L7932–L7949, P37).** Today: Free, Starter, Growth, Pro; `features` a loose map (`priority_support`, `audit_log`, `sso`), `included_seats` 1 / 5 / 15 / 25. After, one new migration `billing_flowdm_plans` and the reference seed in step: **Free** updated ($0, $0); **Creator** added ($29 a month, $276 a year — placeholders, P37); **Studio** added ($79, $756 — placeholders); Starter, Growth, Pro `is_active = false` (billing rows are never deleted), their features set to **Free's** (BLQ4 → [P80](decisions.md), BL24); `included_seats` empty on all seven rows (D55). Stripe product and price ids stay empty until ops creates them at go-live (P37) — until then a paid plan answers `422 planNotAvailableForBillingCycle` on subscribe (as built: no Stripe price for the cycle). |
| BL12 | **Typed features — one switch per feature (plan:L7944, [P83](decisions.md)).** Today: `PlanFeatures = Record<string, boolean \| number \| string>`, nothing checks it. After: one zod object `planFeaturesSchema`, `.strict()`, with `message_month_limit` (integer ≥ 0; BLQ3), `channel_accounts_max` (integer 1–100), `has_priority_support` (boolean — the plan's `priority_support`, P21 form) and `feature_switches` — **one boolean per feature key** of `PLAN_FEATURE_KEYS` (a billing constant in `plan.constants.ts`; 1B's `CHANNEL_FEATURES` names each feature's key — CA11 — and a unit test pins that the two lists agree): the PRO switches `email_ask`, `phone_ask`, `reply_like_person`, `multiple_public_reply_lines`, `message_versions`, `broadcasts`, `segments` (P76), `past_comments`, `extra_delay`, and the channel features every plan has (`starter_questions`, `mark_seen`) — exactly these eleven keys as built at R1 ([P103](decisions.md)); a further feature is a new billing migration. It supersedes the rev 2 `is_pro_enabled` (the plan's `pro_features` bundle, D35): "PRO" is a label for the switches a plan turns on, not a field. Checked when a row is written (seed, migration-backed tests) and parsed on every read in the repository — an unknown or missing key is a loud error, never a silent default. The table keeps `jsonb`; a `CHECK` pins the four top-level keys and their JSON types (the database refuses a bad row too). Values: Free 1,000 / 1 / no priority support / the PRO switches off, every other switch on; Creator 10,000 / 3 / no / every switch on; Studio 50,000 / 10 / **yes** / every switch on. A new or changed plan is a new or changed row — no code change; the one feature check (CA11) reads the exact switch, and a move down (D57, BL8) turns off exactly the switches the new plan lacks. Other option: the rev 2 bundle `is_pro_enabled` — every PRO feature on one flag. |
| BL13 | **The plan object (RC-57, RC-58).** Today: `features` verbatim, `limits: { seats }`, `price_yearly` the yearly total (or null without a yearly price), `billing_cycles`. After: `features` the typed object of BL12 (P83); `price_yearly_per_month` = `price_yearly` ÷ 12, two decimals (plan:L7949); `limits` goes (seats are unlimited on every plan — the field would always read `null`). The one-minute in-process catalog memo stays (as built); the decision reads (`requireActivePlanByPublicId`, the entitlement) never use it (as built). Other option: keep `limits: { seats: null }` for old clients — meepzo-fe changes with this contract anyway (P30). |

#### 8.A.2 Open questions

BLQ3 (the feature key name — P79, `message_month_limit`) and BLQ4 (the old rows' features — P80, Free's: BL11, BL24) — 8.2; both answered.

#### 8.A.3 Tables and relations

`billing.plans` (changed — no new columns)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `features` | `jsonb` | no | — | **changed**: the keys of BL12 — four top-level, the switches inside `feature_switches` (P83); `CHECK` on the top-level key set and JSON types (`chk_plans_features`) |
| `included_seats` | `integer` | yes | | **changed**: empty on every row (the migration); the existing check stays |
| `is_active` | `boolean` | no | `true` | Starter, Growth, Pro → `false` |
| `price_monthly`, `price_yearly` | `decimal(10,2)` | no | | seeded placeholders (P37) |

Indexes unchanged (unique `public_id`, unique `name`, `(is_active, price_monthly)`). RLS: none — a global catalog (as built). The
migration's `features` default `{}` is dropped (a row must carry the four keys).

#### 8.A.4 Permissions

| Code | Routes |
| --- | --- |
| PUBLIC | 100, 101 |

#### 8.A.5 Common to every route

As 8.5; PUBLIC with the catalog cache headers (as built).

#### 8.A.6 Objects returned

**Plan**: `id` (`pln_…`), `name`, `description`, `price_monthly`, `price_yearly` (or null), `price_yearly_per_month` (or null),
`billing_cycles`, `currency`, `is_active`, `features` (`{ message_month_limit, channel_accounts_max,
has_priority_support, feature_switches: { <feature key>: boolean } }` — BL12, P83), `created_at`, `updated_at`.

#### 8.A.7 Routes (100–101)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 100 | GET | `/billing/plans` | The active plans, cheapest first **(changed)** | PUBLIC | |
| 101 | GET | `/billing/plans/{plan_id}` | One active plan **(changed)** | PUBLIC | |

#### 8.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 100 | — (as built) | — | Plan[] (Free, Creator, Studio) |
| 101 | — | — | Plan |

#### 8.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 101 | `400` · `plan_id` | not a `pln_…` id |
| 101 | `404` | no such plan, or it is off (Starter, Growth, Pro) |

#### 8.A.10 Rules worth knowing

- The numbers live only in the plan rows, never in the settings file (plan:L7943); the app reads them through BL2.

#### 8.A.11 Code changes

| # | Change |
| --- | --- |
| BLC6 | BL11–BL13: migration `billing_flowdm_plans` (rows, `CHECK`, seats empty, default dropped); `DEFAULT_PLANS` = the three plans + the three off rows; `planFeaturesSchema` in `plan.types.ts` (the `PlanFeatures` type inferred from it) parsed in `plan.repository.ts`; `PLAN_FEATURE_KEYS` in `plan.constants.ts` (P83); the off rows seeded with Free's features (P80); `price_yearly_per_month` in `plan.service.ts`'s output; `limits` removed from `PlanOutput`; k6 billing journeys and the Stripe sandbox catalog script follow the new names; unit tests for the schema (missing, unknown, wrong type, a switch not in `PLAN_FEATURE_KEYS`) and that `PLAN_FEATURE_KEYS` equals the switch keys of 1B's `CHANNEL_FEATURES` |

---

### 8.B Subscriptions, plan states and the trial — `billing/sub-domains/subscription/` — final (rev 4, confirmed 2026-11-24)

#### 8.B.1 Decisions

| # | Decision |
| --- | --- |
| BL14 | **Subscribe and trial (route 102, RC-65).** Today: `plan_id`, `billing_cycle`; a Free plan creates a local row, a paid plan a Stripe subscription (`payment_behavior: default_incomplete`) with a Redis lock per organization. After: + `is_trial` (optional, default `false`). With `is_trial`: the plan must be paid (`422 plan_has_no_trial` for Free); the checks of BL7 before Stripe (`409 trial_already_used`); the Stripe call with the trial settings; the row `TRIALING`, `trial_end` = now + 7 days; in the same commit the `billing.trial_accounts` rows (a unique-key race with another organization → `409 trial_already_used`, nothing kept — the Stripe subscription is cancelled as the existing compensation does); after commit `PLAN_STATE_CHANGED` (`trial_started`) and the audit entry. Without `is_trial` as built, plus `PLAN_STATE_CHANGED` (`upgraded`) once Stripe says paid (8.D) — a Free local row emits `resumed` when it ends a plan-ended state. |
| BL15 | **Change plan (route 103, RC-59).** Today: `plan_id` only; immediate. After: `plan_id*`, `keep_channel_account_ids` (BL6). Dearer → as built (immediate Stripe price swap with proration), clears any scheduled change, emits `upgraded`. Cheaper or Free → scheduled (BL5): checks the pick (each a not-revoked, active account of this organization — through the port; at most the new plan's `channel_accounts_max`; no repeats), creates or updates the Stripe schedule (or `cancel_at_period_end` for Free), then writes `scheduled_plan_id`, `scheduled_change_at` (= `current_period_end`), `downgrade_keep`. The same plan as the current one → releases the schedule and clears the three columns. During a trial the end date stays (plan:L8104). The answer is the Subscription with its `scheduled_change` (8.B.6). The Redis lock per subscription stays (as built). |
| BL16 | **Plan state for the app and the context (route 108, RC-64).** Today: `active_organization.plan_access` = `{ state, grace_ends_at }`. After: `{ state, grace_ends_at, trial_ends_at, plan: { id, name }, features, is_plan_choice_required }` (the BL2 entitlement, serialized), and `active_organization.channel_accounts_count` (the not-revoked accounts, through the accounts port — the "being set up" notice, plan:L8227). "Workspace paused" is the organization's existing `status` (`SUSPENDED`, plan:L7907) — already in the answer, no new field. The DM meter is not here (RC-56, P14). |
| BL17 | **The plan-state check (WC-59, plan:L7978, L8106).** Every 15 minutes (`PLAN_STATE_CHECK_MINUTES` 15, a billing constant), a sweep under a maintenance scope (`MAINTENANCE_SCOPE.BILLING_PLAN_STATE_CHECK`, new, frozen) finds (a) dunning subscriptions whose `current_period_end + 14 days` has passed and that no event has marked yet, and (b) trialing subscriptions 3 days and 1 day before `trial_end` (`TRIAL_NOTICE_DAYS` 3, 1); one job per organization on the billing queue, payload `organizationPublicId` (+ `subscriptionPublicId`). Inside its organization the job re-reads the row: (a) emits `PLAN_STATE_CHANGED` (`plan_ended`) — once in effect, because the app's handler enqueues WC-38 with the job id `plan-change:<organization>:plan_ended:<period end>` (a repeat is dropped; no marker column); (b) sends `billing.trial_ending` to the billing recipients (sub-domain 11) with the dedupe key `trial-ending:<subscription>:<days>`. Safe to repeat; safe to skip (the next run catches up). Other option: a Stripe `customer.subscription.trial_will_end` event for the 3-day notice — Stripe sends it once, 3 days ahead, and never the 1-day one. |
| BL18 | **One trial per Instagram account, across organizations, without reading them.** The pre-check needs rows of every organization, which RLS hides: a `SECURITY DEFINER` function `billing.resolve_trialled_instagram_user_ids(text[])` answers only which of the given ids already had a trial (yes / no, no organization) — the launch's resolver form (`app.resolve_organization_public_id_for_instagram_user`); the unique key is the final guard. |
| BL24 | **Old plan rows hold an organization to Free (BLQ4 → [P80](decisions.md)).** Today: Starter, Growth and Pro are live plans with their own loose features. After: the migration (BL11) turns them off **and** writes Free's features into them (1,000 messages a month, 1 account, every PRO switch off, no priority support), so every reader — the account limit, the month limit, the one feature check — holds an organization still on one of them to Free with no special case. Its Stripe subscription is not touched (it pays its old price until it changes plan). The entitlement (BL2) adds `is_plan_choice_required` (`true` while the live row points at an off plan): route 108 carries it and the billing screen shows the notice "Choose Creator or Studio". The plan-state check (WC-59, BL17) finds such subscriptions and, once per subscription (job id `plan-change:<organization>:legacy_plan:<subscription>`), emits `PLAN_STATE_CHANGED` (`moved_down` — WC-38 puts the plan stop on accounts above Free's 1, the oldest-connected kept) and sends one email `billing.plan_choice_required` to the billing recipients (sub-domain 11, dedupe key `plan-choice:<subscription>`). Picking Creator or Studio (route 103) ends it — an up move, as built. Other option (the recommendation): map Starter → Creator's, Growth and Pro → Studio's. |

#### 8.B.2 Open questions

BLQ1 (how the move down waits) — 8.2; answered P77: the Stripe schedule.

#### 8.B.3 Tables and relations

`billing.subscriptions` (changed)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `downgrade_keep` | `jsonb` | yes | | **new**: a JSON list of 0–10 `cha_…` strings; set only with `scheduled_plan_id`; `CHECK (jsonb_typeof(downgrade_keep) = 'array')` |
| `scheduled_plan_id` | `bigint` | yes | | **new** (BLQ1): → plans `ON DELETE RESTRICT`; the plan it moves to at `scheduled_change_at` |
| `scheduled_change_at` | `timestamptz` | yes | | **new** (BLQ1): `(scheduled_plan_id IS NULL) = (scheduled_change_at IS NULL)`; `downgrade_keep IS NULL OR scheduled_plan_id IS NOT NULL` |
| `trial_end` | `timestamptz` | yes | | as built; now also the "had a trial" mark (BL7) |

New indexes: `(organization_id) WHERE trial_end IS NOT NULL` — the "organization had a trial" check; `(trial_end) WHERE status =
'TRIALING'` — WC-59's trial notices; `(current_period_end) WHERE status IN ('PAST_DUE', 'UNPAID')` — WC-59's grace sweep;
`(scheduled_plan_id) WHERE scheduled_plan_id IS NOT NULL` (the foreign key). RLS: the existing organization policy, enabled and
forced (as built); WC-59's sweep reads under its maintenance scope's bypass arm (the policy's `USING` gains the new scope's GUC
alongside the retention arm; `WITH CHECK` stays organization-only).

`billing.trial_accounts` (new — append-only: no `updated_*`, no soft delete)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id`, `public_id`, `created_at` | standard | no | | |
| `organization_id` | `bigint` | **yes** | | → organizations `ON DELETE SET NULL` — the row outlives its organization (Rule below) |
| `instagram_user_id` | `text` | no | | digits, 1–30; **unique** (one trial per account, ever) |
| `plan_id` | `bigint` | no | | → plans `ON DELETE RESTRICT` |
| `subscription_id` | `bigint` | yes | | → subscriptions `ON DELETE SET NULL` — the trial it came with |
| `started_at` | `timestamptz` | no | `now()` | the trial start, or the connect time for an account added during the trial |

Rule on deletion: the row must outlive its organization — an account that trialled in a deleted organization must not trial again —
so the standard `ON DELETE CASCADE` would break D73. `organization_id` is therefore nullable with `ON DELETE SET NULL`: the
organization's hard purge (its tombstone-retention worker) leaves the row with no organization; a null-organization row matches no
request's policy (invisible), and only the resolver of BL18 still sees it. Its `subscription_id` → subscriptions `ON DELETE SET
NULL` for the same reason (nullable too). The one documented exception to "every row goes with its organization" (rule list of
db-changes) — db-changes should say so.
Indexes: unique `public_id`; unique `instagram_user_id`; `(organization_id, started_at DESC)`; `(subscription_id)`. RLS:
organization policy, `USING` and `WITH CHECK` on `organization_id`, enabled and **forced**.

#### 8.B.4 Permissions

| Code | Routes |
| --- | --- |
| `subscription:manage` | 102, 103 |
| AUTH | 108 |

#### 8.B.5 Common to every route

As 8.5.

#### 8.B.6 Objects returned

**Subscription** (as built: `id`, `plan_id`, `status`, `billing_cycle`, `current_period_start`, `current_period_end`, `trial_end`,
`cancel_at_period_end`, `canceled_at`, `created_at`, `updated_at`; the seat fields go with BL9) + `scheduled_change` (`null`, or
`{ plan_id, change_at, keep_channel_account_ids }`) + `is_trial` (`status = 'TRIALING'`).

**Plan access** (`active_organization.plan_access` on route 108 and on the two switch routes, as built): `state`, `grace_ends_at`,
`trial_ends_at`, `plan` (`{ id, name }`), `features` (8.A.6), `is_plan_choice_required` (BL24, P80). Route 108's `active_organization` also carries
`channel_accounts_count` (integer).

#### 8.B.7 Routes (102, 103, 108)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 102 | POST | `/billing/subscriptions` | Subscribe, or start the trial **(changed)** | `subscription:manage` | req |
| 103 | POST | `/billing/subscriptions/{subscription_id}/change-plan` | Up now; down at the period end **(changed)** | `subscription:manage` | req |
| 108 | GET | `/auth/me/context` | The caller's context; `plan_access` and the account count **(changed)** | AUTH | |

#### 8.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 102 | — | `plan_id*`, `billing_cycle*` (`monthly` \| `yearly`); optional: `is_trial` (boolean) | Subscription |
| 103 | — | `plan_id*`; optional: `keep_channel_account_ids` (0–10 `cha_…`, no repeats; only on a move down) | Subscription |
| 108 | — | — | the context (as built) with BL16's fields |

#### 8.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 102 | `422` · `plan_has_no_trial` | `is_trial` on the Free plan |
| 102 | `409` · `trial_already_used` | the organization had a trial, or one of its accounts had one (anywhere) |
| 102 | `409` · `subscription_already_exists` / `subscription_create_in_progress` | as built |
| 103 | `400` · `keep_channel_account_ids` | not this organization's active accounts, a repeat, more than the new plan allows, or given on a move up or a release (as built, [P403](decisions.md)) |
| 103 | `422` · `subscription_not_mutable` / `planNotAvailableForBillingCycle` | as built (terminal subscription; no price for the cycle) |
| 103 | `409` · `subscription_change_in_progress` | as built |
| 102, 103 | `422` | a personal organization; the idempotency key missing, malformed or reused |
| 102, 103 | `503` | Stripe down or its circuit open (`errors:paymentProviderUnavailable`) |
| 103 | `404` | no such subscription in the organization |

#### 8.B.10 Rules worth knowing

- **Where the plan comes from, for every reader**: the live row (`TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID`) → its plan; none →
  Free (by name — the one row the reference seed guarantees). A plan the row points at that is off (Starter …) still answers its
  features — Free's, so the organization is held to Free (BLQ4 → P80, BL24).
- **Downgrade at the period end is billing's moment, the stops are the app's**: billing changes the plan row and emits the event;
  WC-38 (sub-domain 6) sets the accounts' plan stop (1B's `plan_stop_reason` — `plan_downgrade` or `plan_ended`), ends broadcasts and past-comment reads — within the same 15-minute backup.

#### 8.B.11 Code changes

| # | Change |
| --- | --- |
| BLC7 | BL14, BL18: `CreateSubscriptionDto` + `is_trial`; the trial path in `SubscriptionService.create` (the checks, the trial rows in the create commit, the compensation); `createStripeSubscription` gains the trial options (`trial_period_days`, `trial_settings`, `payment_settings`); `trial-account.{schema,repository}.ts`; the resolver function in the trial migration; `PAID_TRIAL_DAYS` in `subscription.constants.ts`; the trial port for sub-domain 1 |
| BLC8 | BL5, BL6, BL15: `ChangePlanDto` + `keep_channel_account_ids`; the move-down path (Stripe subscription schedule create / update / release in `stripe.client.ts` and the payment-provider port, `cancel_at_period_end` for Free); the three columns and their checks in the `billing_subscriptions_downgrade_keep` migration; `scheduled_change` in `subscription.serializer.ts`; `suspendExcessMembersForDowngrade` removed |
| BLC9 | BL16: `AuthMeContextService` takes the accounts port; `PlanAccessOutput` + `trial_ends_at`, `plan`, `features`; `channel_accounts_count`; the switch routes' answers follow (one serializer) |
| BLC10 | BL17: `subscription/workers/subscription-plan-state-check.{worker,processor,constants}.ts`, its queue and job schema (`organizationPublicId`, `subscriptionPublicId`), the sweep under `MAINTENANCE_SCOPE.BILLING_PLAN_STATE_CHECK` (registered in `database-context.ts`; the subscriptions policy's bypass arm); registry, scheduler (every 15 minutes), DLQ; tests — a grace that ended emits once, a trial at 3 and 1 days notifies once each, a repeat sends nothing twice |
| R24 | As built ([P403](decisions.md)): three migrations (`billing_subscriptions_downgrade_keep`, `billing_subscriptions_plan_state_indexes` — the 8.B.3 indexes CONCURRENTLY —, `billing_trial_accounts`); trial prefix `tra`, `instagram_user_id` VARCHAR(30) + an index on `plan_id`; route 103's direction by the subscription cycle's price (an off plan always up); `PLAN_STATE_CHANGED` only when the entitlement moved; route 108 reads the account count through billing (`countConnectedChannelAccounts`), the switch routes carry it too; the plan stop `plan_ended` in the app's `ChannelAccountPlanStopService` |
| BLC13 | BL24: the off rows' features in `billing_flowdm_plans` (Free's); `is_plan_choice_required` on the entitlement and `PlanAccessOutput`; WC-59's third finding (subscriptions on an off plan, once per subscription) with the `moved_down` event and the `billing.plan_choice_required` email; tests — an organization on Growth reads Free's limits and switches, gets one email and one event however often the check runs, route 103 to Creator clears the flag, Stripe is never called for it |

---

### 8.C Cards — `billing/sub-domains/subscription/` (payment methods) — final (rev 4, confirmed 2026-11-24)

#### 8.C.1 Decisions

| # | Decision |
| --- | --- |
| BL19 | **List (route 104, RC-67) — already built.** Today: `GET /billing/payment-methods` already answers `is_default` per card (`BillingAccountSerializer.paymentMethods` reads the customer's default). After: unchanged; RC-67 is served as built — the change files should mark it EXISTING (their sync — Merge notes M8). |
| BL20 | **Remove a card (route 105, RC-68, plan:L8075).** Stripe detaches it (`paymentMethods.detach`, outside a database context). The card must be the organization customer's (`card.customer` = the organization's Stripe customer) — else `404` (no existence leak). Refused `409 default_card_in_use` when it is the only card while a paid plan is on (`ACTIVE`, `PAST_DUE`, `UNPAID`, or `TRIALING` with a card — the trial's end would then have nothing to charge). Answers `204`. |
| BL21 | **The default card (route 106, RC-69, plan:L8076).** Sets the customer's `invoice_settings.default_payment_method` and the live subscription's `default_payment_method` (both Stripe calls, the client's `X-Idempotency-Key` forwarded as Stripe's idempotency key — be-idempotency-guard). Already the default → the same answer (a repeat is harmless). Answers the card list (8.C.6) so the screen repaints. |

#### 8.C.2 Open questions

BLQ2 (`{payment_method_id}` as a third non-entity param) — 8.2; answered P78.

#### 8.C.3 Tables and relations

None — cards live only in Stripe (plan:L8069). The organization's Stripe customer is read from its subscription row (as built).

#### 8.C.4 Permissions

| Code | Routes |
| --- | --- |
| `subscription:read` | 104 |
| `subscription:manage` | 105, 106 |

#### 8.C.5 Common to every route

As 8.5; 105 and 106 are team-only (`422` on a personal organization, like `POST …/payment-methods/setup` — RC-68 / RC-69 do not say so yet).

#### 8.C.6 Objects returned

**Payment method** (as built): `id` (Stripe's `pm_…`), `brand`, `last4`, `exp_month`, `exp_year`, `is_default`.

#### 8.C.7 Routes (104–106)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 104 | GET | `/billing/payment-methods` | The cards with `is_default` **(as built)** | `subscription:read` | |
| 105 | DELETE | `/billing/payment-methods/{payment_method_id}` | Remove a card **(new)** | `subscription:manage` | |
| 106 | POST | `/billing/payment-methods/{payment_method_id}/default` | Make it the default **(new)** | `subscription:manage` | req |

#### 8.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 104 | — | — | Payment method[] |
| 105 | — | — | 204 |
| 106 | — | — (strict empty) | Payment method[] |

#### 8.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 105, 106 | `400` · `params.payment_method_id` | not `pm_` + 1–250 letters and digits (as built, [P404](decisions.md): the field is the route schema's path; a segment over 100 characters is `414`, Fastify's parameter limit) |
| 105, 106 | `404` | no such card on the organization's customer, or no customer |
| 105 | `409` · `default_card_in_use` | the only card while a paid plan is on |
| 105, 106 | `422` | a personal organization; (106) the idempotency key missing, malformed or reused |
| 105, 106 | `503` | Stripe down or its circuit open |

#### 8.C.10 Rules worth knowing

None beyond 8.10.

#### 8.C.11 Code changes

| # | Change |
| --- | --- |
| BLC11 | BL20, BL21, BLQ2: `detachStripePaymentMethod`, `setStripeCustomerDefaultPaymentMethod` (+ the subscription's) in `stripe.client.ts` through `outboundCall`, the payment-provider port and its fake; the two routes (`config: { idempotencyRequired: true }` on 106), controller, service, `paymentMethodIdParamsDto`; `payment_method_id` added to the non-entity params (be-api-contract-guard, the param policy test, `route-http-coverage.helper.ts`'s materializer); reason `default_card_in_use`; nock contract fixtures |

---

### 8.D Stripe webhook — `billing/sub-domains/stripe-webhook/` — final (rev 4, confirmed 2026-11-24)

#### 8.D.1 Decisions

| # | Decision |
| --- | --- |
| BL22 | **What the webhook now decides (RC-66, plan:L8111).** Today: `customer.subscription.created` / `.updated` sync the row; `.deleted` marks it `CANCELED`; ordering by `last_stripe_event_created_at` (as built). After, in the same handlers and the same commit: (1) **unpaid trial end** — a `.deleted` for a row whose local status was `TRIALING` (or whose `current_period_end` ≤ `trial_end`: never paid) → the row `CANCELED`, a local `ACTIVE` Free row inserted (no Stripe id), `PLAN_STATE_CHANGED` `trial_ended` with the row's `downgrade_keep`; (2) **scheduled move down to Free** — a `.deleted` for a row whose `scheduled_plan_id` is Free → the same Free row, `moved_down`; (3) **scheduled paid move down** — an `.updated` whose price is now `scheduled_plan_id`'s → `plan_id` follows, the three schedule columns cleared, `moved_down` with the kept accounts; (4) **paid plan cancelled** — a `.deleted` otherwise → `plan_ended`; (5) a status change into or out of `PAST_DUE` / `UNPAID` / `ACTIVE` → `PLAN_STATE_CHANGED` (`plan_ended` is WC-59's when the grace ends, `resumed` when paid again). Each event is emitted after commit, once (the event row's processing is once, as built). The referral part of RC-66 is out (P39). |
| BL23 | **No new Stripe event types.** The schedule's flip arrives as `customer.subscription.updated`; the trial's end as `.deleted` (with `missing_payment_method = cancel`). `invoice.*` and `charge.*` stay unhandled (refunds and disputes were the referral's, P39). |

#### 8.D.2 Open questions

None.

#### 8.D.3 Tables and relations

`billing.stripe_webhook_events` unchanged. Writes `billing.subscriptions` (8.B.3) as built, plus the local Free row.

#### 8.D.4 Permissions

| Code | Routes |
| --- | --- |
| PUBLIC (`Stripe-Signature`) | 107 |

#### 8.D.5 Common to every route

As built: raw body, signature checked, the event stored then processed by its worker; `200` acknowledgement.

#### 8.D.6 Objects returned

**Stripe acknowledgement** (as built).

#### 8.D.7 Routes (107)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 107 | POST | `/billing/webhook` | Stripe's events; trial end and scheduled moves **(changed)** | Stripe-Signature | |

#### 8.D.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 107 | — | Stripe's event (verbatim, third-party payload) | acknowledgement |

#### 8.D.9 Errors

As built (`400` bad signature, `503` not configured).

#### 8.D.10 Rules worth knowing

- The webhook worker runs in the event's organization (`withAppDatabaseContext`, as built); the Free row's insert satisfies the
  policy's `WITH CHECK` there.

#### 8.D.11 Code changes

| # | Change |
| --- | --- |
| BLC12 | BL22, BL23: the four cases in `stripe-webhook.service.ts`'s handlers (`handleSubscriptionUpdated`, `handleSubscriptionDeleted`); the local Free row insert through the subscription service; the event emits; tests per case (an unpaid trial → Free + one event; a scheduled Free move; a paid schedule flip; a cancelled paid plan → `plan_ended`; an out-of-order event changes nothing) |
| R26 | As built ([P405](decisions.md)): a case starts only from a row live before the event; the end cases (1, 2, 4) also on a `.updated` that ends the row (status `canceled`); Free = the catalog's Free plan (a trial) or the scheduled Free plan, the local row `ON CONFLICT DO NOTHING` on the one-live-row index (+ `subscription.created`); case 5 — `resumed` from `PAST_DUE` / `UNPAID`, `upgraded` on the first payment, a Dashboard plan change by route 103's direction rule, entering the grace says nothing; `PLAN_STATE_CHANGED` after the commit, only when the entitlement moved (`stripe-webhook-plan-state.util.ts`, `emitPlanStateChangedAfterCommit`) |

---

## 9. Tenancy — roles and organization — rev 3 (2026-11-24) — nested sub-domains 9.A–9.C; final (rev 3, confirmed 2026-11-24)

**Status: final (rev 3, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 3 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **tenancy domain's own sub-domains**, changed in place in `src/domains/tenancy/sub-domains/` — `organization/` (9.A),
`member-roles/` (9.B), `membership/` with `membership-invitation/` (9.C). The domain is in `main`: new tenancy migrations only
(D48, plan:L7784). No new folder.

9.1 Decisions (whole sub-domain) · 9.2 Open questions · 9.3 Tables and relations · 9.4 Permissions · 9.5 Common to every route ·
9.6 Objects returned · 9.7 Routes · 9.8 Request details · 9.9 Errors · 9.10 Rules worth knowing · 9.11 Code changes (whole sub-domain) ·
9.12 Nested sub-domains · then **9.A Organization · 9.B Roles · 9.C Members and invitations** — each with the same eleven sections.

The four fixed roles every team organization holds (Owner, Admin, Editor, Viewer — D55), the one new code `contact:update` (P20),
custom roles switched off, unlimited members, an invite of several emails at once, the invitation page's preview, and two
organization fields (a read-only slug, a tile colour). Design read: plan §45 (plan:L7782–L7907), §50.5 B2 (plan:L8440), the
migration list (plan:L8459–L8461); `db-changes.md` › organization, Reference data; `route-changes.md` RC-86–RC-94, RC-109, RC-110. Builds on:
users (auth), the app's codes (`app.permissions.ts`), the upload code. Route numbers run 110–118, plus 141–142 (rev 5, P99).

### 9.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). No launch review covers
tenancy; "today" is the code in `main` plus the launch's Member role (launch D2, D3, D31, AS-BUILT "Member role").

**rev 3 changes** (P99, M13): the two changed organization routes this review once listed without numbers are routes 141 (`POST /tenancy/organizations`, RC-109 — TN7) and 142 (`GET /tenancy/organization`, RC-110 — TN8) in 9.A. No decision changes.

| # | Decision |
| --- | --- |
| TN1 | **Four locked system roles on every team organization (plan:L7861–L7889, D55).** Today: Owner (locked, every code), Admin (locked, `ADMIN_PERMISSION_CODES`), Member (locked, six codes: `organization:read`, `instagram-account:read`, `automation:read`, `automation:create`, `automation:update`, `contact:read`) from `DEFAULT_TEAM_ROLES` (`organization-provisioning.ts`), applied by provisioning and `reconcileDefaultTeamRoles`. After: **Member becomes Editor** — the same row renamed (its public id, members and grants keep), plus `automation:delete` (D55), `contact:update` (P20) and `upload:manage` (message files); `MEMBER_ROLE_NAME` → `EDITOR_ROLE_NAME` (plan:L7881); **Viewer is new** — locked, `is_system`, codes `organization:read`, `channel-account:read` (P59), `instagram-account:read`, `automation:read`, `contact:read`, tone `sky`; added by provisioning, by `reconcileDefaultTeamRoles` and by a new migration for the organizations that exist (plan:L7882). Codes not on the screen (webhooks, audit logs, notification policies, `instagram-webhook-event:read`) stay Owner and Admin (as built). Other option: keep Member and add Editor beside it — two near-identical roles on the Roles screen. |
| TN2 | **One new code `contact:update` (P20).** Today: the app holds nine codes (`app.permissions.ts`). After: `CONTACT_UPDATE: 'contact:update'` in `APP_PERMISSIONS` (sub-domain 3's CT1 names it), its row in `tenancy.permissions` (the catalog seed and the new migration `tenancy_permission_contact_update`), granted to Owner, Admin and Editor of every team organization in that migration (plan:L7883). The migration runs before the Editor rename's grants (both in one file is also fine — one migration per plan sketch, ordered). |
| TN3 | **Custom roles off (plan:L7884).** Today: create, edit, delete, restore a custom role and replace its codes are live (`role:create` … ); members may hold extra roles (`membership_additional_roles`). After: a **tenancy code constant** `TENANCY_CUSTOM_ROLES_ENABLED = false` (a product switch, not environment-varying — P4) checked first in the five write routes (9.B) → `403 custom_roles_off`, and in `POST` / `PATCH …/memberships` when `role_ids` names more than one role or a role that is not one of the four system roles → `403 custom_roles_off`. Reads stay (the Roles screen reads them, plan:L7885). A member who already holds a custom role keeps it until an Admin changes it (plan:L7884) — nothing is migrated. Other option: remove the custom-role code — it stays a platform feature another product may switch on. |
| TN4 | **Unlimited members (D55).** Today: inviting reserves a seat against the plan's `included_seats` (`409 seat_limit_reached`, billing's seat port). After: `included_seats` is empty on every plan (billing BL9), so the reserve never refuses; the seat port stays (billing's), no tenancy change beyond tests that an organization with 30 members invites a 31st. |
| TN5 | **Organization paused stops sending (plan:L7907).** Today: `status` `SUSPENDED` (our team's) leaves sending on. After: no tenancy change — the sending engine reads the organization's status (sub-domain 6) and `GET /auth/me/context` already carries `status` (billing BL16). Recorded here so the change files show where it lives. |
| TN6 | **Audit (as built, K9 form).** `tenancy.membership.create` (the built name — [P204](decisions.md)) once per invited email (as built — one entry per row), `tenancy.role.*` writes now refused leave no entry; the role rename is a migration (no audit row). |
| TN12 | **Two codes for the shared channel routes ([P59](decisions.md)).** Today: `instagram-account:read` / `:manage` gate every account route. After: `CHANNEL_ACCOUNT_READ: 'channel-account:read'` and `CHANNEL_ACCOUNT_MANAGE: 'channel-account:manage'` in `APP_PERMISSIONS` gate the shared Channel connection and Channel account routes (sub-domains 1 and 1B: 1–11, 15, 40–42); a new tenancy migration `tenancy_permission_channel_account` adds both catalog rows and grants each to every role that holds its `instagram-account:*` twin — Owner and Admin both, Editor and Viewer read — idempotent on re-run. P59 calls it a rename; it is done as add-and-copy because Instagram's settings and media keep `instagram-account:*`. `DEFAULT_TEAM_ROLES`, `ADMIN_PERMISSION_CODES` and `reconcileDefaultTeamRoles` carry the new codes; Owner holds every code (as built). Runs after `tenancy_permission_contact_update`. The Roles screen's rows do not change (its "Connect and remove Instagram accounts" covers both codes). |

### 9.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| TNQ1 | The tile colour value for lavender: the shared chip tones (`CHIP_TONE`, used by roles' and members' `tone`) store it as `lav` | rename the shared value `lav` → `lavender` everywhere in the same PR (a tenancy migration rewrites the `tone` rows and both `CHECK`s; meepzo-fe follows) · keep `lav` as a wire literal | **Rename to `lavender`** — the full-names rule and your brief ("value names full words"); `db-changes.md` already writes `lavender`; reuse means one tone list, so it changes for roles and members too, not only the new column | **P81** — rename to `lavender` (as recommended) |
| TNQ2 | An invite takes one role (plan:L7891) but the code takes `role_ids` (main first) | keep `role_ids` and allow exactly one (custom and extra roles off, TN3) · a new `role_id` field | **Keep `role_ids`** with exactly one — the same shape `PATCH …/memberships` uses; turning extra roles on later is no contract change | **P82** — `role_ids` with exactly one (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 9.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `tenancy.organizations` (changed) | an organization | + `logo_color` (9.A); `slug` never changes after create |
| `tenancy.roles` (rows change) | a role of an organization | Member rows renamed Editor; a Viewer row added per team organization |
| `tenancy.role_permissions` (rows change) | role ↔ code | Editor + 3 codes; Viewer's 4; `contact:update` for Owner, Admin, Editor |
| `tenancy.permissions` (one row) | the code catalog | + `contact:update` |
| `tenancy.memberships`, `tenancy.membership_invitations` | unchanged | the preview reads an invitation through a resolver (9.C) |

```text
tenancy.organizations ──┬──< tenancy.roles ──< tenancy.role_permissions >── tenancy.permissions
                        │       Owner · Admin · Editor (was Member) · Viewer (new)   + contact:update
                        └──< tenancy.memberships ──< tenancy.membership_invitations
```

**PostgreSQL design**

No new table. Every changed table keeps its standard columns and its organization policy (`USING` and `WITH CHECK`, enabled and
forced — as built); `tenancy.permissions` is the global catalog (as built). Each change is in its nested sub-domain.

### 9.4 Permissions

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `organization:update` | Workspace · Members, workspace name, API keys | the name and the tile colour | 110 | Owner, Admin |
| `role:create` / `role:update` / `role:delete` | Workspace · Members, workspace name, API keys | (refused while custom roles are off) | 111–115 | Owner, Admin |
| `membership:read` | Workspace · Members, workspace name, API keys | the members list with counts | 116 | Owner, Admin |
| `membership:create` | Workspace · Members, workspace name, API keys | invite 1–20 emails | 117 | Owner, Admin |
| — (PUBLIC, the invitation token) | — | the invitation page | 118 | the invitee |
| `contact:update` **(new, P20)** | Contacts · Tag contacts, write notes | (sub-domain 3's routes) | — | Owner, Admin, Editor |
| `channel-account:read` / `channel-account:manage` **(new, P59)** | as `instagram-account:*` (TN12) | (sub-domains 1 and 1B's routes) | — | read: Owner, Admin, Editor, Viewer; manage: Owner, Admin |

The four roles × the nine screen permissions are plan:L7867–L7877; Viewer holds the four reads only.

### 9.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/tenancy` |
| Auth | `Authorization: Bearer <access token>` (110–117); 118 PUBLIC with an optional bearer (a signed-in caller is recognised) |
| Organization | team-only writes answer `422` on a personal organization (as built: roles, invites) |
| Writes | `X-Idempotency-Key` as built: required on 111, 115, 117 (role create, role restore, invite); none on 110, 112–114 (PATCH, DELETE, PUT); none on 118 (it saves nothing) |
| Success | `200` with `{ data, meta }`; 113 → `204` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `409`, `422`, `429` |

### 9.6 Objects returned

| Object | Where |
| --- | --- |
| Organization | 9.A.6 — Organization |
| Role | 9.B.6 — Roles (as built) |
| Membership list meta · Invite result · Invitation preview | 9.C.6 — Members and invitations |

### 9.7 Routes (110–118, 141–142)

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 110 | PATCH | `/tenancy/organization` | Name and tile colour; the slug is read only **(changed)** | `organization:update` | | RC-89 |
| 111 | POST | `/tenancy/organization/roles` | Refused while custom roles are off **(changed)** | `role:create` | req | RC-90 |
| 112 | PATCH | `/tenancy/organization/roles/{role_id}` | Refused while off **(changed)** | `role:update` | | RC-91 |
| 113 | DELETE | `/tenancy/organization/roles/{role_id}` | Refused while off **(changed)** | `role:delete` | | RC-92 |
| 114 | PUT | `/tenancy/organization/roles/{role_id}/permissions` | Refused while off **(changed)** | `role:update` | | RC-93 |
| 115 | POST | `/tenancy/organization/roles/{role_id}/restore` | Refused while off **(changed)** | `role:delete` | req | RC-94 |
| 116 | GET | `/tenancy/organization/memberships` | Members, plus the count per role **(changed)** | `membership:read` | | RC-87 |
| 117 | POST | `/tenancy/organization/memberships` | Invite 1–20 emails with one role **(changed)** | `membership:create` | req | RC-88 |
| 118 | POST | `/tenancy/membership-invitations/{membership_invitation_id}/preview` | What the invitation page shows **(new)** | PUBLIC (token) | | RC-86 |
| 141 | POST | `/tenancy/organizations` | Create a team organization — the slug optional, made from the name; the tile colour from the name **(changed)** | AUTH | req | RC-109 |
| 142 | GET | `/tenancy/organization` | The active organization, + `logo_color` **(changed)** | AUTH | | RC-110 |

### 9.8 Request details

In each nested sub-domain (9.A to 9.C, section .8).

### 9.9 Errors

Every route can answer the errors in 9.5; each route's own errors are in its nested sub-domain (9.A to 9.C, section .9).

### 9.10 Rules worth knowing

- **Role names are never the guard.** Every check reads `is_system` / `is_locked` and the codes (as built); the rename touches
  only `name` (and the constant). Who gets a notification of a kind (sub-domain 11) is decided by codes too, never by role name.
- **The organization chooser's counts** (members, Instagram accounts, live automations — `GET /users/me/organizations`, sub-domain 11
  route 132) read across the caller's organizations through one `SECURITY DEFINER` function owned by the app (11.A, UN3); tenancy
  data (the memberships) is read inside it for the members count; tenancy never imports app code.

### 9.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| TNC1 | TN1, TN2: new tenancy migrations `tenancy_permission_contact_update` (the catalog row and the three grants) and `tenancy_roles_editor_viewer` (rename every team organization's `is_system` Member → Editor and its three new grants; insert Viewer and its four grants per team organization; idempotent on re-run); `DEFAULT_TEAM_ROLES` = Admin, Editor, Viewer; `EDITOR_ROLE_NAME`, `VIEWER_ROLE_NAME`; the permission catalog seed; `scripts/seed/full.ts`'s demo roles; `src/domains/tenancy/tenancy.overview.md`, `src/POLICIES.md`'s role table, `docs/` role docs; tests — a new team gets four roles with exactly these codes, the reconcile on an old team, a Viewer `403` on every app write, an Editor deletes an automation |
| TNC2 | TN3: `TENANCY_CUSTOM_ROLES_ENABLED` in `member-role.constants.ts`; the guard first in the five role writes and in the membership `role_ids` check; reason `custom_roles_off` (`errors:customRolesOff`, `response-codes.md`); tests per route |
| TNC3 | TN4: the invite-the-31st test; `seat_limit_reached` documented as unreachable while plans carry no seats |
| TNC8 | **Built R3** (migration `20261124101530_tenancy_permission_channel_account.sql`, every live role holding the twin — [P115](decisions.md); the grants table rows; the gates of routes 1–5, 40, 42 — routes 6–11, 15, 41 gate with their rows). TN12: `APP_PERMISSIONS` + the two codes; migration `tenancy_permission_channel_account` (two catalog rows, the copied grants, idempotent); the permission catalog seed; the gates of routes 1–11, 15, 40–42 (sub-domains 1, 1B) and their `docs/routes.txt` rows; `src/POLICIES.md`'s role table; tests — the migration's grants equal the `instagram-account:*` grants, a Viewer reads route 6 and is refused route 9, an Editor is refused route 3 |

### 9.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/tenancy/sub-domains/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 9.A Organization | `organization/` | `tenancy.organizations` | 110, 141–142 | final (rev 3, confirmed 2026-11-24) |
| 9.B Roles | `member-roles/` | `tenancy.roles`, `tenancy.role_permissions` (rows) | 111–115 | final (rev 3, confirmed 2026-11-24) |
| 9.C Members and invitations | `membership/` (+ `membership-invitation/`) | `tenancy.memberships`, `tenancy.membership_invitations` (unchanged) | 116–118 | final (rev 3, confirmed 2026-11-24) |

---

### 9.A Organization — `tenancy/sub-domains/organization/` — final (rev 3, confirmed 2026-11-24)

#### 9.A.1 Decisions

| # | Decision |
| --- | --- |
| TN7 | **Slug read only (plan:L7903).** Today: `updateOrganizationDto` takes `slug` (and a taken one is `409 organization_slug_exists`). After: `slug` stays in the strict DTO only so a client that sends it gets the clear refusal `422 slug_read_only` instead of `400` unknown key; it is made once from the name at create. `POST /tenancy/organizations` today **requires** `slug` (`createOrganizationDto`); onboarding step 3 sends the name only (plan:L7808) — so `slug` becomes optional there and is made from the name (kebab, unique with a short suffix on a clash) — route 141 (RC-109; numbered in rev 5, P99). |
| TN8 | **Tile colour `logo_color` (plan:L7905).** One of five chip tones `sky` · `lavender` (TNQ1) · `sage` · `peach` · `slate`, a subset of the shared `CHIP_TONE` list (reuse — one tone vocabulary, `ORGANIZATION_LOGO_COLORS` = those five); default picked from the name at create (a stable hash of the lower-cased name, mod 5 — one name always gets one colour); the migration fills existing organizations the same way; `PATCH` may set it; route 142 (RC-110) returns it. The uploaded logo stays in the API (`PUT …/logo`, as built). |

#### 9.A.2 Open questions

TNQ1 (`lav` → `lavender`) — 9.2; answered P81: renamed.

#### 9.A.3 Tables and relations

`tenancy.organizations` (changed)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `logo_color` | `varchar(10)` | no | (from the name, set by the service and the migration's backfill) | `CHECK (logo_color IN ('sky','lavender','sage','peach','slate'))` — `chk_organizations_logo_color` |

Migration `tenancy_organizations_logo_color`: add nullable, backfill from the name, then `NOT NULL` and the `CHECK` (one file; a
big table would batch the backfill — tenancy organizations are few). Indexes and RLS unchanged (organization policy, enabled and
forced).

**As built R27** ([P202](decisions.md), [AS-BUILT](../AS-BUILT.md)): the name's colour is one SQL rule,
`tenancy.fn_organization_logo_color(name)` (the first 32 bits of the SHA-256 of the lower-cased name, mod 5) — the insert
names it, the backfill uses it, and the BEFORE INSERT trigger `trg_organizations_logo_color` fills a row written without a
colour (the previous release keeps inserting while the file applies). The `lav` → `lavender` rename is its own migration,
`tenancy_chip_tone_lavender`, with an expand-phase trigger storing a written `lav` as `lavender` (contract next release).

#### 9.A.4 Permissions

| Code | Routes |
| --- | --- |
| `organization:update` | 110 |
| AUTH (as built) | 141, 142 |

#### 9.A.5 Common to every route

As 9.5.

#### 9.A.6 Objects returned

**Organization** (as built: `id`, `name`, `slug`, `type`, `status`, `logo_url`, `timezone`, …) + `logo_color`. Also in
`GET /tenancy/organization` (route 142), `GET /auth/me/context` and the chooser (one serializer).

#### 9.A.7 Routes (110, 141–142)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 110 | PATCH | `/tenancy/organization` | Name and tile colour **(changed)** | `organization:update` | |
| 141 | POST | `/tenancy/organizations` | Create one from the name only **(changed)** | AUTH | req |
| 142 | GET | `/tenancy/organization` | Read it, + `logo_color` **(changed)** | AUTH | |

#### 9.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 110 | — | optional: `name` (1–255), `logo_color` (the five values), and the other fields as built; `slug` (any string) → `422` | Organization |
| 141 | — | `name*` (1–255); optional `slug` (made from the name when absent — TN7: kebab, accents folded, `organization` for a name with no Latin letter or digit, a 6-character suffix when taken, [P202](decisions.md)) and `logo_color` (else from the name — TN8); the other fields as built | Organization |
| 142 | — | — | Organization (+ `logo_color`) |

#### 9.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 110 | `422` · `slug_read_only` | the body has `slug` |
| 110 | `400` · `logo_color` | not one of the five |
| 141 | `400` · `logo_color` | not one of the five |

#### 9.A.10 Rules worth knowing

None beyond 9.10.

#### 9.A.11 Code changes

| # | Change |
| --- | --- |
| TNC4 | TN7, TN8: migration `tenancy_organizations_logo_color`; `logo_color` in the schema, DTO, service (the default from the name), serializer; `ORGANIZATION_LOGO_COLORS`; `slug_read_only` (`errors:slugReadOnly`); `createOrganizationDto` slug optional + the slug maker; with TNQ1, `CHIP_TONE.LAVENDER = 'lavender'` and a tenancy migration rewriting `roles.tone` / `memberships.tone` and their checks; tests |

---

### 9.B Roles — `tenancy/sub-domains/member-roles/` — final (rev 3, confirmed 2026-11-24)

#### 9.B.1 Decisions

TN1–TN3 (9.1) are this nested sub-domain's: the four system roles, `contact:update`, custom roles off.

#### 9.B.2 Open questions

None.

#### 9.B.3 Tables and relations

`tenancy.roles` — no column change; rows: Member → Editor (`name`; `description` "Makes and runs automations and keeps contacts
tidy."), a Viewer row per team organization (`is_system`, `is_locked`, tone `sky`). `tenancy.role_permissions` — rows as TN1, TN2.
Both: organization policy, enabled and forced (as built).

#### 9.B.4 Permissions

| Code | Routes |
| --- | --- |
| `role:create` | 111 |
| `role:update` | 112, 114 |
| `role:delete` | 113, 115 |

#### 9.B.5 Common to every route

As 9.5. The custom-roles check runs after the permission gate (a caller without the code still gets `403 missing_permission`).

#### 9.B.6 Objects returned

**Role** (as built) — only reached by the read routes, which do not change.

#### 9.B.7 Routes (111–115)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 111 | POST | `/tenancy/organization/roles` | Refused while custom roles are off **(changed)** | `role:create` | req |
| 112 | PATCH | `/tenancy/organization/roles/{role_id}` | Refused while off **(changed)** | `role:update` | |
| 113 | DELETE | `/tenancy/organization/roles/{role_id}` | Refused while off **(changed)** | `role:delete` | |
| 114 | PUT | `/tenancy/organization/roles/{role_id}/permissions` | Refused while off **(changed)** | `role:update` | |
| 115 | POST | `/tenancy/organization/roles/{role_id}/restore` | Refused while off **(changed)** | `role:delete` | req |

#### 9.B.8 Request details

As built (bodies unchanged; never reached while off).

#### 9.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 111–115 | `403` · `custom_roles_off` | always, while `TENANCY_CUSTOM_ROLES_ENABLED` is false — after the permission gate, before the service's own body checks and role lookups (the route schema still answers a malformed body or query `400` first, as on every route; on a personal organization it comes before the team-only `422`) ([P203](decisions.md)) |

#### 9.B.10 Rules worth knowing

- 112 and 114 on a system role were already refused (`403 system_role_fixed` / `role_locked`); `custom_roles_off` comes first now.

#### 9.B.11 Code changes

TNC1, TNC2 (9.11). As built (R28, [P203](decisions.md)): the guard is `assertCustomRolesEnabled` / `assertMembershipRolesAllowed`
in `member-roles/member-role-capability.ts`; Editor's and Viewer's app codes are the typed table `APP_PERMISSION_DEFAULT_TEAM_GRANTS`
(`organization-provisioning.ts`), and the reconcile also renames a system Member to Editor (`formerNames`).

---

### 9.C Members and invitations — `tenancy/sub-domains/membership/` (+ `membership-invitation/`) — final (rev 3, confirmed 2026-11-24)

#### 9.C.1 Decisions

| # | Decision |
| --- | --- |
| TN9 | **Counts by role (route 116, RC-87, plan:L7895).** Today: the list answers members only. After: `meta.counts_by_role` — `[{ role_id, name, count }]` for each role that is someone's **main** role among live members (`active`, `invited`, `suspended`), Owner first, whatever the list's filters (the screen's header counts); one grouped query in the membership repository beside the page query. |
| TN10 | **Invite several emails (route 117, RC-88, plan:L7891–L7897).** Today: `email` (one), `role_ids`, `expires_in_days` (default 7), staff fields. After: `emails` (1–20, `INVITE_EMAILS_MAX` 20, trimmed, lower-cased, repeats folded) replaces `email`; `role_ids` exactly one (TNQ2, TN3); the staff profile fields go (a multi-email invite cannot carry one person's phone or hours — they stay on `PATCH`). One `X-Idempotency-Key` covers the whole request (be-idempotency-guard: the answer replays). Each email in its own unit of work, in order: `invited` (a membership `invited` + an invitation + its email, as built per row), `already_member` (a live member has the email), `already_invited` (a live invitation exists), `invalid_email` (fails the email check, or a disposable domain — the rest still go). Answers one result per email (9.C.6). The role checks (team, one system role, not the Owner role, the caller's codes) refuse the whole invite before any address; `already_invited` is a live `invited` membership ([P204](decisions.md)). |
| TN11 | **Invitation preview (route 118, RC-86, plan:L7828–L7847).** PUBLIC; body `{ token }` (POST keeps it out of URLs and logs); `30` a minute per IP (`INVITATION_PREVIEW_PER_MINUTE` 30, the route's rate limit). A new `SECURITY DEFINER` resolver `tenancy.resolve_membership_invitation_preview(public_id, token_hash)` answers only when the SHA-256 of the token matches the row (the existing `resolve_membership_invitation_lookup_by_public_id` is the accept path's and keeps its signature): `state` (`valid` · `accepted` · `expired` · `revoked` — a declined invitation reads `revoked`), the organization's `name` and `logo_color`, the main role's name, the inviter's first name, `expires_at`. A wrong token or id → `404` (the same as unknown). `revoked` also covers an invitation whose invited membership ended; the optional sign-in is `authenticateWhenBearerPresent` and the cap the preset `INVITATION_PREVIEW_RATE_LIMIT` ([P204](decisions.md)). `signed_in` = a valid bearer came with it; `email_matches` only when signed in (the caller's verified email equals the invitation's); a signed-out caller never sees the invitee's email. No body is stored, no audit row. |

#### 9.C.2 Open questions

TNQ2 (`role_ids` kept, exactly one) — 9.2; answered P82.

#### 9.C.3 Tables and relations

No column change. Route 118 reads `tenancy.membership_invitations`, `tenancy.memberships`, `tenancy.roles`,
`tenancy.organizations` and `auth.users` (inviter's first name) inside the resolver only. Indexes: the unique `token_hash` index
(as built) serves the resolver. RLS unchanged.

#### 9.C.4 Permissions

| Code | Routes |
| --- | --- |
| `membership:read` | 116 |
| `membership:create` | 117 |
| PUBLIC (token) | 118 |

#### 9.C.5 Common to every route

As 9.5. Route 118: optional auth — a new shared pre-handler that reads a bearer when one is sent and never refuses (none exists today;
the OAuth link start, 10.A, uses the same one) — its own rate limit, no captcha (it reveals nothing without the token).

#### 9.C.6 Objects returned

**Membership list meta** (route 116): the paging meta (as built) + `counts_by_role` (`[{ role_id, name, count }]`).

**Invite result** (route 117): `results` — `[{ email, result, membership_id }]`, `result` = `invited` · `already_member` ·
`already_invited` · `invalid_email`, `membership_id` (`mem_…`) when `invited` or `already_member` (null otherwise);
`invited_count`.

**Invitation preview** (route 118): `state`, `organization` (`{ name, logo_color }`), `role_name`, `inviter_first_name` (or
null), `expires_at`, `signed_in`, `email_matches` (null when signed out).

#### 9.C.7 Routes (116–118)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 116 | GET | `/tenancy/organization/memberships` | Members with the count per role **(changed)** | `membership:read` | |
| 117 | POST | `/tenancy/organization/memberships` | Invite 1–20 emails **(changed)** | `membership:create` | req |
| 118 | POST | `/tenancy/membership-invitations/{membership_invitation_id}/preview` | The invitation page **(new)** | PUBLIC (token) | |

#### 9.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 116 | as built (`q`, `status`, `role_id`, `sort`, `order`, `limit`, `after`) | — | Membership[] + meta |
| 117 | — | `emails*` (1–20), `role_ids*` (exactly 1); optional: `expires_in_days` (1–365, default 7) | Invite result |
| 118 | — | `token*` (1–512) | Invitation preview |

#### 9.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 117 | `400` · `emails` / `role_ids` | none or more than 20; `role_ids` empty |
| 117 | `403` · `custom_roles_off` | more than one role, or a role that is not a system role (TN3) |
| 117 | `400` · `role_ids` | a role not in the organization, or the Owner role |
| 117 | `422` | a personal organization; the idempotency key missing, malformed or reused |
| 118 | `400` · `token` / `membership_invitation_id` | missing, too long, not an `inv_…` id |
| 118 | `404` | unknown id, or the token does not match |
| 118 | `429` | over 30 a minute from one IP |

#### 9.C.10 Rules worth knowing

- Accept and decline stay as built (AUTH, the verified email must match; an unconfirmed email cannot accept — plan:L8212).

#### 9.C.11 Code changes

| # | Change |
| --- | --- |
| TNC5 | TN9: the grouped count in `membership.repository.ts`, `counts_by_role` in the controller's meta; test |
| TNC6 | TN10: `createMembershipDto` → `emails` + one role; the per-email loop in `MembershipService` (each email its own unit of work, results collected); `INVITE_EMAILS_MAX`; the replay of the whole answer; tests (3 emails → 2 invited + 1 already member, a repeat replays, 21 emails `400`) |
| TNC7 | TN11 (**built R29**, migration `20261124091500_tenancy_membership_invitation_preview.sql`): the resolver in a new tenancy migration `tenancy_membership_invitation_preview`; the route (PUBLIC, optional auth, `config.rateLimit` 30/min), controller, service, `previewMembershipInvitationDto`, serializer; tests for the seven states (valid + match, accepted, expired, revoked, declined → revoked, wrong account, signed out) and a wrong token `404` |

---

## 10. Auth — sign-in — rev 3 (2026-11-24) — nested sub-domains 10.A–10.D; final (rev 3, confirmed 2026-11-24)

**Status: final (rev 3, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 3 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **auth domain's own sub-domains**, changed in place in `src/domains/auth/` — `sub-domains/auth-method/` with its
`oauth/` and the email code (10.A, 10.B), `sub-domains/auth-mfa/` plus one **new** persistence folder
`sub-domains/auth-trusted-device/` (10.C), `sub-domains/auth-session/` (10.D); the route file is `auth.routes.ts` with the
handlers under `handlers/` (as built). The domain is in `main`: new auth migrations only (D48, plan:L7600).

10.1 Decisions (whole sub-domain) · 10.2 Open questions · 10.3 Tables and relations · 10.4 Permissions · 10.5 Common to every route ·
10.6 Objects returned · 10.7 Routes · 10.8 Request details · 10.9 Errors · 10.10 Rules worth knowing · 10.11 Code changes (whole sub-domain) ·
10.12 Nested sub-domains · then **10.A Email code and passwords off · 10.B Google, Apple and the sign-in ways · 10.C Two-factor,
trusted devices and step-up · 10.D Sessions** — each with the same eleven sections.

Flowdm signs people in with no password: Google, Apple, a passkey or an email code (plan:L7598–L7778). Design read: plan §44,
§47.5 (plan:L8194–L8199), §50.5 B1 (plan:L8439), the migrations (plan:L8452–L8454), §53.3 items 1–3 (plan:L8802–L8804);
`db-changes.md` › session, trusted_device; `route-changes.md` RC-70–RC-78, RC-98–RC-101 (removed), RC-102–RC-106; `worker-changes.md` WC-64 (the trusted-device clean-up). Builds on: users (user domain), the
organization's MFA policy (tenancy). Route numbers run 120–128 and 143–147 (rev 5, P99); the four removed routes carry no number.

### 10.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). "Today" is the code in
`main` (no launch review covers auth).

**rev 3 changes** (P99, M13): the five changed routes this review once listed without numbers are routes 143–147 (RC-102–RC-106) in 10.B, 10.C and 10.D; the trusted-device clean-up cites WC-64 (10.C.3). No decision changes.

| # | Decision |
| --- | --- |
| AT1 | **Passwords off everywhere (plan:L7613, RC-98–RC-101).** Today: `POST /auth/login`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/password/change` are live; `auth.users.password_hash`; a password step-up (`verifyPasswordForStepUp`, the password step-up budget). After: the four routes are **removed** (not registered — `404`), with their handlers, DTOs (`LoginDto`, `ForgotPasswordDto`, `ResetPasswordDto`, `ChangePasswordDto`, `passwordPolicy`), service paths and the password branch of step-up (ATQ1); a new auth migration `auth_passwords_off` sets every `password_hash` to null and marks every `PASSWORD` row of `auth.auth_methods` revoked (`revoked_at` = the migration time); the column `password_hash` stays (nullable, empty — dropping it is a later clean-up with the user domain). The per-IP failed-login throttle that only `/auth/login` used goes with it; the 429 note in `response-codes.md` is rewritten. |
| AT2 | **One fixed `reason` list for "sign-in failed" (plan:L7695–L7708).** Every sign-in refusal carries a stable `error.reason` the app maps to a line: `oauth_cancelled`, `oauth_expired`, `oauth_failed`, `login_method_turned_off`, `oauth_link_needs_verified_email`, `account_not_active` (OAuth, 10.B); `code_wrong`, `code_expired`, `code_used_up`, `code_day_limit`, `code_resend_too_soon` (10.A); `mfa_code_wrong`, `mfa_locked` (10.C). Today most exist only as i18n keys (`errors:invalidOrExpiredVerificationCode`, `errors:loginMethodTurnedOff`, `errors:accountNotActive`) without reasons. All go to `response-codes.md` and `src/shared/locales/en/errors.json`. |
| AT3 | **Two additive error fields (the envelope).** Today the error body has `type`, `code`, `reason?`, `detail`, `errors[]` and `429` sets `Retry-After`. After: `error.tries_left` (integer, on `code_wrong` and `mfa_code_wrong`) and `error.retry_after_seconds` (integer, on the `429`s — beside the `Retry-After` header, so a browser app need not read headers) — set at the throw site with one new `AppError.withFields({ tries_left, retry_after_seconds })` (snake_case, only these two names allowed; a unit test pins the list). `docs/reference/api/response-codes.md` › "Error body shape" gains them. Other option: put the counts in `detail` only — the app could not branch on them. |
| AT4 | **Audit (plan:L7621, as built form).** Every sign-in, step-up, trusted-device tick and removal writes `audit.logs` (as today); new actions `auth.trusted_device.create`, `auth.trusted_device.revoke` (INFO), `auth.oauth.link` (WARNING, `metadata.provider`), `auth.passwords_off` is the migration's (no row). |
| AT5 | **GitHub off (plan:L7778).** `SUPPORTED_OAUTH_PROVIDERS` = `google`, `apple`. The GitHub provider file and its env vars are **removed** in the same change (reuse rule: not left unused beside the new list); existing `OAUTH` rows with `provider = 'github'` stay (harmless — they can no longer sign in; the person uses the email code of the same email, then connects Google or Apple). Other option: the plan's "the GitHub code stays unused (a later clean-up)". |

### 10.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| ATQ1 | Passwords: remove the code, or keep it behind `AUTH_PASSWORDS_ENABLED` false (the plan's switch) | remove the four routes and the password code paths now (AT1) · a code constant that leaves them unregistered | **Remove** — the migration empties every `password_hash`, so the switch could never be turned back on without a reset flow; a switch that is always off is dead code the reuse rule refuses. The column stays | **P84** — remove (as recommended) |
| ATQ2 | Apple's form callback must end in a browser redirect (plan:L7686, `303`), while every `POST` answers `200` with no exemption (CLAUDE.md, the method-status middleware) | one named exemption — route 124 answers `303` with `Location`, listed in a single allowlist the method-status middleware and the success-status gate both read, pinned by a test that it holds exactly this route · `200` with a tiny HTML page whose `<meta http-equiv="refresh">` goes to the app page (no exemption, no script) · ask Apple for `response_mode=query` (only possible without the name and email scopes) | **The one named `303` exemption** — this POST is a top-level browser navigation sent by Apple, not an API call of our client; a `303` is the HTTP answer for POST-then-GET, the HTML page is a workaround that also needs a CSP for one route. The policy line in CLAUDE.md and `response-codes.md` becomes "no exemptions except the Apple form callback (303)". If you would rather keep "no exemptions" literally, the `200` HTML page is the fallback | **P85** — the one named `303` exception (as recommended) |
| ATQ3 | The IP-to-place file (plan:L8804 — its licence and monthly updates) | DB-IP "IP to City Lite" (CC BY 4.0, no account, monthly file; attribution on the sessions screen or the legal page) · MaxMind GeoLite2 City (free account + licence key, its EULA, monthly) · no place | **DB-IP Lite** — no account or key to keep as a secret, a plain attribution licence, the same `.mmdb` format; read with the `maxmind` reader package (be-dependency-security pin); the file comes in with the image build each month (not a runtime download); unset path → place empty, never an error | **P86** — DB-IP "IP to City Lite" (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 10.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `auth.users` (rows change) | a person | `password_hash` emptied by `auth_passwords_off` (AT1) |
| `auth.auth_methods` (rows change) | a person's ways in | `PASSWORD` rows revoked (AT1); the `EMAIL_CODE` row can never be removed (10.B) |
| `auth.trusted_devices` (new) | a browser trusted for 30 days | own rows only; at most 10 live per person; hash of the cookie only (10.C) |
| `auth.sessions` (changed) | a signed-in session | + `place_city`, `place_country` (10.D) |

```text
auth.users ──┬──< auth.auth_methods            EMAIL_CODE (always) · OAUTH (google, apple) · MFA_TOTP · (PASSWORD revoked)
             ├──< auth.webauthn_credentials    passkeys (as built)
             ├──< auth.trusted_devices         "trust this device" (new)
             └──< auth.sessions                + place
```

**PostgreSQL design**

`auth.trusted_devices` is a **user-owned** table like `auth.sessions` (no organization): its policy keys on the user
(`app.current_user_public_id`), `USING` and `WITH CHECK`, enabled and forced — the `sessions_user_access` shape (be-rls guard:
a user-scoped table is the documented form for `auth`, not a tenant table). Each table's design is in its nested sub-domain.

### 10.4 Permissions

No permission codes — every route is PUBLIC or AUTH (as built).

| Gate | Routes |
| --- | --- |
| PUBLIC (+ captcha as built on 120, 121) | 120, 121, 122, 123, 124, 126 |
| AUTH | 125, 127, 128; 123 in link mode (a bearer and a recent step-up) |

### 10.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/auth` |
| Auth | PUBLIC routes take no bearer (123's link mode does); AUTH routes `Authorization: Bearer <access token>` |
| Writes | none of these takes `X-Idempotency-Key` (as built — sign-in and step-up are not replayable; a repeat is a new attempt) |
| Success | `200` with `{ data, meta }`; 125 → `204`; 124 → `303` (ATQ2) |
| Errors | `{ error: { type, code, reason?, detail, errors[], tries_left?, retry_after_seconds? } }` (AT3) — `400`, `401`, `403`, `404`, `409`, `413` (124), `415` (124), `429`, `503` |

### 10.6 Objects returned

| Object | Where |
| --- | --- |
| Code sent | 10.A.6 |
| OAuth providers · OAuth start | 10.B.6 |
| Sign-in result (session or the 2FA screen) | 10.C.6 |
| Session | 10.D.6 |

### 10.7 Routes (120–128, 143–147)

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 120 | POST | `/auth/email/send-code` | Digits-only code; resend timer; a resend too soon is refused **(changed)** | PUBLIC | | RC-73 |
| 121 | POST | `/auth/email/login` | Four reasons and the tries left **(changed)** | PUBLIC | | RC-74 |
| 122 | GET | `/auth/oauth/providers` | Google and Apple **(changed)** | PUBLIC | | RC-71 |
| 123 | GET | `/auth/oauth/{provider}` | Start; + link mode for a signed-in person **(changed)** | PUBLIC (AUTH in link mode) | | RC-72 |
| 124 | POST | `/auth/oauth/apple/callback` | Apple's form post → `303` to the app page **(new)** | PUBLIC (Apple's form) | | RC-70 |
| 125 | DELETE | `/auth/me/auth-methods/{auth_method_id}` | The email-code way can never be removed **(changed)** | AUTH | | RC-77 |
| 126 | POST | `/auth/mfa/login` | "Trust this device"; tries left; lock **(changed)** | PUBLIC | | RC-75 |
| 127 | POST | `/auth/step-up` | An email code is a strong step-up without 2FA **(changed)** | AUTH | | RC-76 |
| 128 | GET | `/auth/me/sessions` | Each session's place **(changed)** | AUTH | | RC-78 |
| 143 | GET | `/auth/oauth/{provider}/callback` | Takes `apple`; the link mode links that account to the signed-in person **(changed)** | PUBLIC (the OAuth state) | | RC-102 |
| 144 | DELETE | `/auth/me/sessions` | Sign out everywhere else — also ends every trusted device but this browser's **(changed)** | AUTH | | RC-103 |
| 145 | DELETE | `/auth/me/mfa/{mfa_method_id}` | Removing the last 2FA factor ends the trusted devices **(changed)** | AUTH | | RC-104 |
| 146 | DELETE | `/auth/me/sessions/{session_id}` | Its strong step-up takes the email code without 2FA **(changed)** | AUTH | | RC-105 |
| 147 | DELETE | `/auth/me/webauthn/credentials/{credential_id}` | Its strong step-up takes the email code without 2FA **(changed)** | AUTH | | RC-106 |
| — | ~~POST~~ | ~~`/auth/login`~~ | **REMOVED (RC-98)** — the email code, Google, Apple replace it | — | — | RC-98 |
| — | ~~POST~~ | ~~`/auth/password/forgot`~~ | **REMOVED (RC-99)** — nothing replaces it | — | — | RC-99 |
| — | ~~POST~~ | ~~`/auth/password/reset`~~ | **REMOVED (RC-100)** — nothing replaces it | — | — | RC-100 |
| — | ~~POST~~ | ~~`/auth/password/change`~~ | **REMOVED (RC-101)** — step-up by email code (127) | — | — | RC-101 |

Routes 143–147 (rev 5, P99) are the five changed routes this review once listed without numbers: the OAuth callback takes `apple`
and the link mode (10.B); signing out everywhere else and removing the last 2FA factor end trusted devices (10.D, 10.C); the strong
step-up of removing one session or one passkey accepts the email code (10.D, 10.C).

### 10.8 Request details

In each nested sub-domain (10.A to 10.D, section .8).

### 10.9 Errors

Every route can answer the errors in 10.5; each route's own errors are in its nested sub-domain (10.A to 10.D, section .9).

### 10.10 Rules worth knowing

- **Four ways in, the email code always on** (plan:L7617–L7620): the mailbox is the key; 2FA is the extra lock.
- **A trusted device never skips a step-up, never for a `super_admin`, never in an organization that requires 2FA** (D56): the session it
  opens has `mfa_verified_at` empty, so `POST /auth/switch-to-organization` into a 2FA organization still answers `403 mfa_required`
  (as built).
- **No IP leaves us**: the place is looked up in a local file (ATQ3).

### 10.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| ATC1 | AT1, ATQ1: the four routes, handlers, DTOs, service methods and the password step-up removed; migration `auth_passwords_off`; `routes:catalog` (−4), `route-success-statuses.json`, OpenAPI, Postman, k6 journeys that used `/auth/login` moved to the email code; the per-IP failed-login throttle and its docs; `src/domains/auth/auth.overview.md`, `src/FLOWS.md` sign-in flow |
| ATC2 | AT2, AT3: the reasons at their throw sites; `AppError.withFields` (`src/shared/errors/`) and its serialization in `error-handler.middleware.ts`; the envelope doc; i18n keys; a unit test pinning the two field names |
| ATC3 | AT5: `github-oauth.provider.ts`, its env vars (be-env-schema-add: schema, `.env.example`, `harness-provider-env.ts`, credentials fill) and contract fixtures removed; `SUPPORTED_OAUTH_PROVIDERS` |
| ATC4 | AT4: the audit actions; tests and seeds — the demo users sign in by email code (`auth-method/seed/`), no seeded passwords |

### 10.12 Nested sub-domains

| Nested sub-domain | Folder (`src/domains/auth/sub-domains/…`) | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 10.A Email code and passwords off | `auth-method/` (email login, verification code) | `auth.users`, `auth.auth_methods`, `auth.verification_tokens` (rows) | 120, 121; RC-98–RC-101 removed | final (rev 3, confirmed 2026-11-24) |
| 10.B Google, Apple and the sign-in ways | `auth-method/oauth/` | `auth.auth_methods` | 122–125, 143 | final (rev 3, confirmed 2026-11-24) |
| 10.C Two-factor, trusted devices and step-up | `auth-mfa/`, `auth-trusted-device/` **(new)** | `auth.trusted_devices` | 126, 127, 145, 147 | final (rev 3, confirmed 2026-11-24) |
| 10.D Sessions | `auth-session/` | `auth.sessions` | 128, 144, 146 | final (rev 3, confirmed 2026-11-24) |

---

### 10.A Email code and passwords off — `auth/sub-domains/auth-method/` — final (rev 3, confirmed 2026-11-24)

#### 10.A.1 Decisions

| # | Decision |
| --- | --- |
| AT6 | **Digits only (plan:L7634).** Today: `VERIFICATION_CODE_CHARSET` is the Crockford set (letters and digits), normalised to upper case; the step-up DTO accepts `[A-Za-z0-9]{6}`. After: `VERIFICATION_CODE_CHARSET = '0123456789'`, length 6, 15 minutes, 5 wrong tries per code, 60 s between sends (all as built); every DTO that takes the code is `^\d{6}$` (send-code login, step-up). A code issued before the deploy (letters) keeps working until it expires (the hash compares normalised input). |
| AT7 | **Send-code answers (route 120, plan:L7646–L7650).** Today: the same answer whether or not a code went (the cooldown is silent), with `expires_in_minutes`. After: `200` with `resend_after_seconds` (60) and `expires_in_seconds` (900) — the same answer for every email (no hint whether it is known); under 60 s since the last code for that email → `429 code_resend_too_soon` + `retry_after_seconds` (the per-email cooldown key is claimed before any user lookup, as built, so the `429` tells nothing about the email); `expires_in_minutes` goes. The TEST_MODE echo stays (as built). |
| AT8 | **Login answers (route 121, plan:L7651–L7660).** `401 code_wrong` + `tries_left` (wrong code, unknown email, used code — every case except the next); `401 code_expired` only when this email's newest code really is over 15 minutes old; `401 code_used_up` after 5 wrong tries on this code; `429 code_day_limit` + `retry_after_seconds` after 20 wrong tries for this email in 24 hours (`EMAIL_CODE_WRONG_TRIES_PER_DAY` 20 — a new Redis counter keyed by the email's hash, 24 h expiry, cleared on success and by our team). Today: one `401 errors:invalidOrExpiredVerificationCode`. A new code still ends the old one (as built). |
| AT9 | **The email is confirmed by a code sign-in** (plan:L8212, as built) — the confirm link of sub-domain 11 is the rare path. |

#### 10.A.2 Open questions

ATQ1 (remove the password code) — 10.2; answered P84: removed.

#### 10.A.3 Tables and relations

No column change. `auth.verification_tokens` keeps its rows (`EMAIL_CODE`); the per-day counter lives in Redis only (it limits, it
does not record — losing it only resets a limit). `auth.users.password_hash` and `PASSWORD` rows: AT1's migration.

#### 10.A.4 Permissions

| Gate | Routes |
| --- | --- |
| PUBLIC (captcha, per-email rate limit — as built) | 120, 121 |

#### 10.A.5 Common to every route

As 10.5.

#### 10.A.6 Objects returned

**Code sent** (route 120): `message`, `resend_after_seconds`, `expires_in_seconds` (+ the TEST_MODE `debug_verification_code`, as
built). Route 121 answers the sign-in result (10.C.6).

#### 10.A.7 Routes (120–121; four removed)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 120 | POST | `/auth/email/send-code` | Send a 6-digit code **(changed)** | PUBLIC | |
| 121 | POST | `/auth/email/login` | Sign in with it **(changed)** | PUBLIC | |
| — | ~~POST~~ | ~~`/auth/login`~~, ~~`/auth/password/forgot`~~, ~~`/auth/password/reset`~~, ~~`/auth/password/change`~~ | **REMOVED (RC-98–RC-101)** | — | — |

#### 10.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 120 | — | `email*` (as built) | Code sent |
| 121 | — | `email*`, `code*` (`^\d{6}$`) | sign-in result (10.C.6) |

#### 10.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 120 | `429` · `code_resend_too_soon` (+ `retry_after_seconds`) | under 60 s since this email's last code |
| 120 | `400` · `disposable_email` | as built |
| 121 | `400` · `code` | not 6 digits |
| 121 | `401` · `code_wrong` (+ `tries_left`) | wrong, unknown email, used |
| 121 | `401` · `code_expired` | this email's newest code is over 15 minutes old |
| 121 | `401` · `code_used_up` | 5 wrong tries on this code |
| 121 | `429` · `code_day_limit` (+ `retry_after_seconds`) | 20 wrong tries today |
| 121 | `403` · `login_method_turned_off` / `401` · `account_not_active` | as built, now with reasons |

#### 10.A.10 Rules worth knowing

- The day limit can be spent by a stranger (plan:L7664): Google, Apple and passkeys still work, and the signed-in step-up has its own
  count (10.C).

#### 10.A.11 Code changes

| # | Change |
| --- | --- |
| ATC5 | AT6–AT8: `verification-code.ts` charset; DTOs to `^\d{6}$`; `email-login.service.ts` — the four reasons, `tries_left`, the day counter (`EMAIL_CODE_WRONG_TRIES_PER_DAY` beside the other code constants), the `429` on cooldown, `resend_after_seconds` / `expires_in_seconds`; unit tests for each reason and that an unknown email answers `code_wrong` exactly like a wrong code |

**As built (R30, [P205](decisions.md)):** the per-code try counter is keyed by the email's hash (an unknown email
counts like a known one); tries 1–4 answer `code_wrong` with `tries_left` 4…1, the 5th and later `code_used_up`;
`code_expired` is not counted as a wrong try; `resend_after_seconds` is 0 where the resend spacing is off (local
only). The password step-up went with the routes (ATQ1), so the strong step-up without 2FA waits for 10.C (R32,
AT15); route 125's `409 email_code_always_on` (AT13) was built with this row (AC-13.4).

---

### 10.B Google, Apple and the sign-in ways — `auth/sub-domains/auth-method/oauth/` — final (rev 3, confirmed 2026-11-24)

#### 10.B.1 Decisions

| # | Decision |
| --- | --- |
| AT10 | **Apple (plan:L7662–L7693).** A provider `apple` beside `google` (`apple-oauth.provider.ts`), using the same state + PKCE + browser-nonce machinery (`oauth-state.ts`, as built; PKCE kept if Apple accepts it — plan §53.3 item 1 — else the state and the `nonce` inside Apple's `id_token` carry it). The start (route 123) asks `response_mode=form_post` with the `name email` scopes. Apple posts its form to **route 124**, which never signs anyone in: body at most 16 KiB (`OAUTH_FORM_CALLBACK_BODY_LIMIT_BYTES` 16384), `application/x-www-form-urlencoded` only; it checks the `state` exists (not used up — the second call uses it once), keeps Apple's `user` JSON (her name, sent only the first time) next to the state for the state's life (`OAUTH_STATE_TTL_SECONDS` 600, as built), and answers `303` to `<FRONTEND_URL>/callback/apple?code&state` (ATQ2) — or, on Apple's error (`user_cancelled_authorize` …), `303` to the app's failed page with `reason` (`oauth_cancelled`, `oauth_failed`, `oauth_expired`). The app then calls the existing `GET /auth/oauth/apple/callback?code&state` with the `oauth_nonce` cookie: the state used once, the nonce checked, the code swapped with a fresh **ES256 client secret** (a short JWT signed with our Apple key per swap), `id_token` read (`sub`, `email`, `nonce`). The person is matched by Apple's `sub` (later sign-ins may carry no email); a relay address is accepted (the sending domain registered with Apple, plan §53.3 item 2). Find-or-create and the verified-email link guard as Google's (as built). |
| AT11 | **Apple settings (be-env-schema-add).** `OAUTH_APPLE_CLIENT_ID`, `OAUTH_APPLE_TEAM_ID`, `OAUTH_APPLE_KEY_ID`, `OAUTH_APPLE_PRIVATE_KEY` (a Secret), `OAUTH_APPLE_REDIRECT_URI` (route 124's public URL) — optional everywhere, like Google's: unset → Apple is absent from route 122 and route 123 answers `404` for it (as an unknown provider). |
| AT12 | **Link mode (route 123, plan:L7776).** `GET /auth/oauth/{provider}?intent=link` with a bearer and a **recent step-up** (`requireRecentStepUpPreHandler`, as built): the state also binds the user and session public ids; the callback then links that Google or Apple account to this person even with another email, and clears a "turned off" mark on it (A-5, as built); already someone else's → `409 provider_account_in_use`; the callback answers the linked way instead of a new session. Without `intent` the route stays PUBLIC sign-in (as built). |
| AT13 | **The email-code way is always on (route 125, plan:L7777).** Deleting the `EMAIL_CODE` row → `409 email_code_always_on`; removing the last other way is fine. The strong step-up of route 125 accepts an email code for a person without 2FA (AT15). |
| AT14 | **Providers (route 122, RC-71).** Answers the configured ones of `google`, `apple` (GitHub gone, AT5). |

#### 10.B.2 Open questions

ATQ2 (the `303`) — 10.2; answered P85: the one named exception.

#### 10.B.3 Tables and relations

No column change — `provider` is free text (plan:L7614); `OAUTH` rows with `provider = 'apple'`, `provider_user_id` = Apple's
`sub`. Apple's `user` name waits in Redis next to the state (10 minutes, one use — short-lived login state, as the existing state;
nothing is lost if it goes).

#### 10.B.4 Permissions

| Gate | Routes |
| --- | --- |
| PUBLIC | 122, 123 (sign in), 124, 143 (the OAuth state) |
| AUTH + recent step-up | 123 with `intent=link` |
| AUTH + strong step-up (as built) | 125 |

#### 10.B.5 Common to every route

As 10.5. Route 124: no captcha (Apple posts it), the strict public rate limit (as built), a cross-site POST carries no cookie of
ours — the nonce cookie is checked in the second call (plan:L7690).

#### 10.B.6 Objects returned

**OAuth providers** (route 122): `[{ provider, name }]` (as built). **OAuth start** (route 123): `redirect_url` (+ the nonce
cookie, as built). Route 124: no body — `303` with `Location`.

#### 10.B.7 Routes (122–125, 143)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 122 | GET | `/auth/oauth/providers` | Google and Apple **(changed)** | PUBLIC | |
| 123 | GET | `/auth/oauth/{provider}` | Start; link mode **(changed)** | PUBLIC / AUTH in link mode | |
| 124 | POST | `/auth/oauth/apple/callback` | Apple's form → `303` **(new)** | PUBLIC (Apple's form) | |
| 125 | DELETE | `/auth/me/auth-methods/{auth_method_id}` | Remove a way in; never the email code **(changed)** | AUTH | |
| 143 | GET | `/auth/oauth/{provider}/callback` | Google or Apple comes back; link mode **(changed)** | PUBLIC (the OAuth state) | |

#### 10.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 122 | — | — | OAuth providers |
| 123 | `intent` (`link`, optional) | — | OAuth start |
| 124 | — | form: `state*`, `code` or `error`, `user` (JSON text, optional, ≤ 4 KiB), `id_token` (ignored here) | `303` |
| 125 | — | — | 204 |
| 143 | `code`, `state` (as built) or `error` | — | sign-in result; in link mode the linked way |

#### 10.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 123 | `400` · `provider` / `intent` | not `google` or `apple`; an unknown intent |
| 123 | `401` / `403` · `recent_step_up_required` | link mode without a bearer, or without a recent step-up |
| 124 | `400` · `state` | missing; (unknown or spent states are a `303` to the failed page with `oauth_expired`, so the browser lands somewhere) |
| 124 | `413` / `415` | over 16 KiB; not a form |
| 143 | `409` · `provider_account_in_use` | link mode: that Google or Apple account is someone else's |
| 143 | `401` · `oauth_expired` / `oauth_failed`; `403` · `oauth_link_needs_verified_email`, `login_method_turned_off`; `401` · `account_not_active` | AT2 (as built causes, now with reasons) |
| 125 | `409` · `email_code_always_on` | the `EMAIL_CODE` row |

#### 10.B.10 Rules worth knowing

- Google's errors come back to the app page directly (the app shows "Sign-in failed" without calling us); Apple's come through
  route 124's `303` (plan:L7708).

#### 10.B.11 Code changes

| # | Change |
| --- | --- |
| ATC6 | AT10, AT11, ATQ2: `apple-oauth.provider.ts` (ES256 client secret with `node:crypto`, `id_token` check against Apple's keys — cached ≤ 60 s per be-read-cache-guard's TTL rule), the form route with its body limit and form parser, the `303` allowlist entry (method-status middleware + `validate:route-success-coverage` + `route-success-statuses.json` + CLAUDE.md and `response-codes.md` lines), the five env vars, contract fixtures (`src/tests/contract/apple*`), tests: name kept from the first post, a second post without `user`, a spent state, a cross-site post without the cookie still lands |
| ATC7 | AT12–AT14: `intent=link` in the start DTO, the state payload, the callback's link branch; `provider_account_in_use`, `email_code_always_on`; tests |

**As built (R31, [P206](decisions.md)):** Apple gets no PKCE — its `nonce` is the SHA-256 of the browser nonce and the
`id_token`'s `nonce` must equal it (AT10's fallback); the client secret and the `id_token` check use `jose`. Route 124's
failed page is `<FRONTEND_URL>/callback/apple?reason=oauth_cancelled|oauth_failed|oauth_expired`. Route 122 answers the
as-built `{ providers: ["google", "apple"] }` (configured ones only). Route 123: another provider name is a `400`, an
unset provider a `404` (Google's too). Route 143 takes no `error` query (§ 10.B.10) and matches the person by the
provider account before the email. The `303` exception is `METHOD_STATUS_POLICY_EXCEPTIONS`.

---

### 10.C Two-factor, trusted devices and step-up — `auth/sub-domains/auth-mfa/`, `auth/sub-domains/auth-trusted-device/` (new) — final (rev 3, confirmed 2026-11-24)

#### 10.C.1 Decisions

| # | Decision |
| --- | --- |
| AT15 | **Step-up without a password (route 127, plan:L7752–L7771).** Today: `STRONG_STEP_UP_FACTORS = ['password', 'mfa']`; an email-code step-up (`code`) is bootstrap-only (`email_code`, weak) and refused for an account with a password or MFA. After: the password branch goes (AT1); the body takes `code` (6 digits — the field name kept, the plan's `email_code` meaning); the `email_code` window counts as **strong when the person has no settled 2FA factor** (`requireStrongRecentStepUpPreHandler` reads it so; a person with settled 2FA still needs an MFA step-up, `POST /auth/me/mfa/verify`, as built). The provisional rule stays (`PROVISIONAL_FACTOR_PERIOD_SECONDS` 72 h): while the only factor is provisional, an email code still opens a strong step-up (plan:L7769). The email-code step-up has its own try count (as built, A-8). Turning off 2FA needs a 2FA code only (as built). |
| AT16 | **Wrong 2FA codes (route 126, plan:L7716–L7720).** Today: 10 wrong codes in 15 minutes (`MAX_MFA_VERIFICATION_ATTEMPTS` 10, `MFA_VERIFICATION_LOCKOUT_TTL_SECONDS` 900), then the same `401` as a wrong code. After: each wrong code `401 mfa_code_wrong` + `tries_left`; over the limit `429 mfa_locked` + `retry_after_seconds` (the counter's remaining time). The stronger message from the 3rd is the app's (plan:L7720). |
| AT17 | **"Trust this device for 30 days" (plan:L7722–L7750, D56).** Route 126 takes `trust_device` (boolean, default false). On a right code with it: a new `auth.trusted_devices` row (the SHA-256 of 32 random bytes, the user agent, `expires_at` = now + 30 days, `TRUSTED_DEVICE_DAYS` 30 — use never extends it) and the cookie `trusted_device` (HttpOnly, Secure, SameSite Lax, path `/api/v1/auth`, 30 days); an 11th live row revokes the oldest (`TRUSTED_DEVICES_MAX` 10). At sign-in, `completeFirstFactorAuth` reads the cookie: a live row of the same person, not expired, **and** the organization that opens does not require 2FA (`tenancy.organization_requires_mfa`, as built) **and** the person is not `super_admin` → the session opens without the code (`last_used_at` set; `mfa_verified_at` stays empty); otherwise the 2FA screen (as built). Trusted devices end early: 2FA turned off or its factor removed (`DELETE /auth/me/mfa/{mfa_method_id}`), "sign out everywhere else" (`DELETE /auth/me/sessions` — all but this browser's), the account deleted or suspended. Constants in the auth domain (P4 — not environment-varying). |

#### 10.C.2 Open questions

None.

#### 10.C.3 Tables and relations

`auth.trusted_devices` (new — user-owned, no organization, no soft delete: `revoked_at` ends a row)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `id`, `public_id`, `created_at` | standard | no | | public id prefix at kickoff (P22) |
| `user_id` | `bigint` | no | | → users `ON DELETE CASCADE` |
| `token_hash` | `varchar(64)` | no | | SHA-256 hex of the cookie; unique |
| `user_agent` | `varchar(512)` | yes | | as the session's |
| `expires_at` | `timestamptz` | no | | `expires_at > created_at` |
| `last_used_at` | `timestamptz` | yes | | |
| `revoked_at` | `timestamptz` | yes | | |

Indexes: unique `public_id`; unique `token_hash`; `(user_id, created_at) WHERE revoked_at IS NULL` — the live count and "revoke the
oldest"; as built also `(user_id)` (the FK cascade) and `(expires_at)` (the clean-up) ([P207](decisions.md)). RLS: the user policy
(`app.current_user_public_id`), `USING` and `WITH CHECK`, enabled and forced, plus the session clean-up's maintenance arm in `USING`
only ([P207](decisions.md)); it is read after the first factor proves the person, in the same database context the session insert
uses (as built for `auth.sessions`). Clean-up: the session clean-up deletes rows expired or revoked over 30 days ago (a batch delete —
**WC-64**, CHANGED) — built at R50 through `TrustedDeviceRepository.deleteEndedBefore`, which R32 left ([P207](decisions.md)).

#### 10.C.4 Permissions

| Gate | Routes |
| --- | --- |
| PUBLIC (the MFA session token, captcha as built) | 126 |
| AUTH | 127 |
| AUTH (as built; its strong step-up takes the email code without 2FA) | 145, 147 |

#### 10.C.5 Common to every route

As 10.5.

#### 10.C.6 Objects returned

**Sign-in result** (routes 121, 126, the OAuth callback, the passkey verify — as built): the access token and session cookie, or
`{ mfa_required: true, mfa_session_token }`; route 126 also sets the `trusted_device` cookie when ticked. Route 127: `{ stepped_up:
true, factor }` (`factor` added: `email_code` · `mfa`).

#### 10.C.7 Routes (126–127, 145, 147)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 126 | POST | `/auth/mfa/login` | The 2FA code; trust this device **(changed)** | PUBLIC | |
| 127 | POST | `/auth/step-up` | Step-up by email code **(changed)** | AUTH | |
| 145 | DELETE | `/auth/me/mfa/{mfa_method_id}` | The last factor removed ends the trusted devices **(changed)** | AUTH | |
| 147 | DELETE | `/auth/me/webauthn/credentials/{credential_id}` | Remove a passkey; email-code step-up without 2FA **(changed)** | AUTH | |

#### 10.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 126 | — | `mfa_session_token*`, `totp_code` or `recovery_code` (as built); optional: `trust_device` (boolean) | sign-in result |
| 127 | — | `code*` (`^\d{6}$`, the email code) — the `password` branch removed | `{ stepped_up, factor }` |
| 145, 147 | — | — | 204 |

#### 10.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 126 | `401` · `mfa_code_wrong` (+ `tries_left`) | a wrong code |
| 126 | `429` · `mfa_locked` (+ `retry_after_seconds`) | over 10 wrong in 15 minutes |
| 126 | `401` · `mfa_session_invalid` | the MFA session token expired or unknown (as built cause, now a reason) |
| 127 | `400` · `code` | not 6 digits (a `password` field → `400` unknown key) |
| 127 | `401` · `code_wrong` (+ `tries_left`) / `code_expired` / `code_used_up` | as 10.A |
| 127 | `403` · `mfa_step_up_required` | the person has settled 2FA — step up with the 2FA code instead |

#### 10.C.10 Rules worth knowing

- **Why the email-code strong step-up is safe** (plan:L7770): the mailbox can already sign the person in; it gives no new power.

#### 10.C.11 Code changes

| # | Change |
| --- | --- |
| ATC8 | AT15: `StepUpVerifyDto` (code only), `recent-step-up.util.ts` (strong when no settled factor), the handler; tests — no 2FA: email code removes a passkey; settled 2FA: `403 mfa_step_up_required`; provisional only: email code is strong |
| ATC9 | AT16: the `mfa_code_wrong` / `mfa_locked` reasons with the counter's remaining tries and time in `auth-mfa.service.ts` |
| ATC10 | AT17: new auth migration `auth_trusted_devices` (table, indexes, user policy, FORCE; `EXPECTED_FORCE_RLS_TABLES` +1); `auth-trusted-device/auth-trusted-device.{schema,repository,service,constants}.ts`; the cookie in `auth.http.util.ts`; the skip in `complete-first-factor-auth.ts`; the early ends in the MFA removal, sign-out-everywhere-else, account delete and suspend paths; the session clean-up worker's extra delete; tests — trusted + no 2FA organization skips, trusted + 2FA organization asks, `super_admin` asks, the 11th revokes the oldest, a stolen cookie of another person does nothing, an expired row does nothing |

**As built (R32, [P207](decisions.md)).** AT15: route 127 refuses a person with settled 2FA (`403 mfa_step_up_required`), so every
`email_code` window is strong (`STRONG_STEP_UP_FACTORS` = `mfa`, `email_code`; `provisional_mfa` stays weak). AT16: the reasons are
route 126's (the authenticated MFA step-up keeps its generic 401); a wrong recovery code is `mfa_code_wrong` without `tries_left`.
AT17: the skip is refused when **any** organization of the person requires 2FA (the existing gate) and for any `GLOBAL_ADMIN_EMAILS`
address; the cookie's `SameSite` is `lax` (`none` when `COOKIE_SAMESITE=none`) and it is cleared when 2FA is turned off; the
session clean-up worker's extra delete is R50's. Prefix `tdv_`.

---

### 10.D Sessions — `auth/sub-domains/auth-session/` — final (rev 3, confirmed 2026-11-24)

#### 10.D.1 Decisions

| # | Decision |
| --- | --- |
| AT18 | **The session's place (route 128, plan:L8194–L8199).** When a session is made, and when its IP changes on refresh, the city and country of the IP are looked up in a local IP-to-place file (ATQ3) — never an outside service; the lookup is in-process (a memory-mapped `.mmdb`), so it adds no network call to sign-in. New columns `place_city`, `place_country` (empty when not found or no file). The answer adds `place` (`{ city, country_code }` or null); the app shows "Chrome on Mac · Mumbai, India" with the country's name from its code (`Intl.DisplayNames`). File path: env `SESSION_PLACE_DATABASE_PATH` (optional — the file's location differs per deployment; unset → no place, never an error; be-env-schema-add). Other option: store the country's English name — then every locale shows English. |
| AT19 | **Signing out** (plan:L8199): one session, or everywhere else — as built, with the strong step-up of AT15; "everywhere else" also ends the trusted devices except this browser's (AT17). |

#### 10.D.2 Open questions

ATQ3 (the file and its licence) — 10.2; answered P86: DB-IP Lite.

#### 10.D.3 Tables and relations

`auth.sessions` (changed — migration `auth_sessions_place`)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `place_city` | `varchar(100)` | yes | | the file's English city name, trimmed |
| `place_country` | `varchar(2)` | yes | | ISO 3166-1 alpha-2, upper case (`CHECK (place_country ~ '^[A-Z]{2}$')`) |

No new index (never filtered). RLS unchanged (the user policy, as built).

#### 10.D.4 Permissions

| Gate | Routes |
| --- | --- |
| AUTH | 128, 144, 146 |

#### 10.D.5 Common to every route

As 10.5.

#### 10.D.6 Objects returned

**Session** (as built: `id`, `ip_address`, `user_agent`, `device`, `browser`, `last_active_at`, `created_at`, `expires_at`,
`is_current`) + `place` (`{ city, country_code }` or null).

#### 10.D.7 Routes (128, 144, 146)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 128 | GET | `/auth/me/sessions` | Sessions with their place **(changed)** | AUTH | |
| 144 | DELETE | `/auth/me/sessions` | Sign out everywhere else, trusted devices too **(changed)** | AUTH | |
| 146 | DELETE | `/auth/me/sessions/{session_id}` | End one session; email-code step-up without 2FA **(changed)** | AUTH | |

#### 10.D.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 128 | as built | — | Session[] |
| 144, 146 | — | — | 204 |

#### 10.D.9 Errors

As built.

#### 10.D.10 Rules worth knowing

None beyond 10.10.

#### 10.D.11 Code changes

| # | Change |
| --- | --- |
| ATC11 | AT18: migration `auth_sessions_place`; `session-place.ts` (the reader, opened once at boot, a no-op without the path); the lookup at session create and IP change on refresh; `place` in `auth-session.serializer.ts`; the `maxmind` reader package (pinned, be-dependency-security); the file fetched in the image build (`Dockerfile`, a monthly refresh noted in `docs/`); the licence attribution (ATQ3); tests with a small fixture `.mmdb` |

---

## 11. User and notify — profile, settings, notifications — rev 5 (2026-11-24) — nested sub-domains 11.A–11.D; final (rev 5, confirmed 2026-11-24)

**Status: final (rev 5, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 5 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **user domain** (`src/domains/user/` — the person at the root, `sub-domains/user-settings/`,
`sub-domains/user-notification-preferences/`) and the **notify domain** (`src/domains/notify/sub-domains/notification/`, its
dispatch and workers). Both in `main`: new migrations only (D48; the user columns live in schema `auth`, plan:L8455–L8456). No
new folder.

11.1 Decisions (whole sub-domain) · 11.2 Open questions · 11.3 Tables and relations · 11.4 Permissions · 11.5 Common to every route ·
11.6 Objects returned · 11.7 Routes · 11.8 Request details · 11.9 Errors · 11.10 Rules worth knowing · 11.11 Code changes (whole sub-domain) ·
11.12 Nested sub-domains · then **11.A The person and the organization chooser · 11.B Confirm your email · 11.C Notification kinds and
the check before send · 11.D Weekly summary and grouped notes** — each with the same eleven sections.

Onboarding's two fields, reduce motion, the organization chooser, the confirm-email link, and notifications: seven kinds the person
switches per channel, eight new types, defaults with security and billing email always on (D54), the dispatch that finally reads
the choice, the weekly summary and the grouped "new contact details" note. Design read: plan §45.2, §45.4 (plan:L7802–L7859),
§47 (plan:L8115–L8236), §50.5 B2/B4 (plan:L8440, L8442); `db-changes.md` › user, user_setting; `route-changes.md` RC-79–RC-85, RC-107, RC-108;
`worker-changes.md` WC-56, WC-57, WC-58, WC-63. Builds on: auth (verification tokens, mail), tenancy (memberships, roles' codes), the
app (counts through ports). Route numbers run 130–136, plus 148–149 (rev 5, P99).

### 11.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). "Today" is the code in `main`.

**rev 2 changes** (P44, P47, M9): names follow the app's renamed tables (`app.channel_accounts`, `app.instagram_automations`, `app.instagram_automation_counts`, `app.message_month_counts`); the chooser's `channel_accounts_count`; job payloads `channelAccountPublicId`. No route changes shape.

**rev 3 changes** (P48, M10): names only — the app tables the chooser's counts, the weekly summary and the contact notes read are the shared `app.automations`, `app.contacts`, … again (P44 undone). No route, port or column changes.

**rev 5 changes** (P99, M13): `GET /users/me` and `GET /users/me/settings` are routes 148–149 (RC-107, RC-108) in 11.A, the two reads this review once listed without numbers; the grouped note cites WC-63 (UN13, 11.D). No decision changes.

| # | Decision |
| --- | --- |
| UN1 | **The app's numbers come through ports, never app tables (reuse of the launch's erase-step pattern).** The chooser's counts (11.A), the weekly summary's numbers and the grouped note's count (11.D) are app data. Notify and tenancy are built before the app and the app imports them, so a direct service import would be a cycle: the app implements three small ports wired in `src/routes.ts` and the worker bootstrap — `listOrganizationCountsForUser`, `readWeeklySummary`, `countContactsWithDetailsLeft`. Postgres stays the only truth (the ports read it). |
| UN2 | **Who gets a notification is decided by codes, not role names (plan:L8139–L8147, TN-rule).** Owner, Admin, Editor = active members holding `automation:update`; Owner, Admin = holders of `subscription:manage` (billing) or `membership:update` (team changes, plus the member it is about); "every member" = every active member; "who started it" = the run's or broadcast's author + the billing holders. One resolver in notify (`resolveNotificationRecipients({ organization, rule })`) over tenancy's membership service. |

### 11.2 Open questions

| # | Question | Options | Recommendation | Answer |
| --- | --- | --- | --- | --- |
| UNQ1 | The preferences API shape: the screen saves kind × channel (plan:L8150) | the routes speak kinds (`{ kind, channel, is_enabled }`), the server writes one row per type of the kind · keep type × channel and let the app expand kinds | **Kinds** — one place knows which types make a kind (`NOTIFICATION_KINDS`), so the app cannot drift; the per-type rows stay the stored form (no new table, plan:L8150) | **P87** — per kind (as recommended) |
| UNQ2 | When in-app is off but email on, the email still needs a dedupe key (plan:L8180 uses the notification's public id) | callers pass a `dedupe_key`; the outbox key is `<type>:<dedupe_key>:<user>` and the in-app row is written only when in-app is on · always write the row, hidden when in-app is off | **The caller's `dedupe_key`** — every new type already has a "once" rule (once per stop, per month and line, per week, per broadcast) that names its key; no hidden rows | **P88** — the caller's `dedupe_key` (as recommended) |

Answered on 2026-11-24 — the **Answer** column names each decision ([decisions.md](decisions.md)); the decisions of this sub-domain carry the answers.

### 11.3 Tables and relations

| Table | Holds | Key rules |
| --- | --- | --- |
| `auth.users` (changed — user domain) | a person | + `instagram_handle`, `goal` (11.A) |
| `auth.user_settings` (changed) | her settings | + `is_reduce_motion_enabled` (11.A) |
| `auth.verification_tokens` (rows) | one-time tokens | + type `EMAIL_CONFIRM` (11.B) |
| `auth.user_notification_preferences` (rows) | type × channel choices | new types' rows; missing row = the kind's default (11.C) |
| `notify.notifications` (rows) | in-app notifications | the eight new types |

```text
auth.users ──┬──1 auth.user_settings                     + is_reduce_motion_enabled
             ├──< auth.verification_tokens               EMAIL_CODE · EMAIL_CONFIRM (new type)
             ├──< user_notification_preferences          one row per type × channel the person changed
             └──< notify.notifications                   in-app rows (written only when in-app is on — UNQ2)
```

**PostgreSQL design**

No new table. The changed tables keep their standard columns and policies (the user-owned policy for `auth.*`, as built); the
new columns' checks are in 11.A.3. The chooser's counts function is the app's (11.A.3).

### 11.4 Permissions

No permission codes — every route is AUTH or PUBLIC (as built).

| Gate | Routes |
| --- | --- |
| AUTH | 130–133, 135, 136 |
| PUBLIC (the emailed token) | 134 |

### 11.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/users` (130–133, 135, 136); `/api/v1/auth` (134 — registered in `auth.routes.ts`, its service is 11.B's) |
| Auth | `Authorization: Bearer <access token>`; 134 none |
| Writes | none takes `X-Idempotency-Key` (as built for `/users/me/*`); 133's repeat is limited by its 60 s wait; 134's token is one-use and a repeat answers the same |
| Success | `200` with `{ data, meta }` |
| Errors | `{ error: { type, code, reason?, detail, errors[], retry_after_seconds? } }` (AT3) — `400`, `401`, `404`, `409`, `422`, `429` |

### 11.6 Objects returned

| Object | Where |
| --- | --- |
| Me · Settings · Organization summary (the chooser) | 11.A.6 |
| Email confirmation sent · Email confirmed | 11.B.6 |
| Notification preferences | 11.C.6 |

### 11.7 Routes (130–136, 148–149)

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 130 | PATCH | `/users/me` | + Instagram handle and goal (onboarding) **(changed)** | AUTH | | RC-81 |
| 131 | PATCH | `/users/me/settings` | + reduce motion; a personal organization is refused as the default **(changed)** | AUTH | | RC-82 |
| 132 | GET | `/users/me/organizations` | The chooser: role and counts, `q`, personal hidden **(changed)** | AUTH | | RC-83 |
| 133 | POST | `/users/me/email-confirmation` | Email the confirm link; resend after 60 s **(new)** | AUTH | | RC-80 |
| 134 | POST | `/auth/email/confirm` | Confirm the email with the link's token **(new)** | PUBLIC (token) | | RC-79 |
| 135 | GET | `/users/me/notification-preferences` | The seven kinds × channels, with the new types **(changed)** | AUTH | | RC-84 |
| 136 | PUT | `/users/me/notification-preferences` | Save kinds × channels; security and billing email stay on **(changed)** | AUTH | | RC-85 |
| 148 | GET | `/users/me` | + `instagram_handle`, `goal` **(changed)** | AUTH | | RC-107 |
| 149 | GET | `/users/me/settings` | + `is_reduce_motion_enabled` **(changed)** | AUTH | | RC-108 |

Routes 148–149 (rev 5, P99) are the two reads this review once listed without numbers; they show what routes 130–131 save.

### 11.8 Request details

In each nested sub-domain (11.A to 11.D, section .8).

### 11.9 Errors

Every route can answer the errors in 11.5; each route's own errors are in its nested sub-domain (11.A to 11.C, section .9).

### 11.10 Rules worth knowing

- **Always sent, never in the grid** (plan:L8156): `security.alert`, sign-in codes, invitation emails, the confirm-email link.
- **Push is saved, never sent** (plan:L8155): `WEB_PUSH` choices are stored now; nothing sends them (plan §49).
- The organization's own mute (`organization_notification_policies`, `muted_until` in the future) wins over a person's choice (plan:L8182; built R36, P301).

### 11.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| UNC1 | UN1: the three ports (each declared by its consumer, as the launch's erase-step port — the chooser's `OrganizationCountsPort` in tenancy's `organization.service.ts` — and wired in the composition roots `domain-containers.plugin.ts` and `worker-containers.ts`; the app's implementations are sub-domain 1B–6's services — the chooser's is `ChannelAccountService.listOrganizationCountsForUser`, R34, [P407](decisions.md)); `src/domains/user/user.overview.md`, `src/domains/notify/notify.overview.md`, `src/FLOWS.md` (notification flow) |
| UNC2 | UN2: `resolveNotificationRecipients({ scope, rule, subjectUserId })` in `notification-dispatch.service.ts` over the membership service (`findActiveUserIdsWithPermission`, `findActiveUserIds`; `subjectUserId` = the member a team change is about, or who started it — R34, [P407](decisions.md)); tests per rule |

### 11.12 Nested sub-domains

| Nested sub-domain | Folder | Tables | Routes | Status |
| --- | --- | --- | --- | --- |
| 11.A The person and the organization chooser | `user/` (root), `user/sub-domains/user-settings/` | `auth.users`, `auth.user_settings` | 130–132, 148–149 | final (rev 5, confirmed 2026-11-24) |
| 11.B Confirm your email | `user/` (root) + `auth/sub-domains/auth-method/verification-token/` | `auth.verification_tokens` (rows) | 133, 134 | final (rev 5, confirmed 2026-11-24) |
| 11.C Notification kinds and the check before send | `user/sub-domains/user-notification-preferences/`, `notify/sub-domains/notification/` | `user_notification_preferences`, `notify.notifications` (rows) | 135, 136 | final (rev 5, confirmed 2026-11-24) |
| 11.D Weekly summary and grouped notes | `notify/sub-domains/notification/workers/` | — | — (WC-58, WC-63 — two notify jobs) | final (rev 5, confirmed 2026-11-24) |

---

### 11.A The person and the organization chooser — `user/`, `user/sub-domains/user-settings/` — final (rev 5, confirmed 2026-11-24)

#### 11.A.1 Decisions

| # | Decision |
| --- | --- |
| UN3 | **Onboarding fields (route 130, plan:L7802–L7826).** Today: `first_name`, `last_name`, `job_title`, `avatar_key`. After: + `instagram_handle` (input may carry a leading `@` and capitals; saved without `@`, lower case; letters, digits, `.` and `_`, 1–30 — Instagram's rule; `null` clears) and `goal` (`capture_leads` · `drive_sales` · `grow_community`, or `null`). Both may stay empty ("Skip for now", plan:L7824); the handle is a profile note and connects nothing (plan:L7826). `GET /users/me` answers both. |
| UN4 | **Reduce motion and the default organization (route 131, plan:L7857, L8204).** + `is_reduce_motion_enabled` (boolean, default false — the plan's `reduce_motion` in the P21 form, next to `is_dark_mode_enabled`). `default_organization_id` naming a personal organization → `422 team_organization_required` (today it is allowed; the existing `422 default_organization_unavailable` stays for one the caller does not belong to). |
| UN5 | **The organization chooser (route 132, RC-83, plan:L7849–L7859).** Today: `organizationService.listForUser` — every organization the caller owns or actively belongs to, the personal one included, cursor paging. After: the personal organization is hidden (Flowdm never shows or opens it, plan:L7857); `q` searches by name (1–100, case-insensitive); each row adds `role` (the main role's `{ id, name }`), `members_count`, `channel_accounts_count`, `live_automations_count`. The counts come from **one** `SECURITY DEFINER` function owned by the app, `app.list_organization_counts_for_user(user_public_id text, organization_public_ids text[])`, which answers only organizations where that user has an active membership (so it reads across organizations without opening RLS — the same form as `tenancy.user_has_active_membership_for_organization`), called once per page through the counts port (UN1). The migration is the app's (plan:L8460: "a migration file next to the app ones") — a new app migration `app_member_organization_counts` (the plan's `app_member_workspace_counts`, full names), not a change to the seven launch files. Paging stays cursor-based (as built). |

#### 11.A.2 Open questions

None.

#### 11.A.3 Tables and relations

`auth.users` (changed — migration `auth_users_onboarding_fields`, user domain)

| Column | Type | Null | Default | Rule |
| --- | --- | --- | --- | --- |
| `instagram_handle` | `varchar(30)` | yes | | `CHECK (instagram_handle ~ '^[a-z0-9._]{1,30}$')` |
| `goal` | `varchar(20)` | yes | | `CHECK (goal IN ('capture_leads', 'drive_sales', 'grow_community'))` |

`auth.user_settings` (changed — migration `user_settings_reduce_motion`): `is_reduce_motion_enabled boolean NOT NULL DEFAULT false`.

The app function (app migration `app_member_organization_counts`): `SECURITY DEFINER`, `SET search_path` pinned, `STABLE`, owned by
the migration role, `EXECUTE` granted to `meepzo_be_app` and `meepzo_be_maintenance` only (the role-taxonomy policy, [P407](decisions.md)); for each given organization with an active membership of the user:
`members_count` (active members), `channel_accounts_count` (not revoked), `live_automations_count` (`status = 'live'`, not
deleted). It reads `tenancy.memberships`, `app.channel_accounts`, `app.automations` through their existing organization indexes.
No index change. RLS unchanged. The main role is read through tenancy's SECURITY DEFINER
`tenancy.resolve_main_roles_for_user(user_public_id, organization_ids)` (migration `tenancy_resolve_main_roles_for_user`):
`tenancy.roles` is organization-only under RLS in the chooser's user scope (R34, [P407](decisions.md)).

#### 11.A.4 Permissions

| Gate | Routes |
| --- | --- |
| AUTH | 130–132, 148–149 |

#### 11.A.5 Common to every route

As 11.5.

#### 11.A.6 Objects returned

**Me** (as built) + `instagram_handle`, `goal`. **Settings** (as built) + `is_reduce_motion_enabled`. **Organization summary**
(route 132): the organization as built (`id`, `name`, `slug`, `type`, `status`, `owner_user_id`, `logo_color` (9.A), `logo_url`,
`timezone`, `currency`, timestamps — kept, additive, [P407](decisions.md)) + `role` (`{ id, name }`), `members_count`,
`channel_accounts_count`, `live_automations_count`.

#### 11.A.7 Routes (130–132, 148–149)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 130 | PATCH | `/users/me` | Handle and goal **(changed)** | AUTH | |
| 131 | PATCH | `/users/me/settings` | Reduce motion; no personal default **(changed)** | AUTH | |
| 132 | GET | `/users/me/organizations` | The chooser **(changed)** | AUTH | |
| 148 | GET | `/users/me` | + handle and goal **(changed)** | AUTH | |
| 149 | GET | `/users/me/settings` | + reduce motion **(changed)** | AUTH | |

#### 11.A.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 130 | — | as built + optional `instagram_handle` (string or null), `goal` (value or null) | Me |
| 131 | — | as built + optional `is_reduce_motion_enabled` | Settings |
| 132 | `q` (1–100), `limit`, `after` | — | Organization summary[] |
| 148 | — | — | Me |
| 149 | — | — | Settings |

#### 11.A.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 130 | `400` · `instagram_handle` / `goal` | not Instagram's handle form, over 30; not one of the three |
| 131 | `422` · `team_organization_required` | `default_organization_id` is the caller's personal organization |
| 131 | `422` · `default_organization_unavailable` | as built |
| 132 | `400` · `q` | over 100 characters |

#### 11.A.10 Rules worth knowing

- The app shows the chooser when the person has 2 or more organizations; one with no team organization gets onboarding (plan:L7853,
  L7857) — both the app's reading of route 132.

#### 11.A.11 Code changes

| # | Change |
| --- | --- |
| UNC3 | UN3, UN4: migrations `auth_users_onboarding_fields`, `user_settings_reduce_motion`; schemas, DTOs (`UpdateMeDto`, `UpdateUserSettingsDto`), serializers, the personal-default refusal in the settings service; seeds (demo users with a handle and goal); tests |
| UNC4 | UN5: the app migration with the function and its grant; the counts port's app implementation; `listForUser` hides PERSONAL, takes `q`, joins the main role, merges the counts; `listOrganizationsQueryDto` → a chooser query DTO with `q`; tests — personal hidden, counts per organization, another user's organization never counted, `q` |

---

### 11.B Confirm your email — `user/` + `auth/…/verification-token/` — final (rev 5, confirmed 2026-11-24)

#### 11.B.1 Decisions

| # | Decision |
| --- | --- |
| UN6 | **Ask for the link (route 133, RC-80, plan:L8209).** Signed in, email not yet confirmed: a 32-byte random token (base64url), its SHA-256 stored in `auth.verification_tokens` with `token_type` `EMAIL_CONFIRM`, `expires_at` = now + 24 hours (`EMAIL_CONFIRM_LINK_HOURS` 24); a new one ends the old (one live per person, as the email code); the email goes through the mail outbox with the link `<FRONTEND_URL>/confirm-email?token=<token>` (always sent — not in the grid). Again within 60 s → `429 email_confirmation_resend_too_soon` + `retry_after_seconds` (the email code's 60 s, `VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS`, reused; built R35: read from the person's newest link's `created_at` in Postgres, not the code's Redis key — [P302](decisions.md)); already confirmed → `409 email_already_confirmed`. |
| UN7 | **Confirm (route 134, RC-79, plan:L8211).** PUBLIC, body `{ token }`: the existing one-use consume (`verificationTokenRepository.consumeIfValid(hash, 'EMAIL_CONFIRM')` — the reset flow's consume, kept when the password routes go) → `is_email_verified = true` and the token spent, in one transaction; audit `user.email.confirm`. Unknown, spent or expired token → `400 email_confirm_token_invalid`. The person's email already confirmed (a second click after a code sign-in confirmed it) → the same success (nothing to change); built R35: a spent token is the `400`, and so is a token sent to an address the person no longer has ([P302](decisions.md)). No session is made. |

#### 11.B.2 Open questions

None.

#### 11.B.3 Tables and relations

No column change. `auth.verification_tokens.token_type` takes `EMAIL_CONFIRM` (a `varchar(30)` without a check today — the
allowed list moves to a constant `VERIFICATION_TOKEN_TYPE` shared by both flows). The existing index `(user_id, token_type)` and
the unique token hash serve both routes. RLS unchanged (the table's role-gated policy, as built).

#### 11.B.4 Permissions

| Gate | Routes |
| --- | --- |
| AUTH | 133 |
| PUBLIC (token) | 134 |

#### 11.B.5 Common to every route

As 11.5; 134 has the strict public rate limit (as built for the former reset route).

#### 11.B.6 Objects returned

**Email confirmation sent** (133): `resend_after_seconds`, `expires_at`. **Email confirmed** (134): `is_email_verified: true`.

#### 11.B.7 Routes (133–134)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 133 | POST | `/users/me/email-confirmation` | Email the confirm link **(new)** | AUTH | |
| 134 | POST | `/auth/email/confirm` | Confirm it **(new)** | PUBLIC (token) | |

#### 11.B.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 133 | — | — (strict empty; an absent body is accepted, any field `400` — R35, [P302](decisions.md)) | Email confirmation sent |
| 134 | — | `token*` (1–512) | Email confirmed |

#### 11.B.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 133 | `409` · `email_already_confirmed` | nothing to confirm |
| 133 | `429` · `email_confirmation_resend_too_soon` (+ `retry_after_seconds`) | within 60 s of the last link |
| 134 | `400` · `email_confirm_token_invalid` | unknown, spent or expired |

#### 11.B.10 Rules worth knowing

- An unconfirmed email cannot accept an invitation (as built, plan:L8212); the "confirm your email" notice reads `user.is_email_verified`
  from `GET /auth/me/context` (as built).

#### 11.B.11 Code changes

| # | Change |
| --- | --- |
| UNC5 | UN6, UN7: `VERIFICATION_TOKEN_TYPE` (`EMAIL_CODE`, `EMAIL_CONFIRM`; `PASSWORD_RESET` gone with AT1); the request route in `user.routes.ts` and the confirm route in `auth.routes.ts` (one service — built R35 as `EmailConfirmationService` in `auth/sub-domains/auth-method/`, injected into the user routes, [P302](decisions.md)); the email template and its i18n copy; `EMAIL_CONFIRM_LINK_HOURS`; tests — the link confirms, a second click succeeds, an expired token `400`, a resend within 60 s `429` |

---

### 11.C Notification kinds and the check before send — `user/sub-domains/user-notification-preferences/`, `notify/sub-domains/notification/` — final (rev 5, confirmed 2026-11-24)

#### 11.C.1 Decisions

| # | Decision |
| --- | --- |
| UN8 | **Nine new types (plan:L8139–L8147, §50.6; P80).** `NOTIFICATION_TYPES` (11 today) + `automation.stopped`, `contact.details_left`, `membership.role_changed`, `membership.removed`, `report.weekly_summary`, `broadcast.done`, `automation.backfill_done`, `billing.trial_ending`, `billing.plan_choice_required` (P80, BL24) = 20. The DM 80 % and 100 % notes are the existing `billing.usage_threshold` (`data.percent` 80 \| 100, once a month per line — WC-56); "an automation hits an error" is the existing `instagram.reconnect_required` beside `automation.stopped`. Types stay code constants (no database check — plan:L8465). Who emits: `automation.stopped` (sub-domain 6's automatic stop, once per stop), `broadcast.done` (7), `automation.backfill_done` (4), `contact.details_left` (11.D), `billing.trial_ending` and `billing.plan_choice_required` (billing WC-59), `report.weekly_summary` (11.D), `membership.role_changed` and `membership.removed` (notify's handlers of tenancy's `membership.updated` — when the main role changes — and `membership.deleted`; the event payload gains the previous main role). |
| UN9 | **Seven kinds (plan:L8137–L8147, D54).** One constant `NOTIFICATION_KINDS` maps kind → types, recipients rule (UN2) and default per channel: `automation_problem` (`automation.stopped`, `instagram.reconnect_required`; Owner/Admin/Editor; email on, in-app on), `direct_message_limit` (`billing.usage_threshold`; Owner/Admin/Editor; on, on), `contact_details_left` (`contact.details_left`; Owner/Admin/Editor; **email off**, on), `team_change` (`membership.invite_accepted`, `.invite_declined`, `.role_changed`, `.removed`; Owner/Admin + the member; on, on), `billing` (`billing.payment_failed`, `.payment_succeeded`, `subscription.updated`, `billing.trial_ending`, `billing.plan_choice_required`; Owner/Admin; **email always on**, in-app on), `weekly_summary` (`report.weekly_summary`; every member; on, **in-app off**), `broadcast_or_past_comments_done` (`broadcast.done`, `automation.backfill_done`; who started it + Owner/Admin; **email off**, on). Push (`WEB_PUSH`) defaults off ("soon"). Security email is not in the grid and always sent (11.10). |
| UN10 | **The routes speak kinds (UNQ1, RC-84, RC-85).** `GET` answers the seven kinds, each with its channels' effective value (a missing row = the default) and `is_locked` (billing email); `PUT` takes `kinds: [{ kind, channel, is_enabled }]` (up to 21 = 7 × 3) and writes one row per type of the kind in one transaction ("changes save as they are made" — the app may send one item). `channel` is `EMAIL` · `IN_APP` · `WEB_PUSH` (the existing `NOTIFICATION_CHANNELS`; `SMS` is not offered). Billing email off → `422 notification_preference_locked`. Other option: keep type × channel (the app expands kinds). |
| UN11 | **Check the choice before each send (plan:L8163–L8182).** Today: `createAndDispatchNotification` writes the row and enqueues in-app + email for every recipient without reading any choice. After: the dispatch takes the kind's recipients (UN2), reads **all** their choices for the type in one query, then per person: in-app on → the notification row (as today); email on → the mail-outbox row with the dedupe key `notification:<type>:<dedupe_key>:<user_public_id>` (UNQ2 — `dedupe_key` becomes a required input of the create, each emitter passes its once key); push on → nothing yet. The organization's mute (`muted_until` in the future) wins, billing email included (built R36 — it was not built before, P301). Locked billing email is sent whatever a stored row says. `createAndDispatchNotification` takes every recipient of the notification at once, the emitter's `channels` (an upper bound) and `locale`; an email without an inbox row goes to the mail outbox in the caller's unit (P301). |

#### 11.C.2 Open questions

UNQ1, UNQ2 — 11.2; answered P87 (per kind), P88 (the caller's `dedupe_key`).

#### 11.C.3 Tables and relations

`auth.user_notification_preferences` — no column change; the new types' rows; the unique `(user_id, notification_type, channel)`
(as built) is the upsert key. `notify.notifications` — no column change; rows of the new types. RLS unchanged. The dedupe key
is the mail outbox's existing `dedupe_key` (`auth.mail_outbox`, unique where set — no new column).

#### 11.C.4 Permissions

| Gate | Routes |
| --- | --- |
| AUTH | 135, 136 |

#### 11.C.5 Common to every route

As 11.5.

#### 11.C.6 Objects returned

**Notification preferences**: `kinds` — `[{ kind, types: [type…], channels: [{ channel, is_enabled, is_default, is_locked }] }]`,
in the screen's order (UN9).

#### 11.C.7 Routes (135–136)

| # | Method | Path | Purpose | Gate | Idem |
| --- | --- | --- | --- | --- | --- |
| 135 | GET | `/users/me/notification-preferences` | The seven kinds **(changed)** | AUTH | |
| 136 | PUT | `/users/me/notification-preferences` | Save kinds × channels **(changed)** | AUTH | |

#### 11.C.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 135 | — | — | Notification preferences |
| 136 | — | `kinds*` (1–21 of `{ kind*, channel*, is_enabled* }`, no repeat of a kind × channel) | Notification preferences |

#### 11.C.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 136 | `400` · `kinds` | empty, over 21, a repeat, an unknown kind or channel (`SMS`) |
| 136 | `422` · `notification_preference_locked` | billing email set off |

#### 11.C.10 Rules worth knowing

- `automation.stopped` goes once per automatic stop, never once per failed message (plan:L8158); the 80 % and 100 % emails once a
  month each (D34, plan:L8159) — the emitters' dedupe keys.

#### 11.C.11 Code changes

| # | Change |
| --- | --- |
| UNC6 | UN8, UN9: `NOTIFICATION_TYPES` + 9, `NOTIFICATION_KINDS` in `src/shared/constants/notification.constants.ts`; the organization-policy DTO reads the same list (as built); the email and in-app copy per new type (`src/shared/locales/en/common.json` › `notifications` first — P301); notify's handlers for tenancy's internal `MEMBERSHIP_NOTICE_EVENT.ROLE_CHANGED` (main-role change, with the previous main role) and `.REMOVED` — kept apart from the webhook resource events `membership.updated` / `.deleted` (P301) |
| UNC7 | UN10: the DTO (`kinds`), the service's expand-to-types upsert in one transaction, the kinds serializer with defaults; `notification_preference_locked`; tests — the defaults with no rows, billing email locked, one kind writes every type's row |
| UNC8 | UN11: `createAndDispatchNotification` takes `dedupe_key` and the kind's recipients rule; one choices query per notification; in-app only when on; outbox key; every existing emitter (invitation accepted / declined, the reconnect notice, billing) passes its key; tests — in-app off + email on sends one email and writes no row, the mute wins, a replay sends nothing twice |

---

### 11.D Weekly summary and grouped notes — `notify/sub-domains/notification/workers/` — final (rev 5, confirmed 2026-11-24)

#### 11.D.1 Decisions

| # | Decision |
| --- | --- |
| UN12 | **The weekly summary (WC-58, plan:L8184–L8192).** An hourly sweep under a maintenance scope (`MAINTENANCE_SCOPE.NOTIFY_WEEKLY_SUMMARY`, new, frozen) lists the team organizations where it is now Monday 09:00–09:59 in their time zone (`tenancy.organizations.timezone`; `WEEKLY_SUMMARY_WEEKDAY` 1, `WEEKLY_SUMMARY_HOUR` 9 — notify constants) and enqueues one job per organization (job id `weekly-summary:<organization>:<iso year-week>`, payload `organizationPublicId`, `weekStart`). The job, inside its organization: the app's `readWeeklySummary` port (UN1) — per Instagram account for the last 7 days: runs started, DMs sent, % tapped, new contacts, emails and phones collected, the top automation, plus the month count (`app.automation_counts`, `app.message_month_counts`, the runs — one read); nothing happened → no email; else one email per member with the kind's email on (default on), through the mail outbox, dedupe `weekly:<organization>:<year-week>:<user>` — a restart never sends twice. In-app default off (D54). Pull-based (scheduler → queue → worker), safe to repeat and to skip an hour. |
| UN13 | **Grouped "new contact details" (plan:L8157, plan:L8162 example).** At most one note per Instagram account per hour (`CONTACT_DETAILS_NOTICE_EVERY_MINUTES` 60). After the commit that saves a contact's email or phone, the app calls notify's `noteContactDetailsLeft({ organizationPublicId, channelAccountPublicId, at })`, which adds a delayed job (job id `contact-details:<account>` — BullMQ keeps one pending job per id, so the 2nd and 3rd detail in the hour add nothing) due 60 minutes after the first; the job counts, through the app's `countContactsWithDetailsLeft` port, the account's contacts whose details were saved since the window's start, and writes one `contact.details_left` notification ("3 new contacts left details on @account_a") to the kind's recipients — in-app by default, email off. Zero (all erased meanwhile) → nothing. Postgres holds the truth (the contacts' times); the job holds only the window start. Worker-changes row: **WC-63**. |

#### 11.D.2 Open questions

None.

#### 11.D.3 Tables and relations

None of its own — it reads the app's tables only through the ports and writes `notify.notifications` and the mail outbox.

#### 11.D.4 Permissions

None (background work).

#### 11.D.5 Common to every route

No routes.

#### 11.D.6 Objects returned

None (emails and in-app rows: the copy keys in UNC6).

#### 11.D.7 Routes

None.

#### 11.D.8 Request details

None.

#### 11.D.9 Errors

None (job failures retry with the notify queue's backoff and land in the DLQ, as built).

#### 11.D.10 Rules worth knowing

- Estimate (plan:L8192): 1,000 organizations over their time zones = a few hundred reads an hour.

#### 11.D.11 Code changes

| # | Change |
| --- | --- |
| UNC9 | UN12: `notify/sub-domains/notification/workers/notification-weekly-summary.{worker,processor,constants}.ts`, queue and job schema (`organizationPublicId`, `weekStart`), the sweep under the new maintenance scope (`database-context.ts`), registry, scheduler (hourly), DLQ; the email template; tests — an organization at Monday 09:30 local gets one job, at 10:00 none, a quiet week sends nothing, twice = once |
| UNC10 | UN13: the delayed job `notification-contact-details` (queue, job schema with `organizationPublicId`, `channelAccountPublicId`, `windowStartedAt`), `noteContactDetailsLeft`; tests — three details in an hour → one note of 3, a detail after the note starts a new window |

---

## 12. Upload — message files — rev 4 (2026-11-24) — no nested sub-domains; final (rev 4, confirmed 2026-11-24)

**Status: final (rev 4, confirmed 2026-11-24)** (one-pass review, [P31](decisions.md)). Confirmed with your answers ([P54–P90](decisions.md), M12). Rev 4 confirmed 2026-11-24 with the scale and alignment fixes ([P91–P100](decisions.md), M13).

Code: the **upload domain** (`src/domains/upload/`, one folder, no sub-domains — as built), changed in place: its constants, DTO,
validator, content-type and magic-byte checks, and one new read for the sending engine. No migration (the purpose list is a code
constant, plan:L8445; no `scan_status`, P34).

12.1 Decisions (whole sub-domain) · 12.2 Open questions · 12.3 Tables and relations · 12.4 Permissions · 12.5 Common to every route ·
12.6 Objects returned · 12.7 Routes · 12.8 Request details · 12.9 Errors · 12.10 Rules worth knowing · 12.11 Code changes (whole sub-domain) ·
12.12 Nested sub-domains (none).

The files a message carries — a picture, a voice note, a PDF — are uploaded by the owner's team through the existing presigned
flow under a new purpose, checked by type and content on confirm, and read by the sending engine's attachment step (sub-domain 6,
`app.instagram_attachments` by the upload's public id — P25). **No malware scan this iteration** (P34): a D58 deviation, recorded in
`AS-BUILT.md`'s Standing deviations. Design read: plan §50.5 B6 (plan:L8443–L8446), §5.9 / D58 (plan:L984, L269), `db-changes.md` ›
upload (EXISTING), instagram_attachment; `route-changes.md` RC-61, RC-111 (RC-62, RC-63 out of scope — P34). Builds on: organizations, the
`upload:manage` code (Owner, Admin, Editor — sub-domain 9). Route numbers 140 and 150 (rev 5, P99).

### 12.1 Decisions (whole sub-domain)

Taken on your standing answer "go with the recommendation", then confirmed with your answers of 2026-11-24 (P54–P90). "Today" is the code in `main`.

**rev 2 changes** (P43, M9): the message-file reference is `app.instagram_attachments` (was `meta_attachments`). No route changes shape.

**rev 4 changes** (P99, M13): `POST /uploads/{upload_id}/confirm` is route 150 (RC-111) — a changed route (the audio checks, UP4), no longer called unchanged. No decision changes.

| # | Decision |
| --- | --- |
| UP1 | **A new purpose `message-media` (plan:L8443).** Today: four purposes (`avatar`, `organization-logo`, `user-file`, `organization-file`), kebab-case values in `UPLOAD_PURPOSES`; `organization-file` takes png, jpeg, webp, pdf up to 10 MB, no audio. After: `MESSAGE_MEDIA: 'message-media'` (the existing value style; the plan's `MESSAGE_MEDIA` is the constant's key), target **organization** (`UPLOAD_PURPOSE_REQUIRED_TARGET`), key prefix `message-media`, no thumbnails; bound to the organization (the organization id on the row, as every organization upload). Other option: widen `organization-file` — but its size, types and SVG rule differ, and the sending engine must know a file was meant for a message. |
| UP2 | **Types and sizes per type (plan:L8445).** Today: one `maxSize` per purpose. After: `UploadPurposeConfig` gains an optional `maxSizeByContentType` (the validator and the presigned `content-length-range` read it before `maxSize`): `image/png`, `image/jpeg` ≤ 8 MB (`MESSAGE_IMAGE_MAX_BYTES`); `audio/aac`, `audio/mp4` (`.m4a`, `.mp4`), `audio/x-m4a` (`.m4a` — what Safari and macOS send), `audio/wav` ≤ 25 MB (`MESSAGE_AUDIO_MAX_BYTES`); `application/pdf` ≤ 25 MB (`MESSAGE_FILE_MAX_BYTES`) — the plan's `_MB` names in full-name byte form (P6). No webp (Instagram's attachment types, plan:L8445) and **no SVG** even when `UPLOAD_ALLOW_SVG` is on (`getAllowedContentTypesForPurpose` skips this purpose — SVG has no magic bytes and Instagram does not take it). |
| UP3 | **The upload ceiling 10 → 25 MB (plan:L8445).** `UPLOAD_DTO_FILE_SIZE_MAX_BYTES` = 25 MB (the highest per-type cap, as its comment requires); every other purpose keeps its own smaller cap (as built). |
| UP4 | **Type and magic-byte checks only — no scan (P34, a D58 deviation).** Today: confirm checks the object's length and content type, and the first 32 bytes against `MAGIC_SIGNATURES` — **only for the types that have a signature** (png, jpeg, webp, pdf); an unknown type would pass unchecked. After: `file-magic.util.ts` gains the audio signatures — AAC ADTS (`FF F1`, `FF F9`, `FF F0`, `FF F8`) and ADIF (`ADIF`), MP4 / M4A (`ftyp` at offset 4), WAV (`RIFF` at 0 and `WAVE` at 8, the webp form) — and the `message-media` purpose **requires** every one of its types to be verifiable (a unit test pins it), so a message file is used only after confirm's type and content checks pass. No `scan_status` column, no scanner, no scan step (P34); D58's "scanned clean" reads "confirmed (type and magic bytes)" for this iteration. Other option: build the scan now — P34 moved it to a later iteration. |
| UP5 | **One read for the sending engine (P25).** `UploadService.findUsableMessageFile({ scope, uploadPublicId })` → `{ upload_public_id, content_type, file_size, download_url }` when the upload is this organization's, purpose `message-media` (its key under `message-media/<organization public id>/`, [P201](decisions.md)), status `UPLOADED` and not deleted — else `null`. `download_url` is a presigned GET (`PRESIGNED_URL_EXPIRY_SECONDS`, as built) for the attachment-upload task to hand to Meta (sub-domain 6). Called by the automation's go-live check (a message names a file — P2 #15) and by the attachment task; the app keeps only the public id (no cross-domain foreign key, P25). |

### 12.2 Open questions

None — P34 settled the scan; the purpose name is a value in the code's existing style (UP1).

### 12.3 Tables and relations

`upload.uploads` — **not changed** (EXISTING, P34): the table has no `purpose` column — the purpose is the object key's prefix
(`message-media/<organization public id>/…`, as every purpose is built; the list is the code constant) — [P201](decisions.md), as built R12; no `scan_status`. Indexes and RLS unchanged (organization policy for organization uploads, as
built).

```text
tenancy.organizations ──< upload.uploads (purpose = 'message-media')
                                 ·····> app.instagram_attachments.upload_public_id    the public id only, no key (P25)
```

### 12.4 Permissions

No new codes.

| Code | Roles matrix | Allows | Routes | Held by default |
| --- | --- | --- | --- | --- |
| `upload:manage` | Automations · Create, edit … upload files for messages | an organization upload (checked in the handler, with the MFA rule — as built) | 140, 150 (confirm — and read, delete as built) | Owner, Admin, Editor (TN1) |

### 12.5 Common to every route

| Item | Value |
| --- | --- |
| Base | `/api/v1/uploads` |
| Auth | `Authorization: Bearer <access token>`; an organization upload must target the active organization (as built) |
| Writes | `X-Idempotency-Key` required (as built) |
| Success | `200` with `{ data, meta }` |
| Errors | `{ error: { type, code, reason?, detail, errors[] } }` — `400`, `401`, `403`, `404`, `409`, `413`, `422` (as built) |

### 12.6 Objects returned

**Upload create** (as built): `id` (`upl_…`), `upload_url`, `upload_method`, `fields` / `headers`, `expires_at`, `file_key`.

### 12.7 Routes (140, 150)

| # | Method | Path | Purpose | Gate | Idem | RC |
| --- | --- | --- | --- | --- | --- | --- |
| 140 | POST | `/uploads` | + the `message-media` purpose; the ceiling 25 MB **(changed)** | AUTH (`upload:manage` for an organization upload) | req | RC-61 |
| 150 | POST | `/uploads/{upload_id}/confirm` | + the audio magic-byte checks; every `message-media` type must be checkable; no scan **(changed)** | AUTH | | RC-111 |

Route 150 (RC-111, numbered in rev 5 — P99) keeps its request and answer; it now also refuses an audio file whose first bytes do
not match (UP4). Unchanged (RC-62, RC-63 out of scope, P34): `GET /uploads/{upload_id}` as built (no scan result).

### 12.8 Request details

| # | Query | Body | Response |
| --- | --- | --- | --- |
| 140 | — | `purpose*` (+ `message-media`), `for*` (`organization` for it), `organization_id` (as built), `content_type*`, `file_name*` (its extension must fit the type, as built), `file_size*` (1 – 25 MB, then the type's cap) | Upload create |
| 150 | — | — (as built) | Upload (as built) |

### 12.9 Errors

| Route | Status · reason | When |
| --- | --- | --- |
| 140 | `400` · `content_type` | not one of the purpose's types (webp, SVG, ogg … for `message-media`) |
| 140 | `400` · `file_size` | over 25 MB (the route schema answers, field `body.file_size` — [P201](decisions.md)), or over the type's cap (8 MB for an image) |
| 140 | `400` · `for` | `user` with `message-media` |
| 140 | `403` · `missing_permission` | no `upload:manage` in the organization (a Viewer) |
| 150 | `400` · `uploadVerificationFailed` | the bytes do not start like the declared type (as built, now for audio too) |

### 12.10 Rules worth knowing

- **Deleting a message file is allowed** (`DELETE /uploads/{upload_id}`, as built): nothing points at it by key (P25); the go-live
  check and the attachment task find it gone through UP5 and refuse or fail the message (sub-domains 4, 6).
- The pending-upload sweep and the tombstone retention cover the new purpose with no change (they read every purpose).

### 12.11 Code changes (whole sub-domain)

| # | Change |
| --- | --- |
| UPC1 | UP1–UP3: `UPLOAD_PURPOSES.MESSAGE_MEDIA`, its config (types, `maxSizeByContentType`, prefix), its required target, the DTO's purpose enum, `UPLOAD_DTO_FILE_SIZE_MAX_BYTES` 25 MB, the three byte constants; `upload-content-type.util.ts` (extensions for the audio types; no SVG for this purpose); the validator and the presigned range read the per-type cap; `src/domains/upload/upload.overview.md`, the OpenAPI copy of route 140 |
| UPC2 | UP4: the audio signatures in `file-magic.util.ts`; the "every `message-media` type is verifiable" unit test; property tests for the new signatures; the D58 deviation in `AS-BUILT.md` (kickoff) |
| UPC3 | UP5: `findUsableMessageFile` on `UploadService` (exported through the upload container for the app); tests — another organization's, another purpose, pending, deleted → `null` |
| UPC4 | Tests: integration for route 140 (each type at its cap and one byte over, webp refused, a Viewer `403`, an Editor `200`), confirm with a fake `.m4a` refused; `pnpm routes:catalog` (no change in count), `docs:generate` |

### 12.12 Nested sub-domains

None — the upload domain is one folder.

---

## Before you hand a sub-domain over for its OK

Run on the whole file (rev 5, 2026-11-24, after M13 — the scale and alignment fixes, the review still final; rev 4 after your
answers M12, rev 3 after M10 and M11, rev 2 after M9), by script where it can be:

- Every table row has its header's number of columns — **checked by script: 0 rows off** across every table of the file
  (re-run at rev 4 after the **Answer** columns were added to the header's question table and every section 2; rev 4 also
  removed the blank line that split 1B.2's table between CAQ1 and CAQ2); every sub-domain (1, 1B, 2–12) has sections 1–12 and
  every nested sub-domain 1–11 — **checked by script**.
- No decision, code-change or question id is used twice, and every id the text cites exists — **checked by script** for the
  prefixes MC, CA, IA, CT, AU, WH, SN, BC, BL, TN, AT, UN, UP (decisions, `…C` code changes, `…Q` questions), K and M: no repeat
  (each question sits once in the header table and once in its section 2, by design; MGQ2 only in the header), none dangling —
  re-run at rev 4 with M12's new ids (BC19, BCC11, BL24, BLC13, TN12, TNC8, M12) and at rev 5 with M13's (K16, SN24, SNC17, AU36,
  AU37, AUC14, AUC15, M13). Launch ids are cited "launch …"; rev 1 ids
  that moved (IA1–IA5, IA9–IA11, IA16, IA18–IA20, IAC1, IAC2, IAC4, IAC7, IAQ1, IAQ2) are cited only as "was …" / "rev 1 …" and
  mapped in M9.
- Every open question is answered — **checked by script**: 33 questions, each with its decision row in the header table's and
  its section 2's **Answer** column (P54–P89; P79 the one default), no "Until you answer" left; the three answers that differ
  from the recommendation (MCQ3 → P56, BCQ2 → P76, BLQ4 → P80) are written into their decisions (M12).
- Every sub-domain and nested sub-domain reads `final (rev N, confirmed 2026-11-24)` in its heading, its status line, the
  sub-domains table and its parent's section 12 — **checked by script**, again at rev 5 (1, 1B, 3–7, 11 at 5; 2, 8, 12 at 4; 9, 10 at 3): no `awaiting your OK` left; the **Route review final**
  line sits under the title (P90).
- The route numbers never repeat; gaps fall only between sub-domains and bands (43–59, 65–68 — M6 — 83–99, 109, 119, 129,
  137–139); rev 2 renumbered nothing and added 40–42 (M9); rev 3 and rev 4 renumbered and added nothing (M10, M12); rev 5
  renumbered nothing and added 141–150 for RC-102–RC-111 (P99, M13); each sub-domain's count in its section 7 matches the
  sub-domains table (11, 6, 3, 9, 13, 3, 2, 13, 9, 11, 14, 9, 2 for 1, 1B, 2–12) and the domain total (105: 49 new, 55
  changed — moves included, route 60 moved by P53, 141–150 the ten platform routes — and 1 as built) — **checked by script**,
  again at rev 5 (105 numbers, none repeated; every nested section 7 row matches its parent's). Every RC row is served by
  exactly one sub-domain (RC-15, RC-17, RC-18 and RC-112–RC-114 by 1; RC-7–RC-11 and RC-60 by 1B; RC-37, RC-38 by 4 and RC-39,
  RC-40 by 3 only; RC-109, RC-110 by 9; RC-102–RC-106 by 10; RC-107, RC-108 by 11; RC-111 by 12).
- Every route has a gate and an Idem cell; every `POST` without `req` names its reason (K3, MGQ2 → P89): 1, 9, 10, 16, 17, 32,
  33, 35, 40, 61 in the app; 107, 118, 120, 121, 124, 126, 127, 133, 134, 150 as built in the platform domains (141 is `req`, as
  built). Since P59 routes
  1–11, 15 and 40–42 are gated by `channel-account:*` and routes 12–14 keep `instagram-account:*`; since P76 routes 78, 80 and
  82 also refuse a plan without the `segments` switch (`403 plan_lacks_feature`).
- Every table states its RLS, its branch rule (none — this product has no branches) and every pointer's `ON DELETE`;
  no membership pointer is added (K5, K6); every product and sending pointer to an account is `channel_account_id` →
  `app.channel_accounts` (P47); since rev 3 the shared product tables (3, 4, 7) carry no `instagram_` prefix and point at
  no Instagram table — they reach a channel only through the two seams (K15, M10). No identifier, column, route or code
  contains `workspace` (P72; the prose says organization, "workspace" only where a screen is quoted).
- `plans/route-changes.md`, `plans/db-changes.md` and `plans/worker-changes.md` say the same as the sub-domains — rev 1
  **done** (synced 2026-11-23 from M8); rev 2's channel split is synced by the change-files pass of the same day (RC-112–RC-114
  cited here); rev 3's M10 (P48–P51) by the change-files pass of 2026-11-24; rev 4's M12 (P54–P90) by the change-files pass
  of 2026-11-24 run beside this one — `app.sending_helper_slots` dropped (P73), the business resolver and its index (P56),
  `feature_switches` and the off rows' Free features (P83, P80), the code migration (P59), the plan refusal on RC-42, RC-44
  and RC-46 (P76), WC-59's old-plan finding and the `billing.plan_choice_required` email (P80); rev 5's M13 (P91–P100) by the change-files pass of
  2026-11-24 run beside this one (db-changes, route-changes, worker-changes and coverage follow this file's names and the
  decisions' design — P99). Nothing is open.
