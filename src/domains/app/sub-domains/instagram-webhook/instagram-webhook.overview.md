`src/domains/app/sub-domains/instagram-webhook/`

# Instagram webhook

Parent: [App](../../app.overview.md)

## Purpose

Meta's Instagram webhook for the app domain (feat-instagram-dm-sending routes-final § 5, WH1): Meta
checks the subscription (route 60) and delivers the six subscribed fields — comments, Live comments,
messages, postbacks, referrals, reactions (route 61) — at the Instagram object's own Meta webhook
path, `/social/channel-connections/meta/webhooks/instagram` (P53); the receiver **saves only**: each
event once, before Meta gets its answer (keys first, then the events of only the new keys, the 8-day
replay guard — through 5.B's store function). Intake then turns the saved events into contact
updates, automation runs and waiting messages; the team reads what arrived and what happened to each
(route 62).

Flow: receiver → keys → events → intake per kind (ROUTE row R38): three jobs per account by kind
group — `intake-messages`, `intake-live`, `intake-comments` — plus the tag-event job, deciding and
saving only through the inbound seam (WH27: contacts' `recordInboundContactEvent`, the run engine's
entry points with normalized kinds) → sub-domain 6 sends.

Built: the nested `instagram-webhook-event/` — the day-split events and their key table, route 62
(R16) — and, at this folder root, the receiver (routes 60–61, R17; launch R13), intake per kind and
the tag intake (R38) with the stuck-event pick-up — its 1-minute pass and the hourly retry of a
`failed` event (R39) — and the missed-comment look: a 30-minute sweep, one look per watched account
and the full pass after an outage (R39, WH17). The root holds no table of its own and writes the events only through the nested sub-domain's
service.

## Layout

- `instagram-webhook.routes.ts` — the routes plugin mounted by `app.routes.ts`: route 60
  (`GET /social/channel-connections/meta/webhooks/instagram`), route 61 (`POST` on the same path, in
  its own encapsulated context with the signature hook and JSON-only parsing, no per-IP cap of its
  own and `overloadShedLast`) and the nested `instagram-webhook-event.routes.ts` (route 62)
- `instagram-webhook.controller.ts` — the two handlers; both answer `200 text/plain` (the echoed
  challenge, `OK`) with `raw_response`
- `instagram-webhook.service.ts` — the subscription check (WH4) and the save of a delivery (WH9):
  the store unit capped at 3 s (`INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS`, WH2), read receipts and our own
  echoes dropped (the `InstagramOwnSentMessageLookup` port — sub-domain 6's
  `InstagramMessageService.findOwnSentMessageIds`, wired since ROUTE row R19 — a Postgres lookup of
  the echo's `mid` in `app.instagram_messages`, P62), the rest handed to `InstagramWebhookEventService.recordReceivedEvents`
- `instagram-webhook-ingress.plugin.ts` — `X-Hub-Signature-256` over the raw body with the Meta app
  secret (channel-connection's `readMetaWebhookSettings`, WHC3) before anything is parsed (WH4): a
  request without the header is refused before its body is read, and the verified bytes are parsed
  only after the check (D53); each refused signature is counted against the per-IP cap of unsigned
  traffic (`instagramWebhookUnsignedRateLimit`, 1,200 a minute, S9) — a validly signed one never;
  mirrors the Stripe receiver's plugin
- `instagram-webhook-event-classifier.util.ts` — the one pure classifier: each item's kind, key,
  skip reason, contact and time, `null` for a read receipt (WH8, the table in 5.A.10)
- `instagram-webhook-event-dispatch.util.ts` — the inbound seam's map (WH27,
  `INSTAGRAM_INBOUND_EVENT_KIND_OF`: each saved kind → its `ChannelInboundEventKind`; `edit` and
  `unknown` never cross) and the one pure reader of a saved event (the person and the item's ids
  for contacts and the run engine); an unreadable payload is `InstagramWebhookEventPermanentError`
- `instagram-webhook.dto.ts` — route 60's `hub.*` query and the delivery / entry shapes the service
  parses after the signature passed; `instagram-webhook.types.ts` (with
  `InstagramWebhookEventPermanentError`), `instagram-webhook.constants.ts`,
  `instagram-webhook-error.util.ts` (the three reasons, and the store-timeout `503`)
- `queues/instagram-webhook.queue.ts` (+ `.job.schema.ts`) — the intake queue: `intake-messages`,
  `intake-live`, `intake-comments` (`organizationPublicId`, `channelAccountPublicId`, `intakeKind`;
  deduplicated `intake-<kind>-<cha_…>` with `keepLastIfActive`, comments up to four slots — S11;
  priorities 1 · 1 · 5, 10 while over 500 comments wait) and `intake-tag-events`
  (`contactPublicIds`, 1–500; one contact at 5, deduplicated `intake-tag-events-<con_…>`, a bulk piece
  at 10); 5 attempts, exponential from 5 s with jitter
- `workers/instagram-webhook.worker.ts` — a **plain** worker (never provider-pausable, WH25), family
  `instagram`, `WORKER_CONCURRENCY_INSTAGRAM` job places, every unit of work in a slot of the
  process's Instagram database limiter (`instagram-database`, SN24), on while `isMetaConfigured()`;
  routes on `job.name`: `workers/instagram-webhook-intake.processor.ts` (a kind group's events,
  WH11–WH16), `workers/instagram-tag-event-intake.processor.ts` (WH15) and
  `workers/instagram-webhook-reclaim.processor.ts` (+ `.constants.ts`; the every-minute stuck-event
  pick-up: a waiting event over 1 minute old and not leased → its intake job; a `failed` event whose
  `next_attempt_at` is due → back to `received` with its tries from 0 while its trigger is under
  7 days old, else its retry time emptied — WH17, WH21) and
  `workers/instagram-missed-comment-check.processor.ts` (+ `.constants.ts`; the 30-minute sweep
  `sweep-instagram-missed-comments`, WC-26)
- `workers/instagram-missed-comment-check.processor.ts` — also the `missed-comment-check` task on
  `instagram-tasks` (one account's look: its watched posts — the due ones for the round, every one
  for the full pass after two missed rounds — at most 25, comments of the last 7 days, newest first
  back to the last seen minus 10 minutes, one call a second, stopped at 80 % (round) / 60 % (full
  pass) Meta usage; saved through `recordReceivedEvents` with key `comment:<id>`; then one
  `intake-comments` job), `lookForMissedComments` (the full pass the subscription check asks for,
  R40's port) and intake's late comment time read (`createInstagramLateCommentTimeReader`, 3 s)
- `workers/instagram-past-comment-read.processor.ts` — the `automation-backfill-read` task on
  `instagram-tasks` (WC-41, R41): an automation's past-comments read — its post(s) (one post, a
  linked "next post", a `between` window's posts, the newest 50 with comments for "any post", an ad's
  post), each post's comments of the last 1–7 days (never older than 7 days minus 30 minutes) saved
  through `recordReceivedEvents` and handed to `intake-comments` at the low priority; 1 call a
  second, a 15-minute wait at 80 % Meta usage, Meta retried after 1, 5, 15, 60 minutes; the read's
  row through `AutomationBackfillService` (one read at a time per account); also the read queue
  `INSTAGRAM_PAST_COMMENT_READ_QUEUE` route 38 and the watch wake it with
- `workers/instagram-next-post-linking.processor.ts` — the `next-post-linking` task (WC-43, R41):
  one account's posts since its oldest waiting go-live, stored and offered to its waiting "my next
  post" automations oldest first, a linked post's missed-comment watch started; the enqueue the
  automations' 15-minute sweep calls
- `workers/instagram-contact-profile-read.processor.ts` — the `contact-profile` task on
  `instagram-tasks` (S11): a new contact's Instagram profile, read off intake at the lowest priority
- [`instagram-webhook-event/`](instagram-webhook-event/instagram-webhook-event.overview.md) — the
  saved events and their keys, route 62 (`instagram-webhook-event.routes.ts`), the clean-up
- `__tests__/` — `integration/` (routes 60–62 over HTTP, the Stripe receiver still verifying) and
  `unit/` (the classifier, the DTOs, the plugin, the service, the dispatch, the queue, intake and tag
  intake — with fakes and against the database through the real run engine, two groups' jobs racing
  on one contact — the pick-up, the inbound-seam policy, and `events/worker/` for the worker)

## Key invariants

- **Signature first** (WH4, D53): route 61 declares no `schema.body`; a request without
  `x-hub-signature-256` is refused in a `preParsing` hook, before its body is read; for one that
  carries it the content-type parser only keeps the raw bytes (the shared raw-body registry, WH2,
  asked with the route that matched) and parses nothing. Nothing is parsed, looked up or stored
  before the HMAC passes — a wrongly signed 5 MB body costs one HMAC.
- **The per-IP cap counts unsigned traffic only** (S9, P97, AC-16.6): the route opts out of the
  global limiter (`INSTAGRAM_WEBHOOK_RATE_LIMIT` is `rateLimit: false`); the plugin counts each
  missing or wrong signature against `INSTAGRAM_WEBHOOK_UNSIGNED_RATE_LIMIT_OPTIONS` (`429` past
  1,200 a minute per IP), so a validly signed burst from Meta is never refused.
- **The UI sheds first** (S10, P97): route 61 is `overloadShedLast` — the overload guard sheds it
  only at twice each threshold (`OVERLOAD_SHED_LAST_FACTOR`). No pool of its own (WH2): the API and
  the workers already run in separate processes.
- **Saved once, before the answer; saved only** (WH9, P32): per entry one unit of work in the
  organization's `PRINCIPAL_SCOPE.VERIFIED` scope whose first statement caps each statement at 3 s
  (`statement_timeout`); the account's state; every item classified; read receipts and our own
  echoes dropped; then 5.B's store function — the 8-day replay guard, the keys
  (`app.instagram_webhook_event_keys`, `ON CONFLICT DO NOTHING`), then only the new keys' events. A
  repeat delivery saves nothing; nothing is kept in Redis (no buffer, P32).
- **A slow or absent Postgres is a failure Meta retries** (WH2, AC-16.5): a statement or lock wait
  cancelled by the unit's time is a `503` (`toInstagramWebhookStoreFailure`), a lost or refused
  connection the error handler's `503`, any other failure a `500` — never a `200`, so Meta delivers
  again and the next delivery saves normally.
- **One bad entry never costs the others theirs** (WH9, D53): every string of an entry — object keys
  and the event key included — is cleaned once, after the signature, of what Postgres refuses (NUL,
  lone surrogates: `cleanStorableJson`); an entry that still cannot be saved is logged
  (`instagram.webhook.entry_store_failed`), the delivery's other entries are saved, and then the
  first failure is thrown.
- **The folder root owns no table** (WH1): every event and key row is written through
  `InstagramWebhookEventService`; the root never holds their SQL.
- **Finding the organization opens no other organization's data** (WH9, K5): the receiver resolves
  the account through instagram-account's SECURITY DEFINER resolver, then reads the account's state
  and saves under that organization's `PRINCIPAL_SCOPE.VERIFIED` scope (ledgered); intake runs
  under the job's organization scope; the cross-organization sweeps read ids only.
- **Which accounts' events are saved** (WH3): an account no team holds, or a revoked one — nothing
  (one log line and the `instagram_webhook_unknown_account_entries_total` metric); an `error`
  account's events are saved `received` (they wait in its stopped lanes); the automation switch off
  saves them `skipped` `automation_disabled`.
- **Kinds and keys** (WH8, 5.A.10): keys are per account; the account's own comment or Live comment
  is `skipped` `own_comment`; a hand-typed echo and a reaction are saved `received`; an edit is
  `skipped` `edit`; anything unknown is `skipped` `unsupported`; a click without `mid` keys on
  sender, time and a payload hash.
- **No audit entry, no `*_by_user_id`** — nobody signed in acts here (WH6, K6, K9); logs carry ids,
  kinds, keys, statuses and counts, never a payload or message text.
- **The intake hook** (WH5, S25): the app container wires `enqueueInstagramWebhookIntake` into
  `InstagramWebhookService`; after each entry's commit one intake job per kind group that got
  `received` events is added; the rows stay `received` (no `queued` update); a failed add is only
  logged (the stuck-event pick-up takes over).
- **Intake decides and saves, never sends** (WH12, AC-16.7): each event's writes are **one
  transaction** whose first statement locks her live contact `FOR UPDATE`, then marks the event
  final while it still waits (0 rows → another job did it: stop; an erase that held her went first,
  and the event starts her afresh, CT9); its messages are saved `waiting` through the engine and `ChannelSendingPort`.
- **One lock order in every intake path** (WH26, P47 F5): her contact (`recordInboundContactEvent`'s
  upsert) → the automation → the runs — the comment, message, Live and tag paths alike; two groups'
  jobs racing on one contact never deadlock (the DB test races them).
- **Per kind group** (WH11): a failing comment holds back only the comment group; messages and Live
  keep strict order (the head, never skipped); comments claim the oldest free row `SKIP LOCKED`, up to
  four jobs per account (S11). After 25 events a follow-up job.
- **Before the transaction, no lock held** (WH12 step 2): the account again (gone or `revoked` →
  `skipped account_disconnected`, the switch off → `skipped automation_disabled`; an `error` account
  is taken in, WH3), the flood count (more than 20 of her message events a minute → `skipped flood`,
  WH16; a stop word still opts her out), the owner's quiet time (an echo of hers in 6 hours that is
  not ours, WH10), a commented post not stored yet (fail-open Meta read — its publish time for `between` and
  "next post", its row for the missed-comment watch; kept at R41, P315), a late comment's time (R39's reader, failing open). A new contact's profile is a
  `contact-profile` task after the commit (S11).
- **Failures** (WH12): a deadlock or lock timeout retries the transaction 3 times; Postgres
  unreachable gives the claim back without a try; a refusal fails the event at once (no
  `next_attempt_at`); the 5th failed try fails it with `next_attempt_at` an hour later (the pick-up
  tries it again, R39); an earlier failure keeps the try and the group's job retries with backoff.
  Never paused by an Instagram outage (WH25).

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> verified: route 61 — X-Hub-Signature-256 over the raw body (400 / 429 / 503 otherwise)
    verified --> ignored: not JSON, object not instagram, unknown or revoked account, a read receipt, our own echo, over 8 days old — 200, nothing saved
    verified --> failed_answer: the store unit over 3 s or Postgres down — 503 / 500, nothing saved, Meta delivers again
    verified --> stored: each entry cleaned, its new keys, then each event once per account and key — received, or skipped with its reason
    stored --> handled: its kind group's intake job — claimed, checked, one transaction, marked processed / skipped
    stored --> stored: a failure before the 5th try — the lease ends, the job retries; or waiting over 1 minute and not leased — the pick-up adds the job again
    stored --> failed: the 5th failed try (next_attempt_at +1 h) or a refusal (none)
    failed --> stored: next_attempt_at due, while under 7 days — the pick-up's hourly retry (R39)
    [*] --> stored: a missed comment the look found — the same store function and key (R39)
    stored --> listed: route 62 — masked, newest first
    handled --> listed: route 62
    failed --> listed: route 62
    listed --> [*]: its day part dropped after 8 days (R49; the launch's clean-up until then)
```

## Failure modes

- Route 60: a missing `hub.*` part or a challenge over 256 characters → `400 invalid_field`; a mode
  other than `subscribe` or a wrong token → `400 invalid_webhook_verify_token`; the setting unset →
  `503 instagram_webhook_not_configured`.
- Route 61: the Meta app secret unset → `503 instagram_webhook_not_configured`; the signature
  missing, malformed or wrong → `400 invalid_webhook_signature` (missing: before the body is read),
  or `429` once that address sent over 1,200 such requests a minute (validly signed ones are never
  counted); over 5 MB → `413`; not `application/json` → `415`; an entry whose store unit ran past
  3 s → `503`; Postgres down → `503`; any other store failure → `500` — each after the other entries
  are saved (Meta delivers again).
- Route 62's are in the nested overview.
- Intake: a deadlock or lock timeout retries the transaction (3 times); Postgres unreachable gives
  the claim back without a try; any other failure is retried by the group's job (5 attempts, from
  5 s) while only that group of that account waits; the 5th failure marks the event `failed` with
  `next_attempt_at`, a refusal at once without (a code, never payload text); an Instagram outage
  never pauses it; a lost job is re-added by the every-minute pick-up. Nobody is told about a failed event — it shows
  in route 62 (D13).
