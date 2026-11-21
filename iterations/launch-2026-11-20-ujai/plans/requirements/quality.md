# Quality requirements — launch-2026-11-20-ujai

Answers: audit, privacy, retention, limits, idempotency, performance expectations. How long each record
is kept is [data.md](data.md) › `data.retention`.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, CT…, AU…, WH…, K… (and the answered questions IQ…, CQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. One requirement
here changes what the platform does today (`CHANGED`, see Before → after); the rest are NEW.

### `quality.audit` — NEW

Every team action of this iteration is written to the audit log with who did it, named the way the
repository names its actions (the app area, the record, the verb): connecting and disconnecting the
account, changing its settings (with the names of the fields that changed), creating, editing (with the
changed fields) and deleting an automation (with the reason and how many runs were cancelled), and
deleting a contact (the contact's public id only, never the erased values). Meta's deauthorize and
data-deletion requests are written too, marked as coming from Meta, with no signed-in person, the
data-deletion one with its confirmation code. Received events and runs write no audit entries — events
are not team actions, and a run is its own history.

**Sources:** D20 · `routes-final.md` K9, § 1 IA7, § 2 CT12, § 3 AU4, § 4 WH6 · `schema-routes.md:458`,
`:614`, `:632`, `:640`

### `quality.log-masking` — NEW

Logs carry request ids, Instagram ids, event kinds and keys, statuses and counts. They never carry the
Instagram token, the app secret, the login code, a webhook payload, message or comment text, emails or
phone numbers; a contact's name, username, phone and email are masked wherever they would appear, and
an address that carries a secret is shortened before it is logged. An event for an unknown or revoked
account leaves one log line with only its Instagram id and the number of events. The repository's
existing request ids take the place of the legacy per-entry log id.

**Sources:** D21 · `routes-final.md` K7, § 1.10, § 2 CT12, § 4 WH4, WH6 · `PRD.md:170`, `:176`

### `quality.idempotency` — NEW

The two signed-in actions that create something — connecting Instagram and creating an automation — need
an idempotency key from the client: sending the same request again with the same key gets the first
answer, and a missing or reused key is refused. Meta's routes take no key; Meta's own ids make their
repeats safe — an event is stored once per key, and the same data-deletion request gets the same
confirmation code.

**Sources:** D15 · `routes-final.md` K3, § 1.D IA20, § 4.A WH10 · `schema-routes.md:77`

### `quality.error-reasons` — NEW

Every refusal carries a stable reason the frontend can branch on and a message translated through the
repository's translation keys (English first). Reasons follow the repository's error policy: a request
that can never pass (a bad Instagram code, a personal Instagram account, a missing Instagram permission)
is told apart from a conflict that may pass once something changes (another live account, an
overlapping "next post" window, no connected account yet); a read that finds the account needs a
reconnect answers not found with that reason. Each route's reasons are listed in its route review
section. The default DM texts are English, through the same translation keys.

**Sources:** D20, D24 (IA10) · `routes-final.md` K2, § 1 IA10, § 1.A.9, § 1.B.9, § 1.C.9, § 1.D.9,
§ 2.9, § 3.A.9, § 4.A.9, § 4.B.9 · `schema-routes.md:124`, `:657`–`:672`

### `quality.reply-safety` — NEW

When public reply safety is on for the account, each public reply is checked in this order: a comment
that already got a public reply (never twice — a handled comment is remembered for good), a random draw
against the reply chance, the hourly limit, then the random gap since the last reply; the first that
applies is saved as the reason the reply was skipped. The counts come from the saved comment logs, so
they are exact even when many events arrive at once, and always readable. Whatever the setting, an
automation never repeats its last reply text. Reply safety holds back the public reply only; the DM
always goes. Defaults: off, 80 % chance, 60 replies an hour, a gap of 20 to 60 seconds.

**Sources:** D17 · `routes-final.md` § 3.B AU20 · `schema-routes.md:546`–`:552`, `:754`–`:758` ·
`PRD.md:157`–`:166`

### `quality.rate-limit` — NEW

Meta's event delivery has its own limit per sending address, far above Meta's real traffic — about 1,200
deliveries a minute, so a viral "comment to get the link" post is never throttled — while still capping
a flood of unsigned junk, which is turned away before it reaches our records. A delivery may be up to
5 MB, since Meta batches events. Meta's other calls use the repository's usual webhook limit. This
replaces the drop's "no rate limit".

**Sources:** D21 · `routes-final.md` § 4.A WH11 · `schema-routes.md:84`

### `quality.read-only-plan` — CHANGED

While an organization's plan is read-only, creating, editing and deleting automations is refused.
Everything else stays open: every read, the automations already running, connecting Instagram,
changing its settings, disconnecting it and deleting a contact — so a read-only team can still
disconnect and erase personal data.

**Sources:** D26 (AQ8), D27 · `routes-final.md` § 3.2 AQ8, § 3.5, § 3.10

### `quality.no-plan-limits` — NEW

No billing plan limits the number of automations, contacts or Instagram events at launch.

**Sources:** D12 · `routes-final.md` § 2 CT11, § 3.10

### `quality.personal-data` — NEW

A contact's personal data — email, phone, name, username, picture and the text of their comments and
messages — is shown only to people who may view contacts (Members included; there is no split by
field), masked in logs (`quality.log-masking`) and masked in the webhook events list. When the team
deletes a contact it is erased everywhere it was copied, in the same request (`data.erasure`); only the
person's webhook events are left, masked, to the 30-day clean-up. Events of an Instagram account no team
holds, or a revoked one, are never stored — they hold strangers' messages that no organization answers
for. The connected account owner's token, profile and stored posts are erased on Meta's data-deletion
request. There is no export of a person's data at launch.

**Sources:** D22, D25 (CQ1, CQ4), D28 (WQ1, WQ2) · `routes-final.md` K7, § 2 CT7, CT8, § 4 WH4, WH17,
§ 4.B WH18

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `quality.read-only-plan` | the platform's read-only plan check says every write in the app area is blocked, but no guard is attached to it any more, so a read-only organization is blocked nowhere in the app area | while the plan is read-only, creating, editing and deleting automations is refused; every read, running automations, connecting, changing settings, disconnecting and deleting a contact stay open | D26 (AQ8), D27 |
