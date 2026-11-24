# Access requirements — feat-instagram-dm-sending-2026-11-23-oxak

Answers: which role may see or do what, scoped to what.

How to read the sources: `D<n>` is the plan's locked decision (plan:L210–L284), `P<n>` a row of
[decisions.md](../decisions.md); `§ n` and the ids MC…, CA…, CT…, AU…, TN…, AT…, K… are in
[routes-final.md](../routes-final.md); RC-… are rows of [route-changes.md](../route-changes.md);
`plan:L…` points into `../../intake-files/Instagram-DM-Sending-Plan-v8.md`. "Before" is what the launch
built (`iterations/launch-2026-11-20-ujai/AS-BUILT.md`, Standing deviations) or the platform today. Kept
from the launch unchanged: every app route is team-only (a personal organization's writes are refused,
its reads not found), and another organization's id is not found, never forbidden.

### `access.channel-account-codes` — CHANGED

Two new codes guard the shared connection and account routes: `channel-account:read` (see connections and
accounts, the ad picker) and `channel-account:manage` (connect, pick, reconnect, disconnect, pause, resume,
choose active accounts). They are held by the same roles as their `instagram-account:*` twins — Owner and
Admin manage, Editor and Viewer read — and a tenancy migration grants them wherever the twin is held. Only
the Instagram settings, posts, stories and sending status keep `instagram-account:*`. Meta's webhook and its
two callbacks are public, proven by Meta's signature; the received-events list keeps
`instagram-webhook-event:read`. Broadcasts, segments and past comments reuse the automation codes.

**Sources:** P20, P59, P99 · routes-final K4, § 9 TN12 · RC-1–RC-5, RC-7–RC-11, RC-15, RC-60,
RC-112–RC-114 (Access column)

### `access.contact-update-code` — NEW

A new code `contact:update` lets a person change one contact or many — the private note, tags, and the
owner's pause of automations for her — and retry her failed messages. Owner, Admin and Editor hold it;
Viewer does not.

**Sources:** P20 (A20) · routes-final § 3 CT1, § 9 TN2 · RC-22, RC-23, RC-40

### `access.editor-viewer-roles` — CHANGED

Every team organization has four locked roles on every plan, with unlimited members: Owner (every code),
Admin, **Editor** — the launch's Member renamed, keeping its people and grants, plus deleting automations,
`contact:update` and message-file uploads — and the new **Viewer**, who only reads (organization, channel
accounts, Instagram content, automations, contacts). Custom roles are switched off: creating, editing,
deleting, restoring a custom role or replacing its codes is refused, and an invite or member change may name
only one of the four roles; a member who already holds a custom role keeps it until an Admin changes it.
Invitations carry `role_ids` with exactly one role.

**Sources:** D55, P20, P28, P82 · routes-final § 9 TN1, TN3, TN4, TN10 · RC-88, RC-90–RC-94 ·
plan:L7861–L7889

### `access.row-security` — NEW

Every new tenant table follows the launch's rule: each row belongs to one organization, row-level security
is on and forced, and a session sees and writes only its active organization's rows; background work runs
inside one organization's scope at a time. Lookups made before the organization is known — Meta's callbacks
by provider account id or business id, the webhook by the Instagram user id, the one-trial-per-account check
— go through narrow resolvers that answer only organization public ids or a yes / no. The open-run key table
is forced like every other tenant table.

**Sources:** P100 · routes-final K5, § 1 MC15, § 8 BL18 · plan:L4221–L4300

### `access.global-sending-tables` — NEW

The global send state has no organization; it is a documented exception to row-level security, read and
written only by the maintenance login, never by the application session.

**Sources:** P16 (A16), P73 · routes-final K5, § 6 SN7

### `access.trusted-device` — NEW

After a right two-factor code a person may tick "Trust this device for 30 days": that device then skips
the code at sign-in for 30 days, but only when the organization that opens does not require two-factor and
the person is not a platform admin; at most 10 live devices per person, the oldest revoked first. Turning
two-factor off, removing a factor or "sign out everywhere" ends the trusted devices.

**Sources:** D56, P28 · routes-final § 10.C AT17 · RC-75, RC-103, RC-104 · plan:L7722–L7750

### `access.sign-in-v8` — CHANGED

Passwords are gone: the four password routes are removed, every stored password is emptied and step-up no
longer takes one. A person signs in by an emailed **digits-only** code (with a resend timer and a day
limit, four named refusal reasons and the tries left), by Google, or by Apple (Apple's form callback is the
one route that answers with a redirect); GitHub sign-in is off; Google and Apple may also be linked to a
signed-in person. The email-code way can never be removed. Step-up accepts the email code, which counts as
strong when the person has no two-factor.

**Sources:** P28, P84, P85 · routes-final § 10 AT1–AT16 · RC-70–RC-77, RC-98–RC-102, RC-105, RC-106 ·
plan:L7598–L7780

### `access.session-place` — CHANGED

The session list shows where each session is: the city and country of its IP, looked up in a local
IP-to-place file (DB-IP "IP to City Lite") when the session is made and when its IP changes — never an
outside call. No file or no match leaves the place empty.

**Sources:** P28, P86 · routes-final § 10.D AT18 · RC-78 · plan:L8194–L8199

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `access.channel-account-codes` | `instagram-account:read` / `:manage` guard every account route, including connect and disconnect | `channel-account:*` on the shared connection and account routes; `instagram-account:*` only on Instagram settings, posts, stories and sending status | P59, P99 |
| `access.editor-viewer-roles` | Owner, Admin and a locked Member (six codes); custom roles live; one email per invite | Owner, Admin, Editor (Member renamed, + delete automation, `contact:update`, uploads) and Viewer (read only); custom roles off; 1–20 emails with exactly one role | D55, P20, P82, TN1, TN3 |
| `access.sign-in-v8` | password sign-in, forgot, reset and change; letters-and-digits email code; Google and GitHub; step-up by password or two-factor | no passwords; digits-only code; Google and Apple, link mode; GitHub off; email code never removable; step-up by email code | P28, P84, P85 |
| `access.session-place` | a session shows its device and last activity | + the city and country of its IP | P86 |
