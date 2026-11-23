# Coverage — feat-instagram-dm-sending-2026-11-23-oxak

Mode **initial** (Baseline `none`, Intake mode `brief`, from scratch) · Intake hash `e2875698ea64` · 2026-11-23.
Sources: `intake-files/BRIEF.md` (the cover), `intake-files/Instagram-DM-Sending-Plan-v8.md` (`plan:L…`, the
full truth) and `intake-files/DM-System-Simple-Guide-v8.md` (`guide:L…`, its short version — "if they ever
disagree, the plan wins", guide:3). Questions `Qn` / defaults `An`: the Step 4 batch (decisions.md once answered).

Status: `covered` (a requirement reaches it) · `open` (waits for a RED answer) · `out-of-scope` (with its reason).
Requirement identifiers are proposals until Step 6 writes `plans/requirements/`.

## Coverage

### Part A — decisions and system

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L212 | D1 build in `app`, migrations in place | `data.app-migrations-in-place` | all | BRIEF AC-10 | open — Q2 |
| plan:L213 | D2 Neon, pooler link, direct link for migrations | `quality.database-links` | engine | — | covered |
| plan:L214–215 | D3–D4 queues and the four lanes | `background.sending-lanes` | sending-engine | BRIEF AC-4 | covered |
| plan:L216–222 | D5–D11 opening / fast limits, timing, pick order, 24 h, 7 days, estimate | `operations.instagram-send-limits`, `background.opening-turn`, `background.fast-messages` | sending-engine | BRIEF AC-4 | covered |
| plan:L223–228 | D12–D17 follow check, once rule, public replies, events / history kept, unknown result | `operations.automation-follow-check`, `operations.automation-once-rule`, `quality.retention`, `operations.automation-unknown-outcome` | automations, sending-engine | BRIEF AC-5, AC-8 | covered (D13/D16/D17 flagged as risk) |
| plan:L229 | D18 two gates + month count in the send commit | `background.send-gates` | sending-engine | BRIEF AC-6 | covered |
| plan:L230 | D19 Instagram errors per lane | `background.instagram-error-stops` | sending-engine | BRIEF AC-4 | covered |
| plan:L231 | D20 a restore or copy never sends | `quality.restore-never-sends` | sending-engine | BRIEF AC-9 | covered |
| plan:L232–233 | D21–D22 rolling deploy, settings file | `quality.sending-settings` | sending-engine | — | covered (A4) |
| plan:L235–238 | D24–D27 Unified Login, connect, many accounts, `channel` | `integrations.meta-unified-login`, `operations.instagram-connect-multi`, `billing.plan-instagram-accounts-max` | meta-connection | BRIEF AC-2 | covered (A1; D24 risk) |
| plan:L239–256 | D28–D45 automation status, messages, hello, follow / email / phone, public replies, hide, month DMs, plan states, counters, 15 ways to start, also-start-from, targeting, Live, ads, starters, ref links, tags | `operations.automation-*` (see Part B rows) | automations | BRIEF AC-3, AC-7 | covered (ads / Live / repost: open — Q9) |
| plan:L257 | D46 contacts | `operations.contact-*` | contacts | — | covered |
| plan:L258, L281 | D47, D70 later features | — | — | — | out-of-scope — the later-features file (BRIEF Out of scope) |
| plan:L259 | D48 Part F in merged domains, new migrations only | `data.merged-domains-forward-only` | product-around-sending | BRIEF AC-10 | open — Q1 |
| plan:L260–263 | D49–D52 stop word, messages kept, contacts kept, reply lines | `operations.contact-stop-words`, `quality.retention` | contacts, automations | BRIEF AC-8 | covered |
| plan:L264 | D53 referral payout $50 | `billing.referral-payout` | product-around-sending | — | open — Q1, Q12 |
| plan:L265 | D54 email defaults | `notifications.owner-email-defaults` | notices | — | covered (Part F parts: open — Q1) |
| plan:L266 | D55 unlimited members, Editor / Viewer | `access.editor-viewer-roles` | product-around-sending | — | open — Q1 |
| plan:L267 | D56 trusted device | `access.trusted-device` | product-around-sending | — | open — Q1 |
| plan:L268 | D57 moving down a plan | `billing.plan-downgrade` | plans-and-limits | BRIEF AC-7 | covered |
| plan:L269 | D58 file scan | `files.message-file-scan` | message-files | — | open — Q7 (no scanner exists) |
| plan:L270–276 | D59–D65 reply default, close spellings, % tapped, month limit, `@username`, comment replies, once per post | `operations.automation-*`, `operations.instagram-account-settings-v8` | automations, account-settings | — | covered (Q8 for D65's open run) |
| plan:L277–278 | D66–D67 mark as seen, extra delay | `operations.instagram-mark-seen`, `operations.instagram-extra-delay` | account-settings | — | covered (mark seen: Q9) |
| plan:L279 | D68 broadcasts | `operations.broadcast`, `operations.segment` | broadcasts | — | covered |
| plan:L280 | D69 past comments | `operations.automation-past-comments` | past-comments | — | covered |
| plan:L282–283 | D71–D72 pause one person, retry failed | `operations.contact-pause-automations`, `operations.instagram-message-retry-failed` | contacts, automations | — | covered |
| plan:L284 | D73 7-day free trial | `billing.paid-trial` | plans-and-limits | — | open — Q1 |
| plan:L290–305 | version-7 rules (size, limits per account, types, two automations one post, ask once, pause, half speed, owner sees, worker never waits, Redis, missed comments, places, review fixes) | `background.*`, `quality.*` | sending-engine | — | covered (Redis rule vs buffer: Q5) |
| plan:L416–444 | §3.1 where it lives, migration rule | `data.*` | all | — | open — Q2, Q11 |

### Part B — what people and owners see (§4–16)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L452–472 | 15 ways to start | `operations.automation-trigger-types` | automations | BRIEF AC-3 | covered (repost / ads / Live: Q9) |
| plan:L478–515 | once keys per way | `operations.automation-once-key` | automations | BRIEF AC-3 | covered |
| plan:L499–505 | window rule, Live, ad window, tag-start window, every-time mode | `operations.automation-window-rule`, `operations.automation-every-time-mode` | automations | — | covered (Q8) |
| plan:L517–571 | match order (5 levels) | `operations.automation-message-match-order` | automations | BRIEF AC-3 | covered |
| plan:L573–596 | comment match | `operations.automation-comment-match` | automations | — | covered |
| plan:L598–618 | six webhook fields | `integrations.instagram-webhook-fields` | webhook | — | covered |
| plan:L649–710 | draft / live / paused, pause keep or cancel, duplicate, delete, auto stop, live edit, downgrade, go-live check | `operations.automation-status-draft-live-paused`, `operations.automation-go-live-check` | automations | BRIEF AC-7 | covered (A2, A8, A11) |
| plan:L712–796 | step order, step matrix, also start from | `operations.automation-step-order`, `operations.automation-also-start-from` | automations | — | covered |
| plan:L800–880 | targeting, typo match, try it, option row, starter questions, ref link, ad picker | `operations.automation-keyword-typo-match`, `operations.automation-try-it`, `operations.instagram-starter-questions-sync`, `operations.automation-ref-link`, `operations.instagram-ad-picker` | automations | — | covered (ad picker: Q9) |
| plan:L882–954 | hello, versions, nudge, follow, email, phone | `operations.automation-step-hello`, `operations.automation-nudge`, `operations.automation-step-follow`, `operations.automation-step-email-ask` | automations | — | covered (A19) |
| plan:L956–1008 | message list, attachments, waits, window | `operations.automation-step-messages`, `operations.automation-message-attachments` | automations, message-files | — | covered (scan: Q7) |
| plan:L1010–1061 | public replies, tags, tag events, bulk tags, hide | `operations.automation-step-public-reply`, `operations.contact-tag-events`, `operations.automation-hide-comment` | automations, contacts | — | covered |
| plan:L1075–1131 | account settings v8, past comments | `operations.instagram-account-settings-v8`, `operations.automation-past-comments` | account-settings, past-comments | — | covered |
| plan:L1136–1192 | lanes, message types, DM counting | `background.sending-lanes`, `operations.instagram-dm-counting` | sending-engine | BRIEF AC-6 | covered |
| plan:L1195–1443 | comment flow, Live, ads, no-hello, own comment, replies | `operations.automation-comment-flow`, `operations.automation-live-ended`, `operations.automation-ad-comment` | automations | — | covered (Live / ads: Q9) |
| plan:L1445–1818 | story reply, DM, first message, shared post, broadcasts, segments | `operations.automation-message-start-flow`, `operations.broadcast`, `operations.segment` | automations, broadcasts | — | covered (A9) |
| plan:L1820–1949 | once rule, 24 h, window | `operations.automation-once-rule`, `operations.automation-window-table` | automations | — | covered (Q8) |
| plan:L1951–2103 | limits, month DMs, accounts max, plan states, PRO, choose active accounts, trial | `operations.instagram-send-limits`, `billing.plan-dm-month-limit`, `billing.plan-states`, `billing.plan-pro-features`, `operations.instagram-choose-active-accounts` | plans-and-limits | BRIEF AC-6, AC-7 | covered (trial: Q1; A3) |
| plan:L2105–2263 | human timing, extra delay, expiry, estimate | `operations.instagram-timing-boxes`, `operations.instagram-message-expiry`, `operations.instagram-pending-estimate` | sending-engine | — | covered |
| plan:L2267–2362 | public replies per automation, usage header | `operations.automation-public-reply-per-automation` | automations | — | covered |
| plan:L2364–2510 | follow check, email / phone parse, answer table, stop words, ask once, mark seen, pause one person | `operations.automation-answer-table`, `operations.contact-stop-words`, `operations.contact-pause-automations` | automations, contacts | — | covered |
| plan:L2512–2736 | owner screens: counters, switcher, 35 banners, workspace notices, pause / resume account, undo, fix text, limits, contacts (note, timeline, delete, tags), connect / reconnect / disconnect, team suspend, owner emails, broadcast screen, backfill button, retry failed | `operations.automation-list-counters`, `operations.instagram-account-banners`, `operations.workspace-notices`, `operations.contact-note`, `operations.contact-timeline`, `notifications.owner-emails` | owner-actions | — | covered (A14, A15, A18) |
| plan:L2737–2791 | 26 Riya examples | acceptance seeds | all | `plans/acceptance.md` | covered |

### Part C — data (§17–23)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L2798–2884 | table map, reused tables, "already solved" | `data.*` | all | — | covered |
| plan:L2886–3225 | 9 changed `app` tables, token table removed | `data.*` (db-changes.md stages 1–5) | all | — | covered (Q2) |
| plan:L3226–3847 | 20 new tables | `data.*` (db-changes.md) | all | — | covered (Q11 names) |
| plan:L3848–4123 | statuses and state pictures | `data.*-states` | sending-engine | — | covered (A3) |
| plan:L4124–4220 | partitions and retention | `quality.retention`, `background.partition-upkeep` | sending-engine | BRIEF AC-8 | open — Q6 |
| plan:L4221–4300 | row security, roles, organization context | `access.row-security`, `access.global-sending-tables` | all | — | covered (A16) |
| plan:L4302–4342 | Redis keys | `quality.redis-notes` | sending-engine | — | covered (A5, A6; buffer: Q5) |

### Part D — the sending engine (§24–35)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L4346–4480 | queues, tickets, places, BullMQ rules | `background.sending-lanes`, `quality.worker-places` | sending-engine | — | covered |
| plan:L4482–4730 | Unified Login connect, scopes, subscribe, token check, reconnect, disconnect, callbacks, message access | `integrations.meta-unified-login`, `background.token-check`, `background.account-setup` | meta-connection | BRIEF AC-2 | covered (A17) |
| plan:L4732–4818 | webhook save, event kinds, Postgres down | `integrations.instagram-webhook-save` | webhook | — | open — Q5 (buffer) |
| plan:L4820–5175 | intake | `background.intake` | sending-engine | — | covered |
| plan:L5177–5413 | slow and reply lane turns | `background.opening-turn`, `background.reply-turn` | sending-engine | — | covered |
| plan:L5415–5702 | fast messages, attachments | `background.fast-messages`, `background.attachment-upload` | sending-engine | — | covered (scan: Q7) |
| plan:L5704–5866 | gates, month count, Redis down, every wait | `background.send-gates` | sending-engine | BRIEF AC-6 | covered |
| plan:L5868–6040 | Instagram errors, stops, tests | `background.instagram-error-stops` | sending-engine | BRIEF AC-4 | covered (Q9 codes from tests) |
| plan:L6042–6093 | helper every minute | `background.helper-*` | sending-engine | — | covered (A7) |
| plan:L6095–6185 | locks, transactions, timeouts | `quality.lock-order` | sending-engine | — | covered |

### Part E — running it (§36–43)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L6189–6869 | settings file, every number | `quality.sending-settings` | sending-engine | — | covered (A4, A6) |
| plan:L6871–6941 | Neon set-up | `quality.database-links` | — | — | covered (ops parts: out-of-scope — runbook, not code) |
| plan:L6943–7045 | deploy, restart, many servers | `quality.rolling-deploy` | sending-engine | — | covered |
| plan:L7047–7115 | backup, restore, test copies | `quality.restore-never-sends` | sending-engine | BRIEF AC-9 | covered |
| plan:L7117–7179 | health checks and alerts | `quality.sending-health` | sending-engine | — | covered |
| plan:L7181–7375 | security and privacy | `quality.token-secrecy`, `quality.message-privacy` | all | — | covered |
| plan:L7377–7494 | size for 1,000 accounts | `quality.capacity` | — | — | covered (estimates; no load test this iteration) |
| plan:L7496–7594 | tests with Meta before building | — | — | — | out-of-scope — the owner's tasks with a real Meta app (BRIEF Out of scope); their results gate Q9 |

### Part F — the product around sending (§44–49)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L7598–7780 | sign-in: passwords off, Apple, digits code, trusted devices, step-up, GitHub off | `access.sign-in-v8` | product-around-sending | — | open — Q1 |
| plan:L7782–7909 | workspaces, members, Editor / Viewer, `contact:update`, invitations, chooser, `logo_color` | `access.editor-viewer-roles`, `access.contact-update-code` | product-around-sending | — | open — Q1 (`contact:update`: A20) |
| plan:L7911–8115 | Flowdm plans, typed features, plan states, read-only, cards, trial | `billing.flowdm-plans`, `billing.plan-states`, `billing.paid-trial` | plans-and-limits | BRIEF AC-7 | open — Q1, Q10 |
| plan:L8117–8238 | profile, settings, notification kinds, notices | `notifications.kinds-v8` | notices | — | open — Q1 (sending notices: covered) |
| plan:L8240–8316 | refer | `billing.referral` | product-around-sending | — | open — Q1, Q12 |
| plan:L8318–8327 | later features | — | — | — | out-of-scope — D47 |

### Part G — build and track (§50–53)

| Source | Item | Requirement | Feature | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| plan:L8331–8348 | the process: re-open or two new iterations, `--both` | — | — | — | open — Q1, Q3 |
| plan:L8350–8377 | step 0 Meta app check, creator test | — | — | — | out-of-scope — owner task |
| plan:L8409–8434 | Track A A1–A10 | ROUTE rows (Step 6) | all | — | covered |
| plan:L8436–8481 | Track B B1–B6, Part F names | ROUTE rows (Step 6) | product-around-sending, message-files | — | open — Q1, Q7 |
| plan:L8483–8498 | app names from §18–20 | db-changes.md | all | — | covered (A6) |
| plan:L8500–8525 | Meta review checklist | — | — | — | out-of-scope — owner task |
| plan:L8527–8531 | tests and close | `quality.gates` | all | BRIEF AC-1 | covered |
| plan:L8535–8603 | 45 review items | spread over the rows above | all | — | covered |
| plan:L8775–8777 | open: referral payouts, plan prices, AI | — | — | — | open — Q12, Q10; AI out-of-scope (later) |
| plan:L8779–8805 | to test with Meta, to check when building | — | — | — | covered by Q9 (gate) and kickoff checks |

## Reconciliation

The drop has no `PRD.md` / `schema-routes.md`; the plan is the one approved source. Rows below are the plan
against itself, against the guide, and against what the launch built (`SD` = launch Standing deviation,
`iterations/launch-2026-11-20-ujai/AS-BUILT.md`). A verdict only where one approved line settles it.

| # | Item | Says (A) | Says (B) | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| R1 | Go-live checks | §5.1: 17 checks, hello always needs a next-step button (plan:L690–707) | §15.5: 10 checks, button "when later steps exist" (plan:L2635–2653); DB check unconditional (plan:L3111) | — | A2 (default) |
| R2 | Month-limit lanes | slow + fast + broadcast (plan:L2014, L3407, D62 plan:L273) | slow + fast (plan:L4051–4052) | D62 (user-approved) wins: slow + fast + broadcast | A3 |
| R3 | Stop-word restart list | keyword comment, keyword DM, starter, ig.me link (plan:L557, L2423, D49 plan:L260) | "only a keyword DM, a starter tap or a link" (plan:L1471) | D49 (user) wins: the four | none |
| R4 | One open run | one per automation + person in "every time" (plan:L505, L1944) | open key includes the once key with "once" ON (plan:L3473) | — | Q8 |
| R5 | Ad comments live-able | offered only after the Meta test (plan:L626, L1364) | DB checks and backfills allow `ad_comment` live (plan:L3103, L3828) | — | Q9 |
| R6 | Run retention clock | 90 days after the run ends (plan:L4144) | parts dropped by `started_at` month, "approximate" (plan:L3151, L1850) | D13 accepts approximate | depends on Q6 |
| R7 | Messages kept 30 days | D50 (plan:L261) | weekly parts by run start (plan:L3236, L4143) → "what happened" ≈ 30 days | — | A13; depends on Q6 |
| R8 | Per-person limit bounds | owner 5–100 (plan:L1960) | DB check "over 0" (plan:L2904) | two layers (API vs database), consistent | none |
| R9 | Upload scan | D58 "the upload domain scans every file" (plan:L269) | B6 "meepzo-be has no scanner today" (plan:L8444); code: none | the premise of D58 is false | Q7 |
| R10 | Intake never paused | send queues "not paused by the circuit" (plan:L4470–4480) | the launch's intake worker pauses on the open Instagram circuit (`createProviderPausableWorker`) | agent-os decides at kickoff (worker family) | AS-BUILT |
| R11 | Webhook store failure | Redis buffer, answer 200 (plan:L4799–4807) | launch: store first, 500/503 so Meta re-delivers (SD "Store before answering") | repository rule: Postgres only source of truth | Q5 |
| R12 | Once rule | per once key, resets ~90 days (D13) | launch: once ever, `previous_run_final` (SD "Trigger after an earlier run") | D13 (user) wins | before → after in requirements |
| R13 | Unknown result | resend once on her next action (D17) | launch: fail the step (SD "Sending again on a retry") | D17 (user, 22 Nov) wins | before → after |
| R14 | Retention | events 8 d, runs / logs 90 d (D15, D16) | launch 30 d / 180 d (SD "Wait limit and run retention") | D15 / D16 (user) win | before → after |
| R15 | Accounts per workspace | 1 / 3 / 10 by plan (D26) | launch: one not-revoked account, singular routes (SD "Accounts per organization") | D26 wins | A1 |
| R16 | Login | Unified Login only (D24) | launch: Instagram Login, token table, daily renewal (SD "Daily account check") | D24 wins | REMOVED rows |
| R17 | Read-only plan | owner may pause, delete, disconnect (plan:L2066) | launch: `organization_read_only` on create / edit / delete (SD "Read-only plan") | — | A10 |
| R18 | Delete reason | optional (plan:L677, L3035) | launch: required (SD "Automation delete") | — | A11 |
| R19 | Next post | never expires (plan:L3015, L3140) | launch: window + 15-minute expiry (SD "Next-post linking and expiry") | — | A12 |
| R20 | Email plus addresses | allowed (plan:L2384, L2978) | launch refuses Gmail plus (SD "Email and phone checks") | — | A19 |
| R21 | Guide vs plan | guide parts 1–29 summarise §1–53 | the guide defers to the plan (guide:3) | plan wins by its own rule | none |
| R22 | Repository rules | plan names (`dm_*`, `post_key`, `turn_no`, `_MS`, `cnt:`, `uq_`), Redis copies keyed by account, runtime DDL on the migration login, raw `set_config` | full-names rule, be-read-cache-guard, the three logins, the context wrappers | agent-os decides (plan:L8348) | A5, A6, Q6 |

## Delta

n/a — initial (Baseline `none`). The launch iteration (`launch-2026-11-20-ujai`, frozen, not merged) built the
`app` tables, routes and background work this plan changes; every change is written before → after against
it, and its Standing deviations this change touches go into `KICKOFF.md` section 8.

## Counts

Coverage rows 74 — covered 52, open 17 (waiting on Q1, Q2, Q5, Q6, Q7, Q12, Q3), out-of-scope 5 (+ a few
covered rows with an open part). Reconciliation rows 22 — 9 settled by an approved line, 13 to a question or
a default.
