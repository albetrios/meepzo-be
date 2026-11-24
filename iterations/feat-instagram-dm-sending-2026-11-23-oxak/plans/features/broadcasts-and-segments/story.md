Status: draft
Kind: screen
Depends on: contacts, automations, instagram-sending-engine, plans-billing-and-trial
Route review: [routes-final.md](../../routes-final.md) § 7 — routes 70–82 (broadcasts, segments, recipients)

## Stories

- As an Owner, Admin or Editor on Creator or Studio I want to save audiences (segments) of one account from conditions so that I can reuse them.
- As an Owner, Admin or Editor I want a preview of how many match and how many can get it now so that I know a broadcast's reach before sending.
- As an Owner, Admin or Editor I want to write a broadcast of 1–3 messages and send it now, at a set time, or when each person's chat opens so that I reach my followers within Instagram's rules.
- As an Owner, Admin or Editor I want to cancel a broadcast so that what has not gone yet never goes.
- As any member I want each broadcast's numbers — sent, skipped, replies, taps — so that I see what it did.

## Rules

- Broadcasts and segments are shared by every channel and listed per account: the account is a required filter (operations.broadcast, operations.segment, operations.shared-product-routes; P48)
- PRO only: every segment and broadcast action is refused on Free with `plan_lacks_feature`; segments made during a trial stay saved after a move down, unusable until an upgrade (billing.plan-pro-features; P76, P83)
- A segment: conditions on one account in AND / OR groups, at most 2 levels and 20 conditions (operations.segment; D68)
- Always left out: opted-out, paused and deleted contacts; only people whose chat window is open get a broadcast, checked when the audience is built and again just before each send (operations.broadcast; D68)
- A broadcast is a `draft` until sent; only a draft is edited; the send takes the mode — now, scheduled with its time, or when her chat opens with 1–7 days — and its own copy of the conditions (operations.broadcast; plan §8.10)
- A broadcast message carries `{name}`, versions and an optional "start automation X" button; each is a DM and counts in the month (operations.broadcast, operations.instagram-dm-counting; D34)
- Statuses: `draft`, `scheduled`, `sending`, `waiting_for_chats`, `done`, `cancelled`; delete only from `draft`, `done` or `cancelled`, else `broadcast_active` (operations.broadcast; P9)
- Cancel: waiting recipients `skipped`, their waiting messages `cancelled` · `broadcast_cancelled`, sent ones stay sent (operations.broadcast; plan §15.9)
- Broadcasts go in each account's own broadcast lane at the lowest priority with its own hour limit (background.sending-lanes; D4)
- Deleted broadcasts and segments are purged 90 days later (background.broadcast-segment-purge; P75)
- A move down cancels scheduled and waiting broadcasts (`plan_feature_off`); drafts and segments stay (billing.plan-downgrade; D57)
- Owner, Admin and Editor make, send and cancel (`automation:*`); Viewer only sees (access.editor-viewer-roles; P20)
- Creating a segment, creating and sending a broadcast and the audience count need an idempotency key; cancel does not (quality.idempotency; P89)

## Acceptance criteria

- AC-9.1 — On Free, every segment and broadcast action is refused with `plan_lacks_feature` — plans/decisions.md P76
- AC-9.2 — A segment with more than 20 conditions or more than 2 levels is refused; a good one is saved on its account — intake-files/Instagram-DM-Sending-Plan-v8.md:279
- AC-9.3 — The audience count answers how many match and how many can get it now (chat open), leaving out opted-out, paused and deleted contacts; a count too heavy to answer at once says it is counted in the background — intake-files/Instagram-DM-Sending-Plan-v8.md:2689
- AC-9.4 — A broadcast with 0 or 4 messages is refused; a draft can be edited, a sent one cannot — intake-files/Instagram-DM-Sending-Plan-v8.md:2689
- AC-9.5 — Send now builds the audience from the broadcast's own copy of the conditions and sends only to people whose chat is open, checked again just before each message; a person whose chat closed meanwhile is `skipped` — intake-files/Instagram-DM-Sending-Plan-v8.md:279
- AC-9.6 — A scheduled broadcast starts at its time; a "when her chat opens" broadcast sends to each person of the audience when her chat next opens within its 1–7 days, then ends `done` — intake-files/Instagram-DM-Sending-Plan-v8.md:1705
- AC-9.7 — Cancelling a scheduled, sending or waiting broadcast makes it `cancelled`, its waiting recipients `skipped` and their waiting messages `cancelled` · `broadcast_cancelled`; sent ones stay sent — intake-files/Instagram-DM-Sending-Plan-v8.md:2690
- AC-9.8 — Deleting a scheduled, sending or waiting broadcast is refused with `broadcast_active`; deleting a draft, done or cancelled one hides it; editing a segment never changes a broadcast's copy — plans/decisions.md P9
- AC-9.9 — The list shows each broadcast's name, mode, status and sent, skipped, replies and taps — intake-files/Instagram-DM-Sending-Plan-v8.md:2688
- AC-9.10 — Broadcast messages go in the account's broadcast lane behind its other lanes, within its broadcast hour limit; each counts one DM in the month — intake-files/Instagram-DM-Sending-Plan-v8.md:215
- AC-9.11 — A move down to a plan without broadcasts ends scheduled and waiting broadcasts `cancelled` · `plan_feature_off`; drafts and segments stay saved — intake-files/Instagram-DM-Sending-Plan-v8.md:2692
- AC-9.12 — A Viewer lists and reads broadcasts and segments and is refused every change with `missing_permission` — intake-files/Instagram-DM-Sending-Plan-v8.md:2691
- AC-9.13 — Deleted broadcasts and segments are gone for good 90 days after their delete — plans/decisions.md P75

## Work items

- operations.broadcast
- operations.segment
- operations.shared-product-routes
- operations.instagram-dm-counting
- background.sending-lanes
- background.broadcast-segment-purge
- billing.plan-pro-features
- billing.plan-downgrade
- access.editor-viewer-roles
- quality.idempotency
