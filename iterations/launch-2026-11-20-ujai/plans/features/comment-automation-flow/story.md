Status: ready
Kind: flow
Depends on: webhook-intake, contacts, automations
Route review: [routes-final.md](../../routes-final.md) § 3.B — AU16–AU24 (with § 3.2 AQ1, AQ3, AQ5), § 4.A — WH13
Tables: `app.automation_runs`, `app.automation_run_events`, `app.automation_comment_logs`, `app.contacts`, `app.automations`, `app.instagram_media`, `app.instagram_account_settings`

## Stories

- As an Instagram user who comments a keyword on a post I want a reply and a DM so that I get what the post promised.
- As an Owner I want exactly one automation to answer each comment so that a person never gets two different DMs for one comment.
- As an Owner I want public replies spaced, varied and capped while reply safety is on so that the account looks human and stays inside Instagram's limits.
- As an Owner I want the flow to ask for a follow, an email and a phone before the final message so that we gather leads.
- As an Owner I want no message ever sent twice, even after a crash or a retry, so that nobody is spammed.
- As an Instagram user who is being asked for my email I want my other triggered automations to wait and then start so that I am not asked many things at once.

## Rules

- The contact comes first: every comment creates or updates the commenter's contact for the account, and the post is stored the first time a comment arrives on it (data.contact, data.instagram-media)
- One automation answers a comment: only the live comment automations of the commented post's Instagram account whose keywords the lowercased text contains (none = every comment) count; those linked to the post (set to it, or a "next post" linked to it) come first and the oldest match runs; only when none of them matches does the oldest matching "any post" automation run; every other match is logged `ignored` · `comment_already_answered`, never `failed`; automations of other posts are not touched; the choice is saved, so a retry never chooses again (background.event-processing; D26)
- One open run per automation and contact. When the chosen automation meets a run: another run waits for the contact's email → the new automation is saved on that run and the email question asked again (`waiting_for_other_email`); this automation waits → `already_waiting`; it is running → `run_in_progress`; its last run is completed or failed → `previous_run_final`, no second run; after a cancelled run a new one may start (data.automation-run; D14)
- The steps, in order: public reply (comments only) → opening message (the private reply to the comment; skipped when the contact got a DM from the account in the last 24 hours; with a button the run waits for the click) → follow check → email → phone → final message; a waiting run moves on at the person's next answer (data.automation-run; D14)
- Public reply safety, while on, checks duplicate → random → hour limit → gap, and the first that applies is saved as the skip reason; a reply never repeats the automation's last reply text; a comment that got a public reply is remembered for good; the counts come from the replies already saved, so they are exact and always readable; a failed public reply never stops the flow; a DM is never held back (quality.reply-safety; D17)
- The follow step waits until the person clicks "I'm following" and Instagram reports them following; otherwise the follow request is sent again (data.automation-run)
- The email answer is checked and saved lowercased on the contact; a wrong one gets the wrong-email text and the question again; a phone answer needs 10 to 15 digits and is saved normalised; anything else sends nothing and keeps the run waiting; a step whose data the contact already has is skipped (data.automation-run, data.contact)
- The final message carries up to 3 link buttons; the run completes, the automation's completed count goes up by one, and its tags — or its name when it has none — are added to the contact (data.automation-run)
- Every status change, and every email or phone collected, is written to the run's history (data.automation-run-event)
- One comment log per comment × matching automation — the chosen one and every ignored one — with each step's status, time and error (data.automation-comment-log; D26)
- Automations saved behind an email (one entry each) start in order once the email arrives, their email step skipped; one no longer live, deleted, or already run for the contact is skipped (background.queued-automations)
- A message is sent at most once: a retry goes on from the saved step and never sends a saved message again; a send whose outcome is unknown fails its step instead (background.never-send-twice; D16, D26)
- Each send waits a random 200–1000 ms first, so replies look human (integrations.send-pause)
- Every message goes through the Instagram connection; a message left empty uses the English default text; a refused email or phone quick reply falls back to plain text (integrations.instagram-messaging; D20)
- A temporary send failure is retried with its event; a permanent failure on a needed message fails the run with its error; a token error marks the account `error` and starts the reconnect notice (background.message-sends, background.retry-policy; D10, D16)

## Acceptance criteria

- AC-8.1 — A comment whose text matches a live comment automation of the post's account creates or updates the commenter's contact for that account, stores the post if it is new, starts one run and writes a comment log `started` — intake-files/schema-routes.md:545
- AC-8.2 — A keyword matches when the lowercased comment contains it; an automation with no keywords matches every comment — intake-files/PRD.md:98
- AC-8.3 — Only the live comment automations of the commented post's Instagram account are considered; automations of another account, and automations set to other posts, never run and get no log — plans/decisions.md D26
- AC-8.4 — When an automation linked to this post (set to it, or a "next post" linked to it) matches, the oldest such match runs, even when an older "any post" automation also matches — plans/decisions.md D26
- AC-8.5 — Only when no post-linked automation matches does the oldest matching "any post" automation run — plans/decisions.md D26
- AC-8.6 — Every other matching automation gets a comment log `ignored` · `comment_already_answered`, never `failed` and never a run — plans/decisions.md D26
- AC-8.7 — A retried or repeated comment never chooses again: the chosen automation's run goes on and the other logs stay as they were — plans/decisions.md D26
- AC-8.8 — When the chosen automation already waits for this contact the comment is logged `already_waiting`; when it is running, `run_in_progress`; when its last run for the contact is `completed` or `failed`, `previous_run_final` and no second run starts; after a `cancelled` run a new run starts — intake-files/schema-routes.md:562
- AC-8.9 — When another automation's run waits for this contact's email, the email question is asked again, the new automation is saved on that run once, and the comment is logged `waiting_for_other_email` — intake-files/schema-routes.md:564
- AC-8.10 — When the email arrives, each saved automation starts as its own run in order, its comment log moves from `ignored` to `started`, and its email step is skipped; one no longer live, deleted, or already run for the contact is skipped — intake-files/schema-routes.md:555
- AC-8.11 — With reply safety off every chosen comment gets a public reply; with it on, the reply is skipped for `duplicate`, `random`, `hour_limit` or `gap`, checked in that order, and the first that applies is saved on the comment log — intake-files/schema-routes.md:546
- AC-8.12 — A public reply never repeats the automation's last reply text — intake-files/PRD.md:162
- AC-8.13 — The same comment never gets a second public reply — not on a retry, not on a repeat delivery, however much later — plans/decisions.md D17
- AC-8.14 — A failed public reply is saved as `failed` on the comment log and the flow goes on to the opening message — intake-files/PRD.md:130
- AC-8.15 — Reply safety never holds back the opening message or any other DM — intake-files/PRD.md:166
- AC-8.16 — The opening message goes as a private reply to the comment unless the contact got a DM from the account in the last 24 hours; with a button the run waits for the click — intake-files/schema-routes.md:553
- AC-8.17 — A click on the opening button moves the run on; with "follow required" and the contact not following, the follow request goes out and the run waits; a click on "I'm following" checks with Instagram — following moves on, not following sends the request again — intake-files/PRD.md:114
- AC-8.18 — With email collection on and no email known, the email question goes out with an email quick reply and the run waits for the email — intake-files/PRD.md:134
- AC-8.19 — A valid email answer is saved lowercased on the contact with its time; an invalid one gets the wrong-email text and the question again, and the run keeps waiting — intake-files/PRD.md:142
- AC-8.20 — A phone answer with 10 to 15 digits is saved normalised on the contact; anything else sends nothing and the run keeps waiting — intake-files/PRD.md:143
- AC-8.21 — The email and phone steps are skipped when the contact already has them — intake-files/schema-routes.md:556
- AC-8.22 — The final message goes with up to 3 link buttons; the run becomes `completed`, the automation's completed count goes up by one, and its tags — or its name when it has none — are added to the contact — intake-files/schema-routes.md:557
- AC-8.23 — Every run status change, and every email or phone collected, adds one entry to the run's history; the contact's last-message-sent time moves after every DM — intake-files/schema-routes.md:558
- AC-8.24 — After a crash or a temporary failure the retry never sends a message twice; a send whose outcome is unknown fails its step instead of being sent again — plans/decisions.md D16
- AC-8.25 — Each send waits a random 200–1000 ms first — intake-files/PRD.md:152
- AC-8.26 — When Instagram refuses a needed message for good, the run becomes `failed` and the error is saved on the run and its comment log — intake-files/PRD.md:141
- AC-8.27 — A token error while sending marks the account `error`, starts the reconnect notice and fails the run — intake-files/schema-routes.md:571
- AC-8.28 — A message the automation leaves empty uses its English default text; when Instagram refuses the email or phone quick reply, the question goes as plain text — intake-files/schema-routes.md:569

## Work items

- data.automation-run
- data.automation-run-event
- data.automation-comment-log
- background.message-sends
- background.never-send-twice
- background.queued-automations
- integrations.instagram-messaging
- integrations.send-pause
- quality.reply-safety
