`src/domains/tenancy/sub-domains/organization/`

# Organization

Parent: [tenancy](../../tenancy.overview.md)

## Purpose

The top-level tenancy aggregate. Owns the `organizations` table (id, public id, slug, name, status, settings JSON, billing customer id) and the child resources that share its lifecycle: [organization-settings](src/domains/tenancy/sub-domains/organization/organization-settings/), [organization-notification-policy](src/domains/tenancy/sub-domains/organization/organization-notification-policy/), and [organization-api-key](src/domains/tenancy/sub-domains/organization/organization-api-key/).

## Key invariants

- **Slug is unique among LIVE teams only**: `idx_organizations_slug` is a **partial** unique index (`WHERE deleted_at IS NULL`), so a soft-deleted team releases its slug immediately for reuse instead of burning it until tombstone-retention. Matches `SLUG_REGEX`, lowercased, no leading/trailing/consecutive hyphens. Personal organizations carry a NULL slug and are not constrained here.
- **Single-organization access**: the repository reads the organization and checks owner or active membership in one query under the caller's user RLS context. An explicit access predicate also prevents an unrelated user with an organization GUC from passing the gate.
- **Public id is the API contract**: 21-char URL-safe; the internal numeric id never appears in URLs or JSON.
- **The slug is made once and never changes** (feat-instagram-dm-sending TN7): `POST /tenancy/organizations` takes the name alone — the slug is the name in kebab form (`slugFromText`), or that form with a short random suffix when the live-slug index refuses it; a chosen `slug` is still accepted at create. `PATCH /tenancy/organization` with a `slug` answers `422 slug_read_only`.
- **The tile colour `logo_color`** (TN8): one of five chip tones (`ORGANIZATION_LOGO_COLORS` — sky, lavender, sage, peach, slate). Without a chosen one it is the name's colour — `tenancy.fn_organization_logo_color(name)`, the one definition shared by the insert (`organizationLogoColorFromName`), the backfill and the `trg_organizations_logo_color` fill of a row written without one; `PATCH` may change it.
- **Organization profile (launch D7)**: `timezone` (IANA, default `Asia/Kolkata`; IANA validity is the validator's job), `currency` (fixed `INR`, server-set). CHECK: `chk_organizations_currency`.
- **The owner is named (launch D81 (4))**: every organization object (`GET /tenancy/organization`, the
  list, `/auth/me/context`'s `active_organization`, the switch answers) carries `owner_user_id` — the
  owner's user public id, resolved in one batch per response (`auth.resolve_user_public_ids_by_ids`;
  null only if the login is gone). Provisioning makes the `Owner` role `is_system`, `is_locked` and
  slate (`organization-provisioning.ts`).
- **A TEAM organization's default roles are one definition (launch IA2)**: `DEFAULT_TEAM_ROLES` —
  Admin (lavender) and Member (sage), both `is_system` and `is_locked` — plus the TEAM Owner codes. A new
  team gets them at provisioning; a team that already exists gets anything missing from
  `reconcileDefaultTeamRoles`, which `prepareDatabase` runs after every seed: it lists the live TEAM
  organizations under the retention arm (read only), then in each organization's own scope adds a
  missing default role, grants the missing codes (`ON CONFLICT DO NOTHING`) and invalidates its
  permission cache. A custom role already holding a default role's name is renamed
  `<name> (custom)` with its people and codes (launch IQ5). Twice is once.
- **Organization soft-delete cascades to child resources**: settings, API keys, and notification policy tombstone with the organization. Memberships are handled separately.
- **The delete offboards other domains first** (`wireOffboardingUploadService`): the logo and uploads, then the subscription cancel, then — the last step, in the organization's own scope while it is live, because row-level security hides a soft-deleted organization's rows — the `app` domain's erase of its Instagram accounts through `OrganizationInstagramOffboardingPort` (launch D54). A failed step stops the delete before the soft delete; `organization-offboarding-reconcile` runs it again, every step being safe to repeat. The erased accounts are named on the `tenancy.organization.delete` audit entry.
- **The organization chooser** (`GET /users/me/organizations`, `listForUser`, feat-instagram-dm-sending UN5): team organizations only — the personal one is never listed — with `q` on the name (1–100, any case, wildcards literal). Each row adds the caller's main `role` (the SECURITY DEFINER `tenancy.resolve_main_roles_for_user`, since `tenancy.roles` is behind the organization-only policy in the user scope) and `members_count`, `channel_accounts_count`, `live_automations_count` from the app's `OrganizationCountsPort` (UN1), wired by `wireOrganizationCounts` in both composition roots and called once per page.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> active: organization created
  active --> active: name / tile colour change, settings update, API key issuance
  active --> tombstoned: soft delete
  tombstoned --> [*]: retention worker purges children + organization after window
```

## Events

This sub-domain neither emits nor consumes domain events directly. State changes are reflected through audit-emission only.

## Failure modes

- **Slug collision** on create or rename → 409.
- **API key prefix collision** (cosmetic) → service rotates the prefix and retries.
- **Soft-delete with active subscription** → 409; admin must cancel the subscription first.

## Policy constants

- `SLUG_REGEX`
- `ORGANIZATION_DEFAULT_TIMEZONE`, `ORGANIZATION_CURRENCY` (`organization.constants.ts`)
- `ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH = 32`
- `ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH = 8`
