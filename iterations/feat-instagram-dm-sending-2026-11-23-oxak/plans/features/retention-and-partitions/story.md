Status: draft
Kind: screen
Depends on: instagram-webhook-intake, instagram-sending-engine, broadcasts-and-segments
Route review: [routes-final.md](../../routes-final.md) — the tables without routes (Code layout) and § 4.B, § 5.B, § 6.B, § 7.C; worker-changes WC-47–WC-55, WC-62, WC-64

## Stories

- As an Owner I want history kept only as long as it is useful so that the people who wrote to us are protected and storage stays small.
- As the team I want the big tables split by time and cleaned by dropping old parts so that clean-ups never fall behind.

## Rules

- Keep times: webhook events and their keys 8 days, send attempts 8 days, messages 30 days, runs with their history and comment logs 90 days after the run ends, broadcast recipients 90 days, tag events 8 days, month counts 13 months, contacts until deleted (quality.retention; D15, D16, D50, D51)
- Split by time: webhook events (day), send attempts (day), messages (week of the run's start), runs and run history (month of the run's start), comment logs (month), webhook event keys (Meta's event day); broadcast recipients stay plain (data.split-tables, background.partition-upkeep; P33, P96)
- A run part is dropped only once every run in it ended over 90 days ago — 90 days or a little more, never sooner (quality.retention; P96)
- Parts are made at least 14 days ahead, once a day and at server start; dropped hourly with a short lock timeout, retried the next hour; an explicit default part raises an alert; upkeep runs under a maintenance scope, never the migration login (background.partition-upkeep; P33, P97)
- The clean-ups run hourly, each within about 10 minutes, capped per table at the plan's rows a day × 2; a gauge "oldest row past its keep time" per table alerts after 1 day (background.webhook-event-retention, background.send-attempt-retention, background.message-retention, background.run-retention, background.comment-log-retention, background.broadcast-recipient-retention, background.small-table-retention; P92)
- A deleted automation is purged with its counters once its runs and logs are gone; deleted broadcasts and segments 90 days after their delete; expired and revoked sessions and trusted devices hourly (background.deleted-automation-purge, background.broadcast-segment-purge, background.session-cleanup; P75)
- Counters survive the run clean-up (operations.automation-list-counters; D36)
- A run waiting 7 days for a button, follow, email or phone is cancelled `wait_expired` (background.waiting-run-cancel)

## Acceptance criteria

- AC-18.1 — Webhook events and their keys older than 8 days, and send attempts older than 8 days, are gone within the next hourly clean-up — intake-files/BRIEF.md:75
- AC-18.2 — Messages older than 30 days are gone; "What happened" shows about the last 30 days — intake-files/Instagram-DM-Sending-Plan-v8.md:261
- AC-18.3 — Runs, their history and comment logs are kept at least 90 days after the run ended and dropped soon after; no run is dropped sooner — plans/decisions.md P96
- AC-18.4 — Contacts are never removed by age — intake-files/Instagram-DM-Sending-Plan-v8.md:262
- AC-18.5 — Each split table always has its coming parts made at least 14 days ahead; a row that lands in the default part raises an alert — plans/decisions.md P97
- AC-18.6 — Dropping a part that is busy gives up quickly and succeeds on a later hour, without blocking sends or intake — plans/worker-changes.md WC-55
- AC-18.7 — Each clean-up stops after its time budget and its per-table cap; the "oldest row past its keep time" gauge alerts when a table is over a day behind — plans/decisions.md P92
- AC-18.8 — Automation counters stay the same after the runs they counted are deleted — intake-files/Instagram-DM-Sending-Plan-v8.md:247
- AC-18.9 — A deleted automation disappears for good after its runs and logs are gone; deleted broadcasts and segments 90 days after their delete — plans/decisions.md P75
- AC-18.10 — Partition upkeep and the clean-ups run under a maintenance scope; none uses the migration login — plans/decisions.md P33
- AC-18.11 — A run that has waited 7 days for her answer is cancelled `wait_expired`, and she can start again — plans/worker-changes.md WC-45

## Work items

- quality.retention
- data.split-tables
- background.partition-upkeep
- background.webhook-event-retention
- background.send-attempt-retention
- background.message-retention
- background.run-retention
- background.comment-log-retention
- background.broadcast-recipient-retention
- background.small-table-retention
- background.deleted-automation-purge
- background.broadcast-segment-purge
- background.session-cleanup
- background.waiting-run-cancel
- operations.automation-list-counters
