# Data requirements — launch-2026-11-20-ujai

Answers: what is stored, owned by whom, related how, kept how long, removed how. The fields and the
diagrams live in [db-changes.md](../db-changes.md); each requirement links its table section there
instead of repeating them.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, CT…, AU…, WH…, K… (and the answered questions IQ…, CQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. Every requirement
here is NEW against the platform today.

### `data.app-domain` — NEW

All the records of this iteration live together in one new area of the product, the app domain, under
the drop's own table names. The launch starts empty: nothing is moved over from the legacy system, so
organizations connect Instagram and build their automations again.

Tables: [overview](../db-changes.md#overview).

**Sources:** D1, D7 · `routes-final.md` § 1 IA1 · `schema-routes.md:682` · `PRD.md:5`

### `data.organization-scope` — NEW

Every record belongs to exactly one organization and goes away when that organization is deleted. A
record never points at another organization's record. A signed-in person sees and changes only the
records of their active organization. No record exists without an organization — a webhook event
included (see `data.instagram-webhook-event`). When a person who connected the account, or created or
edited an automation, leaves, the record stays and the "who" is emptied.

Tables: [overview](../db-changes.md#overview), [existing context](../db-changes.md#existing-context).

**Sources:** D21, D28 · `routes-final.md` K5, K6, § 4 WH4 · `schema-routes.md:684`, `:685`, `:686`,
`:688`

### `data.instagram-account` — NEW

An organization connects an Instagram professional account. It has at most one account that is not
revoked, and one Instagram account is live in only one organization at a time. Connecting the same
account again reuses its record — a revoked one too — so its settings come back. The connection status
changes only by actions: `connected` → `expired` or `error` when Instagram stops taking the token;
any status → `revoked` on a disconnect (the team's, Meta's deauthorize request or Meta's data-deletion
request); back to `connected` only by connecting again. The account is never removed while its
organization lives: `revoked` stands in, and a revoked record is kept until the organization is
deleted. Meta's data-deletion request empties its profile and keeps the record.

Table: [instagram_account](../db-changes.md#instagram_account).

**Sources:** D5, D8, D22, D24 · `routes-final.md` § 1.A IA11, IA14, § 1.D IA19, IA20, § 1.10 ·
`schema-routes.md:699`, `:720`, `:736`

### `data.instagram-account-settings` — NEW

Each account has one set of settings: the automation master switch (on by default) and public reply
safety (off by default, with a reply chance, an hourly limit and a random gap whose shortest end is
never above its longest). The settings are created with their defaults at the first connect, kept
through a disconnect, and come back when the same account reconnects. They go away with their account.

Table: [instagram_account_setting](../db-changes.md#instagram_account_setting).

**Sources:** D5 · `routes-final.md` § 1.B IA15, § 1.B.10 · `schema-routes.md:744`, `:746`,
`:753`–`:758` · `PRD.md:157`

### `data.instagram-account-token` — NEW

Each account has one long-lived Instagram token (it lasts about 60 days), stored encrypted and never
shown on any screen or in any answer; the date it ends is also kept on the account, so the account can
be read without touching the token. The token is erased on every disconnect — the team's, Meta's
deauthorize request and Meta's data-deletion request. A renewal never overwrites a newer token that a
reconnect saved in the meantime.

Table: [instagram_account_token](../db-changes.md#instagram_account_token).

**Sources:** D21, D24 · `routes-final.md` § 1 IA5, IA8, § 1.A IA14 · `schema-routes.md:764`, `:766`,
`:775`

### `data.instagram-media` — NEW

A post or reel is stored only when an automation needs it: when a comment arrives on a post not stored
yet, and when a "next post" automation links to a post. The post and story pickers read Instagram live
and store nothing. Each stored post belongs to the Instagram account that published it. A stored post
is kept until its organization is deleted or Meta's data-deletion request erases that account's stored
posts. Automations, runs and comment logs name a post by its Instagram id, so they outlive an erased
post.

Table: [instagram_media](../db-changes.md#instagram_media).

**Sources:** D8, D24 (IQ4) · `routes-final.md` § 1.C IA16, IA17, § 1.D IA20 · `schema-routes.md:782`,
`:784` · `PRD.md:90`

### `data.contact` — NEW

A contact is an Instagram user who commented, sent a DM, replied to a story or clicked a button on one
of the organization's Instagram accounts. Each contact belongs to the Instagram account it came from:
one live contact per organization, Instagram account and Instagram user, so reconnecting the same
account keeps its contacts and another account starts its own. A contact holds the person's profile
(read from Instagram when the contact is new), whether they follow the account, the email and phone
they shared, its tags (at most 50), when it was first seen, when it last sent anything, when it last
sent a direct message, story reply or click, and when it last got a DM from us. Only event processing
creates and changes contacts; no one adds or edits one by hand. A contact is kept until its organization
is deleted or the team deletes it (`data.erasure`); no timer removes contacts, and no plan limit counts
them.

Table: [contact](../db-changes.md#contact).

**Sources:** D8, D12, D22, D25 (CQ3, CQ5) · `routes-final.md` § 2 CT2, CT10, CT11, CT13 ·
`schema-routes.md:888`, `:646`

### `data.automation` — NEW

An automation belongs to its organization and to one Instagram account — the one connected when it was
created; creating one needs a connected account, and the account never changes afterwards. It holds its
trigger (comment, story reply or DM), its target (any post, one post or story, or the next post inside a
time window), keywords, tags, public reply texts, the message of each step — the final message is always
there — and two counters only its runs change. It is deleted softly, with a reason that is always given
(and a note when the reason is "other"): the delete cancels its open runs and keeps its runs and comment
logs. A deleted automation is removed for good 180 days after its delete, once no run or comment log
points at it.

Table: [automation](../db-changes.md#automation).

**Sources:** D19, D26 (AQ6, AQ7) · `routes-final.md` § 3.A AU7, AU8, AU10, AU12, AU27 ·
`schema-routes.md:828`, `:640`

### `data.automation-run` — NEW

A run is one automation flow for one contact. There is at most one open run per automation and contact.
A run holds what triggered it, its status, its current step, what it waits for, and the automations
queued behind an email (one entry per automation). It belongs to its automation's Instagram account:
only that account's events start or move it. A disconnect cancels no run — a waiting run goes on when
the same account reconnects, else the 7-day limit cancels it. A run waits at most 7 days. A run that
ended (completed, failed or cancelled) is kept 180 days, then removed with its history; an open run is
never removed. When its contact is deleted the run stays, without personal data.

Table: [automation_run](../db-changes.md#automation_run).

**Sources:** D8, D16, D24 (IQ1), D25, D26 · `routes-final.md` § 3.B AU16, AU17, AU19, AU21, AU25, AU26 ·
`schema-routes.md:913`, `:545`

### `data.automation-run-event` — NEW

A run keeps an append-only history: one entry for each status change and one for each email or phone
it collected — the value itself lives on the contact, never in the history. Each entry is written
together with the run change it records and is never edited. The history goes away with its run.

Table: [automation_run_event](../db-changes.md#automation_run_event).

**Sources:** D8 · `routes-final.md` § 3.B AU23 · `schema-routes.md:936`, `:938`, `:558`

### `data.automation-comment-log` — NEW

There is one comment log per comment and automation that matched it — the automation that answers and
every other match, logged `ignored` with the reason `comment_already_answered`. A log holds each step's
result and time, what the contact sent back, why the comment was ignored, and Instagram's error details
when a step failed. A failed step still leaves its log. A log always names its contact, and names its
run while that run exists (a removed run leaves the log). Reply safety counts the replies sent from
these logs. A log is kept 180 days.

Table: [automation_comment_log](../db-changes.md#automation_comment_log).

**Sources:** D17, D21, D26 (AQ1) · `routes-final.md` § 3.B AU16, AU20, AU24 · `schema-routes.md:951`,
`:953`

### `data.instagram-webhook-event` — NEW

A webhook event is one event from a Meta delivery, kept as received, with its processing status, its
skip reason or error, and how many times it was tried. Each event kind has a key that is unique per
Instagram account, so a repeated delivery is stored once. Only events for an Instagram account an
organization holds and that is not revoked are stored; an event for any other account leaves only a log
line and a count. Every stored event belongs to an organization and to its Instagram account. No person
changes an event. An event is kept 30 days, whatever its status.

Table: [instagram_webhook_event](../db-changes.md#instagram_webhook_event).

**Sources:** D15, D19, D28 (WQ1) · `routes-final.md` § 4 WH4, § 4.A WH9, § 4.B WH16, WH19 ·
`schema-routes.md:806`, `:808`, `:817`

### `data.retention` — NEW

How long each kind of record is kept (product rules, not settings):

- webhook events: 30 days after they arrive, whatever their status;
- comment logs: 180 days after they are written;
- runs and their history: 180 days after the run ends; an open run waits at most 7 days, then it is
  cancelled;
- deleted automations: removed 180 days after their delete, once nothing points at them;
- accounts (revoked ones too), their settings, contacts and stored posts: until the organization is
  deleted, unless an erase (`data.erasure`) removes the data first.

Everything an organization holds goes when the organization is deleted.

Tables: each section's **Holds** line in [db-changes.md](../db-changes.md).

**Sources:** D8, D25, D26 (AQ7), D28 · `routes-final.md` § 2 CT11, § 3.B AU25, § 4.B WH19 ·
`schema-routes.md:808`, `:953`

### `data.erasure` — NEW

Two kinds of erase, each done inside the request that asks for it:

1. **The team deletes one contact**, to honour that person's own request. The contact's personal data —
   Instagram id, username, name, picture, follower count, follow status, email, phone and tags — is wiped
   and its record kept, so its runs stay. In the same all-or-nothing request its open runs are
   cancelled, the trigger text saved on its runs is emptied, and the copies on its comment logs (comment
   text, commenter id and username, email and phone received) are erased. The contact never shows again;
   a new comment or message from the same person starts a fresh contact. That person's webhook events are
   not erased then: they stay, masked in the events list, until the 30-day clean-up removes them. There is
   no restore.
2. **Meta asks to delete the connected account's owner's data.** In every organization that holds that
   account, revoked records included, the account is disconnected and its token, profile and stored posts
   are erased. Contacts are not touched. Meta's deauthorize request only disconnects the account and
   erases its token. Neither cancels a run.

Tables: [contact](../db-changes.md#contact), [automation_run](../db-changes.md#automation_run),
[automation_comment_log](../db-changes.md#automation_comment_log),
[instagram_account](../db-changes.md#instagram_account),
[instagram_account_token](../db-changes.md#instagram_account_token),
[instagram_media](../db-changes.md#instagram_media).

**Sources:** D22, D24 (IQ1, IQ4), D25 (CT7, CQ1) · `routes-final.md` § 2 CT7, CT8, CT9, § 1.D IA19,
IA20, § 3.B AU26, § 4.B WH18

## Before → after

none — every requirement here is NEW.
