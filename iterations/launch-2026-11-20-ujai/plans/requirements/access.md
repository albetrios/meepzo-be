# Access requirements — launch-2026-11-20-ujai

Answers: which role may see or do what, scoped to what.

How to read the sources: `D<n>` is a row of [decisions.md](../decisions.md); `§ n` and the ids
IA…, CT…, AU…, WH…, K… (and the answered questions IQ…, CQ…, AQ…, WQ…) are in
[routes-final.md](../routes-final.md); `file:line` points into `../../intake-files/`. Two requirements
here change what the platform does today (`CHANGED`, see Before → after); the rest are NEW.

### `access.permission-codes` — NEW

Nine new permission codes, one for each thing a person may see or do, written in kebab-case and shown
in the Roles matrix under three rows — Instagram, Automations and Contacts. A person without the code an
action needs is refused with the reason `missing_permission`. Instagram webhook events get a code of
their own; notify's `webhook:read` keeps guarding notify's outgoing webhooks only.

| Code | Allows | Owner | Admin | Member |
| --- | --- | --- | --- | --- |
| `instagram-account:read` | see the connected account, its posts, reels and stories | yes | yes | yes |
| `instagram-account:manage` | connect, change the settings, disconnect; gets the reconnect notice | yes | yes | — |
| `instagram-webhook-event:read` | the received-events list | yes | yes | — |
| `automation:read` | list and open automations | yes | yes | yes |
| `automation:create` | create one (the Duplicate button too) | yes | yes | yes |
| `automation:update` | edit, turn on, turn off | yes | yes | yes |
| `automation:delete` | delete one | yes | yes | — |
| `contact:read` | the contact list, with emails and phones | yes | yes | yes |
| `contact:delete` | delete one contact | yes | yes | — |

The same grid, as reference data: [db-changes.md › Reference data](../db-changes.md#reference-data-no-new-tables).

**Sources:** D4, D20, D23 · `routes-final.md` K4, § 1 IA2, § 1.4 · `schema-routes.md:130`–`:139`,
`:152`

### `access.member-role` — CHANGED

Every team organization has a third default role, **Member**, next to Owner and Admin. Like Admin it is
locked: no one can edit or delete it. Member holds `instagram-account:read`, `automation:read`,
`automation:create`, `automation:update` and `contact:read`, plus the existing `organization:read` so a member can
view the organization itself ([D31](../decisions.md)) — so a member sees the Instagram content,
builds and edits automations and sees contacts (emails and phones included), but cannot connect or
disconnect Instagram, delete an automation or a contact, or see the webhook events. A new team gets the
Member role when it is set up; a team that exists today gets it through `access.existing-team-backfill`.
A team that already has its own role named "Member" keeps it, with its people and codes, renamed
"Member (custom)", and gets the locked Member beside it.

**Sources:** D2, D3, D24 (IQ5) · `routes-final.md` K4, § 1 IA2 · `schema-routes.md:141`–`:150`

### `access.owner-admin-grants` — NEW

A team organization's Owner and its Admin hold all nine codes. A personal organization's Owner holds
none of them, since a personal organization can never use Instagram (`access.team-only`). Holding
`instagram-account:manage` is also what puts a person on the reconnect notice
(`notifications.reconnect-required`).

**Sources:** D2, D10, D23 · `routes-final.md` K4, § 1 IA2, IA3 · `schema-routes.md:143`–`:150`

### `access.existing-team-backfill` — CHANGED

Every team organization that exists today gets exactly what a new team gets: its Owner and Admin gain
the nine codes, and it gets the locked Member role with its codes (the five app codes and `organization:read`). It is done once for every team,
safe to run again (running it twice changes nothing more than running it once), so old and new teams
never drift apart.

**Sources:** D3, D24 (IQ5) · `routes-final.md` § 1 IA2

### `access.team-only` — NEW

Every signed-in action of this iteration is for team organizations only. A personal organization never
reaches them: the permission check refuses first, because its Owner holds none of the codes; behind
that, a write is refused as needing a team, and a read answers not found with the reason
`team_organization_required`. Another organization's account, contact, automation or event is always
reported as not found, never as forbidden.

**Sources:** D24 (IA3) · `routes-final.md` K1, § 1 IA3, § 2 CT3, § 3 AU3, § 4.5 ·
`schema-routes.md:74`, `:81`

### `access.public-meta-routes` — NEW

Four routes have no signed-in person: Meta's webhook subscription check, proved by the verify token;
Meta's event delivery, proved by the signature over the raw body; Meta's deauthorize and data-deletion
callbacks, proved by Meta's signed request. Nothing is read, looked up or stored before the proof
passes. These routes carry no organization and need no idempotency key (`quality.idempotency`). A
verified callback for a person we never stored still ends cleanly, so Meta does not retry.

**Sources:** D15, D22 · `routes-final.md` K3, § 1.D IA18, § 1.D.10, § 4.A WH7, WH8 ·
`schema-routes.md:31`, `:32`, `:75`, `:84`, `:520`

### `access.cross-organization-lookups` — NEW

Where the organization is not known yet — the webhook finding whose account an event is for, connect
checking whether the account is live in another organization, Meta's two callbacks — the lookup answers
only which organization it is, and never shows any other organization's data. Everything after the
lookup runs inside that organization. Background checks that look across all organizations read only
what is due, then act inside each organization (`background.organization-scope`).

**Sources:** D21, D24 · `routes-final.md` K5, § 1 IA6, § 4 WH3, § 3 AU6 · `schema-routes.md:526`

### `access.token-isolation` — NEW

Only the code that calls Instagram ever sees the Instagram token in plain form. Everything else —
screens, answers, background work, logs — holds it only encrypted or not at all; no answer ever returns
it. Only the account's own token handling and the daily account check use the token, and the checks
that look across organizations cannot reach it.

**Sources:** D21, D24 · `routes-final.md` K7, § 1 IA5 · `schema-routes.md:222`, `:766`

## Before → after

| Requirement | Before | After | Why |
| --- | --- | --- | --- |
| `access.member-role` | a team organization is set up with two default roles, Owner and Admin, both locked | a team organization has three: Owner, Admin and a locked Member holding five view, create and edit codes; a team's own role already named "Member" is kept as "Member (custom)" | D2, D3, D24 (IQ5) |
| `access.existing-team-backfill` | a new permission code reaches only teams set up after it; an existing team's Owner and Admin keep the codes they already had | every existing team's Owner and Admin gain the nine codes and the team gets the Member role — the same as a new team, safe to repeat | D3, D24 |
