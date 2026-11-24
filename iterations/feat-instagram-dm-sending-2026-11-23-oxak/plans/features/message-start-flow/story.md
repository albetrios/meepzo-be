Status: draft
Kind: flow
Depends on: instagram-webhook-intake, contacts, automations, instagram-sending-engine
Route review: [routes-final.md](../../routes-final.md) § 5 (intake), § 4.B (runs), § 6 (fast lane); worker-changes WC-1, WC-3, WC-4, WC-7, WC-31

## Stories

- As an Instagram user who sends a DM, replies to a story, taps a starter question, opens a link or QR code, or taps "Send message" on an ad I want the right automation to answer once so that I get what I asked for.
- As an Owner I want exactly one automation to answer each message by a fixed match order so that a person never gets two different answers.
- As an Owner I want a nudge if she does not answer the hello so that fewer conversations die.

## Rules

- Match order: her own waiting run → exact source (starter question, link ref, ad id) → keyword or kind (DM keyword, story reply, story mention, shared post, "also start from") → first message → "no other automation answered"; inside a level an exact target wins, then the automation's own way to start, then the oldest (operations.automation-message-match-order; D37)
- Once keys: DM keyword, starter question and link once a day in the organization's time zone; story reply and mention once per story; shared post once per post; ad once per ad; first message once ever; "every time" uses the event's own id (operations.automation-once-key, operations.automation-every-time-mode; D13, D65)
- Message starts go in the fast lane: her window is open because she just wrote (operations.automation-message-start-flow; D4)
- A reaction, read receipt, edit, our own notice or echo never starts anything (operations.automation-message-start-flow)
- "No other automation answered" stays quiet while the owner typed to her by hand in the last 6 hours (operations.automation-message-start-flow)
- The nudge repeats the same hello version once after 60 minutes, only when she wrote first (operations.automation-nudge; D30)
- Starter questions and links are exact sources; ad "Send message" carries its ad id and uses a 24-hour window until Meta's 7-day test passes (operations.automation-ref-link, operations.instagram-starter-questions-sync; D41, D42, D43, P36)
- A tag start goes only when her window is open (operations.automation-message-start-flow; D45)

## Acceptance criteria

- AC-20.1 — Riya replies to story S1 with story-reply automation ST1 (story S1) and a DM keyword PRICE with "also start from" story reply live: ST1 answers — intake-files/Instagram-DM-Sending-Plan-v8.md:571
- AC-20.2 — Riya taps starter question "Prices?" with starter automation PRICES and DM keyword PRICE live: PRICES answers — intake-files/Instagram-DM-Sending-Plan-v8.md:569
- AC-20.3 — Riya sends "PRICE" twice on Monday: the first runs, the second sends nothing and the search ends there; on Tuesday it runs again — intake-files/Instagram-DM-Sending-Plan-v8.md:511
- AC-20.4 — Riya replies to a story; the hello goes in the fast lane with version B; with no tap, the nudge goes 60 minutes later with version B; a tap 20 minutes later moves the run and counts for version B; a tap before the nudge cancels it — intake-files/Instagram-DM-Sending-Plan-v8.md:2767
- AC-20.5 — Riya scans a QR code with ref "counter": automation COUNTER starts and its hello goes within about a second; scanning again the same day sends nothing; the next day it runs again — intake-files/Instagram-DM-Sending-Plan-v8.md:2771
- AC-20.6 — Riya taps "Send message" on ad 1203 with its ready text: the ad's automation answers even though the text holds another automation's DM keyword; a second tap on the same ad that week sends nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:2773
- AC-20.7 — A reaction, an edited message, a read receipt or our own echo never starts an automation — intake-files/Instagram-DM-Sending-Plan-v8.md:553
- AC-20.8 — After the owner typed to Riya by hand, "no other automation answered" sends nothing to her for 6 hours; other people are not affected — intake-files/Instagram-DM-Sending-Plan-v8.md:556
- AC-20.9 — The owner tags 1,200 contacts "vip": 1,200 tag events are saved in pieces of 500; only the people whose window is open get the VIP hello; the others start nothing (`window_closed`) — intake-files/Instagram-DM-Sending-Plan-v8.md:2781
- AC-20.10 — A starter question of a paused automation is treated as plain text at the keyword level — intake-files/Instagram-DM-Sending-Plan-v8.md:554
- AC-20.11 — A way to start whose Meta test has not passed (story repost, ad comments, Live comments) never starts a run because it cannot go live — intake-files/BRIEF.md:70

## Work items

- operations.automation-message-start-flow
- operations.automation-message-match-order
- operations.automation-once-key
- operations.automation-every-time-mode
- operations.automation-nudge
- operations.automation-ref-link
- operations.instagram-starter-questions-sync
- operations.automation-trigger-types
- background.chat-event-intake
- background.tag-event-intake
- background.bulk-tag
- background.fast-message-send
- background.starter-question-sync
- operations.contact-email-phone-answers
