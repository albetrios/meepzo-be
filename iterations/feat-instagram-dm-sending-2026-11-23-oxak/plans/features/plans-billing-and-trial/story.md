Status: draft
Kind: screen
Depends on: none
Route review: [routes-final.md](../../routes-final.md) § 8 — routes 100–108 (8.A plans, 8.B subscriptions and states, 8.C cards, 8.D Stripe webhook)

## Stories

- As an Owner or Admin I want to compare Free, Creator and Studio with their limits and features so that I pick the right plan.
- As an Owner or Admin I want to try Creator or Studio for 7 days without a card so that I see the paid features before paying.
- As an Owner or Admin I want to move up at once, or down at the end of my billing period choosing which accounts stay, so that I only pay for what I use.
- As an Owner or Admin I want to remove a card and choose the default card so that billing uses the card I want.
- As the system I want every plan state — free, paid, trial, payment failed, plan ended, organization paused — applied to sending so that what the owner pays for is what runs.

## Rules

- Three plans: Free (1,000 messages a month, 1 account), Creator (10,000, 3), Studio (50,000, 10, priority support); prices are placeholders until go-live (billing.flowdm-plans; D26, D34, P37)
- A plan's typed features hold the limits (`message_month_limit`, `channel_accounts_max`), `has_priority_support` and one on / off switch per feature key — email ask, phone ask, reply like a person, more than one public reply line, message versions, broadcasts, segments, past comments, extra delay; a missing or unknown key is an error (billing.plan-feature-switches; P83)
- The switched-off Starter, Growth and Pro rows answer Free's features and limits; an organization still on one is held to Free until it picks Creator or Studio, with a notice and an email once; its Stripe subscription is not touched (billing.retired-plans; P80)
- Free never ends; a failed payment keeps sending until the period end + 14 days; a cancelled paid plan ends at the period end with no grace; a plan ended stops every lane with `plan_ended`; read-only still allows pause, delete, disconnect and choosing a plan (billing.plan-states; D35, P10)
- Billing reports every plan-state change to the app; a sweep every 15 minutes catches graces that ended with no Stripe event (billing.plan-states; plan §46.3)
- A move up is immediate and clears every `plan_downgrade` stop, and `plan_limit` when the count is under the new limit; a move down is a Stripe subscription schedule applied at the period end, taking the accounts to keep (billing.plan-downgrade; D57, P77)
- Trial: 7 days, no card, once per organization and never again for an Instagram account that had one; the plan's full features and limits; notices and emails 3 and 1 days before the end; no card at the end moves the organization to Free by the move-down rule (billing.paid-trial; D73)
- Cards: Stripe's card id in the path, checked by shape and ownership; the only card is kept while a paid plan is on (billing.payment-methods; P78)
- Members are unlimited on every plan; the seat sync is switched off (billing.flowdm-plans; D55)
- Billing and plans need `subscription:read` / `subscription:manage` (Owner, Admin) (access.editor-viewer-roles; plan §45.5)
- New subscriptions, plan changes and the default card need an idempotency key (quality.idempotency; P89)
- Billing's changes ship as new migrations in the billing domain only (data.merged-domains-forward-only; D48)

## Acceptance criteria

- AC-11.1 — The plan list answers Free, Creator and Studio with their prices, `message_month_limit`, `channel_accounts_max`, `has_priority_support` and one switch per feature key, and no PRO bundle — plans/decisions.md P83
- AC-11.2 — A plan row with a missing or unknown feature key is refused when written and when read — intake-files/Instagram-DM-Sending-Plan-v8.md:7945
- AC-11.3 — An organization on a switched-off Starter, Growth or Pro row is held to Free's features and limits, its context says a plan choice is required, it is moved down to Free once (accounts above Free's one stopped, the oldest-connected kept), gets one notice and one email, and its Stripe subscription is untouched — plans/decisions.md P80
- AC-11.4 — Starting a trial of Creator or Studio without a card gives that plan's features and limits at once, with its end date 7 days ahead in the context — intake-files/Instagram-DM-Sending-Plan-v8.md:8105
- AC-11.5 — A second trial in the same organization is refused with `trial_already_used`; connecting during a trial an Instagram account that had a trial elsewhere is refused with `trial_used_by_account` — intake-files/Instagram-DM-Sending-Plan-v8.md:8104
- AC-11.6 — Moving up applies the new limits at once and clears every `plan_downgrade` stop, and the `plan_limit` stop when the month count is under the new limit — intake-files/Instagram-DM-Sending-Plan-v8.md:8006
- AC-11.7 — Moving down first answers the accounts that do not fit and the PRO parts that will be off, takes the accounts to keep, and changes nothing until the period end — intake-files/Instagram-DM-Sending-Plan-v8.md:8019
- AC-11.8 — A failed payment keeps sending until the period end + 14 days, then the plan ends and every lane of every account stops with `plan_ended`, also when no Stripe event arrives — intake-files/Instagram-DM-Sending-Plan-v8.md:7983
- AC-11.9 — A cancelled paid plan stops every lane with `plan_ended` at its period end, without a grace — intake-files/Instagram-DM-Sending-Plan-v8.md:7980
- AC-11.10 — While the plan has ended, waiting messages stay waiting and still expire by the 7-day rule; picking a plan clears `plan_ended` and the lanes wake — intake-files/Instagram-DM-Sending-Plan-v8.md:7985
- AC-11.11 — Removing the only card while a paid plan is on is refused with `default_card_in_use`; another organization's card id is refused; setting a default card sets it on the customer and the subscription — plans/decisions.md P78
- AC-11.12 — No seat count is sent to Stripe and members are not limited by plan — intake-files/Instagram-DM-Sending-Plan-v8.md:7948
- AC-11.13 — An Editor or a Viewer is refused every billing change with `missing_permission` — intake-files/Instagram-DM-Sending-Plan-v8.md:7873
- AC-11.14 — Billing's table and column changes come as new billing migrations; no merged migration is edited — intake-files/BRIEF.md:77

## Work items

- billing.flowdm-plans
- billing.plan-feature-switches
- billing.retired-plans
- billing.plan-states
- billing.plan-downgrade
- billing.paid-trial
- billing.payment-methods
- billing.plan-message-month-limit
- billing.plan-channel-accounts-max
- data.merged-domains-forward-only
- access.editor-viewer-roles
- quality.idempotency
