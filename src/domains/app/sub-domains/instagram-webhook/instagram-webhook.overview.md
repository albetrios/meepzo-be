`src/domains/app/sub-domains/instagram-webhook/`

# Instagram webhook

Parent: [App](../../app.overview.md)

## Purpose

Meta's Instagram webhook for the app domain (feat-instagram-dm-sending routes-final § 5, WH1): Meta
checks the subscription (route 60) and delivers the six subscribed fields — comments, Live comments,
messages, postbacks, referrals, reactions (route 61) — at the Instagram object's own Meta webhook
path, `/social/channel-connections/meta/webhooks/instagram` (P53); the receiver **saves only**: each
event once, before Meta gets its answer (keys first, then the events of only the new keys, the 8-day
replay guard — through 5.B's store function). Event processing then turns the saved events into
contact updates and automation runs; the team reads what arrived and what happened to each (route 62).

Flow: receiver → keys → events → (today) the launch's per-account processor, which takes in the
launch's kinds and marks the new kinds processed with nothing done → (ROUTE row R38) intake per kind:
three jobs per account by kind group plus the tag-event job, deciding and saving only — sending is
sub-domain 6's.

Built: the nested `instagram-webhook-event/` — the day-split events and their key table, route 62
(R16) — and, at this folder root, the receiver (routes 60–61, R17; launch R13) and the launch's
event processing with the stuck-event pick-up (launch R14; intake per kind replaces it at R38). The
root holds no table of its own and writes the events only through the nested sub-domain's service.

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
- `instagram-webhook-event-dispatch.util.ts` — the one pure reader of a stored event for its
  handling (4.A.10 "What each event does"): the sender and the kind's fields for the run engine; an
  unreadable payload is `InstagramWebhookEventPermanentError`
- `instagram-webhook.dto.ts` — route 60's `hub.*` query and the delivery / entry shapes the service
  parses after the signature passed; `instagram-webhook.types.ts` (with
  `InstagramWebhookEventPermanentError`), `instagram-webhook.constants.ts`,
  `instagram-webhook-error.util.ts` (the three reasons, and the store-timeout `503`)
- `queues/instagram-webhook.queue.ts` (+ `.job.schema.ts`) — the processing queue: one job per
  channel account (`organizationPublicId`, `channelAccountPublicId`, WHC4), deduplicated per account with
  `keepLastIfActive` and a unique job id; 5 attempts, exponential from 5 s with jitter
- `workers/instagram-webhook.worker.ts` — provider-pausable on the `meta` circuit until intake per
  kind (R38, WH25), family `instagram`, `WORKER_CONCURRENCY_INSTAGRAM`, on while `isMetaConfigured()`;
  routes on `job.name`:
  `workers/instagram-webhook.processor.ts` (one account's events, WH12–WH14) and
  `workers/instagram-webhook-reclaim.processor.ts` (+ `.constants.ts`; the every-minute stuck-event
  pick-up, WH15)
- [`instagram-webhook-event/`](instagram-webhook-event/instagram-webhook-event.overview.md) — the
  saved events and their keys, route 62 (`instagram-webhook-event.routes.ts`), the clean-up
- `__tests__/` — `integration/` (routes 60–62 over HTTP, the Stripe receiver still verifying) and
  `unit/` (the classifier, the DTOs, the plugin, the service, the dispatch, the queue, the processor
  and the pick-up — with fakes and against the database through the real run engine — and
  `events/worker/` for the worker)

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
  and saves under that organization's `PRINCIPAL_SCOPE.VERIFIED` scope (ledgered); processing runs
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
- **The processing hook**: the app container wires `enqueueInstagramWebhookAccountProcessing` into
  `InstagramWebhookService`; after each entry's commit the channel account's job is added
  (`channelAccountPublicId`) and the just-saved rows turn `queued`; a failed add is only logged (the
  stuck-event pick-up — which reads the channel accounts, not the Instagram rows — takes over).
- **The new kinds wait for intake per kind** (ROUTE row R38): the launch processor marks a
  `live_comment`, `ice_breaker`, `referral`, `reaction` or `echo` `processed` with nothing done, and
  reads a `story_mention` or `shared_post` as a DM.
- **One account at a time, in order** (WH5, WH12): one processing job per account on any replica
  (the deduplication); the job claims the oldest `received` / `queued` event (one more attempt, a
  5-minute lease) and never skips a leased head, so a failing event holds the account's later events
  back (WQ3); after 25 events the job adds one follow-up and yields its slot.
- **Checked again, the contact first** (WH12, WH13): before each event the account is read again
  (switch off → `skipped` `automation_disabled`, not `connected` → `skipped` `account_disconnected`);
  then the contact (a new one's profile read, failing open), then the kind — a comment's post stored
  and "next post" linking in a savepoint before `startCommentRun`; a DM, story reply or click to its
  engine entry point — every call outside any database context with the job's scope and
  `isLastAttempt`.
- **Failures** (WH14): a temporary one ends the lease (attempt kept) and rethrows — the job retries
  with backoff; the 5th failed attempt, a permanent failure (an unreadable payload, a refused token)
  or the engine's `failedErrorType: 'token'` marks the event `failed` with a code; an Instagram
  outage gives the attempt back and pauses the queue. Every `failed` mark — the claim's own of a head
  whose attempts ran out too — also fails the runs the event left `running`, through the engine's
  `failRunsOfFailedEvent` in the same unit of work: both or neither (D47). A `skipped` mark after a claim
  does the same, for a run an earlier try left running (D51).

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> verified: route 61 — X-Hub-Signature-256 over the raw body (400 / 429 / 503 otherwise)
    verified --> ignored: not JSON, object not instagram, unknown or revoked account, a read receipt, our own echo, over 8 days old — 200, nothing saved
    verified --> failed_answer: the store unit over 3 s or Postgres down — 503 / 500, nothing saved, Meta delivers again
    verified --> stored: each entry cleaned, its new keys, then each event once per account and key — received, or skipped with its reason
    stored --> queued: the account's processing job added (after the commit)
    stored --> handled: event processing — one account at a time, in order
    queued --> handled: claimed oldest first, the account checked again, handled, marked
    queued --> queued: a temporary failure — the lease ends, the job retries (up to 5 attempts)
    queued --> queued: not claimed 5 minutes after it arrived — the stuck-event pick-up adds the job again
    stored --> listed: route 62 — masked, newest first
    handled --> listed: route 62
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
- Processing: a temporary failure is retried by the job (5 attempts, from 5 s) while the account's
  later events wait; the 5th failure, a permanent one or a dead token marks the event `failed` (a code
  and a short reason, never payload text) and fails the runs it left running; an Instagram outage spends
  no attempt and pauses the queue;
  a lost job is re-added by the every-minute pick-up. Nobody is told about a failed event — it shows
  in route 62 (D13).
