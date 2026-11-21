# Worker changes — launch-2026-11-20-ujai

The background work of this iteration: everything that happens without a user clicking anything.
It says **what** must happen, never how. Kickoff names the pieces and records them in `AS-BUILT.md`.

| Field | Value |
| --- | --- |
| Iteration | `launch-2026-11-20-ujai` |
| Mode | initial |
| Baseline | none |
| Intake mode | full |
| Intake hash | `f91eaeb355eb` |
| Date | 2026-11-20 |

| Change | Count |
| --- | --- |
| NEW | 13 |
| CHANGED | 0 |
| REMOVED | 0 |
| **Total** | **13** |

Updated with the confirmed route review of sub-domain 1, Instagram account ([D24](decisions.md),
[routes-final.md § 1](routes-final.md); its decision ids IA… and question ids IQ… are cited as they
are there): WC-7 is now the one daily account check, and WC-10 (profile refresh) is merged into it
(IA8); WC-11 follows IA9; WC-14 is dropped, because Meta's data deletion now runs inside Meta's own
request (IA20); a disconnect cancels no run (IQ1). WC-10 and WC-14 keep their numbers so earlier
references still lead somewhere; they are not counted.

Updated with the confirmed route review of sub-domain 2, Contacts ([D25](decisions.md),
[routes-final.md § 2](routes-final.md); its decision ids CT… and question ids CQ… are cited as
they are there): **no new background work.** Deleting a contact, and every copy it reaches, happens
inside the delete request (CT7, CT8); contacts have no clean-up timer (CT11); a deleted contact's
webhook events are not erased at the delete — the 30-day clean-up (WC-8) removes them (CQ1, your
call).

Updated with the confirmed route review of sub-domain 3, Automations ([D26](decisions.md),
[routes-final.md § 3](routes-final.md); its decision ids AU… and question ids AQ… are cited as
they are there): **a comment is answered by one automation** — matched by Instagram account + post
+ keyword, the post-linked ones first, the oldest match runs, every other match is logged
`ignored` · `comment_already_answered` (AQ1, your rule; AU16) — in WC-1 and the notes; every
automation belongs to one Instagram account and answers only its events (AU27); the five automation
timers follow AU6: "next post" expiry every 15 minutes (WC-6), the waiting-run cancel every hour
(WC-13), run and comment-log clean-ups daily at 03:20 and 03:30 UTC (WC-12, WC-9) and a **new**
deleted-automation purge daily at 03:40 UTC (WC-15, AQ7). WC-3–WC-5 take AQ3–AQ5 and AU20–AU21.

Updated with the confirmed route review of sub-domain 4, Instagram webhook ([D28](decisions.md),
[routes-final.md § 4](routes-final.md); its decision ids WH… and question ids WQ… are cited as
they are there): **no new background work** — its three pieces are WC-1, WC-2 and WC-8, now
settled. Event processing (WC-1) reads a new contact's Instagram profile (CQ3, WH13), runs one
Instagram account's events in order, and **a failing event holds back its account's later events
until it is done or `failed`** (WQ3) — up to 5 attempts (WH14); the stuck-event pick-up (WC-2) runs
every minute for events stuck over 5 minutes (WH15); the webhook-event clean-up (WC-8) runs daily
at 03:00 UTC (WH19). Events of an account no team holds, or a revoked one, are not stored (WQ1,
WH4), so no event is without an organization; a deleted contact's events are left to WC-8 (CQ1).

**The route review is final.** The 13 counted rows are the ten background pieces it names —
sub-domain 1's daily account check (WC-7) and reconnect notice (WC-11); sub-domain 3's five timers
(WC-6, WC-13, WC-12, WC-9, WC-15); sub-domain 4's processing, pick-up and clean-up (WC-1, WC-2,
WC-8) — plus three parts of event processing that sub-domain 3's run engine owns (WC-3 sending,
WC-4 "next post" linking, WC-5 the automations queued behind an email).

## Background work

| # | Change | Background work | When it runs | What it touches | On failure | Who is told | Requirement | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WC-1 | NEW | Process each stored Instagram event — a comment, a DM, a story reply or a button click — one Instagram account at a time. For each event, oldest first: (1) **take it**, adding one attempt; an event that already used 5 attempts is marked `failed` instead (WH12); (2) **check the account again** — the automation switch off → `skipped` `automation_disabled`; the account not `connected` → `skipped` `account_disconnected` (either can change while an event waits, WH12); (3) **the contact first** — create or update it from the event; when the contact is new, read the person's Instagram profile (name, username, picture, followers) and save it; a failed read saves the contact without it (CQ3, [D25](decisions.md); WH13); (4) **then by kind** (WH13), every event matching only the automations of its own Instagram account (AU27, [D26](decisions.md)): **a comment** — store its post (read from Instagram the first time), try "next post" linking (WC-4; a failed link is logged and the comment is still matched, [D18](decisions.md)), then **one automation answers** (AQ1, your rule, [D26](decisions.md)) — matched by account + post + keyword: of the account's live comment automations whose keywords match, the ones linked to the commented post (a specific post, or a linked "next post") come first and the oldest of them runs; only when none of them matches does the oldest matching "any post" automation run; every other matching automation gets a comment log `ignored` with the reason `comment_already_answered` — never `failed`; automations of other posts are not touched; the choice is saved with the comment's logs, so a retry never chooses again; **a DM** (or a `messages` change, [D18](decisions.md)) — a run of this contact that waits for an email or phone takes it first (a quick reply, an attachment or typed text, [D18](decisions.md)); otherwise the **first** live automation of the account with the DM keyword trigger on and a matching keyword runs; **a story reply** — the account's first live story-reply automation (any story, or this story) whose keywords match; an expired story simply stops matching ([D18](decisions.md)); **a button click** — continues the run named in it, only if it is this organization's run of this contact; a completed, failed or cancelled run ignores it ([D18](decisions.md)); if another run waits for this contact's email, the email question goes first. Then run the steps: start, public reply, opening DM, follow check, email, phone, final DM (WC-3). When the chosen automation meets a run already open for the contact, the comment gets a comment log with that reason instead, and the next match is not tried ([D14](decisions.md), AU17); a contact who already waits for their email for another automation is asked for it again, and the new automation is saved on that run (WC-5, [D18](decisions.md)). (5) **mark the event `processed`** — its handling finished; a run that could not send shows that on the run and its comment log, not on the event (WH12). Every step is safe to run twice for the same event: a retry goes on from the run's last saved step. Echoes are never processed — they are skipped when stored, a DM the team sends by hand included (WQ4, [D28](decisions.md)); a skipped event is never processed later, even when the switch is turned back on. | Each time the webhook stores events of an account (`route-changes.md` RC-5; each event is stored once before Meta gets its answer, [D15](decisions.md)), and each time the stuck-event pick-up (WC-2) finds the account waiting. **In order per Instagram account** ([D15](decisions.md); WQ3, [D28](decisions.md)): one account's events run one at a time, oldest stored first, never two at once anywhere; **a failing event holds back its account's later events until it is done or `failed`** — at most about 1–2 minutes. After 25 events an account lets the others take a turn, then goes on. Different accounts run side by side (WH5, WH12). | Instagram webhook event (status, attempts), contact, Instagram post, automation (completed count, last triggered), automation run, run history, comment log, Instagram account (`expired` or `error` on a token error) | A temporary failure (Instagram down for a moment or busy, a lost connection, a database blip) is retried — **up to 5 attempts**, with growing waits from 5 seconds — while the account's later events wait (WQ3, WH14); the 5th failed attempt marks the event `failed` with its error (a code and a short reason, never message text) and the account's next event runs. A permanent failure (the run engine refuses the event; a token error) fails the event at once ([D16](decisions.md), WH14). An Instagram outage pauses event processing for every account and spends no attempt (WH5, WH14). A retry goes on from the last saved step: a message already sent is never sent again ([D16](decisions.md)). A DM or story-reply run keeps its error even when its work is undone ([D16](decisions.md)). A token error while reading (the follow check) sets the account to `expired` or `error`. | nobody for a failed event — it shows in the webhook events list, the debugging view ([D13](decisions.md); WH14, [D28](decisions.md)); a token error that breaks the connection: the reconnect notice (WC-11, [D10](decisions.md)) | `background.event-processing` | `decisions.md` D13–D16, D18, D25, D26, D28; `routes-final.md` AU16, AU17, AU27, WH5, WH9, WH12–WH14, WQ3, WQ4, CQ3; `schema-routes.md:529`, `schema-routes.md:534`, `schema-routes.md:536`, `schema-routes.md:537`, `schema-routes.md:538`, `schema-routes.md:539`, `schema-routes.md:541`, `schema-routes.md:545`, `schema-routes.md:560`, `schema-routes.md:818`, `PRD.md:42`, `PRD.md:43`, `PRD.md:66`, `PRD.md:75` |
| WC-2 | NEW | Pick up stuck events: find the Instagram accounts that have an event still `received` or `queued` more than 5 minutes after it arrived and not tried in the last 5 minutes — up to 100 accounts a run — and hand each account's events to event processing (WC-1) again (WH15). This also catches the events whose hand-off failed when they were stored (WH10). | Every minute (WH15, [D28](decisions.md)). An event counts as stuck after 5 minutes ([D15](decisions.md)). One look across all organizations that reads only which accounts wait; each account's processing then runs inside its own organization (WH3). | Instagram webhook event (read only — processing changes it) | Safe to skip — the next minute finds them. Never doubled: while an account's processing runs, picking it up again changes nothing, and an event tried in the last 5 minutes is not taken again. A stuck event does not come back for ever: WC-1's 5-attempt limit marks it `failed` — this replaces the earlier proposal "failed after 3 pick-ups" (WH15). | nobody | `background.stuck-event-pickup` | `decisions.md` D15, D28; `routes-final.md` WH3, WH10, WH15; `schema-routes.md:530`, `schema-routes.md:818` |
| WC-3 | NEW | Send the messages of a run, each after a random 200–1000 ms pause: the public reply to the comment (only when reply safety allows it — checked in the order duplicate → random → hour limit → gap, [D17](decisions.md) — and never the same text twice in a row); the opening message — the private reply to a comment, a normal DM after a DM or a story reply (AQ3, [D26](decisions.md)) — skipped when the contact got a DM in the last 24 hours ([D14](decisions.md)); the follow request; the email and phone questions (as plain text if Instagram refuses the quick reply); the "wrong email" message; the final DM with up to 3 link buttons. An empty message uses the default text. Save the time of the last DM on the contact. | When a run step reaches a message (inside event processing). | Comment log (step status, send errors), automation run, contact (last message sent), Instagram account (`error` on a token error) | A temporary send failure is retried with its event; a permanent one fails at once ([D16](decisions.md)). A message already sent is never sent again on a retry ([D16](decisions.md)); a send whose outcome is unknown (a timeout after it left, a crash) fails its step and is never sent again (AQ5, [D26](decisions.md)). A failed public reply is skipped and the flow goes on. A failed needed message sets the run `failed` and saves the error on the comment log. The reply-safety counts are read from the saved comment logs, so they are exact and always readable (AU20; [D17](decisions.md)'s "cannot be read → send anyway" has nothing left to cover); the DM is never held back by reply safety ([D17](decisions.md)). A comment already handled never gets a second public reply ([D17](decisions.md)). A token error sets the account to `error`. | nobody for a failed send — the error is on the comment log; a token error that breaks the connection: everyone in the organization who may manage the Instagram account, in-app notification and email (WC-11, [D10](decisions.md)) | `background.message-sends` | `decisions.md` D10, D14, D16, D17, D26; `routes-final.md` AU18–AU20, AQ3, AQ5; `schema-routes.md:546`, `schema-routes.md:553`, `schema-routes.md:557`, `schema-routes.md:558`, `schema-routes.md:569`, `schema-routes.md:571`, `PRD.md:130`, `PRD.md:141`, `PRD.md:152`, `PRD.md:165` |
| WC-4 | NEW | Link a waiting "next post" automation to a new post. When a comment arrives on a post published inside the window of a live waiting "next post" automation **of the same Instagram account** (AU27), and no automation of that account targeted that post before, the automation becomes `linked` to it. Every such automation links — two may link the same post (AQ4, [D26](decisions.md)); the comment rule of WC-1 then lets the older one answer. Linking runs before the comment is matched, so a just-linked automation counts as linked to that post. A post we do not have yet is stored first. | When a comment on a post is processed (inside event processing). | Instagram post, automation (next post status, linked time, target post) | Safe to skip — a failed link never stops the comment from being matched ([D18](decisions.md)), and the next comment on that post tries again. Never doubled: a linked automation never links again, and one conditional change links them all at once. | nobody; the automation shows `linked` | `background.next-post-linking` | `decisions.md` D18, D26; `routes-final.md` AU15, AU27, AQ4; `schema-routes.md:536`, `schema-routes.md:784`, `schema-routes.md:839`, `PRD.md:90`, `PRD.md:92` |
| WC-5 | NEW | Start the automations queued behind an email. While a contact's run waits for their email, other automations they trigger are saved on that run — one entry per automation (comment log reason `waiting_for_other_email`). Once the email arrives, each saved automation starts as its own run, in order, and its comment log moves from `ignored` to `started`; the email step of those runs is skipped, since the contact now has one (AU21). | When a waiting run receives a valid email (the drop; AU21). The old backend started them at the final DM instead. | Automation run (saved list, new runs), run history, comment log | Each saved automation starts on its own, so one failure does not stop the others; each follows the retry rule of WC-1 ([D16](decisions.md)). One that is no longer live, was deleted or already has a run for the contact is skipped; a malformed entry is skipped and logged (AU21). A run cancelled for any reason — the 7-day wait, an automation or contact delete — starts none of its saved automations (AU21, WC-13). Never doubled: one open run per automation and contact. | nobody | `background.queued-automations` | `decisions.md` D16, D26; `routes-final.md` AU21; `schema-routes.md:545`, `schema-routes.md:555`, `schema-routes.md:564`, `PRD.md:94`, `PRD.md:96`, `PRD.md:136` |
| WC-6 | NEW | Mark a waiting "next post" automation `expired` when its window ends with no post linked ([D9](decisions.md)). An expired automation is not matched any more; changing its window puts it back to `waiting`. A post published just before the end whose first comment comes after this check does not link — accepted for launch (AU15). | Every 15 minutes ([D9](decisions.md); AU6, AU15), once the window's end has passed (the user picks the end in their local time); one check across all organizations, oldest first, then each change inside its own organization. | Automation (next post status) | Safe to skip — the next check catches it. Doing it twice changes nothing: only a still-waiting automation is changed. | nobody (AMBER, open) — the list shows `expired` on the next refresh ([D11](decisions.md)) | `background.next-post-expiry` | `decisions.md` D9, D11, D26; `routes-final.md` AU6, AU15; `schema-routes.md:328`, `schema-routes.md:610`, `schema-routes.md:629`, `schema-routes.md:631`, `schema-routes.md:842`, `PRD.md:93` |
| WC-7 | NEW | **The daily account check** ([D9](decisions.md); IA8, [D24](decisions.md)) — for each connected account, inside its own organization: (1) **renew the Instagram token** when it ends within 7 days (a token lasts about 60 days) — save the new token, its new end (on the account too) and the renewal time; on failure save the error; (2) **refresh the account's profile** from Instagram — username, name, picture, follower, following and post counts, bio and website — and save when it was refreshed (was WC-10); (3) **subscribe the account to the webhook fields again** when it is not subscribed, so an account that missed it at connect still gets events (answers question 10). | Once a day at 04:00 UTC, after the clean-ups (IA8), for every `connected` account — one piece of work per account, and so per organization. | Instagram token (token, end, last renewed, last error), Instagram account (token end, profile, profile refresh time, webhook subscription time, connection status) | Instagram down or busy while the token is still valid: the account stays `connected`, the error is kept and the next day tries again — seven tries before the token ends (answers question 8). Instagram refuses the token: `error` at once (`expired` when Instagram says the token expired). A token whose end has passed: `expired`, without asking Instagram. A failed profile refresh or subscription is tried again the next day. While Instagram is down the check waits instead of failing every account. Safe to repeat: once per account per day, and a renewal never overwrites a newer token that a reconnect saved in the meantime. | when the check breaks the connection (`expired` or `error`): the reconnect notice (WC-11, [D10](decisions.md), IA9) | `background.daily-account-check` | `decisions.md` D9, D10, D24; `routes-final.md` IA8, IA5; `schema-routes.md:450`, `schema-routes.md:451`, `schema-routes.md:454`, `schema-routes.md:457`, `schema-routes.md:701`, `schema-routes.md:736`, `schema-routes.md:739`, `schema-routes.md:775`, `schema-routes.md:776`, `schema-routes.md:777` |
| WC-8 | NEW | Delete every Instagram webhook event received more than 30 days ago, whatever its status — `failed` ones too, since they are only the debugging view (WH19, [D8](decisions.md), [D13](decisions.md)). A deleted contact's events are left to this clean-up: deleting the contact does not erase them, and the list shows them masked until then (CQ1, your call, [D25](decisions.md); WH18). There are no events without an organization to delete — they are never stored (WQ1, WH4, [D28](decisions.md)). | Once a day at 03:00 UTC (WH19, [D28](decisions.md)), before the other clean-ups; one pass across all organizations, in small batches. | Instagram webhook event | Safe to skip — the next day catches up. Deleting twice changes nothing. | nobody | `background.webhook-event-retention` | `decisions.md` D8, D13, D25, D28; `routes-final.md` WH4, WH18, WH19, CQ1; `schema-routes.md:808` |
| WC-9 | NEW | Remove comment logs created more than 180 days ago. Runs and run history have their own clean-up (WC-12, [D8](decisions.md)); contacts stay ([D8](decisions.md)). | Once a day at 03:30 UTC (AU6, AU25, [D26](decisions.md)). | Comment log | Safe to skip — the next day catches up. Removing twice changes nothing. | nobody | `background.comment-log-retention` | `decisions.md` D8, D26; `routes-final.md` AU6, AU25; `schema-routes.md:953` |
| WC-10 | MERGED into WC-7 — not counted | — Refreshing the account's profile once a day ([D9](decisions.md)) is now step 2 of the daily account check (WC-7; IA8, [D24](decisions.md)): one daily pass per account instead of two, the same work with half the calls to Instagram. | — | — | — | — | — (WC-7's) | `routes-final.md` IA8; `decisions.md` D9, D24 |
| WC-11 | NEW | Tell the organization that its Instagram account must be connected again ([D10](decisions.md); IA9, [D24](decisions.md)). The account leaves `connected` in one place only — one guarded change to `expired` or `error` that records when it changed — and only the change that wins starts the notice, after it is saved: **one notice per break**. It sends an in-app notification and an email, in the organization's language, linking to the frontend's Instagram page. A reconnect makes the account `connected` again, so a later break is told again. | When the account's connection becomes `expired` or `error`: a token error while sending (WC-3) or reading (WC-1, the post and story lists), or the daily account check (WC-7) finding the token refused or ended. | Notification (in-app), email | Retried; never sent twice for the same break — a new break after a reconnect is told again. | every active member of the organization who may manage the Instagram account (`instagram-account:manage` — Owner and Admin by default, [D2](decisions.md)) — in-app notification and email ([D10](decisions.md), IA9) | `background.reconnect-notice` | `decisions.md` D2, D10, D24; `routes-final.md` IA9; `schema-routes.md:488`, `schema-routes.md:571`, `schema-routes.md:701` |
| WC-12 | NEW | Remove runs that ended (completed, failed or cancelled) more than 180 days ago, together with their run history ([D8](decisions.md)). Open runs are never removed. Their comment logs stay, without a run, until their own clean-up (WC-9, AU24). | Once a day at 03:20 UTC ([D8](decisions.md); AU6, AU25, [D26](decisions.md)). | Automation run, run history, comment log (its run emptied) | Safe to skip — the next day catches up. Removing twice changes nothing. | nobody | `background.run-retention` | `decisions.md` D8, D26; `routes-final.md` AU6, AU24, AU25; `schema-routes.md:913`, `schema-routes.md:931`, `schema-routes.md:938` |
| WC-13 | NEW | Cancel a run that has waited more than 7 days — for a button, a follow, an email or a phone ([D8](decisions.md)). Its run history gets the status change and its comment log is marked cancelled. The contact can then start that automation again. Automations saved on it (WC-5) do not start — the saved list is dropped (AU21, AU25). | Every hour (AU6, AU25, [D26](decisions.md)). A run is cancelled once it has waited 7 days ([D8](decisions.md)); one check across all organizations, then each cancel inside its own organization. | Automation run (status `cancelled`, saved list emptied), run history, comment log | Safe to skip — the next check catches it. Cancelling twice changes nothing. A run that got its answer just before is not cancelled: the check first makes sure the run still waits. | nobody | `background.waiting-run-cancel` | `decisions.md` D8, D26; `routes-final.md` AU6, AU21, AU25; `schema-routes.md:565`, `schema-routes.md:927`, `schema-routes.md:931` |
| WC-14 | DROPPED — not background work, not counted | — Meta's data-deletion request for the account's owner is no longer background work. Under IA20 ([D24](decisions.md)) the disconnect and the erase — token, profile and stored posts (IQ4) — are a few writes done inside Meta's own request (`route-changes.md` RC-17), before Meta gets its confirmation code. So nothing waits, there is no "still in progress" status to keep, and no record table or status route is needed (IQ2). Contacts are still not touched ([D22](decisions.md)). See **Not background work**. | — | — | — | — | — | `routes-final.md` IA20, IQ2, IQ4; `decisions.md` D22, D24; `route-changes.md` RC-17, F16 |
| WC-15 | NEW | Remove a deleted automation for good once it was deleted more than 180 days ago and no run or comment log points at it any more (AQ7, [D26](decisions.md)). Its runs and comment logs go by their own clean-ups (WC-12, WC-9), so a deleted automation is removed soon after they are gone; the audit log keeps the delete. | Once a day at 03:40 UTC, after the run and comment-log clean-ups (AU6, AU25). | Automation (deleted ones only) | Safe to skip — the next day catches up. One still pointed at is left and tried again the next day. Removing twice changes nothing. | nobody | `background.deleted-automation-purge` | `decisions.md` D8, D26; `routes-final.md` AQ7, AU6, AU25; `route-changes.md` RC-11; `schema-routes.md:640`, `schema-routes.md:960` |

## Before → after

none — every piece is NEW.

## Notes and open questions

### Rules all background work follows

These go to `requirements/background.md` later; that file links here.

1. **One organization at a time.** Work on one organization's data runs inside that organization's
   scope. One organization has one connected Instagram account at a time (`schema-routes.md:160`,
   [D5](decisions.md)), so "per account" is "per organization"; contacts and automations each belong
   to one account (CT13, AU27). The checks that find what is due (WC-2, WC-6, WC-7, WC-13) and the
   clean-ups (WC-8, WC-9, WC-12, WC-15) look across all organizations without opening any organization's
   data ([D21](decisions.md)); each piece of work then runs inside its own organization. Every
   webhook event belongs to an organization: events of an account no team holds are not stored
   (WQ1, WH4, [D28](decisions.md)), so WC-8 has no ownerless events to remove (the drop's
   `schema-routes.md:814`). The webhook and Meta's two requests find their organizations the same
   way, inside the request (IA6, WH3).
2. **In order per Instagram account** (`schema-routes.md:529`, [D15](decisions.md)). One account's
   events run one after another, in the order stored, never two at once; a failing event holds back
   its account's later events until it is done or `failed` (WQ3, [D28](decisions.md); WH12, WH14).
   Different accounts run side by side.
3. **Each event runs once** ([D15](decisions.md), [D16](decisions.md)). Each event is stored once
   before Meta gets its answer; a store failure does not answer success, so Meta delivers again. A
   repeated delivery is dropped when it arrives, by its stored event key (`schema-routes.md:527`). A
   retry or a pick-up never sends a message that was already saved as sent. A send whose outcome is
   unknown — it may have gone out but could not be saved — fails its step and is never sent again
   (AQ5, [D26](decisions.md)); this replaces the old backend's "log the risk and send again"
   (`PRD.md:66`).
4. **Skips are kept, not lost** ([D15](decisions.md)). The webhook request already marks single
   events `skipped` with a reason: `account_disconnected` (the account `expired` or `error`),
   `automation_disabled`, `echo` (the account's own activity, a DM the team sends by hand included —
   WQ4), `read_receipt`, `reaction`, `edit` (`schema-routes.md:528`), and `unsupported` for a kind we
   do not handle (`schema-routes.md:1012`, [D18](decisions.md), [D19](decisions.md)). The drop's
   `unknown_account` is gone: events of an Instagram account no team holds, or a revoked one, are not
   stored at all — a log line and a metric only (WQ1, WH4, [D28](decisions.md)). Event processing
   checks the account and the switch again, because either can change while an event waits (WH12).
5. **A pause before each send:** a random 200–1000 ms (`schema-routes.md:571`, `PRD.md:152`).
6. **Reply safety limits** (`schema-routes.md:546`–`552`; defaults `schema-routes.md:754`–`758`).
   Off by default. When on: reply to about 80% of comments, at most 60 public replies an hour, a
   random 20–60 s gap after the last reply, never the same text twice in a row, never twice to one
   comment. Checked in the order duplicate → random → hour limit → gap; a handled comment is
   remembered for good; when the counts cannot be read the reply is sent anyway
   ([D17](decisions.md)) — the counts come from the saved comment logs, so they are exact (AU20).
   The limits hold even when many events of the account run at the same moment (`PRD.md:163`).
   They cover the public reply only; the DM always goes (`PRD.md:166`).
7. **The 24-hour rule:** no opening DM when the contact got a DM in the last 24 hours
   (`schema-routes.md:553`, [D14](decisions.md)). The opening message goes on every trigger — the
   private reply to a comment, a normal DM after a DM or a story reply (AQ3, [D26](decisions.md)).
8. **Step logs survive a failure.** A comment log is kept even when its step fails
   (`schema-routes.md:953`); run history is written together with each run change
   (`schema-routes.md:938`). A DM or story-reply run keeps its error too ([D16](decisions.md)).
9. **The database is the only truth.** What waits, what is linked, expired or queued lives in the
   database, never only in memory (replaces `PRD.md:36` and `PRD.md:50`).
10. **Quiet times:** none stated. Background work runs at any hour; sends follow the events as they
    come.
11. **Times of day.** Every minute: WC-2 (WH15, [D28](decisions.md)). Every 15 minutes: WC-6
    ([D9](decisions.md)). Every hour: WC-13 (AU6). Once a day: the clean-ups — WC-8 at 03:00 (WH19,
    [D28](decisions.md)), WC-12 at 03:20, WC-9 at 03:30 and WC-15 at 03:40 UTC ([D8](decisions.md);
    AU6, AU25, [D26](decisions.md)) — then the daily account check WC-7 at 04:00 UTC
    ([D9](decisions.md), IA8). Event processing (WC-1) runs whenever events arrive.
    They span every organization, so they run in UTC, not organization time. No piece here is a
    reminder a person sees at a set local time.
12. **Private data in logs:** an event's payload, message and comment text, emails and phone
    numbers are never logged — only ids, kinds, keys, statuses and counts (WH6, [D28](decisions.md));
    secrets never logged; request ids and the repository's redaction are reused ([D21](decisions.md);
    the old backend logged a short text preview, `PRD.md:176`).
13. **One automation answers a comment** (AQ1, your rule, [D26](decisions.md); AU16). A comment is
    matched by Instagram account + post + keyword: only the commented post's account's live comment
    automations count; the ones linked to that post (a specific post, or a linked "next post") are
    checked first and the oldest match runs; only when none of them matches are the "any post" ones
    checked, and the oldest match runs. Every other matching automation gets a comment log
    `ignored` · `comment_already_answered`, never `failed`; automations of other posts are not
    touched. This replaces the drop's "run every matching automation" (`schema-routes.md:536`):
    Instagram takes one private reply per comment, so the others would only fail.
14. **Each automation belongs to one Instagram account** (AU27, [D26](decisions.md)). Every event
    matches only its own account's automations; after a switch to another account the old account's
    automations never run, and their waiting runs end by the 7-day check (WC-13) unless that account
    reconnects (IQ1, [D24](decisions.md)).

### What the old backend does that this design replaces

Agent-os decides the new mechanics at kickoff ([D21](decisions.md)).

- One queue and one worker for each Instagram account, made on the account's first event, plus a
  scanner every 10 s (`PRD.md:12`, `PRD.md:54`, `PRD.md:57`) → replaced by the rule "in order per
  account" (rule 2).
- Up to 5 events of one account at once, so not in order (`PRD.md:55`) → in order per account
  (`schema-routes.md:529`, [D15](decisions.md)).
- Webhook and workers in one process (`PRD.md:9`) → background work runs in its own worker process.
- Duplicates tracked in memory for 10 minutes and only logged (`PRD.md:36`); two entries in the same
  millisecond dropped (`PRD.md:34`) → each event stored once by its key, repeats dropped
  (`schema-routes.md:527`, [D15](decisions.md)).
- The environment name inside queue names (`PRD.md:40`) → removed; meepzo never branches on the
  environment name ([D20](decisions.md)).
- The list of queues kept in memory only (`PRD.md:50`) → each event's status is in the database
  (`schema-routes.md:818`).
- An echo or read receipt skips the **whole** entry (`PRD.md:31`) → only that one event is skipped
  (`schema-routes.md:528`, [D15](decisions.md)).
- With the switch off, events are skipped and lost (`PRD.md:75`–`78`) → they are kept, marked
  `skipped` with `automation_disabled`, and shown in the list for 30 days (`schema-routes.md:528`,
  `schema-routes.md:808`).
- Handlers swallow their own errors, so most failures are never retried (`PRD.md:84`) → a failure
  marks the event `failed` with its error (`schema-routes.md:818`, `schema-routes.md:821`,
  [D16](decisions.md)).
- 3 tries with 2 s then 4 s waits (`PRD.md:42`, `PRD.md:43`) → up to 5 attempts with growing waits
  from 5 seconds, while the account's later events wait; permanent failures fail at once
  ([D16](decisions.md); WH14, WQ3, [D28](decisions.md)).
- At most 100 events a second per worker (`PRD.md:56`) → not in the drop; accounts run side by side,
  and one account takes up to 25 events before the others get a turn (WH5, WH12).
- One database transaction for a whole event, logs outside it (`PRD.md:72`, `PRD.md:144`) → agent-os
  decides ([D21](decisions.md)); the drop keeps comment logs outside the run's work
  (`schema-routes.md:953`).

### Not background work

- **Subscribing the account to the webhook fields** (comments, messages, button clicks) happens inside
  connect, after it is saved. A failure is logged and does not fail the connect
  (`schema-routes.md:457`); the next connect or the daily account check (WC-7) tries again (IA8,
  IA12; answers question 10). The first try is not a row here; the retry is part of WC-7.
- **Cancelling open runs when an automation is deleted** happens inside the delete request
  (`schema-routes.md:640`, AU12); removing the deleted automation for good, 180 days later, is
  WC-15 (AQ7, [D26](decisions.md)).
- **Choosing which automation answers a comment** (AQ1, your rule, [D26](decisions.md)) is part of
  event processing (WC-1, rule 13), not a piece of its own.
- **Disconnecting the account** — by the user ([D5](decisions.md)), when Meta says the owner removed
  the app, or on Meta's data-deletion request ([D22](decisions.md)) — happens inside that request
  (`route-changes.md` RC-15, RC-16, RC-17): `revoked`, the token erased (IA14, IA19). **It cancels
  no run** (IQ1, your call, [D24](decisions.md)): automations stay `live`; nothing runs while no
  account is connected (a revoked account's events are not stored — WQ1, WH4, [D28](decisions.md));
  a waiting run goes on when the same account reconnects, else the 7-day wait check (WC-13,
  [D8](decisions.md)) cancels it. So there is no background work on disconnect.
- **Carrying out Meta's data-deletion request** happens inside that request (`route-changes.md`
  RC-17): the disconnect, then the profile and the stored posts erased (IA20, IQ4,
  [D24](decisions.md)), before Meta gets its confirmation code; the status link opens a frontend
  page that says the data is deleted (IQ2). This was WC-14 — dropped.
- **Deleting a contact** is the team's own request for one person (`route-changes.md` RC-18,
  [D22](decisions.md), [D23](decisions.md)), not Meta's. Inside that request, all-or-nothing, it
  wipes the contact's personal data and keeps the row (CT7), and sub-domain 3's erase step cancels
  the contact's open runs, empties the comment text saved on its runs and erases the comment-log
  copies (CT8) — like cancelling runs when an automation is deleted ([D25](decisions.md)). The
  person's webhook events are not erased there: the 30-day clean-up (WC-8) removes them (CQ1, your
  call, [D25](decisions.md)). So no background row (question 16; `route-changes.md` F18).
- **Marking the account `expired` or `error`** on an Instagram auth error while listing posts or
  stories happens inside those requests (`schema-routes.md:488`), through the one guarded change
  (IA9); it starts the reconnect notice (WC-11, [D10](decisions.md)).
- **Storing each event once and skipping** happen inside the webhook request (`route-changes.md`
  RC-5; `schema-routes.md:528`): echoes (the account's own activity, a hand-sent DM included — WQ4),
  read receipts, reactions, edits, `unsupported` kinds, a switched-off account and an `expired` or
  `error` account are stored `skipped`; the events of an account no team holds, or a revoked one,
  are not stored at all (WH4, WH9, WH10, [D28](decisions.md)). The hand-off to event processing
  follows the store; a failed hand-off is left to WC-2 (WH10).
- **No clean-up timer for contacts and posts.** Contacts are kept until the organization is deleted
  or the team deletes the contact (`route-changes.md` RC-18) ([D8](decisions.md),
  [D22](decisions.md)); a deleted contact's row, empty of personal data, stays while its runs point
  at it (CT7, CT11, [D25](decisions.md)). Posts are kept until the organization is deleted or Meta's
  data-deletion request erases them ([D8](decisions.md); IQ4, [D24](decisions.md)).
- **No import from the legacy system** ([D7](decisions.md)). The launch starts empty, so there is no
  one-off data move.
- **No live updates** ([D11](decisions.md)). Background work only changes the database; screens show
  it on refresh.

### Open questions

Step 4 answered most of them (marked with their decision). The rest keep their proposed default as
AMBER and stay open.

1. **Retry rule for a failed event (WC-1).** Answered — [D16](decisions.md), WH14
   ([D28](decisions.md)): temporary failures retry up to 5 attempts, with growing waits from
   5 seconds, then `failed` with the error; permanent failures fail at once; an Instagram outage
   spends no attempt; a message already sent is never sent again (the old backend: 3 tries, 2 s then
   4 s, `PRD.md:42`).
2. **Who hears about failed events (WC-1).** Answered — WH14 ([D28](decisions.md)): nobody; a
   failed event shows in the webhook events list, the debugging view (`schema-routes.md:575`,
   [D13](decisions.md)).
3. **Stuck-event check (WC-2).** Answered — WH15 ([D28](decisions.md)): stuck after 5 minutes
   ([D15](decisions.md)), checked every minute; no pick-up count — WC-1's 5-attempt limit marks a
   stuck event `failed`. A picked-up event runs next in line for its account.
4. **When queued automations start (WC-5).** Answered — AU21 ([D26](decisions.md)): right after the
   email arrives (the drop, `schema-routes.md:555`), not when the run that asked for it ends (the
   old backend, `PRD.md:136`); one that is no longer live, was deleted or already has a run for the
   contact is skipped.
5. **"Next post" expiry (WC-6).** Answered — [D9](decisions.md): a check every 15 minutes marks it
   once the window's end has passed. The edge case — a post published just before the end whose
   first comment comes after it does not link — is accepted for launch (AU15, [D26](decisions.md)).
6. **Who hears that a "next post" automation expired (WC-6).** AMBER, open. Proposed: nobody for
   launch; the list shows `expired` on refresh (`schema-routes.md:328`, [D11](decisions.md)).
7. **Token renewal timing (WC-7).** Answered — [D9](decisions.md): once a day, renew every token that
   ends within 7 days — now step 1 of the daily account check at 04:00 UTC (IA8,
   [D24](decisions.md)). (Instagram's own rule, not in the drop: only a token that has not yet ended
   can be renewed.)
8. **Connection status after a failed renewal (WC-7).** Answered — IA8 ([D24](decisions.md)): stays
   `connected` while the token is still valid and Instagram is only down or busy (the error is kept,
   the next day tries again — seven tries before the token ends); `error` at once when Instagram
   refuses the token (`expired` when Instagram says it expired); `expired`, without asking Instagram,
   once the token's end has passed. New events of an `expired` or `error` account are stored
   skipped as `account_disconnected`; a `revoked` account's are not stored (WQ1, WH4,
   [D28](decisions.md)). Who sets `revoked`: answered — disconnect ([D5](decisions.md)), Meta's
   deauthorize request and Meta's data-deletion request ([D22](decisions.md)).
9. **Who hears that Instagram must be reconnected (WC-3, WC-7).** Answered — [D10](decisions.md):
   in-app notification and email to everyone in the organization who may manage the Instagram account
   (WC-11).
10. **A failed webhook subscription at connect.** Answered — IA8 ([D24](decisions.md)): an account
    that is not subscribed gets no events at all, so the daily account check (WC-7, step 3)
    subscribes it again, as well as the next connect (IA12); reading the account shows whether it is
    subscribed (`is_webhook_subscribed`, `route-changes.md` RC-13, IA13). The drop's rule alone
    (retry only on the next connect) would leave such an account silent.
11. **Clean-up time of day (WC-8, WC-9, WC-12, WC-15).** Answered for sub-domain 3's — AU25
    ([D26](decisions.md)): WC-12 at 03:20, WC-9 at 03:30, WC-15 at 03:40 UTC. Answered for WC-8
    (sub-domain 4's) — WH19 ([D28](decisions.md)): once a day at 03:00 UTC. What is kept: answered — [D8](decisions.md) (runs and run history 180 days after they end,
    WC-12; contacts until the organization is deleted or the team deletes the contact,
    [D22](decisions.md); posts until the organization is deleted or Meta's data-deletion request
    erases them, IQ4). The daily account check (WC-7) runs after them, at 04:00 UTC (IA8).
12. **Reply safety when its counts cannot be read.** Answered — [D17](decisions.md): the reply is
    sent anyway, like the old backend (`PRD.md:164`); the DM is never affected.
13. **A time limit on waiting runs.** Answered — [D8](decisions.md): a run waits at most 7 days, then
    it is cancelled (WC-13).
14. **Refreshing the account profile.** Answered — [D9](decisions.md): once a day — step 2 of the
    daily account check (WC-7; WC-10 merged into it, IA8, [D24](decisions.md)).
15. **How often the 7-day wait check runs (WC-13).** Answered — AU25 ([D26](decisions.md)): every
    hour; automations saved on a run that is cancelled this way do not start (AU21).
16. **A deleted contact's runs, run history and comment-log copies (RC-18).** Superseded here by
    [D22](decisions.md): Meta's request never touches contacts; a contact's data goes only when the
    team deletes the contact, inside that request — so it is not background work either way.
    Answered — CT7, CT8 ([D25](decisions.md), `route-changes.md` F18): the contact's row, its runs
    and run history stay, without personal data; in the same request its open runs are cancelled,
    the comment text saved on its runs is emptied, and the comment text, commenter id and username,
    email and phone kept in comment logs are erased. Its webhook events are left to the 30-day
    clean-up (WC-8; CQ1, your call).
17. **Whose data Meta's request names (formerly WC-14).** Answered — [D22](decisions.md): the person
    who logged in to the app, which with Instagram business login is the connected account's owner,
    never a commenter; contacts are not touched (`route-changes.md` F17). Since IA20
    ([D24](decisions.md)) the disconnect and the erase of the token, profile and stored posts run
    inside Meta's request (RC-17), so WC-14 is dropped.
18. **Open runs on disconnect ([D5](decisions.md), [D22](decisions.md)).** Answered — IQ1, your call
    ([D24](decisions.md)): disconnecting the account — by the user, by Meta's deauthorize request or
    by Meta's data-deletion request — **cancels nothing**. Automations stay `live`; nothing runs while
    no account is connected (a revoked account's events are not stored — WQ1, WH4,
    [D28](decisions.md)); a waiting run goes on when the same account reconnects, else the 7-day wait
    check (WC-13, [D8](decisions.md)) cancels it.
19. **Events of an Instagram account no team holds, or a revoked one (WQ1).** Answered — WH4
    ([D28](decisions.md)): not stored; a log line and a metric, and Meta still gets its success
    answer. So WC-8 has no ownerless events to remove; an `expired` or `error` account's events are
    still stored, skipped as `account_disconnected`.
20. **When one event keeps failing, do its account's later events wait (WQ3)?** Answered — WH12,
    WH14 ([D28](decisions.md)): yes — strict order keeps a contact's steps right (an email answer
    after its question, a click after its message); the wait lasts at most about 1–2 minutes, until
    the 5th attempt marks the event `failed` (WC-1).
21. **Does a DM the team sends by hand count for the 24-hour opening-DM rule (WQ4)?** Answered —
    WH9 ([D28](decisions.md)): not at launch — it comes back as an echo, which is skipped (WC-1,
    rule 4). A known gap: a comment soon after a hand-sent DM can still get the opening DM.
