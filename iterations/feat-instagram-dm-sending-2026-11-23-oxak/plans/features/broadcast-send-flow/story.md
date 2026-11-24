Status: draft
Kind: flow
Depends on: broadcasts-and-segments, instagram-sending-engine, instagram-webhook-intake
Route review: [routes-final.md](../../routes-final.md) § 7 (7.A–7.C), § 6 (broadcast lane); worker-changes WC-8, WC-28, WC-29, WC-39, WC-40

## Stories

- As an Owner on Creator or Studio I want a broadcast to reach the open chats of its audience at a safe pace so that I announce something without breaking Instagram's rules.
- As an Owner I want a "when her chat opens" broadcast to wait for each person to write, after her automations finish, so that it never interrupts a conversation.
- As an Owner I want to know when a broadcast is done, with its numbers so that I can judge it.

## Rules

- The audience is built from the broadcast's own copy of the conditions; only open chats get it; opted-out, paused and deleted contacts and anyone who got a broadcast in the last 24 hours are left out (operations.broadcast, background.broadcast-audience; D68)
- Each message goes in the account's broadcast lane at a random second of its box, re-checked just before sending; "too fast" stops the lane for double the time (background.broadcast-lane-send; D4)
- A scheduled broadcast starts at its time; a "when her chat opens" one adds her in the commit of her chat event when no run of hers is open, or when her last open run ends; the oldest matching broadcast wins (background.scheduled-broadcast-start, background.chat-event-intake; plan §27.15)
- A broadcast ends `done` when its audience is done or its waiting days are over (background.broadcast-end)
- Each broadcast message is a DM in the month count and the person limit (operations.instagram-dm-counting; D34)
- The month limit stops the broadcast lane too (billing.plan-message-month-limit; D62, P3)
- Its end sends the "broadcast done" notification (in-app on, email off by default) (notifications.kinds-v8; D54)

## Acceptance criteria

- AC-21.1 — "Send now" to a segment of 1,240 with 310 open chats creates 310 waiting recipients, sends one at a random second of each box, and ends `done` when all 310 are sent or skipped — intake-files/Instagram-DM-Sending-Plan-v8.md:1737
- AC-21.2 — A recipient whose chat closed, who opted out or who got another broadcast in the last 24 hours by the time of her send is `skipped` with its reason — intake-files/Instagram-DM-Sending-Plan-v8.md:1746
- AC-21.3 — A broadcast scheduled for Friday 18:00 starts at that time — intake-files/Instagram-DM-Sending-Plan-v8.md:1758
- AC-21.4 — Riya (tag "vip") replies to a story on day 2 of a 3-day "when her chat opens" broadcast: her automation runs first; when her run is `completed`, she gets the broadcast in the next box of the broadcast lane, counting 1 DM — intake-files/Instagram-DM-Sending-Plan-v8.md:2785
- AC-21.5 — A person already holding a recipient row of the broadcast never gets it twice; several waiting broadcasts send her only the oldest that day — intake-files/Instagram-DM-Sending-Plan-v8.md:5142
- AC-21.6 — A "when her chat opens" broadcast ends `done` at its end time; recipients made before then still go — intake-files/Instagram-DM-Sending-Plan-v8.md:5144
- AC-21.7 — "Too fast" on the broadcast lane stops only that lane for double the time; answers and DMs still go — intake-files/Instagram-DM-Sending-Plan-v8.md:2561
- AC-21.8 — At the end the member who sent it, the Owner and the Admin get one in-app "Broadcast done" note with sent, skipped and replies, and no email by default — intake-files/Instagram-DM-Sending-Plan-v8.md:8158
- AC-21.9 — The month limit reached mid-broadcast stops the broadcast lane with the others; its waiting recipients wait — plans/decisions.md P3

## Work items

- operations.broadcast
- operations.segment
- operations.instagram-dm-counting
- background.broadcast-audience
- background.segment-count
- background.broadcast-lane-send
- background.scheduled-broadcast-start
- background.broadcast-end
- background.chat-event-intake
- billing.plan-message-month-limit
- notifications.kinds-v8
