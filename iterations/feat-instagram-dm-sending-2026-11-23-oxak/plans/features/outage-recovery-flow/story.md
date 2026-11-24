Status: draft
Kind: flow
Depends on: instagram-webhook-intake, instagram-sending-engine, retention-and-partitions
Route review: [routes-final.md](../../routes-final.md) § 5 (receiver), § 6 (engine); worker-changes WC-12–WC-14, WC-20–WC-22, WC-26

## Stories

- As an Owner I want my DMs safe when Postgres restarts, Redis is lost or Instagram is down so that people still get their answers afterwards, once.
- As the team I want the system to recover by itself, and a restore to never send, so that an outage never needs hand repair or causes spam.

## Rules

- Postgres down or slow: the webhook answers a failure and keeps nothing in Redis, so Meta delivers again; missed comments are found by the full pass afterwards (integrations.instagram-webhook-save, background.missed-comment-check; P32, P93)
- A Postgres error before the `sending` commit: nothing was sent and the ticket comes back after 1, 2, 4, 8 seconds; after Meta answered, the result save is retried inside the send, then the message is settled `unknown` by its lease and never resent by itself (background.stuck-send-settle, operations.automation-unknown-outcome; D17, P32)
- Redis down: webhooks still save; sending waits because tickets live in Redis; after Redis comes back (with data, empty or replaced) no count is trusted until rebuilt from Postgres and the repair re-adds every due ticket with a small spread; nothing is sent twice (background.send-count-rebuild, background.lost-turn-repair; plan §31.5)
- After 1 minute of Redis or Postgres down the banner says "Your DMs are safe. Sending waits for a technical reason" (operations.instagram-account-banners)
- Instagram down: one account stops after 3 bad results in a row for 5, 10, 20, 40 minutes; every account stops when 30 % of 50 calls in 30 s fail or 30 % of accounts are down; a read-only call tests first, then one DM; lanes are released over 5 minutes at half speed (background.outage-check; plan §33.5, §33.6)
- A restore or copy never sends: the environment id and `SENDING_ENABLED` outside the database; after a restore, rows of the lost time become `unknown` (DMs) or `skipped` (replies, hides) and restore mode saves "already sent" as `sent` (quality.restore-never-sends; D20)
- Intake is never paused by an outage (background.intake; P47)

## Acceptance criteria

- AC-27.1 — With Postgres down, a webhook delivery answers a failure and nothing is written to Redis; Meta's redelivery after Postgres is back is saved once — plans/decisions.md P32
- AC-27.2 — Comments that Meta never redelivered are found by the full missed-comment pass after the outage (7 days, 25 posts per account, lowest priority) and answered once — plans/decisions.md P93
- AC-27.3 — A Postgres restart before the `sending` commit sends nothing and the same message goes after the retry; one after Meta answered settles the message `sent` (when its Instagram id is known) or `unknown`, never sent twice — intake-files/Instagram-DM-Sending-Plan-v8.md:6005
- AC-27.4 — An `unknown` message is never sent again by a repair, a retry or a restart — intake-files/BRIEF.md:72
- AC-27.5 — Redis dies at 11:00 and comes back empty at 11:03: by 11:05 every due lane has its ticket again, the hour counts are rebuilt from Postgres, and account A sends only what is left of its hour limit — intake-files/Instagram-DM-Sending-Plan-v8.md:5801
- AC-27.6 — While Redis or Postgres has been down over 1 minute, the sending status shows the "Your DMs are safe" banner — intake-files/Instagram-DM-Sending-Plan-v8.md:2548
- AC-27.7 — Three bad results in a row on one account stop only that account for 5 minutes, growing to 40; a test after the stop first reads the profile, then sends one DM — intake-files/Instagram-DM-Sending-Plan-v8.md:5964
- AC-27.8 — 30 % of 50 calls failing in 30 seconds stops every account; after a good test lanes are released over 5 minutes at half speed — intake-files/Instagram-DM-Sending-Plan-v8.md:5967
- AC-27.9 — During an Instagram outage webhooks are still saved and intake still decides; when it ends the waiting messages go without being sent twice — plans/decisions.md P47
- AC-27.10 — A database restored to 13:00 sends nothing until the team switches sending on; messages of the lost time are `unknown` (DMs) or `skipped` (replies, hides) and none is sent again by itself — intake-files/Instagram-DM-Sending-Plan-v8.md:7066
- AC-27.11 — A copy of production whose environment id differs from the server's never sends, whatever `SENDING_ENABLED` says — intake-files/BRIEF.md:76

## Work items

- integrations.instagram-webhook-save
- background.missed-comment-check
- background.stuck-event-pickup
- background.stuck-send-settle
- background.send-count-rebuild
- background.lost-turn-repair
- background.outage-check
- background.intake
- operations.automation-unknown-outcome
- operations.instagram-account-banners
- quality.restore-never-sends
