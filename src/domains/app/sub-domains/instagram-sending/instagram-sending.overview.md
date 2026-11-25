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
connection's usage, SN23). ROUTE row R42 built the **send core** (below); the lanes' own rules (R43–R45), the repair duties (R47) and the watches (R48) come with their rows. ROUTE
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
  `fast-<igm_…>-<tries>`), family **`instagram-send`** — the send service; `instagram-tasks` (the jobs around sending,
  each owner's job name), family `instagram`. Ids only, one attempt per ticket, no rate limiter, never paused by the
  Instagram circuit.
- `workers/` — one plain worker per queue (`isEnabled: env.SENDING_ENABLED`) and `instagram-send-ticket.processor.ts`:
  every ticket asks `mayTakeTickets` first (a task only when it calls Meta) and goes back a minute later, no try used,
  when the server may not send; every unit of work runs in a slot of the process's **Instagram database limiter**
  (`WORKER_INSTAGRAM_DATABASE_SLOTS`, the budget counts it once per process); a ticket with no slot within 2 s goes
  back, no try used (AC-17.20). The work is `appDomain.instagramSendWork` (`InstagramLaneTurnWork`,
  `InstagramFastMessageWork`, `InstagramTaskHandler`s): the send core for the two send queues (R42), the task
  handlers from R40, R41, R46 — a ticket for missing work is logged and finished, no row touched.
- `instagram-send-core.service.ts` — `InstagramSendCoreService` (R42, SNC3, SNC4, SNC7): the work behind the
  lane-turn and fast tickets — the turn's claim (or, with its stop over, a test turn under the account's one test
  claim), the account's holds and the all-accounts stop, the pace (95 % → no call, 80 % → boxes doubled), gate 1, the
  claim, the file, the Meta call outside any unit, the group, the one result save retried inside the send (a deadlock
  or lock timeout 3 times, a lost connection after 1, 2, 4, 8 s; then the message stays `sending` for the repair, D17),
  the stops (lanes by ladder, the connection's break on 190, the account's break, the app limit, "in a row" from the
  attempts), the test's end and half speed, the next tickets. Each lane's own rules plug in through
  `InstagramSendLaneRules` (R43–R45); a lane without rules sends nothing.
- `instagram-send-gate.service.ts` — gate 1 (an advisory Redis sorted set per account and count group, 100 ms, skipped
  30 s after 3 timeouts) and the claim's **one commit**: the lane row locked, gate 2 over the 61 minute rows, her hour,
  the month's 16 slots against the plan's limit, the adds, `sending`, the attempt; the DM that fills the month starts
  `plan_limit` on every account of the organization (the reply lane goes on).
- `instagram-send-error.util.ts` — Meta's answer → its one group (the code table `INSTAGRAM_SEND_ERROR_CODE_GROUPS` in
  the settings file) → the message's outcome and the stop it starts.
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
