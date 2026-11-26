`src/domains/app/sub-domains/instagram-sending/`

# Instagram sending

Parent: [App](../../app.overview.md)

## Purpose

The paced sender of Instagram messages (routes-final § 6 of `iterations/feat-instagram-dm-sending-2026-11-23-oxak/`,
SN1–SN24). Intake saves `waiting` messages; this sub-domain sends them through four lanes per account (slow, reply,
fast, broadcast), two gates and the month count in the claim's commit, one shared result save, the Instagram error
groups and stops, and repair duties that never send. ROUTE row R18 built the **folder root** (§ 6.A): the lane, stop,
minute, month and day count tables, the global sending row, routes 63–64, the sending switch and environment id, the
month meter's Redis copy and the lane steps of the connection, the channel account and route 12. ROUTE row R19 built
the nested [Instagram messages](instagram-message/instagram-message.overview.md) (6.B — the messages and attempts,
Instagram's `ChannelSendingPort`, the claim, the one result save, the failed-message summary and retry). ROUTE row
R20 built the nested [Instagram attachments](instagram-attachment/instagram-attachment.overview.md) (6.C — one Meta
upload per account and file) and `InstagramSendAccessService`, the one read before every Meta call (the pace from the
connection's usage, SN23). ROUTE row R42 built the **send core** (below), R43 the slow and reply lanes' rules, R44 the fast lane's, R45 the broadcast lane's; the repair duties are R47's (below, the **repair duties**) and the watches R48's (below), all on the repair queue `instagram-sending-repair`. ROUTE
row R37 built the **queues, their workers and the database limiter** (SN2, SN24, P91) — the workers hand each ticket
to work the later rows build. No table here has a public id; route 63 takes the account's `cha_` id.

## Routes (under `/api/v1/app`)

| # | Method | Path | Gate | Idem |
| --- | --- | --- | --- | --- |
| 63 | GET | `/social/instagram/accounts/{channel_account_id}/sending-status` | `instagram-account:read` | — |
| 64 | GET | `/usage` | `organization:read` | — |

Team organizations only: a personal one reads `404 team_organization_required`. Route 63 answers `404
instagram_not_connected` for another organization's, a revoked or a non-Instagram account.

## Layout

- **Repair duties (R47, SN6, P94)** — `instagram-sending-repair.service.ts` (`InstagramSendingRepairService`: WC-13 lost
  turns, WC-14 stuck sends, WC-15 the 7-day expiry, WC-17 closed windows, WC-18 the reply trim, WC-19 the paused cancel,
  WC-20 the send counts) over `instagram-sending-repair.repository.ts` (the cross-organization reads under the
  `app.global_retention_cleanup` arm, each organization's writes in its job scope); `workers/instagram-send-repair-duties.processor.ts`
  routes the eleven every-minute jobs on the repair queue `instagram-sending-repair` (these seven, 7's broadcast start
  and end, 3.B's tag-event pick-up and 4.B's open-run key repair — handed over by `runInstagramSendingRepairDuty`) through
  `runRepairDutyRound` (`src/infrastructure/queue/worker-runtime/repair-duty.util.ts`: the `mayTakeTickets` gate, the 40 s
  budget, pieces of 500, `repair_duty_round_seconds` / `repair_duty_backlog`). Lost tickets are re-added in one `addBulk`
  per piece by `addMissingInstagramSendLaneTurns` / `addMissingInstagramSendFastMessages` (a ticket still on its way is
  only counted). Waiting messages end through `InstagramMessageService.settleWaitingMessages` (the result save's
  bookkeeping, the engine told); a stuck send through `saveSendResult`.

- `instagram-sending.constants.ts` — the **sending settings file** (P4): the settings-file limits an empty owner value
  falls back to (route 12 and the lanes read one source), `STOP_WORDS`, the untested Meta features, ways to start and
  message kinds (P36), the lanes, wait reasons and stop groups with their strength, the count groups, the plan stops'
  held lanes (`plan_limit` lets the reply lane go on, D62), `SENDING_SETTINGS_VERSION` and
  `SENDING_MINIMUM_COMPATIBLE_SETTINGS_VERSION` (P95).
- `instagram-send-lane.schema.ts` / `.repository.ts` / `.service.ts` / `.util.ts` — `app.instagram_send_lanes`: four
  rows per account made at the pick; the turn, lease, box, the slow lane's day count and test claim and stored
  estimate (S29), the fast lane's `sending_count`, and the lane's **error stop** only. Guarded updates: a stronger stop
  wins; a turn is claimed only while the lane is not `working` and the ticket's turn is the lane's (never two turns);
  a release only by its own turn. `InstagramSendLaneService` is the lane port of the connection (create, end login
  stops, stop), the channel account (stop, wake, active stop, the break's stop) and route 12 (wake).
- `instagram-send-stop.schema.ts` / `.repository.ts` — `app.instagram_send_stops`: every stop that starts (lane or
  `all`; a stop group or a plan stop), its end and by what. 90 days (WC-53).
- `instagram-send-minute-count.schema.ts` / `.repository.ts` — gate 2's minute counts per account and group.
- `message-month-count.schema.ts` / `.repository.ts` / `.service.ts` / `.cache.ts` — `app.message_month_counts`
  (shared, P43): per organization, month of its time zone and 16 slots. The service is the channel account's plan-stop
  port (`plan_limit`), the month add (tombstones the copy after commit) and route 64's read through the 10-second
  Redis copy `app:message_month_count:<organization>`.
  The month is a hard cap (owner 2026-11-26, P368/P369): the claim's `guardMonth` takes the organization's
  `pg_advisory_xact_lock` (`MESSAGE_MONTH_LIMIT`) and every send lane row only when the month is within the
  organization's send lanes of the limit (lock-free otherwise); a far claim that finds the month near answers `month_busy`.
- `message-month-notice.service.ts` — the month at 80 % and 100 % (WC-56, R53): one `billing.usage_threshold`
  notice and email per organization, month and line (`month-limit:<month>:<line>`), told after the claim that crossed
  a line; `workers/message-month-notice-check.*` is its every-minute backup check on the intake queue.
- `workers/instagram-owner-problem-email.*` — the owners' problem emails (WC-57, R53): every minute on the intake
  queue, the stops that came due (a block, a connection, message access, plan ended or switched off at once; any
  other stop after an hour) told once per account and kind in 6 hours (`automation.stopped`, `data.problem`), and
  one team email grouping them by kind.
- `instagram-send-day-count.schema.ts` / `.repository.ts` — one account's results of its organization's day (S8):
  route 63's "today" line.
- `sending-state.schema.ts` / `.repository.ts` / `.service.ts` — `app.sending_states`, the one tenantless row (P16):
  the environment id, the settings versions, the all-accounts stop and Meta's app-level usage (S13). Readable and
  writable only under `MAINTENANCE_SCOPE.SENDING_STATE`. `checkSending` / `mayTakeTickets` answer whether this server
  may send; `prepareDatabase` creates the row through `pnpm ops:sending-state`.
- `instagram-sending.{service,controller,routes,serializer,types}.ts` — routes 63–64. Route 63's later parts (waiting
  counts, chat-closed lines, last broadcast / past comments / retry) come through `InstagramSendingStatusSources`.
- `instagram-send-access.service.ts` — `InstagramSendAccessService` (SN22, SN23; R20): the account's send access (its
  keys, Instagram user id, the connection's usage key and business id, the encrypted token, whether a call may go),
  the pace before a Meta call from the connection's usage (`readConnectionUsage` over the account's and the
  business's entries — a business-wide 95 % holds every account of the connection, S13) and the connection's usage
  recorder for the call. The lanes keep no usage of their own.
- `instagram-attachment/` — the nested [Instagram attachments](instagram-attachment/instagram-attachment.overview.md).
- `queues/` — `instagram-send-slow` (one ticket per lane turn of `slow`, `reply`, `broadcast`; job id
  `<lane>-<cha_…>-<turn>`, a broadcast turn at priority 10) and `instagram-send-fast` (one ticket per fast message,
  `fast-<igm_…>-<tries>`), and `instagram-tasks` (the jobs around sending, each owner's job name — the account's set-up,
  subscription check and starter-question sync since R40, `../instagram-account/`; `enqueueInstagramTask` takes an
  optional delay for a retry or a spread), all family `instagram` — run in the existing `worker` service, no service of
  their own (P140). Ids only, one attempt per ticket, no rate limiter, never paused by the
  Instagram circuit.
- `workers/` — one plain worker per queue (`isEnabled: env.SENDING_ENABLED`) and `instagram-send-ticket.processor.ts`:
  every ticket asks `mayTakeTickets` first (a task only when it calls Meta) and goes back a minute later, no try used,
  when the server may not send; every unit of work runs in a slot of the process's **Instagram database limiter**
  (`WORKER_INSTAGRAM_DATABASE_SLOTS`, the budget counts it once per process); a ticket with no slot within 2 s goes
  back, no try used (AC-17.20). The work is `appDomain.instagramSendWork` (`InstagramLaneTurnWork`,
  `InstagramFastMessageWork`, `InstagramTaskHandler`s): the send core for the two send queues (R42), the task
  handlers from R40, R41, R46 — a ticket for missing work is logged and finished, no row touched.
- **The task split (S19, R46):** the Meta-calling tasks ride `instagram-tasks` (behind the sending gate,
  `WORKER_CONCURRENCY_INSTAGRAM_TASKS`, at most `INSTAGRAM_TASKS_PER_ORGANIZATION_MAX` of one organization per
  process); the database-heavy ones — `contact-bulk-action`, `segment-count`, `broadcast-audience`,
  `retry-failed` — ride `instagram-database-tasks` (`queues/instagram-database-tasks.queue.ts`, its job input may
  carry a list of ids or a filter; `WORKER_CONCURRENCY_INSTAGRAM_DATABASE_TASKS`, at most
  `INSTAGRAM_DATABASE_TASKS_PER_ORGANIZATION_MAX` per organization, on with sending off). A handler on the queue of
  the other kind is dead-lettered; an organization at its cap gets its ticket back 2 s later, no try used. The
  handlers are wired in `app.tasks.ts` (contacts and broadcasts are channel-neutral, so their processors live in
  their own `workers/` and are wrapped there); this folder's own are `workers/instagram-retry-failed.processor.ts`
  and `workers/instagram-attachment-upload.processor.ts`.
- `instagram-send-core.service.ts` — `InstagramSendCoreService` (R42, SNC3, SNC4, SNC7): the work behind the
  lane-turn and fast tickets — the turn's claim (or, with its stop over, a test turn under the account's one test
  claim), the account's holds and the all-accounts stop, the pace (95 % → no call, 80 % → boxes doubled), gate 1, the
  claim, the file, the Meta call outside any unit, the group, the one result save retried inside the send (a deadlock
  or lock timeout 3 times, a lost connection after 1, 2, 4, 8 s; then the message stays `sending` for the repair, D17),
  the stops (lanes by ladder, the connection's break on 190, the account's break, the app limit, "in a row" from the
  attempts — and an automation's 5 refused texts in a row, `bad_text`, stop it through `automationStopPort` and tell
  its owners, R54), the test's end and half speed, the next tickets. Each lane's own rules plug in through
  `InstagramSendLaneRules` (R43–R45; the fast lane's `checkFastMessage` before its claim, R44); a lane without rules
  sends nothing. A test that says nothing about the
  account (that person, that text) tests again up to 3 turns (`testMaxTurns`), then the stop waits its time again.
- `instagram-slow-lane.service.ts` — `InstagramSlowLaneRules` (R43, WC-5): opening DMs as private replies, one per
  box (3600 ÷ the opening hour limit — 600, ≤ 700, 150 for a new account's 7 days; doubled at half speed or Meta's
  80 %) at a random millisecond, at least 1.5 s apart (`box_start`, `last_sent_at`, `pick_count` written in the
  release); the pick mixes new (under 60 min, newest first) and old (oldest first) comments 4 : 1 (3 : 2 under 12 h
  left), checks each again (expired, erased, opted out, excluded → ended with the engine told; window open → moved to
  the fast lane with its ticket; an opening to her in the last 24 h → `not_before` + 24 h, D8).
- `instagram-reply-lane.service.ts` — `InstagramReplyLaneRules` (R43, WC-6): hides and "Reply like a person" OFF
  replies at once (a hide only after its reply ended), ON replies at their automation's hashed box second (10–100 an
  hour) and 20 s after the account's last ON reply; the line never the last one (only the first without PRO, D57),
  `@username` first; the reply state's box, line and waiting count. The 500 trim is the repair's (R47).
- `instagram-fast-lane.service.ts` — `InstagramFastLaneRules` (R44, WC-7): every message after the opening, one
  ticket `fast-<igm_…>-<tries>` per message at its `not_before` (the message service adds it after the save's commit:
  a random 500–2,000 ms, the PRO extra delay on her event's first answer cut at 25 s, at once after a follow check).
  Before the claim: gone / opted out / excluded → `skipped`; a Live private reply over 240 min → `expired` ·
  `live_ended`; a nudge she answered → `cancelled` · `answered`; her window closed (24 h − 15 min) → a comment's DM
  back to the slow lane, a Live comment's DM to a private reply, anything else `skipped` · `window_closed`. The
  claim takes her contact `NO KEY UPDATE SKIP LOCKED` and one of hers `sending` at a time (else back in 1 s), the
  account's 20 `sending` (`sending_count`, − 1 in the result save), 5 audio and the organization's 25 (S21; else back
  in 500 ms). The follow check reads `is_user_follow_business` (2 tries, the second after 2–5 s, then "following").
  Buttons carry `<aut_…>::<run_…>::<igm_…>`; `InstagramMessageService.markTappedMessageSent` proves an `unknown`
  message `sent` (the intake calls it, R38). "Seen" after a reply is not sent (P36 keeps `mark_seen` off, P412).
- `instagram-broadcast-lane.service.ts` — `InstagramBroadcastLaneRules` (R45, WC-8): broadcast messages (PRO) one per
  box of the broadcast hour limit (600, ≤ 2,000; 3600 ÷ limit, a random second, ≥ 1.5 s apart, ×2 at half speed or
  Meta's 80 %), her window closing soonest first across the account's broadcasts, at most 5 picks a turn. Checks
  again before each send: the broadcast no longer active → message `cancelled`, recipient `skipped`, both
  `broadcast_cancelled`; gone / opted out / excluded / window closed → `skipped`; message 1 within 24 h of her last
  broadcast → `recent_broadcast`; her hour full → `not_before` + 5 min. The claim takes her contact skip locked; gate 2
  counts the `broadcast` group, the month counts it as a DM (P3: the month's `plan_limit` holds this lane). The result
  save moves her `last_broadcast_at` (`sent` or `unknown`), the recipient and message N + 1. Too fast here stops only
  this lane for twice the time (Meta's too); the slow or fast lane's too fast holds it too. Buttons carry
  `<brc_…>::<igm_…>` (`broadcast-recipient-button-payload.util.ts`, read by intake R38).
- `instagram-send-compose.service.ts` — a run DM's Meta call composed at the last moment
  (`instagram-message/instagram-message-compose.util.ts`: the hello, follow ask, email / phone questions with their
  plain-text fallback and default texts, each list kind, `{name}`); `callWithCommentCheck` reads a maybe-gone comment
  once before `deleted_comment` (§33.7). The fast lane (R44) composes its DMs here too; `composeBroadcastMessage` the
  broadcast lane's (R45: the broadcast's message N as a list message, a normal DM to her id, no tag).
- `instagram-send-pace.util.ts` — the boxes, the mix, the reply box second and the line pick (pure).
- `instagram-send-gate.service.ts` — gate 1 (an advisory Redis sorted set per account and count group, 100 ms, skipped
  30 s after 3 timeouts) and the claim's **one commit**: the lane row locked, gate 2 over the 61 minute rows, her hour,
  the month's 16 slots against the plan's limit, the adds, `sending`, the attempt; the DM that fills the month starts
  `plan_limit` on every account of the organization (the reply lane goes on).
- `instagram-send-error.util.ts` — Meta's answer → its one group (the code table `INSTAGRAM_SEND_ERROR_CODE_GROUPS` in
  the settings file) → the message's outcome and the stop it starts.
- **The plan change and the month wake** (R52, WC-37, WC-38): `events/instagram-plan-change.event-handlers.ts` turns
  billing's `subscription.plan_state_changed` into one `plan-change` task on `instagram-database-tasks` (job id
  `plan-change-<org>-<change>-<key>` — the plan-state check's findings carry their key, so a repeat is dropped);
  `workers/instagram-plan-change.processor.ts` (also the `month-wake` job) puts the accounts' plan stops in line with
  the plan through `ChannelAccountService.applyOrganizationPlanStops` (over the limit → `plan_downgrade`, the kept and
  then the oldest stay; a move up lets `plan_downgrade` back; every account in the plan takes the organization's own
  stop — `plan_ended`, else `plan_limit`, else none), on a move down or a trial end cancels the scheduled and waiting
  broadcasts and fails the unfinished past-comment reads (`plan_feature_off`) when the new plan lacks the switch, tells
  the billing people once "Moved to Free: email and phone steps are off in N automations" when the new plan lacks
  either ask (`subscription.updated`, key `plan-moved-down:<plan>:<day>`; R58, AC-23.8), then
  wakes the accounts whose stop got weaker, spread over 5 minutes. `workers/instagram-sending-repair.*` — the repair
  queue `instagram-sending-repair` (SN6, one repeat job per duty; R47's eleven and R48's watches beside them): `repair-month-wake` every minute
  (organizations holding `plan_limit` since before their month turned, their time zone) and `repair-plan-stops` every
  15 minutes (organizations still holding `plan_ended`), each adding one task per organization. The queue runs
  `INSTAGRAM_SENDING_REPAIR_CONCURRENCY` (16 — one place per duty, so a 40 s round never holds another back) duties
  at once, every database unit of a duty in a slot of the `instagram-database` limiter (R48 — so the queue adds no
  Postgres demand of its own).
- **The watches (ROUTE row R48)** — `workers/instagram-sending-watch.*` on the repair queue, over
  `InstagramSendingWatchService` and `InstagramSendingWatchRepository` (the cross-organization reads, retention
  context): `outage-check` every 10 s (`everyMilliseconds`, WC-22 — 30 % bad of ≥ 50 calls in 30 s, or 30 % of the
  active accounts in a down stop → the all-accounts `instagram_down` stop 5 · 10 · 20 · 40 min on `app.sending_states`;
  the all-stop count back to 0 after 24 quiet hours; the late-lane gauge for readiness), `live-check` every minute
  (WC-16 — `GET /<account>/live_media`, then the waiting Live replies of a Live off air or older than 240 min end
  `expired` · `live_ended` and the Live's `live_ended_at` is saved) and `waiting-estimate` every 10 min (WC-24, S29 —
  `computeInstagramWaitingEstimate`, plan §12.3, written to the slow lane's `estimate_*`). A down stop is tested with a
  read-only profile read first (`probeAccount`, plan §33.5 rule 2) — on the fast lane too since R62. After an
  all-accounts stop (R62, plan §33.6 rules 2–3) the first lane or fast message that wakes takes the one test
  (`SendingStateService.claimAllAccountsTest`, `testing_lane` on the row; an `instagram_down` stop reads the profile
  first); a good test sets `all_release_started_at` and each lane goes back at its own place in the next 5 minutes
  (`allAccountsReleaseAt`) at half speed for an hour; a bad test starts the stop again one step longer, an unclear one
  the same step. Two watches run in each worker process, not on the
  schedule (worker-changes note 6): the clock against Postgres every minute (`worker-clock-watch.ts` — over 2 s and
  `mayTakeTickets` refuses, WC-23) and the "Redis lost" watch every 10 s (`worker-redis-watch.ts` — schedules
  re-registered and gate 1 rebuilt from the minute counts under one lock, WC-21). Readiness's `sending` part adds the
  clock skew, the repair queue's last round and the late lanes (SNC9).
- `seed/` — four lanes per seeded account, an ended stop, this minute's and this month's counts.

## Rules

- **Postgres decides** (P32): every count and stop is a row; Redis holds only the meter's 10-second copy. Route 63 has
  no copy (P306): its writers are too many to tombstone, and the day-count row makes it a few indexed rows.
- **The pause, the suspend and the plan stop are the channel account's** (P99): the lanes carry no copy; a turn reads
  them. A plan stop on the account and an error stop on a lane both hold, and both must end.
- **Sending is off unless switched on and matched** (SN7, D20): `SENDING_ENABLED` (default `false`) and
  `SENDING_ENVIRONMENT_ID` equal to the row's `environment_id`; a server older than the row's minimum compatible
  settings version takes no tickets, an older but compatible one does (P95).
- **A lane step joins its caller's unit of work** (the pick, the disconnect, the swap commit with it); a wake runs after
  commit.
- **Meta's usage is the connection's** (P51, SN23): every Meta call of this sub-domain reads its pace through
  `InstagramSendAccessService` first and passes the connection's recorder; `wait` means no call before `waitUntil`.
- **No piece sends twice** (D17): only the claim moves a message to `sending`; a timeout or a cut call saves `unknown`,
  never sent again by itself; a stop never fails a DM — it goes back to `waiting`, no try used, its counts given back.
