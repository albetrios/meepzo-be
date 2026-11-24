Status: draft
Kind: flow
Depends on: plans-billing-and-trial, channel-connection, plan-move-down-flow
Route review: [routes-final.md](../../routes-final.md) § 8.B (trial), § 8.D (Stripe webhook); worker-changes WC-59

## Stories

- As an Owner I want to try Creator or Studio for 7 days without a card so that I see the paid features with my real accounts.
- As an Owner I want to be reminded before the trial ends so that I can add a card in time.
- As an Owner who does not add a card I want to land on Free without losing anything so that I can upgrade later.

## Rules

- 7 days, no card, once per organization and once per Instagram account in any organization (billing.paid-trial; D73)
- The trial gives the plan's full features and limits; a plan change during the trial keeps the same end date (billing.paid-trial)
- Notices and emails 3 days and 1 day before the end (billing.paid-trial, background.plan-state-check; D73)
- With a card the plan goes on paid; without one the organization moves to Free by the move-down rule, keeping the accounts picked in advance or the oldest-connected (billing.paid-trial, billing.plan-downgrade; D57, D73)

## Acceptance criteria

- AC-24.1 — The owner starts a Creator trial on 1 December and connects accounts A and B; both send, and an email step goes live — intake-files/Instagram-DM-Sending-Plan-v8.md:8113
- AC-24.2 — On 5 and 7 December the owner gets the "trial ends" notice and email — intake-files/Instagram-DM-Sending-Plan-v8.md:8107
- AC-24.3 — With no card at the end, the organization is on Free: one account kept (the picked one, else the oldest-connected), the other stopped with `plan_downgrade`, PRO parts off by the plan, nothing deleted — intake-files/Instagram-DM-Sending-Plan-v8.md:8109
- AC-24.4 — With a card added, the plan goes on paid at the end with no gap in sending — intake-files/Instagram-DM-Sending-Plan-v8.md:8097
- AC-24.5 — A second trial in the same organization, or connecting during a trial an account that had a trial elsewhere, is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:8104
- AC-24.6 — Changing from a Creator trial to a Studio trial keeps the same end date — intake-files/Instagram-DM-Sending-Plan-v8.md:8106

## Work items

- billing.paid-trial
- billing.plan-downgrade
- background.plan-state-check
- data.trial-account
- notifications.trial-and-plan-choice
