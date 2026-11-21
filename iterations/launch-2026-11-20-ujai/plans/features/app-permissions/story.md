Status: ready
Kind: screen
Depends on: none
Route review: [routes-final.md](../../routes-final.md) § 1 — IA2, IA3 (rules K1, K4; § 1.4 Permissions)
Tables: none in `app` — it changes the existing team roles and their permission grants

## Stories

- As an Owner I want the Instagram, automation, contact and webhook-event permissions in the roles matrix so that I can see and control who may do what.
- As an Owner or Admin I want every new permission by default so that I can set up Instagram automation without changing a role first.
- As a Member I want to view Instagram content, view, create and edit automations, and view contacts so that I can do the daily automation work without admin rights.
- As an Owner of a team that exists today I want the Member role and the new permissions to arrive by themselves so that my team works the same as a team created tomorrow.
- As an Owner or Admin I want the Instagram webhook-event list behind its own permission so that giving someone our outgoing-webhook access does not show them Instagram messages.

## Rules

- Nine new permissions: view Instagram content (`instagram-account:read`), manage the Instagram account (`instagram-account:manage`), view Instagram webhook events (`instagram-webhook-event:read`), view, create, edit and delete automations (`automation:read` · `:create` · `:update` · `:delete`), view and delete contacts (`contact:read` · `:delete`) (access.permission-codes; D4, D20, D23)
- The Instagram webhook-event permission is its own; the existing outgoing-webhook permission stays notify's only and opens nothing here (access.permission-codes; D4)
- A team's Owner and Admin hold all nine (access.owner-admin-grants; D2)
- Every team has a default Member role holding exactly `instagram-account:read`, `automation:read`, `automation:create`, `automation:update` and `contact:read`; like Admin it is locked — nobody can edit or delete it (access.member-role; D2, D3)
- Teams that exist today get the same: the Member role is added and their Owner and Admin roles gain the nine permissions; doing it again changes nothing; a team's own role already named "Member" is renamed "Member (custom)" and keeps its people and permissions (access.existing-team-backfill; D3, D24)
- Instagram, contact, automation and webhook-event work is for team organizations only; a personal organization's Owner never holds the nine permissions, so every such operation refuses them (access.team-only; D24)
- A caller without the needed permission is refused with the reason `missing_permission` (access.permission-codes, quality.error-reasons)

## Acceptance criteria

- AC-1.1 — The permission catalog lists the nine new permissions in three roles-matrix rows: Instagram, Automations and Contacts — plans/decisions.md D20
- AC-1.2 — In a newly created team, the Owner role and the Admin role each hold all nine new permissions — plans/decisions.md D2
- AC-1.3 — A newly created team has a Member role holding exactly view Instagram content, view, create and edit automations, and view contacts — no other new permission — intake-files/schema-routes.md:143
- AC-1.4 — Editing or deleting the Member role is refused, as it is for the Admin role — plans/decisions.md D3
- AC-1.5 — After the database is prepared, every team that existed before has the Member role and its Owner and Admin roles hold the nine permissions; preparing it a second time adds or changes nothing — plans/decisions.md D3
- AC-1.6 — A team that already had its own role named "Member" ends with that role renamed "Member (custom)", its people and permissions unchanged, beside the locked Member role — plans/decisions.md D24
- AC-1.7 — A Member is refused with `missing_permission` when connecting, changing the settings of or disconnecting Instagram, deleting an automation, deleting a contact and opening the webhook-event list; the same calls are allowed for an Owner and an Admin — intake-files/schema-routes.md:152
- AC-1.8 — A role holding only the outgoing-webhook permission cannot open the Instagram webhook-event list; a role holding only `instagram-webhook-event:read` can — plans/decisions.md D4
- AC-1.9 — In a personal organization every Instagram, contact, automation and webhook-event operation is refused, and its Owner holds none of the nine permissions — intake-files/schema-routes.md:74

## Work items

- access.permission-codes
- access.member-role
- access.owner-admin-grants
- access.existing-team-backfill
- access.team-only
- quality.error-reasons
