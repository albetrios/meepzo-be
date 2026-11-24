Status: draft
Kind: screen
Depends on: channel-accounts, instagram-content-picker, contacts, plans-billing-and-trial, message-files
Route review: [routes-final.md](../../routes-final.md) § 4.A — routes 27–35, 38–39 (counters, go-live, pause, duplicate, keyword test)

## Stories

- As an Owner, Admin or Editor I want to save an automation as a draft with only a name and its way to start so that I can build it over time.
- As an Owner, Admin or Editor I want to choose one of the 15 ways to start, its target and its keywords so that the right people get it.
- As an Owner, Admin or Editor I want to build its steps — hello with buttons and versions, nudge, follow, email and phone asks, a 1–10 message list in 7 kinds with waits, public replies, hide comment, tags — so that it does what my post promised.
- As an Owner, Admin or Editor I want "Go live" to check everything and tell me each problem with its step so that a live automation always works.
- As an Owner, Admin or Editor I want to pause an automation and choose to keep or cancel its waiting DMs so that I stop it the way I need.
- As an Owner, Admin or Editor I want to duplicate an automation and to try a keyword against it so that I build new ones quickly and safely.
- As any member I want each automation's runs and "% tapped", per hello version, so that I know what works.
- As an Owner, Admin or Editor I want to delete an automation, optionally with a reason, so that it stops at once.

## Rules

- Statuses are `draft`, `live`, `paused`; a draft needs only a name and its way to start (required at create; a later change stays in its group); content saves never move the status — go-live and pause do (operations.automation-status-draft-live-paused; D28, P8, P70)
- The 15 ways to start: comment, Live comment, story reply, story mention, story repost, DM keyword, first message, shared post, starter question, link or QR, no other automation answered, ad comment, ad "Send message", tag added, tag removed; each checked against the channel's capability list (operations.automation-trigger-types, operations.channel-capability-list; D37, P48)
- Go-live runs the plan's §5.1 checks plus "a hello always has a next-step button when later steps exist", and refuses with `automation_not_ready` listing every problem with its step; shared keywords and a private account only warn (operations.automation-go-live-check; P2, P68)
- A save of a live or paused automation runs the content checks only; account, plan and month checks wait for go-live (operations.automation-go-live-check; P69)
- Go-live is refused while the plan has ended, the month limit is reached, the account is not connected, or a way to start or feature has not passed its Meta test (story repost, ad comments, Live comments, quick replies / cards) (operations.feature-check; D35, D62, P36)
- PRO parts — email ask, phone ask, "Reply like a person" ON, more than one public reply line, a second hello or follow version — save on a draft, but going live with one, or a save that turns one on, needs a plan with that feature's switch (billing.plan-pro-features, billing.plan-feature-switches; D35, P83)
- Hello: up to 640 characters, up to 3 buttons (link or next step), `{name}`, up to 3 versions; nudge after 1 hour, once, only when she wrote first (operations.automation-step-hello, operations.automation-nudge; D30)
- Follow ask with versions; email and phone asks with 1–10 wordings, never the same twice in a row to her; phone after email; never asked again when we have it (operations.automation-step-follow, operations.automation-step-email-ask; D12, D31)
- Message list: 1–10 messages in 7 kinds, each wait none or 1 minute to 23 hours, text up to 1,000 bytes; files must be uploaded and checked (operations.automation-step-messages, operations.automation-message-attachments; D29, P34)
- Public replies ON or OFF with 1–20 lines, `@username` first unless off; "Reply like a person" ON needs at least 3 lines, is the default on Creator and Studio and unavailable on Free; hide comment after the reply (operations.automation-step-public-reply, operations.automation-hide-comment; D32, D33, D52, D59, D63)
- Keywords match "contains" with one wrong letter allowed in words of 5 or more letters, also inside phrases (operations.automation-keyword-typo-match; D39, D60)
- "Also start from" is off by default (operations.automation-also-start-from; D38)
- Starter questions: 1–4 per automation, at most 4 live per account; a link automation has a `ref_code` unique on the account (operations.instagram-starter-questions-sync, operations.automation-ref-link; D42, D43)
- One live "first message" and one live "no other automation answered" automation per account (operations.automation-go-live-check)
- Pause with keep (waiting DMs stay, open chats finish) or cancel (its waiting messages count as cancelled from now); duplicate makes a "(copy)" draft on the same account with a new link code and counters at 0 (operations.automation-status-draft-live-paused; plan §15.4)
- Delete: the reason is optional (`other` needs a note); open runs and waiting messages are cancelled `automation_deleted`; contacts stay (operations.automation-status-draft-live-paused; P11)
- A "next post" automation never expires (operations.automation-status-draft-live-paused; P12)
- Edits reach waiting messages when they go; a waiting message whose step was removed is `cancelled` · `cancelled_by_owner` (operations.automation-status-draft-live-paused; plan §5.1)
- Counters are all-time, written in the same commit as the event, and survive the run clean-up (operations.automation-list-counters; D36, D61)
- The keyword test sends and stores nothing (operations.automation-try-it; D39)
- While the plan is read-only the owner may still pause and delete; only go-live and turning a PRO part on are refused (billing.plan-states; P10)
- Owner, Admin and Editor create, edit, go live, pause, duplicate and delete; Viewer reads (access.editor-viewer-roles; D55)
- Create and duplicate need an idempotency key; go-live, pause and the keyword test do not (quality.idempotency; P89)

## Acceptance criteria

- AC-6.1 — Creating with a name and a way to start saves a `draft` on the selected account and sends nothing; without a way to start it is refused — plans/decisions.md P70
- AC-6.2 — The list without an account is refused; with one it shows that account's automations with status, and "1.3k runs · 51% tapped" for live and paused ones, "0 runs · edited …" for drafts — intake-files/Instagram-DM-Sending-Plan-v8.md:2517
- AC-6.3 — Go-live of an incomplete automation answers `automation_not_ready` with every problem and its step (name, way to start, words, starter questions, link name, catch-all, hello, comment kinds without hello, follow, email and phone, messages, public reply, tags) and changes nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:690
- AC-6.4 — Go-live is refused when the hello has later steps but no "sends your next step" button — plans/decisions.md P2
- AC-6.5 — A shared keyword with another live automation, and a private account on a comment kind, only warn; go-live still succeeds — intake-files/Instagram-DM-Sending-Plan-v8.md:709
- AC-6.6 — A save of a live or paused automation with a content problem is refused and saves nothing; a save that turns a PRO part on, on a plan without it, is refused with `plan_lacks_feature`; PRO parts already on stay saved — plans/decisions.md P69
- AC-6.7 — On Free, a draft with an email step saves; its go-live answers `plan_lacks_feature` naming "Ask for their email" — intake-files/Instagram-DM-Sending-Plan-v8.md:8067
- AC-6.8 — Go-live is refused while the plan has ended (`organization_read_only`), while the month limit is reached, and while the account is not connected — intake-files/Instagram-DM-Sending-Plan-v8.md:2647
- AC-6.9 — Go-live of a story repost, ad-comment or Live-comment automation, or one using quick replies or cards, whose Meta test has not passed is refused with `feature_not_offered` — plans/decisions.md P36
- AC-6.10 — A second live "first message" or "no other automation answered" automation on the same account is refused at go-live, naming the one that already answers — intake-files/Instagram-DM-Sending-Plan-v8.md:701
- AC-6.11 — Starter questions: a fifth live question on the account is refused at go-live; going live, pausing, deleting or changing such an automation updates the account's ice breakers at Instagram — intake-files/Instagram-DM-Sending-Plan-v8.md:253
- AC-6.12 — A link automation's `ref_code` longer than 64, with other signs, or used by another automation of the account is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:254
- AC-6.13 — "Reply like a person" ON with fewer than 3 lines is refused at go-live; on Free it cannot be switched on; on Creator and Studio a new automation starts with it ON — intake-files/Instagram-DM-Sending-Plan-v8.md:263
- AC-6.14 — A message list with 0 or 11 messages, a wait over 23 hours, a text over 1,000 bytes, or a file not uploaded and checked is refused at go-live — intake-files/Instagram-DM-Sending-Plan-v8.md:240
- AC-6.15 — Pause + keep leaves `paused` with its waiting DMs going on and open chats finishing; pause + cancel leaves `paused` and every waiting message of it ends `cancelled` — intake-files/Instagram-DM-Sending-Plan-v8.md:674
- AC-6.16 — Going live again from `paused` runs the full check; a paused automation's waiting DMs under 7 days go on — intake-files/Instagram-DM-Sending-Plan-v8.md:2602
- AC-6.17 — Duplicate makes a draft "<name> (copy)" on the same account with counters at 0 and, for a link automation, a new link code — intake-files/Instagram-DM-Sending-Plan-v8.md:2607
- AC-6.18 — Delete without a reason succeeds; `other` without a note is refused; afterwards the automation is gone from list and read, its open runs and waiting messages are `cancelled` · `automation_deleted`, and its contacts stay — plans/decisions.md P11
- AC-6.19 — An edit to a live automation reaches waiting messages when they go; a waiting message whose step was removed ends `cancelled` · `cancelled_by_owner`; a missing version number falls back to version 1 — intake-files/Instagram-DM-Sending-Plan-v8.md:681
- AC-6.20 — The keyword test answers whether a text starts this automation, which word matched (exact or close spelling) and which automation of the account would answer first; it sends and stores nothing — intake-files/Instagram-DM-Sending-Plan-v8.md:250
- AC-6.21 — A keyword of 5 or more letters matches a word with one wrong letter ("guide" matches "guida"), also inside a multi-word keyword whose words come together and in order; shorter words must match exactly — intake-files/Instagram-DM-Sending-Plan-v8.md:271
- AC-6.22 — Runs and "% tapped" count a hello tap or a typed answer once per run, per hello version, in the same commit as the event, and stay after old runs are deleted — intake-files/Instagram-DM-Sending-Plan-v8.md:272
- AC-6.23 — A "next post" automation stays waiting for the next post with no expiry — plans/decisions.md P12
- AC-6.24 — While the plan is read-only, pause and delete succeed and go-live is refused — plans/decisions.md P10
- AC-6.25 — A Viewer reads automations and is refused create, edit, go-live, pause, duplicate and delete with `missing_permission`; an Editor may do all of them — intake-files/Instagram-DM-Sending-Plan-v8.md:7866
- AC-6.26 — Create and duplicate without an idempotency key are refused; go-live, pause and the keyword test take none — plans/decisions.md P89
- AC-6.27 — Create, edit, go-live, pause, duplicate and delete each leave one audit entry — intake-files/Instagram-DM-Sending-Plan-v8.md:2595

## Work items

- operations.automation-status-draft-live-paused
- operations.automation-go-live-check
- operations.automation-trigger-types
- operations.channel-capability-list
- operations.feature-check
- operations.automation-step-order
- operations.automation-step-hello
- operations.automation-nudge
- operations.automation-step-follow
- operations.automation-step-email-ask
- operations.automation-step-messages
- operations.automation-message-attachments
- operations.automation-step-public-reply
- operations.automation-public-reply-per-automation
- operations.automation-hide-comment
- operations.automation-keyword-typo-match
- operations.automation-also-start-from
- operations.automation-try-it
- operations.automation-ref-link
- operations.instagram-starter-questions-sync
- operations.automation-list-counters
- operations.automation-window-rule
- billing.plan-pro-features
- billing.plan-feature-switches
- billing.plan-states
- access.editor-viewer-roles
- quality.idempotency
- quality.audit
- background.next-post-expiry
- data.automation
- data.automation-counters
- operations.automation-create-draft
- operations.automation-delete
- operations.automation-duplicate
- operations.automation-next-post
- operations.automation-public-reply-mention
- operations.automation-reply-like-person-default
- operations.automation-step-phone-ask
- operations.automation-step-tags
- operations.automation-targeting
- operations.automation-follow-check
- operations.automation-live-ended
- notifications.automation-stopped
- quality.error-reasons
