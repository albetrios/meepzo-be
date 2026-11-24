Status: draft
Kind: flow
Depends on: plans-billing-and-trial, channel-accounts, automations, broadcasts-and-segments, past-comments
Route review: [routes-final.md](../../routes-final.md) § 8.B (change plan), § 1B (choose active); worker-changes WC-38

## Stories

- As an Owner I want to move to a smaller plan at the end of my billing period, keeping the accounts I choose, so that I pay less without breaking anything.
- As an Owner I want my automations to keep running after a move down, with only the parts my new plan lacks switched off, so that my followers are still answered.

## Rules

- A move down waits for the period end (a Stripe subscription schedule) and takes the accounts to keep; the choice can change until then; with no choice the oldest-connected accounts stay (billing.plan-downgrade; D57, P77)
- At the period end accounts not kept get `plan_downgrade` on all four lanes; their webhooks are still saved and the 7-day rule applies (billing.plan-downgrade, background.plan-change; D57)
- Automations are never stopped: exactly the switches the new plan lacks are off — email and phone steps skipped (a run waiting for them moves on), "Reply like a person" works as OFF, only the first reply line, only version A, no extra delay, scheduled and waiting broadcasts `cancelled` · `plan_feature_off`, an unfinished past-comments read `failed` · `plan_feature_off`; nothing is deleted (billing.plan-feature-switches; D57, P83)
- Segments made earlier stay saved and unusable until an upgrade (operations.segment; P76)
- A notice and an email once name what was switched off (notifications.owner-emails; D57)
- If the month count is at or over the new limit, the plan stop starts at once (billing.plan-message-month-limit)
- "Choose active accounts" stays available at any time within the plan's limit (operations.channel-account-choose-active)
- Moving up again clears every `plan_downgrade` stop and switches the PRO parts back on (billing.plan-downgrade)

## Acceptance criteria

- AC-23.1 — A Studio organization with 6 accounts moving to Creator on 10 December keeps A, B and C; nothing changes until 31 December, when the other 3 accounts stop with `plan_downgrade` — intake-files/Instagram-DM-Sending-Plan-v8.md:8027
- AC-23.2 — Before the period end the owner may change which accounts are kept; with no choice the oldest-connected stay — intake-files/Instagram-DM-Sending-Plan-v8.md:8110
- AC-23.3 — After a Creator → Free move, automation GUIDE keeps running: Riya's run skips the email step, replies go right after each DM using the first line only, and only hello version A is used — intake-files/Instagram-DM-Sending-Plan-v8.md:8029
- AC-23.4 — A run waiting for her email when the move takes effect moves on to its next step — intake-files/Instagram-DM-Sending-Plan-v8.md:8009
- AC-23.5 — Scheduled and "when her chat opens" broadcasts end `cancelled` · `plan_feature_off`; drafts and segments stay — intake-files/Instagram-DM-Sending-Plan-v8.md:8014
- AC-23.6 — An unfinished past-comments read ends `failed` · `plan_feature_off`; the opening DMs it already queued still go — intake-files/Instagram-DM-Sending-Plan-v8.md:8015
- AC-23.7 — No automation, step, line, version or segment is deleted; the editor still saves the rest of an automation whose PRO step is on, and turning a PRO step on is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:8018
- AC-23.8 — The owner gets one notice and one email "Moved to Free: email and phone steps are off in 3 automations" — intake-files/Instagram-DM-Sending-Plan-v8.md:2557
- AC-23.9 — A month count already over the new limit starts the `plan_limit` stop at once — intake-files/Instagram-DM-Sending-Plan-v8.md:8024
- AC-23.10 — Moving up again clears every `plan_downgrade` stop and the PRO parts work again without any edit — intake-files/Instagram-DM-Sending-Plan-v8.md:2629
- AC-23.11 — Moving down, PRO gating and draft / live / paused behave as D28, D35 and D57 say — intake-files/BRIEF.md:74

## Work items

- billing.plan-downgrade
- billing.plan-feature-switches
- billing.plan-message-month-limit
- operations.channel-account-choose-active
- operations.segment
- notifications.owner-emails
- background.plan-change
- integrations.stripe-subscription-schedule
- quality.read-only-plan
