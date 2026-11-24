`src/domains/user/sub-domains/user-notification-preferences/`

# User notification preferences

Parent: [user](../../user.overview.md)

## Purpose

A person's notification choices per **kind × channel** (feat-instagram-dm-sending UN9, UN10, P87):
`GET /users/me/notification-preferences` (route 135) answers the seven kinds of `NOTIFICATION_KINDS`
(`src/shared/constants/notification.constants.ts`) — automation problem, direct message limit,
contact details left, team change, billing, weekly summary, broadcast or past comments done — each
with its types and its `EMAIL`, `IN_APP`, `WEB_PUSH` channels (`is_enabled`, `is_default`,
`is_locked`). `PUT` (route 136) saves 1–21 `{ kind, channel, is_enabled }` items. The notify dispatch
reads the same rows before each send (`notification-dispatch.service.ts`, UN11).

## Key invariants

- **Stored per type, spoken per kind**: one `auth.user_notification_preferences` row per
  `(user, notification_type, channel)` (unique natural key, the upsert target); a save writes the row
  of every type of the kind in one transaction. Only the items sent change.
- **A missing row is the kind's default** (D54): email off for contact details left and for broadcast
  or past comments done, in-app off for the weekly summary, push off everywhere ("soon" — saved, never
  sent yet).
- **One rule for read and send**: `resolveNotificationKindChannel` — a locked channel is on; else the
  kind's stored rows (all must be on); else the default.
- **Always sent, never in the grid**: billing email (`is_locked`), `security.alert` and the other types
  in no kind; the organization's mute (`tenancy.organization_notification_policies`) still wins.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> default: no row → the kind's default
  default --> chosen: PUT /users/me/notification-preferences (rows for every type of the kind)
  chosen --> chosen: a later PUT of the same kind × channel (upsert)
```

## Failure modes

- **Billing email set off** → `422` with reason `notification_preference_locked`; nothing is written.
- **Empty list, over 21 items, a repeated kind × channel, an unknown kind or channel (`SMS`)** → `400`.
