Status: draft
Kind: screen
Depends on: channel-accounts, contacts, automations
Route review: [routes-final.md](../../routes-final.md) § 5 — routes 60–62 (5.A receiver, 5.B events and keys); intake built after § 6

## Stories

- As Meta I want each Instagram webhook delivery checked and stored at once so that no comment, DM or tap is lost.
- As the system I want intake to decide, for every saved event, which one automation it starts or answers — and never to send — so that the decision is fast, exact and repeatable.
- As an Owner or Admin I want missed comments found and the webhook subscription kept on so that a Meta hiccup never costs answers.
- As an Owner or Admin I want a debugging list of the account's webhook events so that I can see what Instagram sent.

## Rules

- Meta's webhook route is per object: the Instagram callback lives under the connection's Meta webhooks; the subscription check answers Meta's challenge (integrations.instagram-webhook-save; P53)
- Signature first, before anything is parsed; read receipts and our own "sent" notices are dropped; our own echoes are found by a Postgres lookup of the message id, an early echo matched by intake within 10 minutes (integrations.instagram-webhook-save; P62)
- An unknown or revoked account saves nothing; an event older than 8 days is dropped; duplicates are found by their event key (integrations.instagram-webhook-save; D15)
- Postgres is the only store: no Redis buffer; Postgres down or slow answers a failure so Meta delivers again (integrations.instagram-webhook-save; P32)
- Validly signed requests are not counted against the per-IP cap; the webhook has its own pool slice (integrations.instagram-webhook-save; P97)
- The six fields — comments, Live comments, messages, postbacks, referrals, reactions — are subscribed per account and checked every 10 minutes (integrations.instagram-webhook-fields, background.webhook-subscription-check; plan §25.7)
- Intake never sends and is never paused by an Instagram outage; one event's writes are one commit; one lock order — contact → automation → runs — in every intake path (background.intake, background.chat-event-intake, quality.lock-order; P47)
- Chat events follow the match order: her own waiting run → exact source → keyword or kind → first message → "no other automation answered"; a match stopped by its once key still ends the search (operations.automation-message-match-order; D37)
- Comments: one comment, one automation — post-linked first, else "any post", the oldest; every other match logged `ignored` · `comment_already_answered`; own comments skipped `own_comment` (operations.automation-comment-match, background.comment-intake; D37, P24)
- One open run per automation and person: a comment that may start a new run (another post, or "every time") replaces her open run (`replaced`); a second comment on the same post with "once" ON is `once_per_post`; every other way to start is ignored while her run is open (`run_in_progress`) (operations.automation-once-rule, background.comment-intake; P35, P100)
- Live comments get a private reply in the fast lane only while the Live is on (background.live-comment-intake, background.live-check; D40)
- Tag events start tag automations only while her window is open; a chain of tag starts stops at 3 (background.tag-event-intake; D45)
- More than 20 message events a minute from one person are skipped `flood`, counted in Postgres (background.chat-event-intake; P63)
- A stop word opts her out; a typed email or phone is taken only while a run waits for it; an echo of the owner's hand-typed message starts a 6-hour quiet time for "no other automation answered" (operations.contact-stop-words, operations.automation-answer-table; D49)
- Stuck events are picked up after 1 minute; failed ones retried hourly while under 7 days (background.stuck-event-pickup)
- Missed comments are read every 30 minutes per watched post; after an outage a full pass keeps the normal limits (7 days, 25 posts), runs one per account at the lowest priority and stops at 60 % Meta usage (background.missed-comment-check; P93)
- "My next post" links to the first post published after go-live, once, and never expires (background.next-post-linking; P12)
- The event list adds the account filter, the new kinds and reasons, and needs `instagram-webhook-event:read` (Owner, Admin) (access.channel-account-codes; P59)

## Acceptance criteria

- AC-16.1 — A delivery with a bad or missing signature is refused before anything is read or saved — intake-files/Instagram-DM-Sending-Plan-v8.md:4755
- AC-16.2 — Meta's subscription check answers the challenge only with the right verify token — plans/routes-final.md route 60
- AC-16.3 — Read receipts and our own "sent" notices are not saved; an echo of our own message is matched to it by id, also when it arrives before its send was saved (within 10 minutes) — plans/decisions.md P62
- AC-16.4 — Events of an unknown or revoked account, and events older than 8 days, are not saved; the same event delivered twice is saved once — intake-files/Instagram-DM-Sending-Plan-v8.md:4761
- AC-16.5 — With Postgres down or the save over its time limit, the webhook answers a failure and keeps nothing in Redis; Meta's next delivery is saved normally — plans/decisions.md P32
- AC-16.6 — A validly signed burst from Meta is never refused by the per-IP limit — plans/decisions.md P97
- AC-16.7 — Intake of an event sends nothing; its decision, runs and waiting messages are written in one commit; an event taken once is never decided twice — plans/worker-changes.md WC-1
- AC-16.8 — Two intake jobs of one account racing on one contact (her DM and her comment) never deadlock — plans/decisions.md P47
- AC-16.9 — An Instagram outage does not pause intake: events keep being decided and messages keep waiting — plans/decisions.md P47
- AC-16.10 — "GUIDE" as her first DM with keyword GUIDE and a first-message automation live starts GUIDE; "hi" starts the first-message one; a week later "hi" starts "no other automation answered" once that day — intake-files/Instagram-DM-Sending-Plan-v8.md:566
- AC-16.11 — A tap or any text while her run waits moves that run (level 1) before any other automation is considered — intake-files/Instagram-DM-Sending-Plan-v8.md:570
- AC-16.12 — A starter-question tap or a link ref naming a live automation starts it (level 2) even when a keyword also matches; a paused automation's starter tap is treated as text — intake-files/Instagram-DM-Sending-Plan-v8.md:554
- AC-16.13 — A comment matching a post-linked and an "any post" automation starts only the oldest post-linked one; every other match is logged `ignored` · `comment_already_answered`; the account's own comment is skipped `own_comment` — intake-files/Instagram-DM-Sending-Plan-v8.md:577
- AC-16.14 — "Any post" LINK answers her comment on post 1 and on post 2, and her second comment on post 1 gets nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:2763
- AC-16.15 — With "once" ON, a second comment on the same post is ignored `once_per_post`; a comment on another post (or any comment in "every time") cancels her open run of that automation with its waiting messages (`replaced`) and starts the new run in the same commit — plans/decisions.md P35
- AC-16.16 — Any other way to start while her run of that automation is open is ignored `run_in_progress` — intake-files/Instagram-DM-Sending-Plan-v8.md:1944
- AC-16.17 — More than 20 of her message events in a minute are skipped `flood` — plans/decisions.md P63
- AC-16.18 — A Live comment's private reply waits in the fast lane only while the Live is on; when the Live ends its waiting replies become `expired` · `live_ended` — intake-files/Instagram-DM-Sending-Plan-v8.md:2769
- AC-16.19 — A tag event starts a tag automation only when her window is open; closed, no run starts (`window_closed`); a chain of tag starts stops at the third — intake-files/Instagram-DM-Sending-Plan-v8.md:2781
- AC-16.20 — An event stuck over 1 minute is picked up again; a failed one is retried every hour until its comment is 7 days old — plans/worker-changes.md WC-12
- AC-16.21 — A watched post's comments that never arrived by webhook are found within 30 minutes and answered like any comment; after an outage the full pass reads at most 7 days and 25 posts per account, at the lowest priority, and pauses at 60 % Meta usage — plans/decisions.md P93
- AC-16.22 — An account whose subscription lost a field is subscribed again within 10 minutes and its missed comments are looked for — plans/worker-changes.md WC-25
- AC-16.23 — "My next post" links to the first post published after go-live, once, with no expiry — plans/decisions.md P12
- AC-16.24 — The event list filters by account and shows the new kinds and reasons; a Viewer or Editor is refused it with `missing_permission` — plans/decisions.md P59

## Work items

- integrations.instagram-webhook-save
- integrations.instagram-webhook-fields
- background.intake
- background.chat-event-intake
- background.comment-intake
- background.live-comment-intake
- background.tag-event-intake
- background.tag-event-pickup
- background.stuck-event-pickup
- background.live-check
- background.webhook-subscription-check
- background.missed-comment-check
- background.next-post-linking
- operations.automation-message-match-order
- operations.automation-comment-match
- operations.automation-once-rule
- operations.automation-once-key
- operations.automation-every-time-mode
- operations.automation-answer-table
- operations.contact-stop-words
- quality.lock-order
- access.channel-account-codes
- background.per-account-order
- background.retry-policy
- data.instagram-webhook-event
- data.instagram-webhook-event-key
- operations.instagram-webhook-events-list
- quality.rate-limit
