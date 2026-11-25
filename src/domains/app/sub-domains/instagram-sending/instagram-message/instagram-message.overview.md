`src/domains/app/sub-domains/instagram-sending/instagram-message/`

# Instagram message

Parent: [Instagram sending](../instagram-sending.overview.md)

## Purpose

Every message the sending engine sends or plans to send to a person, and every call to Meta for one
(feat-instagram-dm-sending routes-final § 6.B, SN16–SN19, SN22; ROUTE row R19). `InstagramMessageService`
is Instagram's implementation of the app kernel's `ChannelSendingPort` (`app.channel-ports.ts`, AU35),
wired as `channelSendingPorts.instagram`: the run engine (4.B) and broadcasts (7) save `waiting` rows
through it and it picks the lane. Nothing sends here — the lane turns, fast tickets, gates and the send
call are ROUTE rows R37 / R42, which claim a waiting row and finish it through the one result save.
No routes of its own: contacts (routes 24–26) and automations (routes 36–37) call it through the port.

## Layout

- `instagram-message.schema.ts` — `app.instagram_messages`, split by the ISO week of its run's start
  (`automation_run_started_at`; parts by `app.fn_create_weekly_partitions`, about 30 days kept),
  public id `igm_…`, the run key `CASCADE`, the CHECKs of plan §19.1 (lane / channel pairs, one source,
  the DM count, `sending_at` / `sent_at`, the reason list), one row per run place
  (`idx_instagram_messages_run_type`, `NULLS NOT DISTINCT`).
- `instagram-send-attempt.schema.ts` — `app.instagram_send_attempts`, split by UTC day, 8 days.
- `instagram-message.constants.ts` — types, kinds, channels, statuses, the reason list, the lane /
  channel pairs, the keep days, the retry piece (500), the 7-day expiries, the person-final Meta
  errors and the retry's "cannot" reasons.
- `instagram-message.util.ts` — the lane rule (`chooseInstagramMessagePlace`), her window, the
  type ↔ step map and the result mapping.
- `instagram-message.repository.ts` / `instagram-send-attempt.repository.ts` — the guarded writes and
  the reads (own echoes, waiting per lane, last retry, a contact's messages, the failed-message verdict
  SQL and the retry piece).
- `instagram-message.service.ts` — the port (`saveWaitingMessage`, `cancelWaitingMessages`,
  `skipWaitingMessages`, `listContactMessages`, `summarizeFailedMessages`, `retryFailedMessages`), the
  claim (`claimMessage`), the one result save (`saveSendResult`, which calls the engine's
  `recordMessageResult` in its commit), the lane move, the own-echo lookup (`findOwnSentMessageIds`,
  the webhook receiver's 4th argument) and route 63's sources (`countWaitingByLane`, `findLastRetry`).
- `instagram-message-compose.util.ts` — a waiting message's Meta `message` built from its automation's steps at
  the last moment (ROUTE row R43): the hello and nudge, the follow ask, the email / phone questions with Instagram's
  button and their plain-text fallback (the default texts when a wording is empty), each list kind, `{name}`. The
  service adds `endWaitingMessage` (a lane's check again: `expired` / `skipped`, the engine told in its commit) and
  `listWindowClosedByAutomation` (route 63's "chat closed" lines); the repository the lanes' pick reads.
- `instagram-message.types.ts` — the engine result port, the `retry-failed` queue port (R46), the
  claim and result inputs.

## Rules

- **Status machine:** `waiting` → `sending` → `sent` · `unknown` · `failed`; `waiting` → `skipped` ·
  `cancelled` · `expired`. Only `saveSendResult` changes a claimed row; every other writer touches
  `waiting` rows with a guarded update.
- **`unknown` is never sent again by itself** (D17): only the engine's save of the same step on her
  next message or tap reopens the same row; a `sent` question asked again reopens it with `asks` + 1.
- **The lane rule:** a comment's first DM is a slow private reply while her chat is closed, a fast DM
  once it is open, a fast private reply for a Live comment; public replies and hides wait in the reply
  lane; a follow check is a channel-less read in the fast lane; any other DM whose chat is closed is
  answered `skipped` · `window_closed` and writes no row.
- **The owner's retry** (SN18): failed messages of the last 30 days, never `unknown`, `skipped`,
  `expired`, `cancelled` or a broadcast; each at most once (`owner_retry_at`); not when too old, her
  chat is closed, final for her (erased, opted out, paused, a person error) or the automation is still
  stopped for a refused text. Until the `retry-failed` job lands (R46) the retry runs in the request,
  500 per commit, and answers `is_queued: false`.

## Tests

- `__tests__/unit/instagram-message.util.unit.test.ts` — the lane rule and mappings.
- `__tests__/unit/instagram-message-compose.util.unit.test.ts` — every composed kind, `{name}`, the fallbacks (R43).
- `__tests__/unit/instagram-message.service.db.unit.test.ts` — the engine through the real port, every
  status move, `unknown` never re-sent, the own-echo lookup, the summary and retry verdicts.
- `__tests__/integration/instagram-message.integration.test.ts` — routes 24–26 and 36–37 over HTTP.
