Status: ready
Kind: flow
Depends on: instagram-connection, webhook-events
Route review: [routes-final.md](../../routes-final.md) § 4.A — WH7–WH15 (with § 4.1 WH3–WH6; § 4.2 WQ1, WQ3, WQ4)
Tables: `app.instagram_webhook_events` (reads `app.instagram_accounts`, `app.instagram_account_settings`)

## Stories

- As Meta I want my subscription check answered when the verify token matches so that I can subscribe the app to the account's events.
- As Meta I want each delivery accepted quickly once its signature is checked so that I do not retry it or switch the subscription off.
- As an Owner or Admin I want every event stored once and handled in the order it arrived, one account at a time, so that a contact's steps happen in the right order and nothing is handled twice.
- As an Owner or Admin I want events that got stuck picked up again so that a crash never loses an event.
- As an Owner or Admin I want events skipped while automation is switched off or the account needs a reconnect so that nothing is sent when we do not want it.

## Rules

- Subscription check: the mode must be `subscribe` and the verify token must equal the configured one, compared in constant time; then the challenge is echoed; otherwise it is refused; without the setting it answers "not configured" (operations.webhook-verify; D20)
- A delivery is first checked against its signature — the raw body with the Instagram app secret; a missing or wrong signature is refused and nothing is read or stored; without the app secret it answers "not configured" (operations.webhook-receive, integrations.meta-signed-requests; D15)
- Each event is stored once, before Meta gets its answer; a repeat delivery stores nothing new; a store failure is never answered as a success, so Meta delivers again (operations.webhook-receive; D15)
- A signed body that cannot be read, or is not about Instagram, gets a success answer, stores nothing and leaves a warning (operations.webhook-receive; D15)
- Events of an Instagram account no team holds, or a revoked one, are not stored — one log line and a metric only (operations.webhook-receive; D28)
- Skipped at once with their reason: echoes (the account's own DMs and its own comments too), read receipts, reactions, edits and anything unsupported; `automation_disabled` while the switch is off; `account_disconnected` while the account is `expired` or `error`; a skipped event is never handled later, even when the switch goes back on (background.event-processing; D18, D19)
- A DM the team sends by hand comes back as an echo and is skipped; it does not reset the 24-hour opening-DM rule at launch (background.event-processing; D28)
- One Instagram account's events are handled one at a time, oldest first; different accounts are handled side by side (background.per-account-order; D15)
- Just before an event is handled, the account's status and switch are checked again (background.event-processing; D15)
- A temporary failure is retried a capped number of times (five) while the account's later events wait; then the event is `failed` with its error and the next one runs; a permanent failure fails at once; while Instagram is down handling pauses and spends no attempt (background.retry-policy; D16, D28)
- An event left `received` or `queued` for more than 5 minutes, and not being handled, is picked up again (background.stuck-event-pickup; D15)
- Handling works only inside the event's own organization (background.organization-scope; D21)
- Meta's deliveries are capped per sender well above Meta's own traffic, so a viral post is never throttled while a flood of unsigned requests is (quality.rate-limit; D21)
- An event's status says how its handling went, not how a run went; a failed event tells nobody — it shows in the webhook-event list (background.event-processing; D13)
- Logs never carry the payload, message or comment text, emails or phone numbers (quality.log-masking; D21)

## Acceptance criteria

- AC-7.1 — The subscription check echoes the challenge as plain text when the mode is `subscribe` and the verify token matches; a wrong mode or token is refused with `invalid_webhook_verify_token` — intake-files/schema-routes.md:508
- AC-7.2 — Without the verify token setting (subscription check) or the app secret (delivery), Meta's call is answered `instagram_webhook_not_configured` and nothing is stored — intake-files/PRD.md:17
- AC-7.3 — A delivery whose signature is missing, malformed or not the HMAC-SHA256 of the raw body with the app secret is refused with `invalid_webhook_signature`, and nothing is read or stored — intake-files/PRD.md:18
- AC-7.4 — A correctly signed delivery is answered `OK` once its events are stored, each event once; the same delivery sent again stores nothing new — intake-files/schema-routes.md:527
- AC-7.5 — When the events cannot be stored, Meta does not get a success answer, so it delivers again; the part already stored is not stored twice — plans/decisions.md D15
- AC-7.6 — A signed body that is not JSON, or whose `object` is not `instagram`, is answered `OK`, stores nothing and leaves a warning in the log — intake-files/PRD.md:22
- AC-7.7 — Events for an Instagram account no team holds, or a revoked one, are answered `OK` and not stored; a log line and a metric count them — plans/decisions.md D28
- AC-7.8 — An entry without an Instagram account id is dropped with a log line — intake-files/PRD.md:28
- AC-7.9 — Echoes (the account's own DMs and its own comments included), read receipts, reactions, edits and unsupported items are stored `skipped` with that reason and never handled — intake-files/schema-routes.md:528
- AC-7.10 — With the automation switch off, events are stored `skipped` · `automation_disabled`; with the account `expired` or `error`, `skipped` · `account_disconnected`; switching back on never handles them — intake-files/PRD.md:78
- AC-7.11 — An event that waited while the switch went off, or while the account broke, is `skipped` with that reason when its turn comes — plans/decisions.md D15
- AC-7.12 — One Instagram account's events are handled one at a time, oldest first; different accounts' events are handled side by side — intake-files/schema-routes.md:529
- AC-7.13 — An event that keeps failing with a temporary error holds back its account's later events and is marked `failed` with its error after its fifth attempt; the account's next event then runs — plans/decisions.md D28
- AC-7.14 — A permanent failure marks the event `failed` at once; while Instagram is down, handling pauses and spends no attempt — plans/decisions.md D16
- AC-7.15 — An event still `received` or `queued` more than 5 minutes after it arrived, and not being handled, is picked up again and handled once — intake-files/schema-routes.md:530
- AC-7.16 — Every handled event ends `processed`, `skipped` or `failed` with its finish time; a `failed` one carries a short error code, never payload text — plans/decisions.md D16
- AC-7.17 — Signed deliveries from one sender are accepted far above Meta's usual rate (the cap is 1,200 a minute, routes-final WH11); past the cap a sender is refused with `rate_limited` — plans/decisions.md D21
- AC-7.18 — The log lines of the receiver and of event handling never carry the payload, message or comment text, emails or phone numbers — intake-files/PRD.md:176
- AC-7.19 — A DM the team sends by hand comes back as an echo, is skipped, and does not reset the 24-hour opening-DM rule — plans/decisions.md D28

## Work items

- operations.webhook-verify
- operations.webhook-receive
- background.event-processing
- background.stuck-event-pickup
- background.per-account-order
- background.retry-policy
- background.organization-scope
- quality.rate-limit
- quality.log-masking
