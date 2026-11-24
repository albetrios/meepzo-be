Status: draft
Kind: screen
Depends on: channel-accounts, instagram-account-settings, automations, instagram-webhook-intake, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 6 — routes 63–64 (6.A sending, 6.B messages, 6.C attachments); the lane steps of routes 3, 8–11, 24–26, 36–37

## Stories

- As an Owner I want every message to wait in Postgres and go at a human-like pace within Meta's limits so that my account is never flagged.
- As an Owner I want each account to have its own four lanes — slow, reply, fast, broadcast — so that one account's trouble never slows another.
- As an Owner I want an Instagram error to stop only the affected account's lane, test itself and start again by itself so that sending recovers without me.
- As an Owner I want nothing ever sent twice and nothing sent from a restored or copied database so that nobody is spammed.
- As the team I want the engine to survive a restart, a rollback and Redis being lost so that sending never needs hand repair.

## Rules

- Every message is a `waiting` row in Postgres; Redis holds tickets, quick counts, short notes and copies, is never the last check and is never called inside a transaction (background.channel-send-interface, quality.redis-notes; D18, P32)
- Four lanes per account: slow (opening private replies, one at a time), reply (public replies and hides, one at a time), fast (every other DM, Live private replies, nudges, "Seen", many at once), broadcast (one at a time, lowest priority); shared queues, never one per account (background.sending-lanes; D3, D4)
- Opening DMs: one at a random second in each box (3600 ÷ hour limit), at least 1.5 seconds apart, missed boxes never sent together; picked new 4 : 1 old, urgent ones first; one opening DM per person per 24 hours while her window is closed (background.slow-lane-send, operations.instagram-timing-boxes; D5–D8)
- Fast messages: a random 500–2,000 ms after her action, at most 20 at once per account, one per person at a time, 10,000 an hour, 60 per person an hour from Postgres; her window checked before each (background.fast-message-send; D11)
- Public replies: reply step OFF goes right after the DM; "Reply like a person" ON paces them by chance, hour box and gap and never repeats the last line; a hide follows the reply and a failed hide stops nothing (background.reply-lane-send; D32, D33)
- Two gates plus the month: a Redis count before the transaction, Postgres minute counts in the same commit that sets `sending`, and the month count in that commit; Postgres decides (background.send-gates; D18, D34)
- An `unknown` result is never resent by itself; only her next message or tap may send that step once more as the same row; a result save that fails is retried inside the send (operations.automation-unknown-outcome; D17, P32)
- Instagram errors stop only the affected account's lane; a test message ends the stop; half speed for 1 hour after "too fast", 24 hours after a block; code 4 is an app limit only without a subcode and from 2 accounts within 5 minutes (background.instagram-error-stops, background.outage-check; D19)
- A token error stops every account of the connection at once (background.instagram-error-stops; plan §25.8)
- 7-day rule: an opening DM or public reply waits at most 7 days minus 30 minutes after the comment, then `expired`; messages after the hello whose window closed are `skipped` · `window_closed` (operations.instagram-message-expiry, background.message-expiry, background.window-closed-skip; D9)
- Meta's usage per connection is read before each call: 80 % slows, 95 % waits (background.meta-usage-per-connection; P51)
- Every DM counts one in the organization's month; public replies, hides, follow checks and "Seen" do not (operations.instagram-dm-counting; D34)
- One open run per automation and person is held by an open-run key written and deleted in the run's own commits; a repair removes keys of ended runs (data.split-tables, background.open-run-key-repair; P100)
- The repair duties run every minute, one scheduled run per duty in parallel, each within a 40-second budget, re-adding lost tickets in bulk (background.lost-turn-repair, background.stuck-send-settle; P7, P73, P94)
- Every wait is a delayed ticket: a worker never waits (background.sending-lanes; plan §2.1)
- An in-process database limiter caps the send, intake and task workers' connections; the send workers run as their own service (quality.connection-budget, quality.worker-places; P91)
- A restore or copy never sends: the environment id must match and `SENDING_ENABLED` (default off, outside the database) must be on (quality.restore-never-sends; D20, P74)
- Each release writes its minimum compatible settings version; an older server below it takes no tickets, an older compatible one does; a server finishes its sends within 30 seconds at shutdown (quality.rolling-deploy, quality.sending-settings; D21, P95)
- Every number lives in one app constants file; environment-varying values are env flags with production-safe defaults (quality.sending-settings; D22, P4)
- After Redis is lost, counts are rebuilt from Postgres and tickets re-added with a small spread; nothing is sent twice (background.send-count-rebuild; plan §31.5)
- The server clock is checked against Postgres every minute; over 2 seconds apart, the server stops sending (background.clock-check)
- The "will go / may expire" estimate is worked out every 10 minutes per account (operations.instagram-pending-estimate, background.waiting-estimate; D10)
- Backpressure on a slow Postgres, the poison-ticket rule and the other operations items listed in KICKOFF.md's open items are after-launch work, not built here (operations.after-launch)

## Acceptance criteria

- AC-17.1 — With an opening limit of 600 an hour, opening DMs of one account go one per 6-second box at a random second, never two in one box and at least 1.5 seconds apart — intake-files/Instagram-DM-Sending-Plan-v8.md:217
- AC-17.2 — 2,000 comments on one post at 10:00 are all saved and their opening DMs go one per box; 200 taps in one second are answered within about 12 seconds, at most 20 at once — intake-files/Instagram-DM-Sending-Plan-v8.md:2745
- AC-17.3 — Her comment with her window closed gets the opening DM as a private reply in the slow lane; with her window open it goes as a normal DM in the fast lane within 2 seconds, outside the 600 an hour, counting 1 DM in the month — intake-files/Instagram-DM-Sending-Plan-v8.md:2743
- AC-17.4 — A second opening private reply to the same person within 24 hours waits until the 24 hours pass — intake-files/Instagram-DM-Sending-Plan-v8.md:219
- AC-17.5 — A tap gets the next step after a random 500–2,000 ms; a message list's waits are kept; a message whose window closed is `skipped` · `window_closed` and no later message of that run is made — intake-files/Instagram-DM-Sending-Plan-v8.md:2765
- AC-17.6 — The nudge goes once, 60 minutes after the hello, with the same version, only when she wrote first; her tap before it cancels the nudge — intake-files/Instagram-DM-Sending-Plan-v8.md:2767
- AC-17.7 — "Reply like a person" OFF posts the public reply right after the DM; ON posts it by its chance, hour box and 20-second gap, never with the automation's last line; the hide follows the reply and a failed hide changes nothing else — intake-files/Instagram-DM-Sending-Plan-v8.md:2777
- AC-17.8 — Gate 2 adds the minute count in the same commit that sets `sending`; with Redis empty the Postgres counts still hold every limit — intake-files/BRIEF.md:71
- AC-17.9 — A send whose result is unclear is saved `unknown` and is never sent again by any job; her next message or tap sends that step once more as the same row — intake-files/BRIEF.md:72
- AC-17.10 — A block on account A's slow lane stops A's DM lanes and its replies and hides; other accounts, also A's sister account in the same organization, keep sending; a test the next day ends the stop and A sends at half speed for 24 hours — intake-files/Instagram-DM-Sending-Plan-v8.md:2759
- AC-17.11 — "Too fast" on one lane gives that lane half speed for 1 hour; code 4 with a subcode stops only that account's lane; code 4 without a subcode from 2 accounts within 5 minutes stops every account as the app limit — intake-files/Instagram-DM-Sending-Plan-v8.md:230
- AC-17.12 — A token error on a send stops every account of that connection at once and gives each account one reconnect notice — intake-files/Instagram-DM-Sending-Plan-v8.md:4656
- AC-17.13 — An opening DM still waiting 7 days minus 30 minutes after its comment becomes `expired` and is never sent — intake-files/Instagram-DM-Sending-Plan-v8.md:2757
- AC-17.14 — The follow check is tried twice; both failing, she is treated as following and the next step goes — intake-files/Instagram-DM-Sending-Plan-v8.md:2751
- AC-17.15 — Two automations on one post share one unanswered opening message; her one tap moves both; email is asked once; both message lists go one message at a time — intake-files/Instagram-DM-Sending-Plan-v8.md:2761
- AC-17.16 — With the connection at 95 % of Meta's usage the account's calls wait the time Meta gave (or 15 minutes); at 80 % the boxes double — plans/decisions.md P51
- AC-17.17 — Every DM kind counts one in the month; public replies, hides, follow checks and "Seen" do not; a picture with a text counts two — intake-files/Instagram-DM-Sending-Plan-v8.md:1997
- AC-17.18 — At most one open run exists per automation and person at any time, also under two intake jobs at once; a key whose run ended is removed by the repair within a minute — plans/decisions.md P100
- AC-17.19 — A lane whose ticket was lost gets a new turn within about a minute; a send whose lease ran out is settled as `unknown` and not resent — plans/worker-changes.md WC-13
- AC-17.20 — With more send work than database slots, the workers wait for a slot up to 2 seconds and then put the ticket back; the connection count never exceeds the budget — plans/decisions.md P91
- AC-17.21 — With `SENDING_ENABLED` off, or an environment id that differs from the database's, no worker or repair sends anything while webhooks are still saved — intake-files/BRIEF.md:76
- AC-17.22 — A server older than the release's minimum compatible settings version takes no tickets; an older compatible one does; a stopping server finishes its sends within 30 seconds — plans/decisions.md P95
- AC-17.23 — A server whose clock is over 2 seconds from Postgres's sends nothing until it is back in line — plans/worker-changes.md WC-23
- AC-17.24 — An account's estimate of "will go / may expire" is refreshed every 10 minutes and answered by its sending status — intake-files/Instagram-DM-Sending-Plan-v8.md:221
- AC-17.25 — The engine's numbers live in one constants file; a value that varies by environment is an env flag whose default is production-safe (`SENDING_ENABLED` off by default, on in the template) — plans/decisions.md P74

## Work items

- background.channel-send-interface
- background.sending-lanes
- background.slow-lane-send
- background.reply-lane-send
- background.fast-message-send
- background.broadcast-lane-send
- background.send-gates
- background.instagram-error-stops
- background.outage-check
- background.meta-usage-per-connection
- background.message-expiry
- background.window-closed-skip
- background.reply-backlog-trim
- background.paused-automation-cancel
- background.lost-turn-repair
- background.stuck-send-settle
- background.send-count-upkeep
- background.send-count-rebuild
- background.clock-check
- background.waiting-estimate
- background.open-run-key-repair
- background.starter-question-sync
- background.month-wake
- operations.instagram-send-limits
- operations.instagram-timing-boxes
- operations.instagram-message-expiry
- operations.instagram-pending-estimate
- operations.instagram-dm-counting
- operations.automation-unknown-outcome
- operations.automation-step-follow
- data.split-tables
- quality.redis-notes
- quality.connection-budget
- quality.worker-places
- quality.restore-never-sends
- quality.rolling-deploy
- quality.sending-settings
- quality.sending-health
- access.global-sending-tables
- background.account-stops
- background.fast-messages
- background.helper-one-run-per-duty
- background.helper-never-sends
- background.helper-cross-organization-reads
- background.helper-per-server-duties
- background.helper-open-run-key-repair
- background.instagram-owned-work
- background.message-sends
- background.never-send-twice
- background.never-waits
- background.opening-turn
- background.reply-turn
- background.scale-defaults
- background.times
- data.instagram-sending
- data.lane-states
- data.message-states
- data.sending-state
- data.kickoff-defaults
- integrations.instagram-messaging
- integrations.send-pause
- operations.automation-window-table
- quality.capacity
- quality.database-links
- quality.scale-defaults
- quality.gates
