# KICKOFF — feat-instagram-dm-sending-2026-11-23-oxak

## 1. Header

| Field | Value |
| --- | --- |
| Iteration | `feat-instagram-dm-sending-2026-11-23-oxak` (feat) |
| Mode | initial — Baseline `none` (the launch it changes is read through its `AS-BUILT.md`, section 8) |
| Intake mode | `brief` |
| Intake note | 3 received (`BRIEF.md`, `DM-System-Simple-Guide-v8.md`, `Instagram-DM-Sending-Plan-v8.md`) · from scratch |
| Drop placed | 2026-11-23 |
| Intake hash | `e2875698ea64` |
| Schema-routes | — (brief mode, no `schema-routes.md`) |
| Owner | Rimeet Mavani |
| Branch | `feat/instagram-automation` — one PR with the frozen launch ([P29](plans/decisions.md)) |
| Date | 2026-11-24 |
| Repositories | backend only; this plan owns the contract and meepzo-fe opens its own iteration later ([P30](plans/decisions.md)) |

The plan proposes; agent-os decides. The route review ([plans/routes-final.md](plans/routes-final.md), final rev 5,
confirmed 2026-11-24 — [P90](plans/decisions.md)) is built **ditto** — where agent-os cannot build it as written, kickoff
stops and asks before anything differs. The plan's own decisions D1–D73 (`intake-files/Instagram-DM-Sending-Plan-v8.md`
§2) are locked inputs; this plan's decisions are `P1`–`P100`. Every other difference is recorded in `AS-BUILT.md` and
synced back into [db-changes.md](plans/db-changes.md), [route-changes.md](plans/route-changes.md) and
[worker-changes.md](plans/worker-changes.md).

## 2. Goal and scope

**Goal.** Turn the launch's Instagram automation into the Flowdm v4 product (plan D23): one Meta login per business
portfolio that connects 1, 3 or 10 accounts by plan; a paced sending engine where every message waits in Postgres and
goes out through four lanes per account within Meta's limits, never twice; automations with draft / live / paused, a
go-live check and 15 ways to start; contacts, broadcasts, segments and past comments for the owner; and the product
around it — Flowdm plans with a monthly message limit and a trial, four fixed roles, sign-in without passwords,
notices and emails, message files.

**In scope** ([P28](plans/decisions.md): Track A §4–43 and Part F §44–47 in one iteration)

- Twelve sub-domains of the route review, 105 routes — 49 new, 55 changed, 1 as built, 5 removed
  ([route-changes.md](plans/route-changes.md); [routes-final.md › Sub-domains](plans/routes-final.md)).
- A common channel core (connection and account) with Instagram adapters, and the product data (contacts, automations,
  broadcasts, segments) shared across channels so WhatsApp or TikTok can be added later
  ([P40–P51](plans/decisions.md), [P53](plans/decisions.md)).
- The data model of [db-changes.md](plans/db-changes.md), stages 1–8 — the launch's `app` migrations changed in place,
  every merged domain on new migrations only (plan D1, D48; [P29](plans/decisions.md)).
- The background work of [worker-changes.md](plans/worker-changes.md): 45 new, 13 changed, 3 removed pieces — intake,
  the four sending lanes, the repair duties, retention and partition upkeep, plan states, notices.
- The scale fixes of the large-scale review ([P91–P96](plans/decisions.md), [P100](plans/decisions.md)).

**Out of scope**

- The referral program (plan §48, D53) — its tables, routes and month-close work ([P39](plans/decisions.md)).
- The malware scan of message files — type and content checks now, the scan in a later iteration; a plan D58
  deviation recorded in `AS-BUILT.md` ([P34](plans/decisions.md)).
- Everything in `Instagram-DM-Later-Features-v8.md` — booking, link tracking, AI FAQ, same-meaning keywords, forms,
  integrations, ads sync, Facebook / Messenger (plan D47, D70).
- A list of a connection's other assets (ad accounts, catalogs, Pages without Instagram) — with its first feature
  ([P52](plans/decisions.md)).
- The team "suspend account" route (the column only, [P18](plans/decisions.md)); an undo route ([P15](plans/decisions.md));
  a route to dismiss a notice ([P27](plans/decisions.md)); live screen updates (no realtime requirement).
- The owner's tasks, not code: the Meta app set-up, business verification and App Review (BRIEF, plan §50.2, §50.8);
  the Meta tests of plan §43 that open each gated feature ([P36](plans/decisions.md)); the real Stripe products at
  go-live ([P37](plans/decisions.md)).
- The frontend (meepzo-fe) and its screens ([P30](plans/decisions.md)).

## 3. Locked decisions

Every RED answer, one line each; the full rows are in [plans/decisions.md](plans/decisions.md).

| # | Decision |
| --- | --- |
| P28 | Everything in one iteration — Track A and Part F — except the referral program. |
| P29 | One PR on `feat/instagram-automation` with the frozen launch; the launch's `app` migrations change in place; the PR waits until this iteration is frozen. |
| P30 | Backend only now; meepzo-fe opens its own iteration later and links here. |
| P31 | The route review in one pass — every sub-domain drafted, then reviewed together. |
| P32 | Redis never holds data Postgres lacks: no webhook buffer (Postgres down → Meta delivers again), no separate result-save jobs. |
| P33 | Partition only high-volume tables; maintenance scope for partition upkeep (its plain list superseded by P96). |
| P34 | File type and content checks now, the malware scan later (a D58 deviation). |
| P35 | At most one open run per automation and person; a comment that may start a new run replaces it (`replaced`); other starts are ignored while her run is open. |
| P36 | Build every Meta-gated feature; go-live refuses each one until its Meta test passes. |
| P37 | Placeholder plan prices in the seed; operations creates the real Stripe products at go-live. |
| P38 | The plan's names, everything new in `app`; plan rows stay in billing; Part F in its merged domains (naming refined by P40–P48). |
| P39 | Referral payouts not in scope; the referral program moves to a later iteration. |
| P40 | A common channel core with adapters, the line drawn by P41–P46. |
| P41 | Connections are common; one Meta login (Unified Login) per business portfolio serves Instagram, Facebook and ads. |
| P42 | A common channel account plus a 1:1 Instagram extension; Instagram settings stay Instagram's. |
| P43 | The sending tables are Instagram's; the month count and the global send switch are shared. |
| P44 | Contacts, automations and broadcasts Instagram-specific — superseded by P48. |
| P45 | The webhook, its events and the Instagram queues and workers are Instagram-specific. |
| P46 | Meta's deauthorize and data-deletion callbacks live with the connection. |
| P48 | The product data is shared across channels, keyed by the channel account; each channel's abilities in one capability list. |
| P49 | The connection token keeps an encrypted refresh token and a token type now. |
| P50 | One feature check — channel ability, granted permission, plan switch, Meta test — with four named refusals. |
| P51 | Meta's usage is kept per connection and read by every channel before a call (refined by S13). |
| P53 | One Meta webhook route per object; each object saves into its own channel's tables. |
| P54 | A reconnect from a portfolio an account moved to attaches it at the callback. |
| P55 | The pick re-reads the assigned accounts from Meta every time. |
| P56 | Meta's callbacks match the account id first, else the business id; an unmatched id still gets its code and the team an email. |
| P57 | The ad picker reads one ad account at a time. |
| P58 | Reconnect is its own route. |
| P59 | The shared connection and account routes take the new `channel-account:*` codes, same roles as before. |
| P60 | "One account, one organization" lives on the channel account. |
| P61 | The four feature-check refusals: `422` · `409` · `403` · `422`. |
| P62 | Our own echoed message is recognised by a Postgres lookup. |
| P63 | The flood guard counts in Postgres at intake. |
| P64 | The tag list's cache key is organization + account, the account read back inside the scope. |
| P65 | Contact lists must name their account. |
| P66 | Bulk actions select ids (1–500) or a filter, worked in pieces of 500. |
| P67 | The tag list is one shared path filtered by account. |
| P68 | Go-live refusal is `409 automation_not_ready` with every problem and its step. |
| P69 | Saving a live or paused automation runs content checks only; account, plan and month checks at go-live. |
| P70 | The way to start is required at create. |
| P71 | Drop the open-run key table — superseded by P100. |
| P72 | "Workspace" is the platform's organization everywhere. |
| P73 | No helper-slot table; the repair runs as scheduled jobs. |
| P74 | The sending switch ships on in the template; its default stays off. |
| P75 | Deleted broadcasts and segments are purged after 90 days. |
| P76 | Segments and audience counts are PRO only; a trial's segments stay saved. |
| P77 | A move down waits for the period end through a Stripe subscription schedule. |
| P78 | Card paths use Stripe's card id, a third non-entity parameter. |
| P80 | An organization still on a switched-off old plan is held to Free's features until it picks a plan. |
| P81 | The lavender colour value is renamed `lavender` everywhere. |
| P82 | Invites take `role_ids` with exactly one role. |
| P83 | One on / off switch per plan feature; "PRO" is a label, not a field. |
| P84 | Passwords removed — four routes and every password path. |
| P85 | Apple's form callback is the one named `303` exception. |
| P86 | Session places from DB-IP "IP to City Lite"; no file → place empty. |
| P87 | Notification preferences per kind. |
| P88 | Email with in-app off uses the caller's dedupe key. |
| P89 | `X-Idempotency-Key` on creates and job starts only. |
| P90 | The route review confirmed — every open question answered. |
| P91 | An in-process database limiter for the send, intake and task workers; the send work runs as its own service. |
| P92 | High-volume clean-ups hourly within a time budget, with an "oldest row past its keep time" gauge. |
| P93 | The missed-comment full pass keeps the normal limits, lowest priority, stops at 60 % Meta usage, one job per account. |
| P94 | One scheduled job per repair duty, each within a 40 s budget. |
| P95 | A rollback keeps sending: a minimum compatible settings version per release. |
| P96 | Partition runs, run events, comment logs and event keys while empty; expiry drops a part. |
| P100 | A small open-run key table holds "one open run per automation and person" across monthly parts. |

## 4. Features and order

Screen features before the flow features that involve them; the numbers are those of
[plans/acceptance.md](plans/acceptance.md) (`AC-<n>.*`). Each story is in `plans/features/<feature>/story.md`; the build
order is the ROUTE's.

| # | Feature | Kind | Depends on |
| --- | --- | --- | --- |
| F1 | [channel-connection](plans/features/channel-connection/story.md) | screen | F11 |
| F2 | [channel-accounts](plans/features/channel-accounts/story.md) | screen | F1, F11 |
| F3 | [instagram-account-settings](plans/features/instagram-account-settings/story.md) | screen | F2, F11 |
| F4 | [instagram-content-picker](plans/features/instagram-content-picker/story.md) | screen | F2 |
| F5 | [contacts](plans/features/contacts/story.md) | screen | F2 |
| F6 | [automations](plans/features/automations/story.md) | screen | F2, F4, F5, F11, F15 |
| F7 | [automation-runs-and-messages](plans/features/automation-runs-and-messages/story.md) | screen | F5, F6, F17 |
| F8 | [past-comments](plans/features/past-comments/story.md) | screen | F6, F11, F16 |
| F9 | [broadcasts-and-segments](plans/features/broadcasts-and-segments/story.md) | screen | F5, F6, F11, F17 |
| F10 | [organization-usage-and-notices](plans/features/organization-usage-and-notices/story.md) | screen | F11, F17 |
| F11 | [plans-billing-and-trial](plans/features/plans-billing-and-trial/story.md) | screen | none |
| F12 | [roles-and-organization](plans/features/roles-and-organization/story.md) | screen | none |
| F13 | [sign-in-and-security](plans/features/sign-in-and-security/story.md) | screen | F12 |
| F14 | [profile-settings-and-notifications](plans/features/profile-settings-and-notifications/story.md) | screen | F12, F13 |
| F15 | [message-files](plans/features/message-files/story.md) | screen | F12 |
| F16 | [instagram-webhook-intake](plans/features/instagram-webhook-intake/story.md) | screen | F2, F5, F6 |
| F17 | [instagram-sending-engine](plans/features/instagram-sending-engine/story.md) | screen | F2, F3, F6, F11, F16 |
| F18 | [retention-and-partitions](plans/features/retention-and-partitions/story.md) | screen | F9, F16, F17 |
| F19 | [comment-to-dm-flow](plans/features/comment-to-dm-flow/story.md) | flow | F5, F6, F16, F17 |
| F20 | [message-start-flow](plans/features/message-start-flow/story.md) | flow | F5, F6, F16, F17 |
| F21 | [broadcast-send-flow](plans/features/broadcast-send-flow/story.md) | flow | F9, F16, F17 |
| F22 | [month-limit-flow](plans/features/month-limit-flow/story.md) | flow | F10, F11, F17 |
| F23 | [plan-move-down-flow](plans/features/plan-move-down-flow/story.md) | flow | F2, F6, F8, F9, F11 |
| F24 | [trial-flow](plans/features/trial-flow/story.md) | flow | F1, F11, F23 |
| F25 | [reconnect-after-token-error-flow](plans/features/reconnect-after-token-error-flow/story.md) | flow | F1, F2, F10, F17 |
| F26 | [data-deletion-and-contact-erase-flow](plans/features/data-deletion-and-contact-erase-flow/story.md) | flow | F1, F5, F7, F9 |
| F27 | [outage-recovery-flow](plans/features/outage-recovery-flow/story.md) | flow | F16, F17, F18 |

## 5. ROUTE

One row per work item, in build order. A `sub-domain` row's spec is its route-review section of
[plans/routes-final.md](plans/routes-final.md) and its checklist is that section's code changes (the ids named). Order:
the route review's build order — billing's plan rows and the plan read (8.A) first, because 1, 1B, 2, 4 and 6 read them;
then 1 → 1B → 2 → 3 → 4 → 5's receiver and tables → 6 → 7 → the rest of 8 → 9 → 10 → 11 → 12 — then the background work
(5's intake after 6's message table; the database limiter before every lane), then the flows, then Close. Where a row
needs a piece of a later row (the pick's lane step and trial check; the pause, resume, choose-active and disconnect lane
steps; "What happened" and the failed-message retries; the own-message lookup; the message-file read), that step is
finished in the later row, as the route review's build-order notes say (CA5) — the earlier row leaves it behind the
named interface. Acceptance that names the Editor or Viewer role is proven once R28 adds the roles. Drivers: a NEW
table → the staged-build prompt ([docs/getting-started/staged-build-prompt.md](../../docs/getting-started/staged-build-prompt.md));
a CHANGE table, background work and flows → `/be-build-requirement`. Assignee: Rimeet Mavani.

| # | Work item | Kind | Depends on | Skill/driver | Acceptance | Assignee | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 8.A Plans: the Flowdm plan rows and the switched-off rows, one switch per feature, the plan read; routes 100–101 — `routes-final.md` § 8.A (BLC6) and § 8 BLC1 (plans part), BLC2 | sub-domain | — | `/be-build-requirement` | AC-11.1, AC-11.2, AC-11.14 | Rimeet Mavani | done |
| R2 | 1 The Meta client moved into the connection, Meta's usage per connection, the one-use login state — § 1 MCC2, MCC3, MCC12 | sub-domain | R1 | `/be-build-requirement` | AC-1.18, AC-1.19 | Rimeet Mavani | done |
| R3 | 1 Channel connection: the connection and token tables, routes 1–5, 40, 42 (start, callback, pick, list, disconnect, reconnect), the two `channel-account:*` codes of § 9 TNC8 first — § 1 MCC1, MCC4, MCC5, MCC7, MCC10, MCC11 | sub-domain | R1, R2 | staged-build prompt | AC-1.1–AC-1.10, AC-1.15–AC-1.17 | Rimeet Mavani | done |
| R4 | 1 The ad picker: routes 15, 41 — § 1 MCC8 | sub-domain | R3 | `/be-build-requirement` | AC-1.13 | Rimeet Mavani | done |
| R5 | 1B Channel account: the account table, routes 6–11, the capability list and the one feature check — § 1B CAC1–CAC6 (the lane steps of routes 8–11 at R18) | sub-domain | R3 | staged-build prompt | AC-2.1, AC-2.4, AC-2.5, AC-2.8, AC-2.10, AC-2.11 | Rimeet Mavani | done |
| R6 | 2.A Instagram account extension, and the team-delete erasure over every account — § 2.A (IAC6), § 2 IAC5 | sub-domain | R5 | `/be-build-requirement` | AC-2.1, AC-2.12 | Rimeet Mavani | done |
| R7 | 2.B Instagram account settings: route 12 — § 2.B (IAC8) | sub-domain | R6 | `/be-build-requirement` | AC-3.1–AC-3.11 | Rimeet Mavani | done |
| R8 | 2.C Instagram media: routes 13–14, the watch and Live columns — § 2.C (IAC9, IAC10) | sub-domain | R6 | `/be-build-requirement` | AC-4.1–AC-4.6 | Rimeet Mavani | done |
| R9 | 1 Meta's callbacks: routes 16–17, matched by account then business — § 1 MCC9 (after 1B and 2, whose disconnect and erasure they call) | sub-domain | R5, R6, R8 | `/be-build-requirement` | AC-1.11, AC-1.12 | Rimeet Mavani | done |
| R10 | 3.A Contacts (shared): routes 18–23, `contact:update`, the activity and tag-count tables (S5, S7), search rules (S6), the erase and pause steps — § 3 CTC1–CTC4, § 3.A CTC5–CTC8, CTC10 (routes 24–26, CTC9, at R19; the bulk job at R46) | sub-domain | R5, R6 | `/be-build-requirement` | AC-5.1–AC-5.4, AC-5.6, AC-5.8–AC-5.14 | Rimeet Mavani | done |
| R11 | 3.B Contact tag events — § 3.B (CTC11, CTC12) | sub-domain | R10 | staged-build prompt | AC-5.5, AC-5.7 | Rimeet Mavani | done |
| R12 | 12 Upload — message files: the message purpose, audio checks, the usable-file read (completes R13's go-live check and R20's file read); routes 140, 150 — § 12 (UPC1–UPC4) | sub-domain | — (Editor’s `upload:manage` grant lands with roles at R28) | `/be-build-requirement` | AC-15.1–AC-15.3, AC-15.5, AC-15.6 | Rimeet Mavani | done |
| R13 | 4.A Automations (shared): the new shape, routes 27–35, counters and reply states, the go-live list over the feature check — § 4 AUC1–AUC4, § 4.A AUC5–AUC8, § 4.C AUC13 (routes 36–37 at R19; the message-file check at R12) | sub-domain | R5, R7, R8, R10, R12 | `/be-build-requirement` | AC-6.1–AC-6.21, AC-6.24–AC-6.27 | Rimeet Mavani | done |
| R14 | 4.B Automation runs: the run engine around waiting messages (through the channel sending interface), runs, run events and comment logs split by month, the open-run keys — § 4.B (AUC9–AUC11, AUC14, AUC15) | sub-domain | R11, R13 | `/be-build-requirement` | AC-6.22; decision items P35, P100 | Rimeet Mavani | done |
| R15 | 4.C Automation backfills: the table, routes 38–39 — § 4.C AUC12 (the read job at R41) | sub-domain | R13 | staged-build prompt | AC-8.1–AC-8.3, AC-8.9 | Rimeet Mavani | done |
| R16 | 5.B Webhook events (split by day, kept 8 days) and their key table (split by Meta's event day), route 62 — § 5.B WHC11, WHC12, WHC14 | sub-domain | R5 | `/be-build-requirement` | AC-16.4, AC-16.24 | Rimeet Mavani | done |
| R17 | 5.A Webhook receiver: routes 60–61 at the per-object path, the save-only store, the replay guard, a slow store answers a failure, the per-IP cap for unsigned traffic only (S9, S10) — § 5 WHC1–WHC3, § 5.A WHC5, WHC6 (the own-message lookup at R19) | sub-domain | R16 | `/be-build-requirement` | AC-16.1–AC-16.6 | Rimeet Mavani | done |
| R18 | 6.A Instagram sending: lanes, stops, minute and month counts, the global send state, routes 63–64, the sending switch and environment id, the short copies, health checks; the lane steps of routes 3 and 8–11 — § 6 SNC1, SNC6, SNC8, SNC9, § 6.A SNC10–SNC12 (S8, S18, S29) | sub-domain | R1, R5, R6 | staged-build prompt | AC-7.12, AC-10.1, AC-1.7, AC-2.2, AC-2.3, AC-2.6, AC-2.7, AC-2.9, AC-17.21 | Rimeet Mavani | done |
| R19 | 6.B Instagram messages (weekly parts) and send attempts (daily parts), Instagram's sending interface, the summary and retry service; routes 24–26 and 36–37, the own-message lookup — § 6.B (SNC13, SNC14), § 3.A CTC9 | sub-domain | R14, R17, R18 | staged-build prompt | AC-7.1–AC-7.11, AC-7.13 | Rimeet Mavani | done |
| R20 | 6.C Instagram attachments; the sending interface wired, usage read from the connection — § 6.C (SNC15, SNC16) | sub-domain | R19 | staged-build prompt | AC-15.4 | Rimeet Mavani | open |
| R21 | 7.B Segments (shared): the table, routes 77–82, the segments switch — § 7 BCC1, BCC2, BCC4, BCC5, § 7.B (BCC8, BCC11) | sub-domain | R1, R10 | staged-build prompt | AC-9.1–AC-9.3, AC-9.12 | Rimeet Mavani | done |
| R22 | 7.A Broadcasts (shared): the table, routes 70–76, the send step, the messages' link to broadcasts — § 7.A BCC6 (the duties of BCC7 at R47) | sub-domain | R19, R21 | staged-build prompt | AC-9.4, AC-9.7–AC-9.9 | Rimeet Mavani | done |
| R23 | 7.C Broadcast recipients — § 7.C (BCC9, BCC10) | sub-domain | R22 | staged-build prompt | AC-9.5 | Rimeet Mavani | open |
| R24 | 8.B Subscriptions, plan states and the trial: the trial table and port (completes R3's pick), the move down at the period end with kept accounts, the context; routes 102, 103, 108 — § 8 BLC1, BLC3–BLC5, § 8.B BLC7–BLC9, BLC13 (the state check at R52) | sub-domain | R1, R5 | `/be-build-requirement` | AC-11.4, AC-11.5, AC-11.7, AC-10.2 | Rimeet Mavani | done |
| R25 | 8.C Cards: routes 104–106 — § 8.C (BLC11) | sub-domain | R24 | `/be-build-requirement` | AC-11.11, AC-11.13 | Rimeet Mavani | done |
| R26 | 8.D Stripe webhook: the four plan-state cases — § 8.D (BLC12) | sub-domain | R24 | `/be-build-requirement` | AC-11.8, AC-11.9 (the state change; the lane stops at R52) | Rimeet Mavani | done |
| R27 | 9.A Organization: optional slug, the tile colour (`lavender`); routes 110, 141–142 — § 9.A (TNC4) | sub-domain | — | `/be-build-requirement` | AC-12.8–AC-12.11 | Rimeet Mavani | done |
| R28 | 9.B Roles: Owner, Admin, Editor, Viewer on every team, `contact:update`, custom roles off; routes 111–115 — § 9 TNC1, TNC2, § 9.B | sub-domain | R27 | `/be-build-requirement` | AC-12.1–AC-12.4 | Rimeet Mavani | done |
| R29 | 9.C Members and invitations: several emails, the preview, counts per role; routes 116–118 — § 9 TNC3, § 9.C (TNC5–TNC7) | sub-domain | R28 | `/be-build-requirement` | AC-12.5–AC-12.7 | Rimeet Mavani | done |
| R30 | 10.A Email code, passwords removed; routes 120–121 (four removed) — § 10 ATC1, ATC2, ATC4, § 10.A (ATC5) | sub-domain | R28 | `/be-build-requirement` | AC-13.1–AC-13.4 | Rimeet Mavani | done |
| R31 | 10.B Google and Apple, the one `303` exception; routes 122–125, 143 — § 10 ATC3, § 10.B (ATC6, ATC7) | sub-domain | R30 | `/be-build-requirement` | AC-13.5–AC-13.7 | Rimeet Mavani | done |
| R32 | 10.C Two-factor, trusted devices, step-up; routes 126–127, 145, 147 — § 10.C (ATC8–ATC10) | sub-domain | R30 | staged-build prompt | AC-13.8–AC-13.11 | Rimeet Mavani | done |
| R33 | 10.D Sessions with their place; routes 128, 144, 146 — § 10.D (ATC11) | sub-domain | R30 | `/be-build-requirement` | AC-13.12, AC-13.13 | Rimeet Mavani | done |
| R34 | 11.A The person and the organization chooser (the app's counts port); routes 130–132, 148–149 — § 11 UNC1, UNC2, § 11.A (UNC3, UNC4) | sub-domain | R13, R18, R29 | `/be-build-requirement` | AC-14.1–AC-14.3 | Rimeet Mavani | done |
| R35 | 11.B Confirm your email; routes 133–134 — § 11.B (UNC5) | sub-domain | R30 | `/be-build-requirement` | AC-14.4 | Rimeet Mavani | done |
| R36 | 11.C Notification kinds and the check before send; routes 135–136 — § 11.C (UNC6–UNC8) | sub-domain | R29 | `/be-build-requirement` | AC-14.5–AC-14.7 | Rimeet Mavani | done |
| R37 | The database limiter, the Instagram queues and their workers, the send work as its own service — § 6 SNC17, SNC2; K16 (1) | background | R19 | `/be-build-requirement` | AC-17.20; decision item P91 | Rimeet Mavani | open |
| R38 | Intake per kind — chat events, comments and ad comments, Live comments, tag events: the inbound seam, one lock order, the flood skip, several comment-intake jobs per account and the profile read as a low-priority task (S11, S20, S25); sending moves out of intake (WC-9 removed) — § 5 WHC4, WHC16, WHC17, § 5.A WHC7–WHC9; WC-1–WC-4 | background | R14, R17, R19, R37 | `/be-build-requirement` | AC-16.3, AC-16.7–AC-16.17, AC-16.19 | Rimeet Mavani | open |
| R39 | Stuck-event pick-up and missed comments, with the bounded full pass after an outage — § 5.A WHC10; WC-12, WC-26 | background | R38 | `/be-build-requirement` | AC-16.20, AC-16.21 | Rimeet Mavani | open |
| R40 | Account jobs: set-up at Meta, the webhook subscription check, the starter-question sync — § 2 IAC3; WC-25, WC-30, WC-31 | background | R6, R37 | `/be-build-requirement` | AC-1.7, AC-6.11, AC-16.22 | Rimeet Mavani | open |
| R41 | Past-comment reads and "my next post" linking (never expires) — § 4.C AUC12 (read job), § 4 AUC3; WC-41, WC-43, WC-44 removed | background | R15, R38 | `/be-build-requirement` | AC-8.4–AC-8.6, AC-6.23, AC-16.23 | Rimeet Mavani | open |
| R42 | The send core: the two gates, the month count in the send commit, the one shared result save, error groups and stops, plan stops and Meta usage read at the turn (S13, S14) — § 6 SNC3, SNC4, SNC7 | background | R20, R37 | `/be-build-requirement` | AC-17.8–AC-17.12, AC-17.16, AC-17.17, AC-17.25; decision item D17 | Rimeet Mavani | open |
| R43 | The slow and reply lanes — WC-5, WC-6 | background | R42 | `/be-build-requirement` | AC-17.1–AC-17.4, AC-17.7 | Rimeet Mavani | open |
| R44 | The fast lane, with an in-flight cap per organization (S21) — WC-7 | background | R42 | `/be-build-requirement` | AC-17.5, AC-17.6, AC-17.14, AC-17.15, AC-16.18 | Rimeet Mavani | open |
| R45 | The broadcast lane — WC-8 | background | R23, R42 | `/be-build-requirement` | AC-9.10 | Rimeet Mavani | open |
| R46 | Tasks, split Meta-calling and database-heavy, capped per organization (S19): attachment upload, bulk contact changes, segment count, broadcast audience, failed-message retry — § 3.A CTC7, § 7.B BCC8, § 7.C BCC9, § 6.B SNC14, § 6.C SNC15; WC-32, WC-36, WC-39, WC-40, WC-42 | background | R20, R23, R12, R37 | `/be-build-requirement` | AC-5.6, AC-7.3, AC-9.3, AC-9.5, AC-15.4 | Rimeet Mavani | open |
| R47 | Repair duties, one scheduled job each (P94): lost turns, stuck sends, the 7-day expiry, closed windows, too many waiting replies, cancel-on-pause, send counts, tag events not started, broadcast start and end, the waiting-run cancel, open-run keys — § 6 SNC5, § 7.A BCC7, § 4.B AUC11, AUC15; WC-13–WC-15, WC-17–WC-20, WC-27–WC-29, WC-45, WC-67 | background | R42, R22 | `/be-build-requirement` | AC-17.13, AC-17.18, AC-17.19, AC-18.11, AC-6.15, AC-9.6, AC-9.7 | Rimeet Mavani | open |
| R48 | Watches: a Live still on, the rebuild after Redis was lost, outage and app limit, the server clock, the waiting estimate, the minimum compatible settings version (P95) — § 6 SNC5, SNC9; WC-16, WC-21–WC-24 | background | R42 | `/be-build-requirement` | AC-16.18, AC-17.11, AC-17.22–AC-17.24 | Rimeet Mavani | open |
| R49 | Partition upkeep and part drops — parts at least 14 days ahead, a default part with an alert (S17); webhook events and keys 8 days, attempts 8 days, messages 30 days, runs, run events and comment logs 90 days — § 5.B WHC13, WHC15, § 4.B AUC14, § 6.B SNC13; WC-48–WC-52, WC-55 | background | R14, R16, R19 | `/be-build-requirement` | AC-18.1–AC-18.3, AC-18.5, AC-18.6, AC-18.10; decision item P96 | Rimeet Mavani | open |
| R50 | Hourly clean-ups within a time budget, with the oldest-row gauge: deleted automations, recipients and stop history, tag events and month counts, deleted broadcasts and segments, sessions and trusted devices — § 7 BCC3, § 7.C BCC9; WC-47, WC-53, WC-54, WC-62, WC-64 | background | R23, R32, R49 | `/be-build-requirement` | AC-18.4, AC-18.7–AC-18.9, AC-9.13 | Rimeet Mavani | open |
| R51 | The connection's daily token check (re-encrypts an old-key token, S26) and the reconnect notice per account and break — § 1 MCC6; WC-34, WC-35 removed, WC-46 | background | R3, R18, R36 | `/be-build-requirement` | AC-1.14, AC-10.7 | Rimeet Mavani | open |
| R52 | Plan state: the 15-minute check (grace end, trial notices, switched-off plans), the month and upgrade wake, the period-end plan change, seat sync off — § 8.B BLC10, BLC13; WC-37, WC-38, WC-59, WC-65 | background | R24, R26, R42 | `/be-build-requirement` | AC-11.3, AC-11.6, AC-11.8–AC-11.10, AC-11.12, AC-10.9, AC-9.11, AC-8.7 | Rimeet Mavani | open |
| R53 | Notices and emails: the month 80 % and 100 % notices, owner problem emails, the weekly summary, the grouped "new contact details" note, the "past comments done" notice — § 11.D (UNC9, UNC10); WC-56–WC-58, WC-63 | background | R36, R42 | `/be-build-requirement` | AC-10.3–AC-10.6, AC-10.8, AC-14.8, AC-14.9, AC-8.8 | Rimeet Mavani | open |
| R54 | Flow — a comment becomes a DM: intake, the match, the opening DM by lane, public reply and hide, the replacement rule | flow | R38, R43, R44 | `/be-build-requirement` | AC-19.* | Rimeet Mavani | open |
| R55 | Flow — every other way to start: DMs, taps, story replies, mentions, refs, Live comments, tags | flow | R38, R40, R44 | `/be-build-requirement` | AC-20.* | Rimeet Mavani | open |
| R56 | Flow — a broadcast from draft to done | flow | R45, R46, R47 | `/be-build-requirement` | AC-21.* | Rimeet Mavani | open |
| R57 | Flow — the month limit: 80 %, 100 %, the new month | flow | R52, R53 | `/be-build-requirement` | AC-22.* | Rimeet Mavani | open |
| R58 | Flow — a move down at the period end | flow | R25, R52 | `/be-build-requirement` | AC-23.* | Rimeet Mavani | open |
| R59 | Flow — a trial from start to its end | flow | R52, R58 | `/be-build-requirement` | AC-24.* | Rimeet Mavani | open |
| R60 | Flow — a token error, the reconnect, the lanes waking | flow | R51, R42 | `/be-build-requirement` | AC-25.* | Rimeet Mavani | open |
| R61 | Flow — Meta's data deletion and a contact erase | flow | R9, R46, R50 | `/be-build-requirement` | AC-26.* | Rimeet Mavani | open |
| R62 | Flow — recovery after an outage: Meta down, Redis lost, a restore that must not send | flow | R39, R47, R48, R49 | `/be-build-requirement` | AC-27.* | Rimeet Mavani | open |
| R63 | Close — `plans/acceptance.md` filled, the gates green, the frontend route map, `AS-BUILT.md` summary and Standing deviations | flow | R1–R62 | be-kickoff-iteration › Close | every AC, BRIEF-1–BRIEF-10, every decision item | Rimeet Mavani | open |

## 6. Requirements index

Each identifier is defined in its file under [plans/requirements/](plans/requirements/).

- [data.md](plans/requirements/data.md) (40): `data.app-migrations-in-place`, `data.merged-domains-forward-only`, `data.channel-common-core`, `data.shared-product-tables`, `data.organization-ownership`, `data.organization-naming`, `data.split-tables`, `data.channel-connection`, `data.channel-connection-token-refresh`, `data.channel-account`, `data.instagram-account-extension`, `data.instagram-account-settings`, `data.instagram-account-token`, `data.instagram-media`, `data.connection-states`, `data.contact`, `data.contact-tag-event`, `data.automation`, `data.automation-counters`, `data.automation-backfill`, `data.automation-run`, `data.automation-run-open-key`, `data.automation-comment-log`, `data.run-states`, `data.instagram-webhook-event`, `data.instagram-webhook-event-key`, `data.broadcast-segment`, `data.broadcast-states`, `data.instagram-sending`, `data.message-states`, `data.lane-states`, `data.message-month-count`, `data.sending-state`, `data.plan-subscription`, `data.platform-columns`, `data.trusted-device`, `data.trial-account`, `data.reference-data`, `data.kickoff-defaults`, `data.erasure`
- [access.md](plans/requirements/access.md) (8): `access.channel-account-codes`, `access.contact-update-code`, `access.editor-viewer-roles`, `access.row-security`, `access.global-sending-tables`, `access.trusted-device`, `access.sign-in-v8`, `access.session-place`
- [operations.md](plans/requirements/operations.md) (96): `operations.channel-account-connect-multi`, `operations.channel-connection-list`, `operations.channel-connection-ad-picker`, `operations.channel-account`, `operations.channel-account-choose-active`, `operations.feature-check`, `operations.channel-capability-list`, `operations.instagram-account-settings-v8`, `operations.instagram-media-pickers`, `operations.instagram-webhook-events-list`, `operations.instagram-send-limits`, `operations.instagram-timing-boxes`, `operations.instagram-extra-delay`, `operations.instagram-mark-seen`, `operations.instagram-dm-counting`, `operations.instagram-message-expiry`, `operations.instagram-pending-estimate`, `operations.instagram-starter-questions-sync`, `operations.instagram-account-banners`, `operations.instagram-message-retry-failed`, `operations.organization-usage-meter`, `operations.organization-notices`, `operations.shared-product-routes`, `operations.contact-list`, `operations.contact-detail`, `operations.contact-note`, `operations.contact-tags`, `operations.contact-tag-events`, `operations.contact-bulk-actions`, `operations.contact-pause-automations`, `operations.contact-stop-words`, `operations.contact-email-phone-answers`, `operations.contact-timeline`, `operations.contact-delete`, `operations.automation-create-draft`, `operations.automation-status-draft-live-paused`, `operations.automation-go-live-check`, `operations.automation-duplicate`, `operations.automation-delete`, `operations.automation-trigger-types`, `operations.automation-targeting`, `operations.automation-next-post`, `operations.automation-keyword-typo-match`, `operations.automation-try-it`, `operations.automation-ref-link`, `operations.automation-also-start-from`, `operations.automation-step-order`, `operations.automation-step-hello`, `operations.automation-nudge`, `operations.automation-step-follow`, `operations.automation-step-email-ask`, `operations.automation-step-phone-ask`, `operations.automation-step-messages`, `operations.automation-message-attachments`, `operations.automation-step-tags`, `operations.automation-step-public-reply`, `operations.automation-public-reply-per-automation`, `operations.automation-reply-like-person-default`, `operations.automation-public-reply-mention`, `operations.automation-hide-comment`, `operations.automation-comment-match`, `operations.automation-comment-replies`, `operations.automation-comment-flow`, `operations.automation-live-ended`, `operations.automation-ad-comment`, `operations.automation-message-match-order`, `operations.automation-message-start-flow`, `operations.automation-answer-table`, `operations.automation-window-rule`, `operations.automation-window-table`, `operations.automation-once-key`, `operations.automation-once-rule`, `operations.automation-every-time-mode`, `operations.automation-unknown-outcome`, `operations.automation-follow-check`, `operations.automation-list-counters`, `operations.automation-past-comments`, `operations.broadcast`, `operations.segment`, `billing.flowdm-plans`, `billing.plan-feature-switches`, `billing.plan-pro-features`, `billing.plan-channel-accounts-max`, `billing.plan-message-month-limit`, `billing.plan-states`, `billing.plan-downgrade`, `billing.paid-trial`, `billing.payment-methods`, `billing.retired-plans`, `tenancy.organization-logo-color`, `operations.organization-slug-read-only`, `operations.member-invitations`, `operations.user-profile-onboarding`, `operations.organization-chooser`, `operations.email-confirmation`, `operations.after-launch`
- [background.md](plans/requirements/background.md) (86): `background.instagram-owned-work`, `background.channel-send-interface`, `background.never-waits`, `background.never-send-twice`, `background.retry-policy`, `background.per-account-order`, `background.account-stops`, `background.times`, `background.scale-defaults`, `background.intake`, `background.sending-lanes`, `background.opening-turn`, `background.reply-turn`, `background.fast-messages`, `background.send-gates`, `background.instagram-error-stops`, `background.meta-usage-per-connection`, `background.missed-comment-check`, `background.attachment-upload`, `background.account-setup`, `background.token-check`, `background.helper-one-run-per-duty`, `background.helper-never-sends`, `background.helper-cross-organization-reads`, `background.helper-per-server-duties`, `background.helper-open-run-key-repair`, `background.retention-hourly-budget`, `background.retention-drop-parts`, `background.retention-oldest-row-gauge`, `background.partition-upkeep`, `background.chat-event-intake`, `background.comment-intake`, `background.live-comment-intake`, `background.tag-event-intake`, `background.slow-lane-send`, `background.reply-lane-send`, `background.fast-message-send`, `background.broadcast-lane-send`, `background.stuck-event-pickup`, `background.lost-turn-repair`, `background.stuck-send-settle`, `background.message-expiry`, `background.live-check`, `background.window-closed-skip`, `background.reply-backlog-trim`, `background.paused-automation-cancel`, `background.send-count-upkeep`, `background.send-count-rebuild`, `background.outage-check`, `background.clock-check`, `background.waiting-estimate`, `background.webhook-subscription-check`, `background.tag-event-pickup`, `background.scheduled-broadcast-start`, `background.broadcast-end`, `background.starter-question-sync`, `background.bulk-tag`, `background.month-wake`, `background.plan-change`, `background.segment-count`, `background.broadcast-audience`, `background.past-comments`, `background.retry-failed`, `background.next-post-linking`, `background.waiting-run-cancel`, `background.reconnect-notice`, `background.deleted-automation-purge`, `background.webhook-event-retention`, `background.send-attempt-retention`, `background.message-retention`, `background.run-retention`, `background.comment-log-retention`, `background.broadcast-recipient-retention`, `background.small-table-retention`, `background.month-limit-notice`, `background.owner-problem-email`, `background.weekly-summary`, `background.plan-state-check`, `background.broadcast-segment-purge`, `background.contact-details-notice`, `background.session-cleanup`, `background.seat-sync`, `background.open-run-key-repair`, `background.message-sends`, `background.daily-account-check`, `background.next-post-expiry`
- [notifications.md](plans/requirements/notifications.md) (13): `notifications.kinds-v8`, `notifications.owner-email-defaults`, `notifications.check-before-send`, `notifications.recipients-by-code`, `notifications.reconnect-required`, `notifications.owner-emails`, `notifications.month-limit`, `notifications.automation-stopped`, `notifications.contact-details-left`, `notifications.weekly-summary`, `notifications.done-notes`, `notifications.trial-and-plan-choice`, `notifications.team-changes`
- [realtime.md](plans/requirements/realtime.md): n/a — no live screen updates; every screen shows new data when read again
- [integrations.md](plans/requirements/integrations.md) (11): `integrations.meta-graph-client`, `integrations.channel-connection-unified-login`, `integrations.channel-connection-meta-callbacks`, `integrations.instagram-webhook-fields`, `integrations.instagram-webhook-save`, `integrations.instagram-messaging`, `integrations.instagram-login`, `integrations.send-pause`, `integrations.stripe-subscription-schedule`, `integrations.apple-sign-in`, `integrations.session-place-data`
- [files.md](plans/requirements/files.md) (3): `files.message-file-upload`, `files.message-file-scan`, `files.message-file-reference`
- [quality.md](plans/requirements/quality.md) (23): `quality.retention`, `quality.message-privacy`, `quality.token-secrecy`, `quality.audit`, `quality.idempotency`, `quality.error-reasons`, `quality.method-status-exception`, `quality.rate-limit`, `quality.read-only-plan`, `quality.no-plan-limits`, `quality.reply-safety`, `quality.restore-never-sends`, `quality.sending-settings`, `quality.rolling-deploy`, `quality.lock-order`, `quality.redis-notes`, `quality.sending-health`, `quality.capacity`, `quality.connection-budget`, `quality.worker-places`, `quality.database-links`, `quality.scale-defaults`, `quality.gates`

280 identifiers, listed from the files as they stand on 2026-11-24.

## 7. Open AMBER items

Safe defaults taken and still open — any can change before or during kickoff (a new decision row).

| # | Default |
| --- | --- |
| P1 | Nested account routes for many accounts; the singular account routes removed (paths since P47: `{channel_account_id}`). |
| P2 | The go-live list of plan §5.1, plus: a hello always has a "next step" button when later steps exist. |
| P3 | The month limit stops the slow, fast and broadcast lanes (plan D62). |
| P4 | One app settings file; environment-varying values only as env flags with production-safe defaults; the settings version gate kept. |
| P5 | Short Redis copies follow be-read-cache-guard (scoped keys, tombstone after commit, ≤ 60 s). |
| P6 | Plan identifiers renamed to full names. |
| P7 | The existing scheduler, one repeat job per rule group, plus a 10-second Redis-down check (refined by P73, P94). |
| P8 | Go-live, pause, duplicate and the keyword test are action routes; the edit saves content only. |
| P9 | Segments and broadcasts soft-deleted, then purged. |
| P10 | Read-only plan: the owner may pause, delete, disconnect; only go-live and turning a PRO part on are refused. |
| P11 | The automation delete reason is optional; `other` needs a note. |
| P12 | "My next post" never expires; the 15-minute expiry removed. |
| P13 | Message rows dropped by the run's start week; "What happened" and the retry read about the last 30 days. |
| P14 | The organization's message meter is a new app route. |
| P15 | The undo toast replays on the client; no route. |
| P16 | The global sending state is a documented row-security exemption, maintenance login only. |
| P17 | The daily profile refresh rides inside the token check. |
| P18 | The team "suspend account" column now, its platform-admin route later. |
| P19 | Plus addresses accepted in email answers; the question asked again up to 3 times with its wordings. |
| P20 | Broadcasts, segments and past comments reuse the automation codes; `contact:update` for note, tags and pause. |
| P21 | Yes / no fields take the `is_` form; the launch's public-reply switch keeps its name. |
| P22 | Public-id prefixes of new tables chosen at kickoff, recorded in `AS-BUILT.md`. |
| P23 | The launch's two comment-log ignored reasons are kept. |
| P24 | `own_comment` for our own comments; `echo` stays for DM echoes. |
| P25 | Attachments keep the upload's public id only, read through the upload service. |
| P26 | The Meta connect state is a one-use Redis value (10 minutes). |
| P27 | Dismissing a notice is remembered by the browser. |
| P47 | The derived names of the channel split (plan features, route bases, the token check as the connection's work); the webhook review's F3 (intake never paused by a provider outage) and F5 (one lock order, raced in a test). |
| P52 | A connection's other assets are listed with their first feature. |
| P79 | The plan feature key `message_month_limit`. |
| P97 | The scale review's kickoff defaults, each built as its Fix column says ([reviews/scale-review-2026-11-24.md](plans/reviews/scale-review-2026-11-24.md)): **S2** Neon pooler limits written and measured · **S5** fast-changing contact fields in a narrow 1:1 table · **S6** search ≥ 3 characters, led by the account · **S7** a tag-count table kept in the tag commit · **S8** a per-account day counter for the sending status · **S9** signed webhook requests outside the per-IP cap · **S10** the webhook's own pool slice or service · **S11** the new-contact profile read as a low-priority task, several comment-intake jobs per account · **S13** Meta usage per (connection, asset, type), the app-level usage once · **S14** the Meta circuit as a backstop per call class · **S17** parts ≥ 14 days ahead, short lock timeouts, a default part with an alert · **S18** the job Redis required when sending is on · **S19** tasks split and capped per organization · **S20** one tag-intake job per 500 contacts · **S21** an in-flight cap per organization on the fast lane · **S25** no `queued` update after the store · **S26** the token check re-encrypts old-key tokens · **S29** the estimate stored by its 10-minute job. |
| P98 | After launch, operations: backpressure on a slow Postgres and the poison-ticket rule (S22); rate-based alerts and per-tenant views without metric labels (S23); WAL and storage measured in month 1 (S24); Meta usage logged per call class to set the thresholds (S27); RPO / RTO written and the restore rehearsed once (S28). |
| P99 | The alignment check settled: names follow `routes-final.md`, design follows the decisions (the plan stop on the channel account, `broadcasts.channel`, the retired-plan notice inside the plan-state check, routes 141–150 numbered). |

Smaller items still open: the launch's "start the automations queued behind an email" kept unchanged until a row says
otherwise ([worker-changes.md › Notes](plans/worker-changes.md), note 1); the timing details marked open in
[worker-changes.md](plans/worker-changes.md).

## 8. Standing deviations

This iteration has no Baseline, but it changes the launch's code in place ([P29](plans/decisions.md)), so the launch's
Standing deviations ([`../launch-2026-11-20-ujai/AS-BUILT.md`](../launch-2026-11-20-ujai/AS-BUILT.md) › Standing
deviations) are planned against. Every row below is since `launch-2026-11-20-ujai`; "launch D<n>" is
[the launch's decision](../launch-2026-11-20-ujai/plans/decisions.md), a bare `D<n>` is the plan's (§2), `P<n>` is this
plan's. Launch deviations not listed are untouched and kept.

| Item | Design says | Built as (launch) | Launch decision | This iteration | Decision |
| --- | --- | --- | --- | --- | --- |
| Accounts per organization | One in any status | One not-revoked; reconnect reuses row and settings | launch D5, D24 | **Resolved** — 1, 3 or 10 by plan, checked under a lock; one organization per account stays | D26, P42, P60 |
| Instagram Login and its token | — | Instagram Login; token per account renewed daily; `access_expires_at` on the account | launch D24, D35 | **Resolved** — Unified Login only, one never-expiring system-user token per connection; Instagram Login removed | D24, P41, P49 |
| Connect refusals, spent code, settings not set | `409` / `503` | `422` refusals, `409 instagram_connect_restart_required`, `503 …_not_configured` | launch D24, D56 | **Resolved** — replaced by the Unified Login callback and pick refusals; Meta settings read through the connection | P41, P58 |
| API paths and folders | `/app/…` | `/api/v1/app/…`, `social/instagram` | launch D1, D20 | **Kept and extended** — common connection and account bases, shared product at the top, Instagram under `social/instagram` | P47, P48 |
| Permission codes | `instagram_account:*`, `webhook:read` | `instagram-account:*`, `instagram-webhook-event:read` | launch D4, D20 | **Kept**, plus `channel-account:*` on the shared routes and `contact:update` | P20, P59 |
| Member role | A Member column | A locked Member role on every team | launch D2, D3, D31 | **Resolved** — four fixed roles: Member becomes Editor, Viewer added, custom roles off | D55, P83 |
| Read-only plan | No rule | Automation create, edit, delete refused | launch D26, D27 | **Changed** — the owner may pause, delete, disconnect; go-live and turning a PRO part on are refused | P10 |
| Read the account, change its settings, disconnect | No routes | Singular `…/account` routes; disconnect revokes, keeps runs and live automations | launch D5, D24 | **Changed** — per-account routes, a business disconnect too; a disconnect also stops the account's lanes | P1, P47 |
| Deleting the team | Rows cascade | One account unsubscribed, token and profile erased | launch D54 | **Kept** — over every account of the organization | IAC5 |
| Meta's deauthorize and data-deletion | None | On the Instagram account | launch D22, D24 | **Changed** — with the connection, matched by account then business | P46, P56 |
| Daily account check | Token renewed | Daily renewal, profile refresh, subscription retry | launch D9 | **Resolved** — the connection's token check (no renewal), profile refresh inside it; subscription checked every 10 minutes | P17, P47 |
| Reconnect notice | None | In-app and email once per break | launch D10 | **Kept** — per account and break; a broken connection tells every account | P41 |
| Instagram auth errors | Code 190 | 190 / 463 `expired`, permission codes count | launch D24, D32 | **Changed** — one error-group table; a token error stops every account of the connection | D19 |
| Token isolation | Not readable by the app session | Encrypted row, one reader | launch D21, D24 | **Kept** — on the connection's token | P49 |
| Contacts per account | Per workspace | Per Instagram account | launch D25 | **Kept** — per channel account, lists must name it | P48, P65 |
| Delete one contact | No route | Data wiped, row kept, runs cancelled; events stay 30 days | launch D22, D23, D25 | **Kept** — also her waiting messages, tag events and recipients; events stay 8 days | D15, P48 |
| Email and phone checks | Email checked | Gmail plus addresses refused | launch D25 | **Resolved** — plus addresses accepted, asked again up to 3 times | P19 |
| Automations per account | Per workspace | Tied to the account at create | launch D26 | **Kept** — per channel account; the way to start required at create | P48, P70 |
| Automation delete | Optional reason | Reason required; purged after 180 days | launch D26 | **Resolved** — reason optional (`other` needs a note); purged hourly once its runs are gone | P11, P92 |
| Opening button, final message, other checks | Nullable fields | Required button and final message | launch D19, D26 | **Replaced** — the new shape: hello with buttons, a 1–10 message list, the go-live check | D28–D30, P2 |
| Next-post linking and expiry | — | Window linking; a 15-minute expiry | launch D9, D26 | **Resolved** — links the first post after go-live, never expires | P12 |
| How many automations answer a comment | Every match | One — post-linked first, oldest; others `ignored` | launch D26 | **Kept** — the match order of the 15 ways to start | D37 |
| Trigger after an earlier run (once rule) | Ask again / continue / start anew | No second run | launch D14 | **Resolved** — a once key per way to start; a new comment replaces her open run; one open run held by a key | D13, D65, P35, P100 |
| DM triggers and empty keywords | DM automations only | Any live automation with the switch | launch D14 | **Resolved** — 15 ways to start with one match order | D37 |
| 24-hour opening rule | Skip after a chat | Skip after our DM in 24 h | launch D14, D28 | **Resolved** — window closed: one private reply per 24 h; open: a normal DM at once | D8 |
| Opening message and DM channel | A private reply | Private reply only after 24 h without contact | launch D26 | **Resolved** — the slow lane for private replies, the fast lane when her window is open | D4, D8 |
| Email answers | Ask again | One wrong-email message | launch D18, D26 | **Changed** — up to 10 wordings, never the last one, asked again up to 3 times | D31, P19 |
| Queued automations | All saved | One entry each, at most 100 | launch D26, D48 | **Kept** until a row says otherwise (worker-changes note 1) | — |
| Wait limit and run retention | Runs stay | 7-day wait; runs kept 180 days | launch D8 | **Changed** — 7-day wait kept; runs, run events, comment logs 90 days | D16 |
| Clean-ups by batch delete (no partitioning) | — | Daily batch deletes | launch D8 | **Resolved** — high-volume tables split by time and dropped by part; the rest hourly within a budget | P92, P96 |
| Reply safety order, counts and memory | Random, gap, hour limit | Counted from comment logs | launch D17, D26 | **Replaced** — the reply lane, "Reply like a person", reply states | D32, D59 |
| Token error on the public reply | Never stops the flow | Ends the run `failed` | launch D26 | **Changed** — stops every account of the connection, reconnect notice | D19 |
| Store before answering | `200` at once | Stored first; a store failure answers `500` / `503` | launch D15, D28 | **Kept** — no Redis buffer; a slow store answers a failure | P32 |
| Webhook rate limit | None | 1,200 a minute per IP | launch D21, D28 | **Changed** — signed requests not counted | P97 (S9) |
| Webhook proof failures | `403` | `400` in the API shape | launch D28 | **Kept** | — |
| Event of an unknown or revoked account | Stored as `unknown_account` | Not stored | launch D28 | **Kept** | — |
| Event keys | Comments, messages, postbacks | Every kind, unique per account | launch D15, D28 | **Changed** — their own table split by Meta's event day, kept 8 days | P96 |
| Skip reasons | `unknown_account` | `unsupported`, `echo` for own comments | launch D18, D19, D28 | **Changed** — `own_comment` for comments, `flood` added | P24, P63 |
| Webhook events kept | 30 days | 30 days, batch delete | launch D8, D28 | **Resolved** — 8 days, body cleared when done | D15 |
| Queues, workers and order | A queue per account | One queue, one in-order job per account | launch D15, D21 | **Resolved** — Instagram's queues, several comment-intake jobs per account, one lock order, a database limiter | D3, P45, P91, P97 (S11) |
| Retries | 3 tries | 5 tries, then `failed` | launch D16, D47, D51 | **Changed** — a failed event retried hourly until its comment is 7 days old | WC-12 |
| Sending again on a retry | May go twice | Claimed; an unknown outcome fails the step | launch D16, D26, D55 | **Changed** — `unknown` is never resent; her next message may send that step once more | D17 |
| Legacy settings | Legacy names | One app secret, fixed pause, one concurrency | launch D20, D21 | **Resolved** — paced lanes, own concurrency settings, the sending switch and environment id | D20, P91 |
| Personal data in logs | Previewed | Never logged | launch D21, D38, D40 | **Kept** — the contact note added | — |
| Reading runs and comment logs | Public ids | No route | launch D13 | **Changed** — a contact's "What happened" shows her runs | D46 |
| Live updates, plan limits, export, restore | — | None | launch D11, D12, D25, D26 | **Changed** — plan limits added; live updates, export and restore still none | D26, D34, P83 |
| `instagram_accounts`, `instagram_account_tokens` columns | Drop's columns | Launch columns, token table per account | launch D24, D52 | **Resolved** — the account becomes the Instagram extension; the token table removed | P41, P42 |
| Run, contact and automation columns | Drop's columns | Launch columns, the send claim on the run | launch D25, D26 | **Changed** — the claim moves to the message row; shared tables keyed by the channel account | P48 |

## 9. Definition of done

- Every ROUTE row `done`, or `deferred` with your OK.
- [plans/acceptance.md](plans/acceptance.md) filled — every `AC-*`, `BRIEF-*` and decision item with its Result and
  Evidence.
- `AS-BUILT.md` written: one row per ROUTE row, the closing summary, and the Standing deviations — the launch's list
  minus what this iteration resolved (section 8), plus its new ones (the D58 file scan, [P34](plans/decisions.md), among
  them); every difference synced back into the three change files.
- The frontend's route map `plans/frontend-route-map.md` written (sections 1, 2 and 4 by hand, section 3 by
  `pnpm iteration:frontend-map feat-instagram-dm-sending-2026-11-23-oxak`).
- The repository's gates green: `pnpm validate`, `pnpm ci:local` (the build and the full test suite), `pnpm tsdoc:check`,
  `pnpm routes:catalog:check`, `pnpm docs:check`.

## 10. Verification

- **Gates** — `pnpm iteration:intake feat-instagram-dm-sending-2026-11-23-oxak --check`, `pnpm validate`, `pnpm ci:local`,
  `pnpm test:rls-role` (every new and changed table read and written as the row-level-security role),
  `pnpm routes:catalog:check`, `pnpm iteration:frontend-map feat-instagram-dm-sending-2026-11-23-oxak --check`.
- **Acceptance (Intake mode `brief`)** — the `BRIEF.md` acceptance criteria, `BRIEF-1`–`BRIEF-10` in
  [plans/acceptance.md](plans/acceptance.md), each proven through the feature criteria it names; plus the plan's own
  acceptance in the same file — `AC-1.*`–`AC-27.*` and the decisions that must be proven (D17, D20, D57, D62, P35,
  P91, P96, P100) — each with a test or command as evidence.
- **Changed launch behaviour** — the launch's end-to-end and integration tests for every sub-domain this iteration
  changes in place (connection, contacts, automations, runs, webhook) run green against the new behaviour.
- **Review** — `/be-pre-merge-review` at Close (review only).
