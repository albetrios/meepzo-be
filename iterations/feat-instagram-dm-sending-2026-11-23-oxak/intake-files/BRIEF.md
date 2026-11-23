# Brief — Instagram DM sending engine and the Flowdm v4 product around it

<!--
Cover brief for a written drop. The design source is `Instagram-DM-Sending-Plan-v8.md` (the full truth,
8,809 lines, 73 decisions D1–D73 approved 22–23 Nov 2026); `DM-System-Simple-Guide-v8.md` is its short
version ("if they ever disagree, the plan wins", guide:3). Both are stored beside this file. Section
numbers below (§n) and decisions (Dn) are the plan's.
-->

## What changes

The Instagram automation built by `launch-2026-11-20-ujai` (connect, webhook, automations, contacts)
becomes the full Flowdm v4 product (plan:122, D23):

- **Connect**: Instagram Login is removed; Meta's Unified Login (business portfolio, one system-user
  token per connection) is the only login; a workspace connects 1, 3 or 10 Instagram accounts by plan
  (§25, D24–D27).
- **Sending engine**: every message is a `waiting` row in Postgres; four lanes per account (slow,
  reply, fast, broadcast); shared sending queues; two gates (Redis fast, Postgres exact) plus the monthly
  DM count in the send commit; human-like timing; Instagram error stops per account lane; an
  every-minute helper; partitioned history (§6, §24–35, D3–D22).
- **Automations**: draft / live / paused with a go-live check; 15 ways to start with one match order;
  hello with buttons and versions, nudge, follow / email / phone asks, a 1–10 message list in 7 kinds
  with waits, tags, public replies ON/OFF ("Reply like a person"), hide comment; starter questions,
  ref links, Live and ad comments; counters (§4–14, D28–D45, D59–D67).
- **Owner actions**: account settings, contacts (note, tags, detail, pause one person), retry failed
  messages, broadcasts and audiences (PRO), run on past comments (PRO), banners and estimates
  (§8, §15, D46, D68–D72).
- **Product around sending** in merged domains (new migrations only): sign-in changes (passwords off,
  Apple, trusted devices), roles Editor / Viewer, Flowdm plans Free / Creator / Studio with DM-per-month
  and account limits, PRO gating, a 7-day no-card trial, notices and emails, referrals, a message-file
  upload purpose with a file scan (§44–48, D48, D53–D58, D73).

## Why

Flowdm v4 is the product (D23). The launch build answers 3 ways to start with fixed steps and sends
inside the webhook job; it cannot pace opening DMs under Meta's limits, serve many accounts per
workspace, bill by DMs a month, or offer the v4 features (plan:418–436).

## Affected screens, entities and routes

- Screens: meepzo-fe's Flowdm v4 screens (prototype Version 181, D23) — named in the plan only where
  the backend serves them; no `_index.md` slugs in this drop.
- Entities: changed `app` tables — instagram accounts and settings, media, contacts, webhook events,
  automations, runs, run events, comment logs; removed `app.instagram_account_tokens`; new
  `app.meta_connections`, `app.meta_connection_tokens`, `app.instagram_messages`,
  `app.instagram_send_attempts`, lanes and counts, `app.automation_counts`, `app.automation_reply_state`,
  `app.meta_attachments`, `app.dm_month_counts`, `app.contact_tag_events`, `app.segments`,
  `app.broadcasts`, `app.broadcast_recipients`, `app.automation_backfills` (§17–19, §50.7); merged
  domains — `auth.trusted_devices`, users / settings / sessions columns, tenancy roles and
  `logo_color`, `billing.plans` rows, `billing.trial_accounts`, the referral tables,
  `subscriptions.downgrade_keep`, the upload scan status (§50.5–50.6).
- Routes: the account routes take `{instagram_account_id}`; the connect routes are replaced; new routes
  for drafts / go-live / pause / duplicate / try-a-keyword, contacts detail / note / bulk tags / pause,
  tag list, retry failed, segments, broadcasts, past comments; Part F's routes of §50.6 (Apple callback,
  email confirm, invitation preview, payment methods, referrals; password routes switched off).

## Rules

The plan's decisions D1–D73 (§2) and the version-7 rules (§2.1) are the rules. Headlines: Postgres is
the truth and Redis is never the last check nor called inside a transaction (D18, plan:302); a worker
never waits — every wait is a delayed job (plan:301); an unclear send result is never resent by itself
(D17); the `app` migrations are not in `main` and change in place, every merged domain gets new
migrations only (D1, D48); the plan proposes and meepzo-be's agent-os decides (plan:8348).

## Acceptance criteria

- [ ] Every decision D1–D73 holds in the built code or has an `AS-BUILT.md` deviation the user accepted.
- [ ] A workspace connects through Unified Login and picks accounts up to its plan limit; no Instagram Login code, table, worker, scope or host remains (D24–D26, plan:444).
- [ ] Each of the 15 ways to start, its match order and its once key behave as §4 and §9 say, Meta-gated ones only once their §43 test passes (D37).
- [ ] Opening DMs, public replies, fast messages and broadcasts keep their per-account limits, timing and lanes (D5–D11, D32, D68), and an error stops only the affected account's lane (D19).
- [ ] An `unknown` send result is never resent automatically (D17).
- [ ] The monthly DM count stops only new DMs at 100% and notifies at 80% and 100% (D34, D62).
- [ ] Draft / live / paused, the go-live check and PRO gating by plan, including moving down a plan, behave as D28, D35 and D57 say.
- [ ] Retention: webhook events 8 days, messages 30 days, runs / run events / comment logs 90 days, send attempts 8 days, contacts until deleted (D15, D16, D50, D51).
- [ ] A restored or copied database can never send (D20).
- [ ] Part F's changes ship as new migrations in the merged domains only (D48).

## Out of scope

Everything in `Instagram-DM-Later-Features-v8.md` (D47, D70, §49) — booking, link tracking, AI FAQ and
same-meaning keywords, forms, integrations, ads sync, Facebook / Messenger. The Meta app set-up,
business verification and App Review are the owner's tasks, not code (§50.2, §50.8). meepzo-fe's screens.
