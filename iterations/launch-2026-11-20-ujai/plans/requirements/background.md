# Background requirements — launch-2026-11-20-ujai

Answers: the rules every piece of background work follows — timing, order, retries, scope. The list of
background work itself — when each piece runs, what it touches, what happens on failure and who is
told — is [worker-changes.md](../worker-changes.md); each piece below is one short requirement that
links its WC row there.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, CT…, AU…, WH…, K… (and the answered questions IQ…, CQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. Every requirement
here is NEW against the platform today.

## Rules for all background work

### `background.per-account-order` — NEW

One Instagram account's events are handled one at a time, in the order they were stored; different
accounts are handled side by side, and a busy account takes turns so it never holds up the others. When
one event keeps failing, the same account's later events wait until it is done or marked `failed` —
about a minute or two at most — so a contact's steps stay in order (an email answer after its question,
a click after its message). What waits, what is linked and what is queued lives in the database, never
only in memory. This replaces the legacy system's up to five events of one account at once, out of
order.

**Sources:** D15, D28 (WQ3) · `routes-final.md` § 4 WH5, § 4.A WH12, WH14 · `schema-routes.md:529` ·
`PRD.md:50`, `:55`

### `background.never-send-twice` — NEW

Each event is handled once, and each message goes out at most once. A repeated delivery is dropped by
its event key. A retry goes on from the run's last saved step, and a message already saved as sent is
never sent again. A send whose outcome is unknown — it may have left but could not be saved — fails its
step instead of being sent again. The automation chosen for a comment is chosen once; a retry never
chooses again. Every handling step must be safe to run twice. This replaces the legacy "log the risk and
send again".

**Sources:** D15, D16, D26 (AQ5) · `routes-final.md` K8, § 3.B AU16, AU19, § 4.A WH13 ·
`schema-routes.md:527` · `PRD.md:66`

### `background.retry-policy` — NEW

A temporary failure — Instagram down or busy, a lost connection, a database hiccup — is retried a capped
number of times (five attempts, each wait longer than the last); after the last one the event is marked
`failed` with its error and the account's next event goes on. A permanent failure — Instagram refuses
the request, the token is refused — fails at once. While Instagram is down, the work that needs it
pauses and spends no attempt. On an event's last attempt a run is marked `failed` rather than left
running. A DM or story-reply run keeps its error even when its other work is undone. Nobody is told
about a failed event; it shows in the webhook events list. A check or clean-up that misses a turn is
safe to skip — the next turn catches up, and doing it twice changes nothing.

**Sources:** D13, D16 · `routes-final.md` § 4.A WH14, WH15, § 3.B AU19 · `schema-routes.md:530` ·
`PRD.md:42`, `:84`

### `background.organization-scope` — NEW

Work on an organization's data runs inside that organization, and every piece of work that touches it
carries which organization it is for. Checks that look across all organizations — the stuck-event
pick-up, the "next post" expiry, the 7-day wait check, the daily account check and the clean-ups — read
only what is due, never another organization's content, then act inside each organization. Because they
span every organization, their times are in UTC; there are no quiet hours, and no piece is a reminder a
person sees at a local time.

**Sources:** D21 · `routes-final.md` K5, K8, § 3 AU6, § 4 WH3 · `schema-routes.md:686`

## Pieces of background work

### `background.event-processing` — NEW

Handle each stored event: the contact first (its profile read from Instagram when it is new), then by
kind. A comment: the post stored, "next post" linking tried, then **one** automation answers — matched by
Instagram account + post + keyword, the automations linked to that post first, the oldest match runs,
every other match logged `ignored` · `comment_already_answered`. A DM: a run of this contact waiting for
an email or phone takes it first, else the first live automation of the account with the DM keyword
trigger and a matching keyword. A story reply: the first matching story automation. A button click:
continues its run; a completed, failed or cancelled run, or another account's, ignores it. Only the
event's own account's automations ever run. The account and the switch are checked again before acting.
→ [WC-1](../worker-changes.md#background-work)

**Sources:** D14, D18, D26 (AQ1), D28 · `routes-final.md` § 4.A WH12, WH13, § 3.B AU16, AU17, AU27 ·
`schema-routes.md:534`–`:541`

### `background.stuck-event-pickup` — NEW

Every minute, hand back to their account's processing the events still waiting 5 minutes after they
arrived and not being worked on. → [WC-2](../worker-changes.md#background-work)

**Sources:** D15 · `routes-final.md` § 4.A WH15 · `schema-routes.md:530`

### `background.message-sends` — NEW

Send a run's messages, each after the human-like pause (`integrations.send-pause`): the public reply to a
comment, when reply safety allows (`quality.reply-safety`); the opening message on every trigger — the
private reply to a comment, a normal DM after a DM or story reply — skipped when the contact got a DM in
the last 24 hours; the follow request; the email and phone questions (as plain text when Instagram
refuses the quick reply); the "wrong email" message; the final DM with up to 3 link buttons. A message
with no text of its own uses the default English text. A DM the team sends by hand from Instagram does
not reset the 24-hour rule at launch. → [WC-3](../worker-changes.md#background-work)

**Sources:** D14, D17, D20, D26 (AQ3, AQ5), D28 (WQ4) · `routes-final.md` § 3.B AU18, AU19, AU22 ·
`schema-routes.md:545`–`:558`, `:569`, `:571` · `PRD.md:130`–`:136`

### `background.next-post-linking` — NEW

When a comment arrives on a post published inside the window of a live, waiting "next post" automation
of the same Instagram account, and no automation of that account targeted that post before, link the
automation to the post — before the comment is matched. Two may link the same post; the older one then
answers. A failed link never stops the comment. → [WC-4](../worker-changes.md#background-work)

**Sources:** D18, D26 (AQ4) · `routes-final.md` § 3.A AU15, AU27 · `schema-routes.md:536` · `PRD.md:90`

### `background.queued-automations` — NEW

While a contact's run waits for their email, other automations they trigger are saved on that run — one
entry per automation. When the email arrives, each starts as its own run, in order, without asking for
the email again; one that is no longer live, was deleted or already has a run for the contact is
skipped. A run cancelled for any reason starts none of them.
→ [WC-5](../worker-changes.md#background-work)

**Sources:** D16, D26 · `routes-final.md` § 3.B AU21 · `schema-routes.md:555`, `:564` · `PRD.md:94`–`:96`

### `background.next-post-expiry` — NEW

Every 15 minutes, mark `expired` each waiting "next post" automation whose window ended with no post
linked; an expired one is not matched any more. → [WC-6](../worker-changes.md#background-work)

**Sources:** D9, D26 · `routes-final.md` § 3.A AU15, § 3 AU6 · `schema-routes.md:629`, `:842`

### `background.daily-account-check` — NEW

Once a day, for each connected account: renew its token when it ends within 7 days, refresh its profile,
and subscribe it to Instagram's events again when it is not subscribed. Instagram only down or busy and
the token still valid: the account stays connected and the next day tries again. Instagram refusing the
token: the account becomes `error` (`expired` when Instagram says so); a token already past its end:
`expired` without asking Instagram. → [WC-7](../worker-changes.md#background-work)

**Sources:** D9, D24 · `routes-final.md` § 1 IA8 · `schema-routes.md:701`, `:775`

### `background.reconnect-notice` — NEW

When the account's connection breaks (`expired` or `error`), tell the people who may manage Instagram,
once per break (`notifications.reconnect-required`). → [WC-11](../worker-changes.md#background-work)

**Sources:** D10, D24 · `routes-final.md` § 1 IA9 · `schema-routes.md:488`, `:571`

### `background.waiting-run-cancel` — NEW

Every hour, cancel each run that has waited more than 7 days — for a button, a follow, an email or a
phone — after checking it still waits; its history records the change, its comment log is marked
cancelled, and the automations saved on it do not start. The contact may then trigger that automation
again. → [WC-13](../worker-changes.md#background-work)

**Sources:** D8, D26 · `routes-final.md` § 3.B AU25, AU21

### `background.run-retention` — NEW

Once a day, remove runs that ended more than 180 days ago, with their history; open runs are never
removed, and their comment logs stay until their own clean-up.
→ [WC-12](../worker-changes.md#background-work)

**Sources:** D8, D26 · `routes-final.md` § 3.B AU25, AU24

### `background.comment-log-retention` — NEW

Once a day, remove comment logs written more than 180 days ago.
→ [WC-9](../worker-changes.md#background-work)

**Sources:** D8, D26 · `routes-final.md` § 3.B AU25 · `schema-routes.md:953`

### `background.webhook-event-retention` — NEW

Once a day, remove webhook events that arrived more than 30 days ago, whatever their status — the events
of a deleted contact included. Every stored event belongs to an organization, so there are none without
one to remove. → [WC-8](../worker-changes.md#background-work)

**Sources:** D8, D25 (CQ1), D28 (WQ1) · `routes-final.md` § 4.B WH18, WH19 · `schema-routes.md:808`

### `background.deleted-automation-purge` — NEW

Once a day, remove for good each automation deleted more than 180 days ago once no run or comment log
points at it; one still pointed at is tried again the next day. The audit log keeps the delete.
→ [WC-15](../worker-changes.md#background-work)

**Sources:** D8, D26 (AQ7) · `routes-final.md` § 3.B AU25 · `schema-routes.md:640`

## Before → after

none — every requirement here is NEW.
