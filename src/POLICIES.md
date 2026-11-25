`src/`

# System policy constants

Every value here is a deliberate business, UX, or security trade-off. Each entry records what the value is, why it was picked, what changes if you move it, and when it was last reviewed. **Changing one requires updating this file in the same commit and re-running PR review.**

The canonical exports live under [src/shared/constants/](src/shared/constants/) (`ttl.constants.ts`, `limits.constants.ts`, `security.constants.ts`, `pagination.constants.ts`, `billing.constants.ts`, `instagram.constants.ts`, `roles.constants.ts`, `query-limits.constants.ts`, `notification.constants.ts`, `project-identity.constants.ts`). When a new policy constant is added there, the `be-tsdoc-export-guard` skill cross-pings `be-system-narrative-maintainer` to add a row here.

## VERIFICATION_CODE_TTL_MINUTES

- **Value**: 15 minutes
- **Source**: [src/domains/auth/sub-domains/auth-method/verification-code.ts](src/domains/auth/sub-domains/auth-method/verification-code.ts) (domain-local constant, not under `shared/constants/`)
- **Rationale**: Balances security (limited replay window) and UX (a user must have time to switch from the login form → email client → read and type the code).
- **Consequences of change**:
  - Decreasing → tighter replay window; users on slow devices or pulling email through corporate spam filtering may miss the window and have to retry.
  - Increasing → larger token replay window; review with security if pushing past 30 minutes.
- **Last reviewed**: 2026-05-28

## EMAIL_CONFIRM_LINK_HOURS

- **Value**: 24 hours
- **Source**: [src/domains/auth/sub-domains/auth-method/auth-method.constants.ts](src/domains/auth/sub-domains/auth-method/auth-method.constants.ts) (domain-local constant, not under `shared/constants/`)
- **Rationale**: The confirm-your-email link (`POST /users/me/email-confirmation`, feat-instagram-dm-sending UN6) is clicked from an inbox, often later than a sign-in code is typed; the token is 32 random bytes stored as its SHA-256, one live per person, one use. A new link may be asked 60 seconds after the last (`VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS`, reused).
- **Consequences of change**:
  - Decreasing → more "link no longer valid" answers (`400 email_confirm_token_invalid`) for people who open the email the next day.
  - Increasing → a longer window for a forwarded or leaked email to confirm an address it does not own.
- **Last reviewed**: 2026-11-24

## ACCESS_TOKEN_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Short JWT access-token lifetime is the primary mitigation for stolen tokens. Refresh happens via the session cookie (Origin-checked, see [`docs/reference/security/csrf-and-session-cookies.md`](docs/reference/security/csrf-and-session-cookies.md)). 15 minutes is the industry-standard balance of revocation latency vs network chatter.
- **Consequences of change**:
  - Decreasing → more refresh requests under load; each one hits Postgres + Redis.
  - Increasing → longer window where a leaked token remains usable; requires reviewing the session-revocation propagation strategy.
- **Last reviewed**: 2026-05-28

## SESSION_TOKEN_CACHE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Positive cache for valid session-token lookups in Redis. 60 s is the upper bound on how long a revoked session may keep working — the auth middleware always re-validates against Postgres after the cache expires.
- **Consequences of change**:
  - Decreasing → higher Postgres load on every authenticated request.
  - Increasing → longer window where a revoked session keeps working; review with security.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS

- **Value**: 86 400 seconds (24 hours)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Stripe and most enterprise webhook senders allow up to 24 h replays of the same `Idempotency-Key`. We mirror that window so retries from any client get the original response back, not a new one.
- **Consequences of change**:
  - Decreasing → callers may get a fresh execution on long retries; review compatibility with Stripe.
  - Increasing → larger Redis footprint; bounded by `IDEMPOTENCY_CACHED_BODY_BYTES`.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: TTL of the in-flight SETNX placeholder claimed by the first concurrent caller. 60 s is enough to cover the slowest legitimate request (Stripe API call + Postgres write) while bounding the wait for a second caller if the first crashes mid-flight.
- **Consequences of change**:
  - Decreasing → second concurrent caller may run a duplicate execution earlier on a crash.
  - Increasing → second caller waits longer on a crash.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_CACHED_BODY_BYTES

- **Value**: 102 400 bytes (100 KiB)
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Cap on the response body cached against an `X-Idempotency-Key`. Above this the response is not cached — the claim is released, so a retry with the same key runs the request again — and Redis never holds multi-MB payloads.
- **Consequences of change**:
  - Decreasing → more endpoints fall over the cap and lose idempotency replay.
  - Increasing → larger Redis footprint per stored entry.
- **Last reviewed**: 2026-05-28

## MFA_SESSION_TTL_SECONDS

- **Value**: 300 seconds (5 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: MFA challenge ticket lifetime in Redis between successful primary-credential verification and the second-factor submission. 5 minutes is enough to switch to an authenticator app or hardware key without forcing a fresh login.
- **Consequences of change**:
  - Decreasing → users with slow context-switching fail MFA more often.
  - Increasing → larger replay window for a half-completed login; review with security.
- **Last reviewed**: 2026-05-28

## TRUSTED_DEVICE_DAYS

- **Value**: 30 days
- **Source**: [src/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.ts](src/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.ts)
- **Rationale**: How long "trust this device" lets a browser skip the 2FA code at sign-in (feat-instagram-dm-sending AT17, D56). Counted from the tick; use never extends it. The `trusted_device` cookie lasts as long.
- **Consequences of change**:
  - Decreasing → people re-enter the 2FA code more often.
  - Increasing → a stolen browser profile skips the 2FA code longer; review with security.
- **Last reviewed**: 2026-11-24

## TRUSTED_DEVICES_MAX

- **Value**: 10 live trusted devices per person
- **Source**: [src/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.ts](src/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.ts)
- **Rationale**: Bounds the rows and the trusted surface per person (AT17); an 11th revokes the oldest under a per-user advisory lock.
- **Consequences of change**:
  - Decreasing → people with many browsers lose trust on the oldest sooner.
  - Increasing → more live trusted cookies per account.
- **Last reviewed**: 2026-11-24

## WEBAUTHN_CHALLENGE_TTL_SECONDS

- **Value**: 300 seconds (5 minutes; alias of `MFA_SESSION_TTL_SECONDS`)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: WebAuthn ceremony challenge lifetime in Redis. Same trade-offs as MFA challenges — kept identical so authenticator and platform flows feel uniform.
- **Consequences of change**: See `MFA_SESSION_TTL_SECONDS`.
- **Last reviewed**: 2026-05-28

## OAUTH_STATE_TTL_SECONDS

- **Value**: 600 seconds (10 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Lifetime of the OAuth `state` parameter in Redis between redirect to the provider and the callback. 10 minutes covers slow OAuth provider response while bounding the CSRF replay window.
- **Consequences of change**:
  - Decreasing → users may fail the callback if the provider stalls.
  - Increasing → wider CSRF replay window; review with security.
- **Last reviewed**: 2026-05-28

## PERMISSION_CACHE_DEFAULT_TTL_SECONDS

- **Value**: 300 seconds (5 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Authoritative TTL on the per-`(user, organization)` permission set in Redis. Permission writes invalidate the cache, but we keep a short TTL as a safety net for cross-process invalidation gaps.
- **Consequences of change**:
  - Decreasing → higher Postgres load on permission resolution.
  - Increasing → revoked permissions may keep working longer if invalidation is missed.
- **Last reviewed**: 2026-05-28

## PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS

- **Value**: 15 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: SETNX lock TTL while a single process recomputes the permission set, preventing thundering-herd recomputes on cache-miss across many processes.
- **Consequences of change**:
  - Decreasing → herd risk returns if recomputation outgrows the window.
  - Increasing → latency on legitimate retries when the leader process crashes mid-recompute.
- **Last reviewed**: 2026-05-28

## NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Backstop on the per-user unread-notification count in Redis — not the invalidation strategy. Every write that names a user (mark-read, mark-all-read, delete, the invitation accepted / declined fan-outs) invalidates immediately; the TTL exists for the two writers that cannot name one, the retention sweep (deletes by `created_at`) and the enqueue-rollback delete (holds only a row id). It is an independent literal, deliberately not an alias of `SESSION_TOKEN_CACHE_TTL_SECONDS`, so retuning one does not silently retune the other.
- **Consequences of change**:
  - Decreasing → more Postgres counts on a route every open tab polls, which is the pool cost this cache exists to remove.
  - Increasing → a badge stays wrong for longer after a sweep, always in the user's favor (it can show a notification that is gone; it cannot hide one that arrived).
- **Last reviewed**: 2026-09-21

## CHANNEL_CONNECTION_USAGE_CACHE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Backstop on the Redis copy of a channel connection's Meta usage (`app:meta_usage:<organization>:<connection>`, routes-final § 1 MC19, P5). Every usage write tombstones the entry after it lands, so the TTL only bounds a write whose tombstone failed. Postgres holds the usage (P32); Redis is the copy gate 1 reads before every Meta call. Its own literal, not an alias of another cache's TTL.
- **Consequences of change**:
  - Decreasing → more Postgres reads on the hottest path of the send lanes.
  - Increasing → not allowed past 60 s (be-read-cache-guard); a missed tombstone would hold an old pace longer.
- **Last reviewed**: 2026-11-24

## MESSAGE_MONTH_COUNT_CACHE_TTL_SECONDS

- **Value**: 10 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: The Redis copy of an organization's month count of sent messages (`app:message_month_count:<organization>`, routes-final § 6 SN11, P5), read by route 64's DM meter. Postgres holds the count in 16 slots (`app.message_month_counts`); each add tombstones the copy after its commit, and the send's claim always reads the slots, never the copy. Its own literal, not an alias of another cache's TTL.
- **Consequences of change**:
  - Decreasing → more slot sums on a meter every screen shows.
  - Increasing → a meter a little further behind on a quiet organization; not allowed past 60 s (be-read-cache-guard).
- **Last reviewed**: 2026-11-24

## SEGMENT_COUNT_CACHE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: The Redis copy of a segment audience count the background `segment-count` task wrote (`app:segment_count:<organization>:<account>:<conditions hash>`, routes-final § 7.B BC14, WC-39, P5), read by route 82 before its inline count. Derived from Postgres; every contact write moves the count, so nothing tombstones it — the TTL is how old a preview number may get. Its own literal, not an alias of another cache's TTL.
- **Consequences of change**:
  - Decreasing → heavy counts run again sooner (each a 30 s database task).
  - Increasing → not allowed past 60 s (be-read-cache-guard).
- **Last reviewed**: 2026-11-25

## API_KEY_LAST_USED_THROTTLE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: How long one recorded API-key `last_used_at` write suppresses the next. Matches the `interval '1 minute'` predicate the `UPDATE` itself carries (audit-#8) — the two throttle the same thing from opposite sides: the SQL stops the row write, this stops the transaction around it, which was the only transaction an authenticated API-key request opened. Not a cache: the claim is never read back, so nothing about authentication depends on it and a revoked key is still refused on the very next request.
- **Consequences of change**:
  - Decreasing → more transactions per key, approaching one per request at zero.
  - Increasing → the dashboard's "last used" column lags by that much. Nothing else reads the field; there is no retention sweep, audit report or query that filters on it.
- **Last reviewed**: 2026-09-21

## CATALOG_MEMO_TTL_MILLISECONDS

- **Value**: 60 000 ms (one minute)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: How long the public catalogs (plans, permissions) are served from **process memory**. An in-process memo, not a Redis cache: the catalogs are global rather than scope-keyed and cannot change while the process runs — every writer is a migration or a CLI seed in a different process — so there is no invalidation to get wrong, only a staleness window. One minute is far tighter than the staleness those routes already promise: they send `Cache-Control: max-age=300`, so a browser or CDN may serve a five-minute-old catalog regardless.
- **Consequences of change**:
  - Decreasing → more queries on a public unauthenticated route that any caller can drive at the public rate limit.
  - Increasing → a seeded catalog change takes longer to appear in a running process. Defensible up to the 300 s the `Cache-Control` header already allows; beyond that the header becomes the tighter promise, which would be confusing.
- **Last reviewed**: 2026-09-21

## CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS

- **Value**: 15 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: How long a **freshness** invalidation tombstone blocks repopulation of a read cache. Sized to the race, not to the cache: it only has to outlive the in-flight read that already fetched a pre-write value and has yet to issue its `SET … NX`, a window the request-path statement timeout (`DATABASE_HTTP_STATEMENT_TIMEOUT_MS`, 5 s) already bounds — so 15 s carries roughly a 3x margin. A **revocation** tombstone is a different quantity and must not use this: it has to outlive the cached positive entry it overrides (see `SESSION_TOKEN_CACHE_TTL_SECONDS`).
- **Consequences of change**:
  - Decreasing below the statement-timeout window → reopens the read-through race the tombstone exists to close: a slow reader can install a pre-write value after the marker expires.
  - Increasing toward a cache's own TTL → correctness is unaffected, but every write leaves its key cold for that long, so the users interacting most lose the cache entirely.
- **Last reviewed**: 2026-09-21

## EMAIL_CODE_WRONG_TRIES_PER_DAY

- **Value**: 20 wrong tries per email per 24 hours (`EMAIL_CODE_WRONG_TRIES_DAY_SECONDS`, from the first wrong try)
- **Source**: [src/domains/auth/sub-domains/auth-method/verification-code.ts](src/domains/auth/sub-domains/auth-method/verification-code.ts)
- **Rationale**: Passwords are off (feat-instagram-dm-sending P84), so the six-digit email code is the main way in; besides the 5 wrong tries per code (`VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS`), one email may spend 20 wrong tries a day before `POST /auth/email/login` answers `429 code_day_limit` with the wait. Counted in Redis by the email's hash (it limits, it does not record — a lost counter only resets the limit); a successful sign-in clears it. A stranger can spend it (routes-final § 10.A.10) — Google, Apple and passkeys still work, and the signed-in step-up has its own count.
- **Consequences of change**:
  - Decreasing → a stranger locks a person's email-code sign-in out sooner.
  - Increasing → more online guesses per email per day against the 10^6 code space.
- **Last reviewed**: 2026-11-24

## STRIPE_WEBHOOK_STUCK_PROCESSING_LEASE_MINUTES

- **Value**: 15 minutes
- **Source**: [src/shared/constants/billing.constants.ts](src/shared/constants/billing.constants.ts)
- **Rationale**: Stripe webhook event reclaim lease. Events stuck in `processing` for longer than this are presumed orphaned (worker crashed or pod evicted) and may be reclaimed for retry. 15 minutes is the upper bound on one legitimate processing run. The mail outbox reclaims `sending` rows on its own env-driven window (`MAIL_OUTBOX_RECLAIM_SENDING_MINUTES`); webhook deliveries need no lease — BullMQ runs one execution per job, so a new execution re-claims any attempt that is not yet `SENT`.
- **Consequences of change**:
  - Decreasing → reclaim races with slow legitimate processing; may produce duplicate Stripe processing (absorbed by the event ledger's claim).
  - Increasing → orphaned events take longer to recover after a worker crash.
- **Last reviewed**: 2026-10-05

## STRIPE_WEBHOOK_MAX_PROCESSING_ATTEMPTS

- **Value**: 25 attempts
- **Source**: [src/shared/constants/billing.constants.ts](src/shared/constants/billing.constants.ts)
- **Rationale**: A Stripe webhook event whose handler keeps failing was reclaimed every five minutes forever, and every reclaim cycle that ran out of BullMQ attempts raised another alert. After this many attempts — counted only when our handler ran, so a Stripe outage costs none — the ledger row turns `abandoned`, the reclaim stops, and one alert fires. Five BullMQ attempts per cycle make it about five cycles (~30 minutes) of a handler failing every time. A failure no retry fixes (conflicting organization metadata, `resource_missing`) is abandoned at once.
- **Consequences of change**:
  - Decreasing → transient bugs or brief data races abandon events sooner (an operator then retries them with `tool:stripe-webhook-replay -- --retry`).
  - Increasing → a broken event retries longer before anyone is told.
- **Last reviewed**: 2026-10-05

## PAID_TRIAL_DAYS

- **Value**: 7 days
- **Source**: [src/domains/billing/sub-domains/subscription/subscription.constants.ts](src/domains/billing/sub-domains/subscription/subscription.constants.ts)
- **Rationale**: The no-card trial of a paid plan (Creator or Studio — feat-instagram-dm-sending routes-final § 8 BL7, D73): `POST /billing/subscriptions` with `is_trial` sends it to Stripe as `trial_period_days`, writes `trial_end` = now + 7 days and gives the plan's features at once. One trial per organization and per Instagram account, ever (`billing.trial_accounts`). Not environment-varying (P4).
- **Consequences of change**:
  - Decreasing → less time to try the paid switches before Stripe cancels an unpaid trial.
  - Increasing → longer free use of the paid plans; the plan-state check's notices (`TRIAL_NOTICE_DAYS`) still fire 3 and 1 days before the end.
- **Last reviewed**: 2026-11-24

## TRIAL_NOTICE_DAYS

- **Value**: 3 and 1 days before `trial_end`
- **Source**: [src/domains/billing/sub-domains/subscription/subscription.constants.ts](src/domains/billing/sub-domains/subscription/subscription.constants.ts)
- **Rationale**: The days on which a trial's billing recipients get the "trial ending" notice (BL17), sent once per subscription and day by the plan-state check (WC-59). Stripe's own `trial_will_end` fires only once, 3 days ahead, so the check sends both.
- **Consequences of change**:
  - Adding a day → one more notice per trial (its own dedupe key).
  - Removing the 1-day notice → an owner who missed the first may lose the plan without warning.
- **Last reviewed**: 2026-11-24

## PLAN_STATE_CHECK_MINUTES

- **Value**: 15 minutes
- **Source**: [src/domains/billing/sub-domains/subscription/subscription.constants.ts](src/domains/billing/sub-domains/subscription/subscription.constants.ts)
- **Rationale**: How often the plan-state check sweeps (feat-instagram-dm-sending BL17, WC-59, ROUTE row R52): a grace that ended (no Stripe event marks it) stops the lanes with `plan_ended` within 15 minutes, the trial notices go out within 15 minutes of their day, and a subscription on a switched-off plan row is moved to Free's limits once. The app's plan-stop backup (`INSTAGRAM_PLAN_STOP_BACKUP_MINUTES`, WC-38) runs at the same pace. A grace that ended more than `PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS` (7) ago is not swept again — the app's plan-change job keeps its id for 7 days, and Stripe cancels the row at the end of its retries. Not environment-varying (P4).
- **Consequences of change**:
  - Decreasing → the stops follow the plan sooner, at one more cross-organization read per run.
  - Increasing → a lapsed plan keeps sending longer after its grace.
- **Last reviewed**: 2026-11-25

## BILLING_SEAT_SYNC_ENABLED

- **Value**: `false`
- **Source**: [src/domains/billing/sub-domains/subscription/subscription.constants.ts](src/domains/billing/sub-domains/subscription/subscription.constants.ts)
- **Rationale**: Members are unlimited on every plan (feat-instagram-dm-sending D55, BL9, WC-65 — ROUTE row R52): the member count is not pushed to Stripe (the quantity stays 1) and the hourly seat reconcile is not scheduled. A billing product switch, not an environment setting (P4); the seat machinery is kept for a plan that carries seats again.
- **Consequences of change**:
  - Turning it on → member adds and removes push the quantity to Stripe again and the hourly reconcile is scheduled; only worth it with a plan that has `included_seats`.
- **Last reviewed**: 2026-11-25

## INSTAGRAM_WEBHOOK_EVENT_MAX_PROCESSING_ATTEMPTS

- **Value**: 5 attempts
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: An Instagram webhook event's handling attempts before it is marked `failed` (launch-2026-11-20-ujai WH12, WH14, D16). One account's events run strictly in order (WQ3, D28), so a failing event holds back that account's later events: five attempts with growing waits from 5 seconds keep the hold to about one to two minutes. Counted only when our handling ran — an Instagram outage (open circuit) gives the attempt back. The event-processing queue's BullMQ `attempts` is the same number; the 5th failed attempt marks the event `failed` with a code, and the account's next event runs. A permanent failure (an unreadable payload, a refused token) fails at once.
- **Consequences of change**:
  - Decreasing → a brief outage of the database or Instagram fails events that one more retry would have handled.
  - Increasing → one broken event holds every later event of its account back longer (a DM's answer waits behind it).
- **Last reviewed**: 2026-11-22

## INSTAGRAM_WEBHOOK_EVENT_STUCK_AFTER_MINUTES

- **Value**: 5 minutes
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: The lease (WH12, D15): a claim holds its event this long, so a run that died mid-event frees it; the every-minute pick-up re-adds the intake job of an event that waited `INSTAGRAM_WEBHOOK_EVENT_PICK_UP_AFTER_MINUTES` (1, WH17 — R39) and is not leased this long. A temporary failure ends the lease at once (the attempt kept) so the job's own backoff retry does not wait it out.
- **Consequences of change**:
  - Decreasing → a slow but live handling (many sends with their 200–1000 ms pauses) can lose its lease to another run; the claim's attempt-count guard keeps that run's marks from landing, but the event is handled twice up to the engine's own idempotency.
  - Increasing → an event whose job was lost (a Redis refusal at the receiver, a crash) waits longer before it is picked up.
- **Last reviewed**: 2026-11-22

## INSTAGRAM_WEBHOOK_EVENTS_PER_JOB

- **Value**: 25 events
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: How many events one account's processing job handles before it adds one follow-up job and gives its worker slot up (WH12): a busy account (a viral "comment to get the link" post) never keeps the other accounts waiting, while a normal account's burst finishes in one job.
- **Consequences of change**:
  - Decreasing → more jobs and Redis round trips for a busy account; fairer slot sharing.
  - Increasing → one busy account can hold a slot (of `WORKER_CONCURRENCY_INSTAGRAM`) for longer while other accounts' events wait.
- **Last reviewed**: 2026-11-22

## INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS

- **Value**: 8 days
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: One number for three rules (feat-instagram-dm-sending WH9 step 5, WH19, WH20, WH24; P33, D15): how long a saved Instagram webhook event and its event key are kept (their day parts are dropped after it — the shared upkeep), and the replay guard — an event whose Meta time is older is never saved, because its key's day part may already be gone and a repeat could no longer be recognised. Meta redelivers for at most a few days, and the event list is only a debugging view.
- **Consequences of change**:
  - Decreasing → a late Meta redelivery is refused as a replay sooner; the debugging list covers fewer days.
  - Increasing → more day parts kept (storage), and the event body of a failed event lives longer.
- **Last reviewed**: 2026-11-24

## INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS

- **Value**: 3,000 ms
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: The Instagram webhook's store unit (route 61) caps each of its statements at this `statement_timeout` (feat-instagram-dm-sending WH2, WHC2; plan `WEBHOOK_SAVE_TIMEOUT_MS`). Meta waits about 5 seconds for an answer; a slow Postgres must fail the delivery with a `503` inside that budget — nothing saved, nothing kept in Redis (P32) — so Meta delivers it again, instead of timing out while the unit may still commit.
- **Consequences of change**:
  - Decreasing → more deliveries refused under a briefly slow database (Meta retries them).
  - Increasing → past ~4 s Meta's own timeout fires first and its retry races the still-running unit (the key table keeps it a no-op, but the answer is lost).
- **Last reviewed**: 2026-11-24

## INSTAGRAM_WEBHOOK_ENTRY_STORE_CONCURRENCY

- **Value**: 8 accounts
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: How many accounts' entries of one Meta delivery the receiver (route 61) stores at once (feat-instagram-dm-sending WH9, WH2; P253). Meta batches up to 1,000 updates across accounts; stored one after another, a few slow units (each capped at `INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS`) would pass Meta's answer budget and the whole batch would come again. One account's entries still go in delivery order.
- **Consequences of change**:
  - Decreasing → a large multi-account batch takes longer to answer; at 1 the old serial store.
  - Increasing → one delivery holds more connections of the HTTP pool (`DATABASE_POOL_MAX`) at once, less headroom for the UI and other deliveries.
- **Last reviewed**: 2026-11-25

## INSTAGRAM_WEBHOOK_EVENT_KEY_NEARBY_DAYS

- **Value**: 2 days
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: The store function looks for an event's key on the UTC days this far either side of its own before saving it (WH20; P254). A comment change carries no time of its own, so its day is the entry's `time` — Meta's send time, which each retry moves for up to 36 hours (two UTC days at most); the missed-comment check files the same comment under the comment's own time.
- **Consequences of change**:
  - Decreasing → a retry or a missed-comment read whose day moved further saves the comment twice (and its automation answers twice up to the engine's once key).
  - Increasing → a wider read per store unit, for no repeat Meta can send.
- **Last reviewed**: 2026-11-25

## OVERLOAD_SHED_LAST_FACTOR

- **Value**: 2 (times each overload threshold)
- **Source**: [src/shared/middlewares/core/overload-guard.middleware.ts](src/shared/middlewares/core/overload-guard.middleware.ts)
- **Rationale**: A route marked `config.overloadShedLast` — today Meta's Instagram webhook delivery only (feat-instagram-dm-sending S10, P97) — is shed by the overload guard only at twice its event-loop, pool-queue and connection-wait thresholds, so under load the UI sheds first and Meta's deliveries keep their slice: Meta slows, then disables, a subscription that keeps failing.
- **Consequences of change**:
  - Decreasing toward 1 → the webhook sheds with the UI again.
  - Increasing → the webhook keeps being served deeper into an overload, with less headroom for the process itself.
- **Last reviewed**: 2026-11-24

## INSTAGRAM_WEBHOOK_CHALLENGE_MAX_LENGTH

- **Value**: 256 characters
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: The longest `hub.challenge` the Instagram webhook's subscription check (route 16) echoes back (route 60; route 16 in the launch). The route is public and answers the text Meta sent, so the text is bounded; Meta's challenges are short numbers.
- **Consequences of change**:
  - Decreasing → a longer challenge Meta may send one day is refused (`400 invalid_field`) and the subscription check fails.
  - Increasing → the public route echoes longer caller-chosen text.
- **Last reviewed**: 2026-11-22

## APP_PARTITION_MAKE_AHEAD_DAYS / APP_PARTITION_READY_ALERT_DAYS / APP_PARTITION_OVERDUE_ALERT_SECONDS

- **Value**: parts made **14 days** ahead; an alert below **7** ready days; an alert when the oldest kept part is more than **1 day** (86,400 s) past its drop time
- **Source**: [src/domains/app/workers/app-partition-upkeep.constants.ts](src/domains/app/workers/app-partition-upkeep.constants.ts) — the floors (14 ahead, keep ≥ 8) are also checked inside `app.fn_manage_time_partitions` (`migrations/20261125190000_app_partition_upkeep.sql`)
- **Rationale**: The shared partition upkeep of the seven time-split `app` tables (feat-instagram-dm-sending WC-55, S17, P92, P97): a row whose day has no part lands in the DEFAULT part, and that day cannot get its part until the rows are moved, so two weeks of parts give a week of warning before the first alert and another week to fix it. The overdue alert is P92's "oldest row past its keep time … alerts after 1 day", measured per part: the hourly drop retries a lock time-out 24 times before it fires.
- **Consequences of change**:
  - Decreasing the days ahead → less time between an upkeep outage and rows landing in a DEFAULT part (the function refuses below 14).
  - Increasing the ready alert → more noise on a normal day; decreasing it → less warning.
  - Decreasing the overdue alert → a lock time-out on a busy hour pages the team.
- **Last reviewed**: 2026-11-25

## AUTOMATION_RUN_KEEP_DAYS / AUTOMATION_RUN_PART_DROP_AFTER_DAYS / AUTOMATION_TOMBSTONE_RETENTION_DAYS

- **Value**: runs, their run events and comment logs are kept **90 days** (`AUTOMATION_RUN_KEEP_DAYS`, feat-instagram-dm-sending D16 — was 180); since the tables are split by month (P96, AU36) a runs part (with its run-events part) is dropped once its month ended more than **98 days** ago (`AUTOMATION_RUN_PART_DROP_AFTER_DAYS` = 90 + the 7-day wait + 1), a comment-log part 90 days after its month; a deleted automation stays **180 days** (`AUTOMATION_TOMBSTONE_RETENTION_DAYS`) once no run or comment log points at it
- **Source**: [src/domains/app/sub-domains/automation/automation-run/automation-run.constants.ts](src/domains/app/sub-domains/automation/automation-run/automation-run.constants.ts), [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: How long the automation history is kept (D16): about three months of runs and comment logs for the team to read, after which they carry personal data for no reason. Expiry drops whole month parts (the shared upkeep, ROUTE row R49) instead of deleting rows in batches — no batch delete remains on these tables (P92, P96). A run goes 90 days or a little more after it ends, never sooner. Product rules, not settings.
- **Consequences of change**:
  - Decreasing → history the team still reads disappears sooner; the once rule (D13) frees a person sooner.
  - Increasing → personal data (comment texts) is kept longer and more parts are kept; check the privacy text first.
- **Last reviewed**: 2026-11-24

## The hourly batch clean-ups — TIME_BUDGETED_CLEAN_UP_* / keep times / per-table caps

- **Value**: each plain-table clean-up runs **hourly** until a **10-minute** budget (`TIME_BUDGETED_CLEAN_UP_BUDGET_MS`) is spent, in units of **10 batches** (50,000 rows, `TIME_BUDGETED_CLEAN_UP_BATCHES_PER_UNIT`), capped per table at the plan's rows a day × 2 (`APP_TABLE_CLEAN_UP_MAX_ROWS_PER_RUN`, `SESSION_CLEANUP_MAX_ROWS_PER_RUN` 500,000, `TRUSTED_DEVICE_CLEANUP_MAX_ROWS_PER_RUN` 50,000, `AUTOMATION_TOMBSTONE_RETENTION_MAX_ROWS_PER_RUN` 50,000); the gauge `retention_cleanup_oldest_overdue_seconds` alerts after **1 day** (`TIME_BUDGETED_CLEAN_UP_OVERDUE_ALERT_SECONDS`). Keep times: deleted broadcasts and segments **90 days** (`BROADCAST_TOMBSTONE_RETENTION_DAYS`, P75), recipients **90 days** (`BROADCAST_RECIPIENT_KEEP_DAYS`), ended stops **90 days** (`INSTAGRAM_SEND_STOP_KEEP_DAYS`), tag events **8 days** (`CONTACT_TAG_EVENT_KEEP_DAYS`), month counts **13 months** (`MESSAGE_MONTH_COUNT_KEEP_MONTHS`), trusted devices **30 days** after they end (`TRUSTED_DEVICE_ENDED_KEEP_DAYS`)
- **Source**: [src/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.ts](src/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.ts), [src/domains/app/workers/app-table-clean-up.constants.ts](src/domains/app/workers/app-table-clean-up.constants.ts), [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts), the sub-domains' constants files
- **Rationale**: feat-instagram-dm-sending P92 (scale review S3): a once-a-day delete of at most 250,000 rows falls behind at the plan's volume; an hourly run within a budget keeps up, short units keep each transaction's locks and WAL small, the cap keeps a backlog from taking the hour, and the gauge says when a table falls behind. The keep times are the plan's (§ 33.4 size table, D51 — contacts are never removed by age).
- **Consequences of change**:
  - Decreasing the budget or a cap → a table may fall behind (the gauge alerts after a day).
  - Increasing a unit's batches → longer transactions and lock waits on the hot tables.
  - Shortening a keep time → history the team or the product reads disappears sooner; check the privacy text and the readers (route 63's months, the pick-up's 24 h).
- **Last reviewed**: 2026-11-25

## PAGINATION

- **Value**: `{ DEFAULT_LIMIT: 25, MAX_LIMIT: 100 }`
- **Source**: [src/shared/constants/pagination.constants.ts](src/shared/constants/pagination.constants.ts)
- **Rationale**: Cursor-only pagination defaults applied to every list endpoint. 25 is large enough for typical UI tables and small enough for sub-100 ms p95; 100 caps DOS exposure on bulk listing.
- **Consequences of change**:
  - Decreasing → more pagination round trips for batch consumers.
  - Increasing past 100 → review query plans for every list endpoint; some indexes assume LIMIT ≤ 100.
- **Last reviewed**: 2026-05-28

## DEFAULT_REPOSITORY_LIST_LIMIT

- **Value**: 500 rows
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Hard cap for unscoped repository list helpers (used in workers, scripts, internal tooling). Prevents accidental OOM from `findAll()` patterns.
- **Consequences of change**:
  - Decreasing → some workers may need explicit pagination they currently skip.
  - Increasing → wider blast radius for accidental fetch-all queries.
- **Last reviewed**: 2026-05-28

## GDPR_EXPORT_MAX_ROWS_PER_TABLE

- **Value**: 1 000 rows per table
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Per-table row cap inside a GDPR data export bundle. Keeps export bundles bounded and ensures the download URL TTL window covers the largest legitimate export.
- **Consequences of change**:
  - Decreasing → users with large histories may receive truncated exports; review with legal.
  - Increasing → larger S3 objects, longer worker time-to-complete, larger Redis cardinality.
- **Last reviewed**: 2026-05-28

## ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH

- **Value**: 32 bytes (256 bits)
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Raw secret length for organization API keys. 256-bit randomness, the standard for API tokens; only the prefix is stored in plaintext.
- **Consequences of change**:
  - Decreasing → reduced collision-resistance margin; never go below 16.
  - Increasing → cosmetic only; client SDKs may need to widen any fixed-length parsers.
- **Last reviewed**: 2026-05-28

## ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH

- **Value**: 8 characters
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Prefix length stored in plaintext for human disambiguation in dashboards/logs. Long enough to identify a key visually, short enough that it leaks no usable secret entropy.
- **Consequences of change**:
  - Decreasing → harder to disambiguate keys in audit logs.
  - Increasing → leaks more bits of the raw secret to anyone with read access to the prefix.
- **Last reviewed**: 2026-05-28

## USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: GDPR export download URL lifetime. sec-U6 shortened this from 24 h to 15 min: an exfiltrated session token used to be able to mint a URL that stayed valid for a full day and replay it. 15 min still gives the legitimate browser pull ample headroom (a single gzip download) while collapsing the stolen-token replay window. Every mint is recorded to `audit.logs` so forensics survive even after the URL expires.
- **Consequences of change**:
  - Decreasing → a slow download or interrupted pull may need a re-export; worker load increases.
  - Increasing → widens the stolen-token replay window; review with security before moving past 15 min (hard S3 SigV4 cap is 7 days, but the privacy posture is the binding limit).
- **Last reviewed**: 2026-07-09 (sec-U6)

## PRESIGNED_URL_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes; alias of `ACCESS_TOKEN_EXPIRY_SECONDS`)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Default lifetime for S3 presigned upload/download URLs. Aligned with access-token TTL so a single auth burst (sign in → upload) succeeds end-to-end without refreshing.
- **Consequences of change**:
  - Decreasing → users on slow uploads may retry repeatedly.
  - Increasing → larger window where a leaked URL keeps working; review with security.
- **Last reviewed**: 2026-05-28

## CATALOG_CACHE_MAX_AGE_SECONDS / CATALOG_CACHE_STALE_WHILE_REVALIDATE_SECONDS

- **Value**: 300 s `max-age`, 60 s `stale-while-revalidate`
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Public-catalog (plan list, etc.) HTTP cache headers. Max-age aligned with `PERMISSION_CACHE_DEFAULT_TTL_SECONDS` so policy changes propagate at the same rate; SWR aligned with `SESSION_TOKEN_CACHE_TTL_SECONDS` for snappy follow-up requests.
- **Consequences of change**: Affects CDN behavior; coordinate with whoever owns the edge config.
- **Last reviewed**: 2026-05-28

## HEALTH_READINESS_PROBE_TIMEOUT_MS

- **Value**: 1 500 ms per dependency
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Per-dependency budget inside `GET /readyz`. The `/readyz` endpoint must return within Railway's readiness-probe window; with three probes (Postgres, Redis, BullMQ) running in parallel the worst-case is 1.5 s.
- **Consequences of change**:
  - Decreasing → flapping readiness on slow days; instances cycle.
  - Increasing → readiness probe may exceed Railway's deadline and the platform yanks traffic.
- **Last reviewed**: 2026-05-28

## CORS_PREFLIGHT_MAX_AGE_SECONDS

- **Value**: 86 400 seconds (24 hours)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Browser CORS preflight cache. 24 h reduces preflight chatter for SPAs without making CORS-policy changes propagate dangerously slowly (we don't tighten origins frequently).
- **Consequences of change**: When tightening `ALLOWED_ORIGINS`, expect up to 24 h of legacy clients still sending requests under the old policy.
- **Last reviewed**: 2026-05-28

## BULLMQ_DEFAULT_LOCK_DURATION_MS / BULLMQ_STALLED_INTERVAL_MS

- **Value**: 30 000 ms (30 s) each
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Worker lock duration and stalled-job check interval. 30 s is BullMQ's recommended floor that avoids spurious re-runs on legitimately slow jobs while still recovering quickly from a worker crash.
- **Consequences of change**:
  - Decreasing → spurious re-runs on slow jobs (duplicate emails, duplicate Stripe processing).
  - Increasing → slower recovery from a crashed worker; jobs sit unclaimed longer.
- **Last reviewed**: 2026-05-28

## BULLMQ_WEBHOOK_LOCK_DURATION_MS

- **Value**: 60 000 ms (60 s)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Webhook delivery worker lock. Doubled vs default because the slowest legitimate downstream webhook receiver is allowed up to 60 s before we treat the attempt as failed.
- **Consequences of change**: See `BULLMQ_DEFAULT_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## BULLMQ_RETENTION_LOCK_DURATION_MS

- **Value**: 120 000 ms (2 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Retention worker lock. Retention sweeps may scan large tables; 2 minutes covers the longest legitimate sweep without triggering spurious re-runs.
- **Consequences of change**: See `BULLMQ_DEFAULT_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## QUEUE_RETRY_JITTER_RATIO

- **Value**: 0.2 (up to 20% added to every queue retry delay)
- **Source**: [src/infrastructure/queue/queue.constants.ts](src/infrastructure/queue/queue.constants.ts) — BullMQ's `jitter` on the built-in exponential backoff; `addRetryJitter` ([retry-jitter.util.ts](src/infrastructure/queue/retry-jitter.util.ts)) on the custom ones (mail, Stripe webhook, webhook delivery)
- **Rationale**: Jobs that fail together must not retry together. When a provider's circuit opens, every failing job waits exactly the circuit's remaining open time; without jitter the whole backlog hits the half-open probe in the same instant and opens the circuit again. A delay is never shortened, only lengthened.
- **Consequences of change**:
  - Increasing → retries spread wider, but the schedule stretches (the Stripe webhook curve's ~5-minute dead-letter window grows by up to the ratio).
  - Decreasing → retries bunch up again; 0 restores lockstep retries.
- **Last reviewed**: 2026-10-05

## DEFAULT_BATCH_DELETE_ROW_COUNT

- **Value**: 5 000 rows per batch
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Batch size for retention and tombstone-purge helpers. Large enough to amortize per-statement overhead, small enough that one batch fits in `BULLMQ_RETENTION_LOCK_DURATION_MS`.
- **Consequences of change**: Tune in lockstep with `BULLMQ_RETENTION_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## GLOBAL_ROLES

- **Value**: `{ SUPER_ADMIN: 'super_admin', USER: 'user' }`
- **Source**: [src/shared/constants/roles.constants.ts](src/shared/constants/roles.constants.ts)
- **Rationale**: Two-tier platform role, independent of organization-scoped permissions and granting nothing inside an organization. `super_admin` comes from the `GLOBAL_ADMIN_EMAILS` allowlist, is granted only to an ACTIVE, verified account with an enrolled MFA factor, and is re-derived against live account state on every request; `requireRole` admits it only on a session that proved the second factor (`amr: ['mfa']`, A-2), and the admin delete / suspend / status-edit routes also need a recent strong step-up (the 2FA code — a `super_admin` always holds MFA); `user` is every other active account, and no guard tests for it. A third code, `admin`, was removed as never-issued: no mint path produced it, the auth middleware downgraded it on sight, and nine route guards accepted a value that could not occur.
- **Consequences of change**:
  - Adding a role → add the code that ISSUES it in the same change, then audit every JWT issuance path and `requireRole` call site. A role nobody mints is an authorization surface that reads as real and is not.
  - Removing a role → audit every Postgres row + JWT in flight. `admin` was safe to remove immediately because nothing minted it, and the auth middleware re-derives any claim that is not `user`, so a token carrying the retired value fails closed rather than being trusted.
- **Last reviewed**: 2026-09-20

## DEFAULT_TEAM_ROLES / TENANCY_CUSTOM_ROLES_ENABLED

- **Value**: every TEAM organization holds four locked system roles — Owner (every code), Admin (every code but `organization:delete`), Editor and Viewer — and `TENANCY_CUSTOM_ROLES_ENABLED = false`.

  | Role | Codes |
  | --- | --- |
  | Owner | every code |
  | Admin | every code but `organization:delete` |
  | Editor | `organization:read`, `upload:manage`, `channel-account:read`, `instagram-account:read`, `automation:read` / `:create` / `:update` / `:delete`, `contact:read`, `contact:update` |
  | Viewer | `organization:read`, `channel-account:read`, `instagram-account:read`, `automation:read`, `contact:read` |

- **Source**: [src/domains/tenancy/sub-domains/organization/organization-provisioning.ts](src/domains/tenancy/sub-domains/organization/organization-provisioning.ts) (`DEFAULT_TEAM_ROLES`; which app codes Editor and Viewer hold is `APP_PERMISSION_DEFAULT_TEAM_GRANTS`, typed so a new app code does not compile until it names its roles) and [src/domains/tenancy/sub-domains/member-roles/member-role.constants.ts](src/domains/tenancy/sub-domains/member-roles/member-role.constants.ts) (`TENANCY_CUSTOM_ROLES_ENABLED`, checked by `member-role-capability.ts`).
- **Rationale**: the Roles screen of the Instagram DM product is four fixed roles (feat-instagram-dm-sending TN1, D55); Editor is the launch's Member renamed in place (`tenancy_roles_editor_viewer`), so its people keep their access. Custom roles are a platform feature this product switches off (TN3): the five role writes answer `403 custom_roles_off` after the permission gate, and a membership's `role_ids` must be exactly one system role. Role names are never the guard — every check reads `is_system` / `is_locked` and the codes.
- **Consequences of change**:
  - Adding an app code → name its Editor / Viewer holders in `APP_PERMISSION_DEFAULT_TEAM_GRANTS`; provisioning grants it to new teams and `reconcileDefaultTeamRoles` (every deploy, after the migrations) to existing ones. A migration that copies grants is optional.
  - Switching custom roles on → set the constant to true; the role writes and extra roles come back unchanged (the platform tests run with it on).
- **Last reviewed**: 2026-11-24

## ORGANIZATION_TYPE_CAPABILITY_MATRIX

- **Value**: A `PERSONAL` organization cannot exercise the team-only actions — add or invite members, manage custom roles, transfer ownership, delete the organization, manage billing, and use Instagram automation (the `app` domain — writes answer 422, reads `404 team_organization_required` through `assertTeamOrganizationForRead`); a `TEAM` organization can. The organization `type` is the **sole** determinant (no per-organization or plan-based variation today).
- **Source**: [src/domains/tenancy/sub-domains/organization/organization-capability.ts](src/domains/tenancy/sub-domains/organization/organization-capability.ts) (`assertTeamOrganization({ organization, capability })` enforces the rule; capability buckets `MEMBERS | ROLES | MUTATION | BILLING | INSTAGRAM`). Which routes are team-only is declared per route in [tooling/openapi/route-catalog/route-organization-scope.json](tooling/openapi/route-catalog/route-organization-scope.json) (gated by `pnpm validate:route-organization-scope`) and printed as `team` in the `O` column of [docs/routes.txt](docs/routes.txt).
- **Rationale**: There is **one** route surface for both organization types — no personal-only / team-only paths. The team-only actions are structurally unavailable to a single-owner personal workspace. Rather than fork the URL space, the team-only routes are backstopped by a single centralized guard; clients derive availability from the organization `type` (`PERSONAL` vs `TEAM`) and gate the action on the caller's permissions. The API response carries **no** `capabilities` object — it was a redundant projection of `type`; reintroduce a purpose-built `features`/`entitlements` object only if availability ever stops being purely type-derived. The team-only routes are the ones the route catalog marks `team` — read the list there rather than copying it here, so it cannot drift.
- **422-on-personal-organization policy**: `assertTeamOrganization` rejects a personal organization with **HTTP 422** (`unprocessable_entity`), not 409. The organization `type` is **immutable**, so an identical retry can never succeed — 409 (transient state conflict) would mislead clients into retrying. One `team` route answers a personal organization without that guard: `POST /api/v1/tenancy/organization/memberships/{membership_id}/restore` has no guard of its own — a personal workspace has no removed member to bring back, so it ends in 404 (or 409 `membership_not_deleted` for the owner's live membership). See [docs/reference/api/response-codes.md](docs/reference/api/response-codes.md) (`409 vs 422`) and [docs/reference/api/route-consistency-and-organization-model.md](docs/reference/api/route-consistency-and-organization-model.md).
- **Consequences of change**:
  - Adding a team-only action → call `assertTeamOrganization({ organization, capability: <bucket> })` in its service before the mutation, mark the route `team` in `route-organization-scope.json`, and run `pnpm routes:catalog`.
  - Allowing a personal organization to gain a team capability → would require making the organization `type` mutable; that changes the 422 rationale (a retry could then succeed) and must be reviewed against the response-code policy.
  - Re-introducing client-facing availability hints → build a purpose-named `features`/`entitlements` object (not a `type` mirror) when a real per-organization/plan need exists.
- **Last reviewed**: 2026-10-17

## SLUG_REGEX / UUID_REGEX

- **Value**: `^[a-z0-9]+(?:-[a-z0-9]+)*$` / standard 36-char UUID
- **Source**: [src/shared/constants/index.ts](src/shared/constants/index.ts)
- **Rationale**: Bounded patterns used for input validation. The slug regex disallows leading/trailing hyphens and consecutive hyphens — required by URL-segment hygiene and by Postgres index assumptions on slugged columns.
- **Consequences of change**: Loosening either invalidates URL constraints baked into routes and migrations.
- **Last reviewed**: 2026-05-28

## CONNECT_STATE_MINUTES

- **Value**: 10 minutes
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: How long a channel connection's one-use login state (routes 1 and 40, read and deleted by the callback, route 2) stays in Redis (routes-final § 1 MC4, P26, plan:L4567). Long enough for an owner to finish Meta's login screens; short enough that a leaked `state` is soon worthless. Nothing is lost when it goes — the owner starts the login again.
- **Consequences of change**:
  - Decreasing → slow logins (two-factor, choosing assets) fail with `channel_connect_state_invalid`.
  - Increasing → a leaked or abandoned state stays usable longer.
- **Last reviewed**: 2026-11-24

## PROFILE_READ_TIMEOUT_MILLISECONDS

- **Value**: 3000 ms
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: The longest one Instagram profile read may take during a pick (route 3, routes-final § 1 MC7) before the pick goes on without it — it fails open, the username is enough.
- **Consequences of change**:
  - Decreasing → more picks connect without the profile (filled by the connection's next daily token check).
  - Increasing → a slow Meta holds the owner's pick answer longer.
- **Last reviewed**: 2026-11-24

## META_USAGE_SLOW_PERCENT

- **Value**: 80 percent
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: From this Meta usage (the highest of `X-Business-Use-Case-Usage`'s call count, CPU time and total time for that asset and type, kept per connection — routes-final § 1 MC19, P51, S13) every channel's calls on the connection slow down (the reply lane's boxes double), the plan's rule (plan:L2353–L2360).
- **Consequences of change**:
  - Decreasing → slows earlier, wasting headroom.
  - Increasing → less room before Meta blocks the business.
- **Last reviewed**: 2026-11-24

## META_USAGE_WAIT_PERCENT

- **Value**: 95 percent
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: From this Meta usage every channel's calls on that connection wait until the time Meta gave (`estimated_time_to_regain_access`), else `META_USAGE_DEFAULT_WAIT_MINUTES` (routes-final § 1 MC19, P51).
- **Consequences of change**:
  - Decreasing → stops sending while Meta would still accept calls.
  - Increasing → Meta blocks the business before we stop, which costs longer than a wait.
- **Last reviewed**: 2026-11-24

## META_USAGE_DEFAULT_WAIT_MINUTES

- **Value**: 15 minutes
- **Source**: [src/shared/constants/instagram.constants.ts](src/shared/constants/instagram.constants.ts)
- **Rationale**: How long a connection at `META_USAGE_WAIT_PERCENT` waits when Meta's answer names no time to regain access (routes-final § 1 MC19).
- **Consequences of change**:
  - Decreasing → calls resume into a limit that may still be on.
  - Increasing → a business's sends stand still longer than Meta needs.
- **Last reviewed**: 2026-11-24
