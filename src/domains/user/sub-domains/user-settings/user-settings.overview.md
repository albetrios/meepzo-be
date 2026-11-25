`src/domains/user/sub-domains/user-settings/`

# User settings

Parent: [user](../../user.overview.md)

## Purpose

Per-user feature toggles and presentation preferences (locale override, theme, dashboard widgets, etc.). The row is optional: if a user has no settings row, the API serializes the platform default. Writes upsert.

## Key invariants

- **Default-on semantics**: a missing row implies the platform default, never "feature disabled".
- **One row per user**: `user_id` is unique; writes upsert.
- **Settings are user-private**: nothing here is organization-scoped or visible to other users.
- **Locale override is the auth source for i18n**: when set, it overrides `Accept-Language` for response translation.
- **The analytics consent fields are a receipt** (launch D85, re-scoped by CC1–CC4): the browser owns the answer in its own cookie
  (claude.com's model — signing out never forgets it, signing in never replaces it), and the
  account keeps a receipt of the last answer given **while signed in**: `analytics_consent`
  (`granted` / `denied`), the `analytics_consent_version` it answered and `analytics_consent_at` —
  null until first given, written together (`chk_user_settings_analytics_consent`). A `PATCH`
  sends the decision and the version together (either alone is a 400 on
  `analytics_consent_version`); the database stamps the time. Each decision is also its own audit
  row, `user.settings.analytics_consent.update`, with the decision, version and time — the proof of
  consent. Nothing reads the receipt back to decide what runs, and `POST /auth/logout` leaves it as
  it was (pinned by `consent-receipt-survives-logout.integration.test.ts`).
- **The organization at sign-in**:
  `default_organization_id` pins the organization the login opens; `null` (the default) keeps the
  automatic choice — the organization last switched to, else the newest organization. Stored as the organization's
  internal id (a soft pointer, no foreign key); a `PATCH` accepts only an ACTIVE organization (TEAM) the
  caller has an ACTIVE membership in — the caller's own personal organization is `422`
  `reason: team_organization_required` (feat-instagram-dm-sending UN4), anything else is `422` with
  `reason: default_organization_unavailable`, one answer for every other miss so the route never
  confirms an organization exists.
- **Reduce motion** (feat-instagram-dm-sending UN4): `is_reduce_motion_enabled`, default `false`, next to
  `is_dark_mode_enabled`. Reads resolve it through the tenancy membership lookups, inside the same user
  context, and report `null` while the pin is not usable (left, suspended, organization suspended or
  deleted); the stored id stays, so rejoining restores the choice. The login side is
  `resolveDefaultActiveOrganizationPublicId` (tenancy). No audit row: a preference, not a security
  event.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> default: user has no row → API returns platform defaults
  default --> customized: PATCH /users/me/settings (upsert row)
  customized --> customized: subsequent PATCH updates fields
  customized --> default: explicit reset (DELETE row)
```

## Failure modes

- **Unknown setting key** → 400 Validation error.
- **A consent decision without its policy version, or the reverse** → 400 on `analytics_consent_version`.
- **Locale value not in supported list** → 400.
- **A `default_organization_id` that is not an active organization the caller actively belongs to** → 422
  `errors:defaultOrganizationUnavailable` (`reason: default_organization_unavailable`); the caller's
  personal organization → 422 `errors:teamOrganizationRequired` (`reason: team_organization_required`);
  a blank or over-long one → 400.
