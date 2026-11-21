# Notification requirements — launch-2026-11-20-ujai

Answers: who is told what, through which channel, when.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, K… (and the answered questions IQ…) are in [routes-final.md](../routes-final.md); `file:line`
points into `../../intake-files/`. Every requirement here is NEW against the platform today.

### `notifications.reconnect-required` — NEW

When the organization's Instagram connection breaks — its status moves from `connected` to `expired` or
`error`, because Instagram refused the token while sending or reading, or the daily account check found
it refused or ended — every active member of the organization who may manage Instagram (Owner and Admin
by default) gets an in-app notification and an email, in the organization's language, that link to the
Instagram page in the app. They are told once per break: the same break never sends a second notice,
and a reconnect followed by a new break is told again.

Nothing else tells anyone at launch: a failed event shows in the webhook events list, an expired "next
post" automation shows in the automation list, and a failed run shows on its comment log — nobody is
notified of them (AMBER defaults, still open in [worker-changes.md](../worker-changes.md)).

**Sources:** D2, D10, D13, D24 · `routes-final.md` § 1 IA9, § 1.4 · `schema-routes.md:488`, `:571` ·
[WC-11](../worker-changes.md#background-work)

## Before → after

none — every requirement here is NEW.
