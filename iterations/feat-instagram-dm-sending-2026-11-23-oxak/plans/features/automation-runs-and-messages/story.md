Status: draft
Kind: screen
Depends on: automations, contacts, instagram-sending-engine
Route review: [routes-final.md](../../routes-final.md) § 4.B, § 3.A routes 24–26, § 4.A routes 36–37, § 6 route 63 — built with sub-domain 6 (CA5)

## Stories

- As any member I want to open "What happened" on a contact so that I see our messages to her, her saved answers and her runs.
- As an Owner, Admin or Editor I want to retry the failed messages of an automation or a contact, seeing first how many can go again, so that an outage does not cost me leads.
- As any member I want each account's sending status — what waits in each lane, every stop with its reason and end, the estimate — so that the banners tell me the truth.
- As an Owner I want a message whose result was unclear never sent again by itself so that nobody gets a DM twice.

## Rules

- "What happened" shows our messages of about the last 30 days, her saved answers (email, phone, taps) and her runs with their history (90 days); her own free text is never kept (operations.contact-timeline; D46, D50, P13)
- Retry takes only `failed` messages of about the last 30 days, never `unknown`, `skipped`, `expired`, `cancelled` or broadcast messages, each at most once ever (operations.instagram-message-retry-failed; D72)
- A failed message goes back to `waiting` only when allowed now: an opening private reply still within its comment's 7 days minus 30 minutes, any other DM with her window open, not final for her (blocked us, not found, no consent, another app, opted out, paused), not while the automation is stopped for a refused text, not when another open run of the automation for her holds it (operations.instagram-message-retry-failed; plan §33.10)
- The count the owner sees first uses the same check, reads only, and changes nothing (operations.instagram-message-retry-failed)
- Retried messages go through the normal lanes, gates and limits and count in the month when sent; a second failure stays `failed` for good (operations.instagram-message-retry-failed, background.send-gates)
- Retry on an automation needs `automation:update`; on a contact `contact:update`; both are audited (access.contact-update-code; P20)
- Retry needs an idempotency key (it starts background work) (quality.idempotency; P89)
- An `unknown` result is never resent automatically; only her next message or tap may send that step once more (operations.automation-unknown-outcome; D17)
- The sending status answers, per account: waiting per lane, each stop with reason and end, paused or suspended, the new-account limit, the estimate of "will go / may expire", and the daily line (operations.instagram-account-banners, operations.instagram-pending-estimate; D10)
- Banner numbers come from a copy of at most 10 seconds, or Postgres without one (operations.instagram-account-banners; P5)

## Acceptance criteria

- AC-7.1 — "What happened" on a contact lists our messages of about the last 30 days with status and reason, her saved email, phone and taps, and her runs with their history; none of her own free text appears — intake-files/Instagram-DM-Sending-Plan-v8.md:2627
- AC-7.2 — The retry summary of an automation answers the failed messages of about the last 30 days, how many can go again and how many cannot with their reasons (too old, chat closed, final for her, text still refused, broadcast), and changes nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:6036
- AC-7.3 — Retrying puts exactly the allowed failed messages back to `waiting`, marks each retried, wakes their lanes, and they then go through the normal limits and count in the month when sent — intake-files/Instagram-DM-Sending-Plan-v8.md:2791
- AC-7.4 — A message already retried once, an `unknown`, `skipped`, `expired` or `cancelled` message, and a broadcast message are never put back by a retry — intake-files/Instagram-DM-Sending-Plan-v8.md:6029
- AC-7.5 — An opening private reply whose comment is older than 7 days minus 30 minutes, or a DM whose window is closed, stays `failed` on retry — intake-files/Instagram-DM-Sending-Plan-v8.md:6031
- AC-7.6 — A message whose last error is final for the person (she blocked us, not found, no consent, another app), or whose person is opted out or paused, stays `failed` on retry — intake-files/Instagram-DM-Sending-Plan-v8.md:6033
- AC-7.7 — While the automation is stopped for a refused text, its failed messages are not retried until the text is fixed — intake-files/Instagram-DM-Sending-Plan-v8.md:6034
- AC-7.8 — A retried message that fails again stays `failed` and is never retried again — intake-files/Instagram-DM-Sending-Plan-v8.md:6040
- AC-7.9 — The contact's retry summary and retry do the same for that one person — intake-files/Instagram-DM-Sending-Plan-v8.md:2702
- AC-7.10 — A Viewer is refused both retries with `missing_permission`; an Editor may retry; each retry leaves one audit entry — intake-files/Instagram-DM-Sending-Plan-v8.md:7889
- AC-7.11 — A retry without an idempotency key is refused; repeated with the same key it starts nothing twice — plans/decisions.md P89
- AC-7.12 — The sending status of an account answers the waiting count per lane, every stop with its reason and end time, paused or suspended, the new-account limit's end, the "will go / may expire" estimate and today's sent, not sure, skipped and expired counts — intake-files/Instagram-DM-Sending-Plan-v8.md:2532
- AC-7.13 — A message whose send result is `unknown` is never sent again by any job; her next message or tap may send that step once more, as the same row — intake-files/BRIEF.md:72

## Work items

- operations.contact-timeline
- operations.instagram-message-retry-failed
- operations.automation-unknown-outcome
- operations.instagram-account-banners
- operations.instagram-pending-estimate
- background.send-gates
- access.contact-update-code
- quality.idempotency
- quality.audit
- background.retry-failed
- data.automation-run
- data.automation-run-open-key
- data.run-states
