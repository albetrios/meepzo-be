# Operations requirements — launch-2026-11-20-ujai

Answers: what people — and Meta — can do: connect, change, disconnect, list, search, filter, sort,
create, edit, delete. Each operation names its route in the route review (route 1–18) and its proposal
in [route-changes.md](../route-changes.md) (RC-…); the paths live only there.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, CT…, AU…, WH…, K… (and the answered questions IQ…, CQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. Every requirement
here is NEW against the platform today. Who may do each one is in [access.md](access.md).

### `operations.connect-instagram` — NEW

A person who may manage Instagram finishes "Connect Instagram" with the code Instagram sent back
(route 1, RC-1). Only a professional Instagram account that granted every permission the product needs
is accepted. It is refused when Instagram refuses the code (expired, used, another redirect address),
when the account is a personal one, or when a needed permission was left unticked — none of these can
ever pass. It is a conflict when the organization already has another account that is not revoked, or
when this account is live in another organization. Connecting an account the organization had before
reuses its record and its settings and says so; a new account gets the default settings. After it is
saved, the account is subscribed to Instagram's comment, message and button-click events; a failed
subscription never fails the connect (`integrations.webhook-subscription`). Nothing is saved when an
Instagram step fails. Sending the same request again with the same key gets the first answer. The
connect is written to the audit log.

**Sources:** D5, D24 (IQ6) · `routes-final.md` § 1.A IA12, § 1 IA10 · `schema-routes.md:28`, `:438`,
`:450`–`:458`

### `operations.read-instagram-account` — NEW

Everyone who may view Instagram content sees the connected account (route 2, RC-13): its profile, its
connection status — `connected`, `expired` or `error`, so a reload shows the reconnect card — its
settings, when its token ends, and whether it receives Instagram's events. The token itself is never
shown. With no account, or only revoked ones, the account is not found. It is read from our own records,
never from Instagram.

**Sources:** D5 · `routes-final.md` § 1.A IA13 · `schema-routes.md:208`–`:227`

### `operations.change-account-settings` — NEW

A person who may manage Instagram turns the automation master switch on or off and sets public reply
safety (route 3, RC-14): on or off, the reply chance (0–100 %), the hourly limit (1–1000 replies) and
the shortest and longest gap (5–3600 seconds, the longest never below the shortest), whole numbers only,
at least one field per change. It also works while the account is `expired` or `error`, so the switch
can be turned off while reconnecting. An optional "last seen" time refuses a save made over a newer
change. The change is written to the audit log with the names of the fields that changed.

**Sources:** D5 · `routes-final.md` § 1.B IA15 · `schema-routes.md:198`–`:206`

### `operations.disconnect-instagram` — NEW

A person who may manage Instagram disconnects the account (route 4, RC-15). The account becomes
`revoked`, its token is erased, its settings and profile are kept, and the organization may connect
another account. Instagram is asked to stop sending the account's events; a failure there never blocks
the disconnect. Events that still arrive for a revoked account are not stored. A disconnect cancels no
run: the automations stay `live`, nothing runs while no account is connected, and a waiting run goes on
when the same account reconnects, else the 7-day limit cancels it. The disconnect is written to the
audit log.

**Sources:** D5, D24 (IQ1), D28 (WQ1) · `routes-final.md` § 1.A IA14, § 4 WH4 · `schema-routes.md:221`

### `operations.browse-media` — NEW

Everyone who may view Instagram content pages through the account's posts and reels, read live from
Instagram, to pick a post for an automation (route 5, RC-2). Paging follows Instagram's own pages, up to
50 a page (25 by default), with no total. Nothing is stored. An account that must be reconnected is
reported as such without asking Instagram; when Instagram refuses the token, the account is marked for
reconnect first (which starts the reconnect notice) and then reported the same way. When Instagram is
down or busy the person is told to try again later.

**Sources:** D10 · `routes-final.md` § 1.C IA16, § 1 IA9 · `schema-routes.md:29`, `:473`–`:489`

### `operations.browse-stories` — NEW

The same for the account's live stories, for story-reply automations (route 6, RC-3): each story shows
when it ends (24 hours after it was published). Paging, reconnect and "try again later" work as for
posts.

**Sources:** `routes-final.md` § 1.C IA16 · `schema-routes.md:30`, `:491`–`:500`, `:263`

### `operations.meta-deauthorize` — NEW

When the account's owner removes the app on Instagram, Meta tells us (route 7, RC-16). In every
organization that holds that owner's account, the account is disconnected as in
`operations.disconnect-instagram` — `revoked`, its token erased — without asking Instagram to stop the
events, since the app is already removed. An already revoked account changes nothing. No run is
cancelled. The answer is the same when no account matches, so Meta does not retry. Each organization
changed gets an audit entry marked as coming from Meta. Meta's request names the owner by the
app-scoped id — confirmed with a test account before this route ships.

**Sources:** D22, D24 (IQ1, IQ3) · `routes-final.md` § 1.D IA18, IA19

### `operations.meta-data-deletion` — NEW

When the account's owner asks Meta to delete their data, Meta tells us (route 8, RC-17). In every
organization that holds that owner's account, revoked records included, the account is disconnected
and its token, profile and stored posts are erased — all before Meta gets its answer, so nothing waits
in the background. Contacts are not touched. Meta's answer carries a confirmation code and a status
link that opens a frontend page saying the data is deleted; the same request sent again gets the same
code, and a request for someone we never stored still gets one. The audit entry is the only record of
the request — there is no request list and no status lookup. Each organization changed gets an audit
entry marked as coming from Meta, with the code.

**Sources:** D22, D24 (IQ2, IQ3, IQ4) · `routes-final.md` § 1.D IA20, § 1.D.10

### `operations.list-contacts` — NEW

Everyone who may view contacts sees the Contacts page list (route 9, RC-12): every live contact, with
the email and phone they shared and the Instagram account they came from. They can:

- search, any case, over username, full name and email, every word anywhere;
- filter by tags (up to 10; the contact holds them all), has an email, has a phone, follows the account
  (yes = follows; no = checked and does not follow), first seen between two times, had a run of one
  automation, and one Instagram account (every account by default);
- sort by last message received (the default, newest first), first seen, or username (A to Z, contacts
  without a username last), in either direction;
- page through the list, with a total on the first page.

Members see emails and phones too. A deleted contact is never listed. The list is not live: a refresh
shows new contacts and new messages.

**Sources:** D2, D11, D25 (CQ2, CQ5) · `routes-final.md` § 2 CT4, CT5, CT6, CT13 · `schema-routes.md:39`,
`:372`–`:382`, `:644`–`:653`

### `operations.delete-contact` — NEW

A person who may delete contacts erases one contact, to honour that person's own request (route 10,
RC-18) — what is erased, and what is not, is `data.erasure` (1). No reason is asked and there is no
restore. A contact already deleted, or another organization's, is not found. The audit entry names the
contact's public id only, never the erased values.

**Sources:** D22, D23, D25 (CT7, CQ1) · `routes-final.md` § 2 CT7, CT8, CT9, CT12

### `operations.list-automations` — NEW

Everyone who may view automations lists them (route 11, RC-7), each showing the Instagram account it
belongs to. They can search the name, any case; filter by status, trigger, target, "next post" status
and Instagram account; sort by created (the default, newest first), name (A to Z), last triggered
(never triggered last) or completed runs (most first), in either direction; and page through, with a
total on the first page. Deleted automations are never listed. The counters are shown as they were at
the last refresh.

**Sources:** D11, D26 (AQ9) · `routes-final.md` § 3.A AU13, AU27 · `schema-routes.md:34`,
`:324`–`:331`, `:584`–`:588`

### `operations.create-automation` — NEW

A person who may create automations adds one (route 12, RC-8) — the Duplicate button uses the same
action. The automation belongs to the Instagram account connected now; with no connected account it is
refused until one connects. Every saved automation is a complete flow, whatever its status:

- "next post" only on comment automations; a DM automation targets any message, has at least one
  keyword and keeps its DM keyword trigger on;
- "one post" or "one story" names that post or story, and only that one;
- public replies only on comment automations, with 1–20 texts;
- every step that is on has its message, and the final message is always there;
- a comment automation whose opening message is on gives that message a button;
- a "next post" window has both dates, ends after it starts, starts no earlier than 24 hours ago and
  does not end in the past.

Two live, waiting "next post" automations of the same Instagram account may not overlap in time while
sharing a keyword (or while either has none): the save is refused as a conflict that names the other
automation, the keyword and its dates. Sending the same request again with the same key gets the first
answer. Creating is blocked while the organization's plan is read-only (`quality.read-only-plan`). The
create is written to the audit log.

**Sources:** D19, D26 (AQ2, AQ8), D27 · `routes-final.md` § 3.A AU7, AU8, AU9, AU27 ·
`schema-routes.md:35`, `:590`–`:616`

### `operations.read-automation` — NEW

Everyone who may view automations opens one (route 13, RC-9), with the Instagram account it belongs to.
A deleted automation, or another organization's, is not found.

**Sources:** `routes-final.md` § 3.A AU27 · `schema-routes.md:36`, `:620`–`:622`

### `operations.edit-automation` — NEW

A person who may edit automations changes one, or turns it on or off (route 14, RC-10). The create
rules run on the automation as it will be after the change. The Instagram account never changes; the
counters and the "next post" status belong to the system. Changing the window of an `expired` "next
post" automation puts it back to `waiting`; a `linked` one keeps its window, target and post. An
optional "last seen" time refuses a save made over a newer change. An edit reaches open runs from their
next step, and a step turned off meanwhile is skipped; turning an automation off stops new runs and
lets open ones finish. Editing is blocked while the organization's plan is read-only. The change is
written to the audit log with the names of the fields that changed.

**Sources:** D26 (AQ8), D27 · `routes-final.md` § 3.A AU8, AU9, AU11, AU14, AU27 · `schema-routes.md:37`,
`:624`–`:634`

### `operations.delete-automation` — NEW

A person who may delete automations deletes one (route 15, RC-11) with a reason that is always given —
a mistake, a duplicate, not needed, or other with a note of up to 280 characters. In the same request
its running and waiting runs are cancelled, each with an entry in its history, and their comment logs
are marked cancelled; its runs and comment logs stay. There is no restore at launch; the deleted
automation is removed for good 180 days later (`background.deleted-automation-purge`). Deleting is
blocked while the organization's plan is read-only. The audit entry carries the reason and how many
runs were cancelled.

**Sources:** D26 (AQ6, AQ7, AQ8), D27 · `routes-final.md` § 3.A AU12, § 3.10 · `schema-routes.md:38`,
`:636`–`:642`

### `operations.webhook-verify` — NEW

Meta checks the webhook subscription (route 16, RC-4). When the mode is "subscribe" and the verify token
matches the configured one — compared so that timing gives nothing away — the challenge is sent back as
plain text. A wrong mode or token is refused; with no verify token configured the check answers that the
service is not set up.

**Sources:** `routes-final.md` § 4.A WH7 · `schema-routes.md:31`, `:502`–`:512`

### `operations.webhook-receive` — NEW

Meta delivers comments, DMs, story replies and button clicks (route 17, RC-5). The signature is checked
first. Each event of an Instagram account an organization holds and that is not revoked is stored once,
before Meta gets its answer — as received, or already skipped with its reason: the account's own
activity (`echo`), a read receipt, a reaction, an edit, a kind we do not handle (`unsupported`), the
automation switch off, or the account `expired` or `error`. The rest are handed to event processing
(`background.event-processing`) and Meta is answered OK at once. When events cannot be stored, the
answer is never a success, so Meta delivers again and what was already stored is not stored twice. An
event for an unknown or revoked account, a signed body that cannot be read, or a delivery that is not an
Instagram one is answered OK and stores nothing — a log line and a count only. A skipped event is never
processed later, even when the switch is turned back on.

**Sources:** D14, D15, D18, D19, D28 (WQ1, WQ4) · `routes-final.md` § 4.A WH8, WH9, WH10, § 4.10 ·
`schema-routes.md:32`, `:514`–`:530` · `PRD.md:7`, `:20`, `:22`, `:30`, `:78`

### `operations.list-webhook-events` — NEW

People who may see the received events — Owner and Admin by default, never the Member role — see what
arrived from Meta and what happened to each event: the debugging view (route 18, RC-6). The list is newest first; it filters by status, kind, and received
between two times; it pages, with a total only when asked. Each event shows its payload masked: message
and comment text cut to the first 40 characters, emails and phone numbers masked, media and attachment
links replaced; ids, kinds and usernames stay. Only the organization's own events are listed. A failed
event shows here with its error; no one is told about it.

**Sources:** D4, D13, D28 (WQ2) · `routes-final.md` § 4.B WH17 · `schema-routes.md:33`, `:573`–`:582`

Not at launch (out of scope, no requirement): reading runs or comment logs (D13), restoring a deleted
automation (`routes-final.md` § 3.A AU12), exporting a contact's data (D25, CQ4).

## Before → after

none — every requirement here is NEW.
