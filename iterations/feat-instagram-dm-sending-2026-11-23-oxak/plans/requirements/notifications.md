# Notification requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: who is told what, through which channel, when. The background work that sends each one is in
[worker-changes.md](../worker-changes.md); the in-app banners and organization notices that are read, not
sent, are [`operations.instagram-account-banners`](operations.md) and
[`operations.organization-notices`](operations.md).

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids UN…, MC…, K… are in [routes-final.md](../routes-final.md);
RC-… are rows of [route-changes.md](../route-changes.md); WC-… rows of [worker-changes.md](../worker-changes.md);
`plan:L…` points into `../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch
built or the platform today.

### `notifications.kinds-v8` — CHANGED

Notification choices speak seven **kinds**, each grouping its types, with a channel switch each (email,
in-app, push — push "soon", off): automation problem (automation stopped, reconnect required), direct
message limit (80 % and 100 %), contact details left, team change (invite accepted or declined, role changed,
removed), billing (payment failed or succeeded, subscription updated, trial ending, choose a plan), weekly
summary, and broadcast or past comments done. Nine new types join the eleven of today. A person reads the
kinds with each channel's effective value and whether it is locked, and saves kind × channel; each save
writes one row per type of the kind. Turning billing email off is refused.

**Sources:** D54, P28, P87 · routes-final § 11.C UN8–UN10 · RC-84, RC-85 · plan:L8117–L8238

### `notifications.owner-email-defaults` — CHANGED

With no choice saved, email is **on** for automation problems, the direct message limit, team changes,
billing and the weekly summary, and **off** (in-app only) for "new contact left details" and "broadcast or
past comments done"; the weekly summary is email only. Security and billing emails can never be turned
off. Push is off.

**Sources:** D54 · routes-final § 11.C UN9 · plan:L8137–L8147

### `notifications.check-before-send` — CHANGED

Every notification reads the recipients' choices for its type before it goes: in-app on → the in-app row;
email on → one email, keyed by the caller's once key so a replay never sends twice; an email with in-app off
is still sent once and writes no in-app row.

**Sources:** P88 · routes-final § 11.C UN11 · [worker-changes notes](../worker-changes.md) (P87, P88)

### `notifications.recipients-by-code` — NEW

Who is told is decided by the codes people hold, never by role names: Owner, Admin, Editor are the active
members holding `automation:update`; Owner and Admin are the holders of `subscription:manage` (billing) or
`membership:update` (team changes, plus the member it is about); "who started it" is the run's or broadcast's
author plus the billing holders.

**Sources:** routes-final § 11 UN2 · plan:L8139–L8147

### `notifications.reconnect-required` — CHANGED

When an account or its channel connection breaks — the daily token check or a login error while sending —
every account on it gets one notice per break (in-app and email) to the people who manage accounts.

**Sources:** D24, P41 · routes-final § 1 MC11 · [WC-46](../worker-changes.md#background-work)

### `notifications.owner-emails` — NEW

The owners are emailed about account problems — blocked, connection stopped, message access off, a refused
text, any stop over 1 hour, missed comments found, plan ended, payment failed, plan switches off after a
move down — one email of a kind per account per 6 hours; a stop that ended before its email was due sends
none. Team alerts are grouped across accounts and go by email and a second channel.

**Sources:** D54, P83 · plan:L2663–L2671 · [WC-57](../worker-changes.md#background-work)

### `notifications.month-limit` — NEW

At 80 % and at 100 % of the organization's messages this month: a notice and an email each, once per
organization per month and line, to the people the kind names.

**Sources:** D34, P3 · routes-final § 11.C UN8 · [WC-56](../worker-changes.md#background-work)

### `notifications.automation-stopped` — NEW

An automation that stops itself tells the kind's recipients once per stop, never once per failed message.

**Sources:** routes-final § 11.C.10 · plan:L8158

### `notifications.contact-details-left` — NEW

After a contact leaves her email or phone, one grouped note per account at most once an hour counts the
account's contacts who left details since the first ("3 new contacts left details on @account_a"); none left
by then → nothing.

**Sources:** D54 · routes-final § 11.D UN13 · [WC-63](../worker-changes.md#background-work)

### `notifications.weekly-summary` — NEW

On Monday between 09:00 and 09:59 in the organization's time zone, each member who has the kind on gets the
last 7 days per account — runs, DMs sent, % tapped, new contacts, emails and phones, the top automation, the
month count; a quiet week sends nothing.

**Sources:** routes-final § 11.D UN12 · [WC-58](../worker-changes.md#background-work) · plan:L8184–L8192

### `notifications.done-notes` — NEW

A finished broadcast and a finished past-comments read tell who started it and the Owner and Admin (in-app by
default, email off).

**Sources:** D54 · routes-final § 11.C UN9 · [WC-29, WC-41](../worker-changes.md#background-work)

### `notifications.trial-and-plan-choice` — NEW

A trial's owners get a notice and email 3 days and 1 day before it ends; an organization still on a retired
plan row gets one email asking it to choose Creator or Studio; a move down that turns switches off sends one
notice and email.

**Sources:** D73, P80, P83 · routes-final § 8 BL17, BL24 · [WC-38, WC-59](../worker-changes.md#background-work)

### `notifications.team-changes` — NEW

A member whose main role changes or who is removed, and the Owner and Admin, are told.

**Sources:** routes-final § 11.C UN8, UNC6 · plan:L8139–L8147

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `notifications.kinds-v8` | 11 types, preferences per type × channel | 7 kinds grouping 20 types; preferences read and saved per kind; billing email locked | D54, P87 |
| `notifications.owner-email-defaults` | every type sends in-app and email to every recipient | per-kind defaults; contact details and done notes email off; security and billing always on | D54 |
| `notifications.check-before-send` | the dispatch writes the row and enqueues in-app and email without reading any choice | reads every recipient's choice first; in-app only when on; one email keyed by the caller's once key | P88, UN11 |
| `notifications.reconnect-required` | one notice per break when the one Instagram account became `expired` or `error` | one notice per account and break when an account or its channel connection becomes `error` | D24, P41 |
