Status: draft
Kind: flow
Depends on: organization-usage-and-notices, instagram-sending-engine, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 6 (the month count), § 8 (plan limits); worker-changes WC-37, WC-56

## Stories

- As an Owner on a plan with a monthly DM limit I want new DMs to stop at the limit while comment replies go on so that I never pay for more than my plan and my followers still see answers.
- As an Owner I want to be told at 80 % and at 100 % so that I can upgrade in time.
- As an Owner I want sending to start again on the 1st or right after I upgrade so that waiting people still get their DMs.

## Rules

- The month count is per organization, every account and channel together, in the organization's time zone; it is checked in the same commit as each send and may go over by the few DMs on their way (billing.plan-message-month-limit; D34, D18)
- At 100 %, only new DMs stop: the slow, fast and broadcast lanes of every account get the plan stop; the reply lane keeps going for DMs already sent (billing.plan-message-month-limit; D62, P3)
- Waiting DMs stay waiting; one whose 7 days end behind the limit becomes `expired` · `plan_limit` (operations.instagram-message-expiry; D62)
- Go-live is refused while the limit is reached (operations.automation-go-live-check; D34)
- The stop ends at 00:00 on the 1st in the organization's time zone, or at an upgrade whose limit is above the count; lanes wake spread over 5 minutes (background.month-wake; D34)
- Notice and email at 80 % and at 100 %, each once per organization per month (background.month-limit-notice; D34)

## Acceptance criteria

- AC-22.1 — A Free organization at 820 of 1,000 DMs gets one "820 of 1,000 DMs used this month" notice and email — intake-files/Instagram-DM-Sending-Plan-v8.md:2775
- AC-22.2 — At the 1,000th DM the slow, fast and broadcast lanes of every account of the organization stop with `plan_limit`; public replies and hides of DMs already sent still go — intake-files/BRIEF.md:73
- AC-22.3 — A tap at 15:10 after the limit waits; 40 opening DMs wait; none is sent until the stop ends — intake-files/Instagram-DM-Sending-Plan-v8.md:2775
- AC-22.4 — Two accounts sending at the same moment never push the count more than the DMs on their way over the limit — intake-files/Instagram-DM-Sending-Plan-v8.md:2025
- AC-22.5 — Go-live is refused while the limit is reached — intake-files/Instagram-DM-Sending-Plan-v8.md:2030
- AC-22.6 — At 00:00 on the 1st in the organization's time zone the count is 0, the stops end, and the waiting DMs under 7 days go; answers whose window closed meanwhile are `skipped` — intake-files/Instagram-DM-Sending-Plan-v8.md:2040
- AC-22.7 — An upgrade whose limit is above the count ends the stop at once and wakes the lanes — intake-files/Instagram-DM-Sending-Plan-v8.md:2029
- AC-22.8 — A waiting DM whose 7 days end while the limit is reached becomes `expired` · `plan_limit` — intake-files/Instagram-DM-Sending-Plan-v8.md:273
- AC-22.9 — With Redis saying "full" but Postgres under the limit, sending continues; Postgres decides — intake-files/Instagram-DM-Sending-Plan-v8.md:2026

## Work items

- billing.plan-message-month-limit
- operations.instagram-message-expiry
- operations.automation-go-live-check
- operations.organization-notices
- background.send-gates
- background.month-wake
- background.month-limit-notice
- data.message-month-count
- notifications.month-limit
