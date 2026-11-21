Status: ready
Kind: flow
Depends on: webhook-intake, contacts, automations
Route review: [routes-final.md](../../routes-final.md) § 3.B — AU16–AU19, AU21 (with § 3.2 AQ3), § 4.A — WH13
Tables: `app.automation_runs`, `app.automation_run_events`, `app.contacts`, `app.automations`

## Stories

- As an Instagram user who sends a DM with a keyword I want the matching automation to answer so that I get what I asked for.
- As an Instagram user who replies to a story I want that story's automation to answer so that my reply gets a response.
- As an Instagram user I want to answer the email or phone question by quick reply, attachment or typing so that sharing it is easy.
- As an Instagram user I want my button clicks to move the conversation on, and old clicks to be ignored, so that the conversation stays consistent.

## Rules

- The contact comes first: every DM, story reply and button click creates or updates the sender's contact for the account (data.contact)
- A DM — or a `messages` change from Meta — first answers a run of this contact that waits for an email or a phone (an email wait first, then the oldest wait); the answer may come as a quick reply, an attachment's email or typed text (background.event-processing; D18)
- Otherwise the first live automation of the account — any trigger — with the DM keyword trigger on and a keyword the text contains runs, oldest first; an automation with no keywords never answers a DM (background.message-sends; D14)
- A story reply runs the account's oldest live story-reply automation set to any story or to that story whose keywords match (no keywords = every reply); an expired story simply stops matching (background.message-sends; D18)
- A button click continues the run it names when that run waits for the opening button or a follow and its automation belongs to the event's account; a completed, failed, cancelled or running run, a deleted automation's run or another account's run ignores it; when another run of the contact waits for an email, the email question goes first (background.message-sends; D18)
- A follow is confirmed only by a button click, never by a typed message (data.automation-run; D14)
- The opening message is sent on DM and story-reply triggers too, as a normal DM, skipped when a DM went to the contact in the last 24 hours (background.message-sends; D26)
- A story reply while another run of the contact waits for an email is saved on that run, and the email question is asked again (background.queued-automations; D14)
- The steps, the one-open-run rule, the at-most-once send and the failure handling are those of a comment run, without a public reply and without comment logs (background.message-sends, background.never-send-twice; D14, D16)
- A DM or story-reply run keeps its error even when the rest of the event's handling is undone (data.automation-run; D16)

## Acceptance criteria

- AC-9.1 — A DM containing a keyword starts a run of the oldest live automation of the account with the DM keyword trigger on and that keyword; only one automation answers — intake-files/PRD.md:119
- AC-9.2 — An automation with no keywords never answers a DM — intake-files/schema-routes.md:541
- AC-9.3 — A DM while one of the contact's runs waits for an email or a phone is taken as that answer and starts no new run — intake-files/schema-routes.md:537
- AC-9.4 — The email answer is read from the email quick reply, an attachment's email or the typed text — plans/decisions.md D18
- AC-9.5 — A `messages` change from Meta is handled as a DM — intake-files/PRD.md:80
- AC-9.6 — A story reply starts a run of the oldest live story-reply automation set to any story or to that story whose keywords match; once the story has expired, an automation set to it no longer matches — intake-files/schema-routes.md:538
- AC-9.7 — On a DM or story-reply trigger the opening message goes as a normal DM, unless a DM went to the contact in the last 24 hours — plans/decisions.md D26
- AC-9.8 — A button click continues the run named in its payload when that run waits for the opening button or a follow — intake-files/PRD.md:113
- AC-9.9 — A click on a completed, failed or cancelled run, on a run of a deleted automation, or on another account's run is ignored and sends nothing — plans/decisions.md D18
- AC-9.10 — A click while another of the contact's runs waits for an email sends the email question again and does not move the clicked run — intake-files/PRD.md:111
- AC-9.11 — A typed message never confirms a follow; only a click on the follow button does — intake-files/PRD.md:115
- AC-9.12 — A DM or story reply for an automation that already has an open, completed or failed run for the contact starts no new run — plans/decisions.md D14
- AC-9.13 — A story reply while another of the contact's runs waits for an email is saved on that run, and the email question is asked again — intake-files/schema-routes.md:555
- AC-9.14 — A DM or story-reply run that fails keeps its error on the run even when the rest of the event's handling is undone — intake-files/PRD.md:144

## Work items

- background.message-sends (DM, story-reply and button-click rules)
- background.queued-automations
