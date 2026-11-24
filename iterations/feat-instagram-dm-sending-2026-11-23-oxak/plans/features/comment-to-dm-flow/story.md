Status: draft
Kind: flow
Depends on: instagram-webhook-intake, contacts, automations, instagram-sending-engine
Route review: [routes-final.md](../../routes-final.md) § 5 (intake), § 4.B (runs), § 6 (lanes); worker-changes WC-2, WC-5, WC-6, WC-7

## Stories

- As an Instagram user who comments a keyword on a post I want a DM, a public reply and what the post promised so that I get it without waiting.
- As an Owner I want one automation to answer each comment, one run per person, and the steps — hello, follow, email, phone, messages, tags — in order so that every person gets one clean conversation.
- As an Owner I want public replies and hides after the DM, paced when "Reply like a person" is ON so that the account looks human.

## Rules

- The comment is saved, then intake picks one automation (post-linked first, then the oldest "any post"), checks the once key and the open-run rule, and writes the run and its opening message in one commit (background.comment-intake, operations.automation-comment-flow; D37, P35, P100)
- Window closed: the opening goes as a private reply in the slow lane, one per person per 24 hours, at most 7 days minus 30 minutes after the comment; window open: a normal DM in the fast lane (operations.automation-comment-flow; D8, D9)
- A comment start without a hello allows only one text message with no picture (operations.automation-comment-flow; plan §7.5)
- After the DM is `sent`: the public reply (if ON) then the hide (if on); a comment never gets a nudge (operations.automation-step-public-reply, operations.automation-hide-comment; D32, D33)
- She taps a "next step" button or writes any text; then follow check, email, phone (each only if needed), the message list, the tags; the run is `completed` (operations.automation-step-order, operations.automation-answer-table; D29, D45)
- A wrong email gets "ask again" up to 3 times with wordings, then the run still waits; plus addresses are accepted (operations.automation-step-email-ask; P19)
- A stop word opts her out; a later keyword comment of hers restarts her (operations.contact-stop-words; D49)
- A run waits at most 7 days for her, then is cancelled `wait_expired` (background.waiting-run-cancel)

## Acceptance criteria

- AC-19.1 — Riya comments "GUIDE" with her window closed: her opening DM goes as a private reply at a random second of the slow lane's box, and with "Reply like a person" ON the public reply "@riya Check your inbox" goes later under her comment — intake-files/Instagram-DM-Sending-Plan-v8.md:2741
- AC-19.2 — Riya, who wrote yesterday, comments "GUIDE": the opening message goes as a normal DM in the fast lane within about a second, outside the opening-DM limit, and counts 1 DM in the month — intake-files/Instagram-DM-Sending-Plan-v8.md:2743
- AC-19.3 — Riya taps "Send me the guide": the email question goes 0.5–2 seconds later; her email answer is followed by message 1 within 0.5–2 seconds — intake-files/Instagram-DM-Sending-Plan-v8.md:2747
- AC-19.4 — Riya writes "yes send" instead of tapping: the run moves on as if she tapped and the automation counts a typed answer in "% tapped" — intake-files/Instagram-DM-Sending-Plan-v8.md:2749
- AC-19.5 — Wrong email three times gets three "ask again" wordings, then no more asks while the run waits; a correct email two days later is saved and message 1 goes — intake-files/Instagram-DM-Sending-Plan-v8.md:2753
- AC-19.6 — Riya's comment on a second post (with "once" ON) while her run of that automation is open cancels her open run (`replaced`) with its waiting messages and starts a new one in the same commit; a second comment on the same post is ignored `once_per_post` — plans/decisions.md P35
- AC-19.7 — With "every time" mode, Riya's second comment on post P the next day starts a new run once her earlier run ended; with her window open its hello goes as a normal DM — intake-files/Instagram-DM-Sending-Plan-v8.md:2783
- AC-19.8 — The hide goes after the public reply; if the hide fails, her DM and reply stay as they are — intake-files/Instagram-DM-Sending-Plan-v8.md:2779
- AC-19.9 — "Reply like a person" OFF and ON on two automations of one account: the OFF reply goes right after its DM and does not count for the ON automation's gap and box — intake-files/Instagram-DM-Sending-Plan-v8.md:2777
- AC-19.10 — After the last message the tag step adds its tags (or the automation's name when it has none) and the run is `completed`; the automation's runs counter went up when the run started — intake-files/Instagram-DM-Sending-Plan-v8.md:1245
- AC-19.11 — Riya writes "STOP!": her waiting messages become `skipped`, her open runs `cancelled`, a story reply later sends nothing, and a keyword comment a week later starts her again — intake-files/Instagram-DM-Sending-Plan-v8.md:2755
- AC-19.12 — A run still waiting for her 7 days after it started is cancelled `wait_expired` and she may start that automation again — plans/worker-changes.md WC-45
- AC-19.13 — On a private account no comment automation starts, and the owner sees the private-account banner — intake-files/Instagram-DM-Sending-Plan-v8.md:1262

## Work items

- operations.automation-comment-flow
- operations.automation-comment-match
- operations.automation-step-order
- operations.automation-answer-table
- operations.automation-step-email-ask
- operations.automation-step-public-reply
- operations.automation-hide-comment
- operations.automation-once-rule
- operations.automation-every-time-mode
- operations.contact-stop-words
- background.comment-intake
- background.slow-lane-send
- background.reply-lane-send
- background.fast-message-send
- background.waiting-run-cancel
- data.automation-comment-log
- operations.automation-ad-comment
- operations.automation-comment-replies
- quality.reply-safety
