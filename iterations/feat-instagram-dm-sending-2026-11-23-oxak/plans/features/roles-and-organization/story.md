Status: draft
Kind: screen
Depends on: none
Route review: [routes-final.md](../../routes-final.md) § 9 — routes 110–118, 141–142 (organization, roles, members and invitations)

## Stories

- As an Owner I want four fixed roles — Owner, Admin, Editor, Viewer — on every plan so that my team gets the right access without setting it up.
- As an Owner or Admin I want to invite up to 20 emails at once with one role so that a team joins quickly.
- As an invited person I want the invitation page to tell me its state before I accept so that I know what happens.
- As a new person I want to create an organization with just its name so that onboarding is short.
- As an Owner or Admin I want a coloured tile with the organization's initials and a fixed slug so that it is recognisable and links never break.

## Rules

- Four locked system roles in every team organization: Member becomes Editor (plus `contact:update`, `automation:delete`, `upload:manage`), Viewer is new and reads only; every role has `organization:read` (access.editor-viewer-roles; D55, plan §45.5)
- `contact:update` is a new code granted to Owner, Admin and Editor; the shared account routes use `channel-account:read` / `manage` (access.contact-update-code, access.channel-account-codes; P20, P59)
- Custom roles are off: creating, editing, deleting, restoring a role and replacing its codes are refused; the read routes stay (access.editor-viewer-roles; plan §45.5)
- Members are unlimited and all four roles exist on every plan (access.editor-viewer-roles; D55)
- Invites take 1–20 emails and exactly one role, answer one result per email (`invited`, `already_member`, `already_invited`, `invalid_email`), and one idempotency key covers the whole call (access.editor-viewer-roles; P82)
- The invitation preview is public, takes the link's token, answers its state (`valid`, `accepted`, `expired`, `revoked`) and never shows the invitee's email to a signed-out caller; a wrong token or id answers not found; 30 a minute per IP (access.invitation-preview)
- The members list counts members per role (access.editor-viewer-roles)
- An organization is created with its name only; the slug is made once from it and is read-only after; the tile colour is picked from the name and may be changed among five tones including `lavender` (tenancy.organization-logo-color; P81)
- An organization paused by the team (`SUSPENDED`) stops all sending on every account (billing.plan-states; plan §45.7)
- Tenancy's changes ship as new tenancy migrations only (data.merged-domains-forward-only; D48)

## Acceptance criteria

- AC-12.1 — A new team organization has exactly the four locked roles Owner, Admin, Editor, Viewer with the codes of the plan's table; existing organizations get Editor (from Member) and Viewer by migration — intake-files/Instagram-DM-Sending-Plan-v8.md:7880
- AC-12.2 — An Editor may create, edit, go live, pause and delete automations, tag and note contacts and upload message files, and is refused contact delete, account connect and billing — intake-files/Instagram-DM-Sending-Plan-v8.md:7866
- AC-12.3 — A Viewer reads automations, contacts, accounts, broadcasts and the meter, and every change is refused with `missing_permission` — intake-files/Instagram-DM-Sending-Plan-v8.md:7865
- AC-12.4 — Creating, editing, deleting, restoring a role or replacing its codes is refused while custom roles are off; listing roles still answers — intake-files/Instagram-DM-Sending-Plan-v8.md:7883
- AC-12.5 — Inviting 3 emails with one role answers one line per email; more than 20 emails or more or fewer than one role is refused — plans/decisions.md P82
- AC-12.6 — The invitation preview answers `valid` with whether the signed-in email matches, `accepted`, `expired` or `revoked` (also for a declined one); a wrong token answers not found; a signed-out caller never sees the invitee's email; the 31st call a minute from one IP is refused — intake-files/Instagram-DM-Sending-Plan-v8.md:7833
- AC-12.7 — The members list answers the count per role — intake-files/Instagram-DM-Sending-Plan-v8.md:7895
- AC-12.8 — Creating an organization with only a name makes a unique slug from it and a tile colour; an update that sends the slug is refused with `slug_read_only` — intake-files/Instagram-DM-Sending-Plan-v8.md:7904
- AC-12.9 — The tile colour accepts the five tones, `lavender` among them, and the organization read answers it — plans/decisions.md P81
- AC-12.10 — A team-paused organization sends nothing on any account and its context says so — intake-files/Instagram-DM-Sending-Plan-v8.md:7907
- AC-12.11 — The new code, the roles and the colour arrive as new tenancy migrations — intake-files/BRIEF.md:77

## Work items

- access.editor-viewer-roles
- access.contact-update-code
- access.channel-account-codes
- access.invitation-preview
- tenancy.organization-logo-color
- billing.plan-states
- data.merged-domains-forward-only
