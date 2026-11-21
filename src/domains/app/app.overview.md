`src/domains/app/`

# App

## Purpose

The Instagram automation product: a team organization connects its Instagram professional account, builds
automations that answer comments, direct messages and story replies, and keeps the contacts those
conversations create. Every table lives in the Postgres schema `app` and every route under `/api/v1/app`
(decision D1 of the launch iteration `launch-2026-11-20-ujai`).

What it owns today: the routes plugin (`app.routes.ts`, mounted by `src/routes.ts`), the container
(`app.container.ts`, decorated as `app.appDomain` by `domain-containers.plugin.ts`), the seed module
(`seed/index.ts`, registered in `SEED_MODULES`), the permission codes (`app.permissions.ts`), the schema
`app` (`appSchema` in `src/infrastructure/database/pg-schemas.ts`, created by
`migrations/20261121050908_app_schema.sql`) and the first sub-domain, the Instagram account (routes 1, 2
and 4; the tables `app.instagram_accounts`, `app.instagram_account_tokens` and
`app.instagram_account_settings`, created by `migrations/20261121064529_app_instagram_account.sql`). The
other sub-domains fill it in one ROUTE row at a time (`iterations/launch-2026-11-20-ujai/KICKOFF.md`).

What it does not own: organizations, members, roles and the permission catalog (tenancy — the nine app
codes and the locked Member role are seeded there), in-app notifications and email (notify, mail
outbox), the audit log (audit), and the Instagram client (`src/infrastructure/social/instagram.client.ts` — the
only code that calls Instagram, and the only code that decrypts the Instagram token).

## Key invariants

- **One schema, granted like every other domain schema**: `app` is owned by `meepzo_be_owner` and gives
  `meepzo_be_app` and `meepzo_be_maintenance` USAGE plus the same default table privileges (and, for the
  maintenance role, default sequence privileges) as `auth`, `tenancy`, `billing`, `notify`, `audit` and
  `upload` — `migrations/20261121050908_app_schema.sql`. The schema `app` is not the `app.*` session
  settings (`app.current_organization_public_id`, …); those are GUCs, a separate namespace.
- **One mount point**: `src/routes.ts` registers `appRoutesPlugin` under `/api/v1/app`; each sub-domain's
  routes register under it (`__tests__/unit/app.domain-wiring.unit.test.ts`).
- **Seeded after tenancy**: the seed module depends on `tenancy`, so organizations exist before any app row
  (`src/tests/unit/scripts/seed/modules.unit.test.ts`); it has no reference data — the nine codes and the
  Member role are tenancy's. Bulk: each demo team organization gets a connected Instagram account, a fake
  `encryptFieldSecret` token and the default settings.
- **Team-only, organization from the token** (K1): every signed-in route takes the active organization
  from the token's `org` claim; on a personal organization a write answers `422` and a read
  `404 team_organization_required`, after the permission gate's `403`.
- **Forced RLS on every table** (K5): `organization_id` → organizations `ON DELETE CASCADE`, RLS enabled
  and forced, an organization policy with `USING` and `WITH CHECK` (listed in `EXPECTED_FORCE_RLS_TABLES`).
  The Instagram token table alone has no retention sweep arm (IA5).
- **The Instagram token stays ciphertext** outside the Instagram client (IA5) — pinned by
  `sub-domains/instagram-account/__tests__/unit/instagram-account-token-isolation.policy.unit.test.ts`.
- **The rules every sub-domain follows** are fixed by the route review (`plans/routes-final.md`, rules
  K1–K10) and become invariants of this file as each sub-domain is built.

## Sub-domains

In build order (`iterations/launch-2026-11-20-ujai/plans/routes-final.md`):

| Sub-domain | Purpose |
| --- | --- |
| [instagram-account](src/domains/app/sub-domains/instagram-account/instagram-account.overview.md) | The organization's one connected Instagram account and its encrypted token (connect, read, disconnect); nested `instagram-account-settings` (the automation switch and public reply safety). Still to come: nested media and Meta's callbacks. |
| `sub-domains/contact/` (planned) | The people the automations talk to, per Instagram account. |
| `sub-domains/automation/` (planned) | Comment, direct-message and story-reply automations and their runs. |
| `sub-domains/instagram-webhook/` (planned) | Meta's webhook receiver and the stored events that drive the runs. |

## Patterns used

This domain implements the contracts documented in [src/PATTERNS.md](src/PATTERNS.md):

- [`tenant-isolation`](src/PATTERNS.md#tenant-isolation) / [`rls-context`](src/PATTERNS.md#rls-context) —
  every `app` table is organization-scoped with forced row-level security, reached only inside a
  database context; lookups before the organization is known go through narrow SECURITY DEFINER
  resolvers, then the organization's `VERIFIED` scope (IA6).
- [`idempotency`](src/PATTERNS.md#idempotency) — signed-in writes that create (route 1, connect) require
  `X-Idempotency-Key`.
- [`audit-emission`](src/PATTERNS.md#audit-emission) — `app.<resource>.<verb>` audit actions
  (`app.instagram_account.connect`, `app.instagram_account.disconnect`).

## Cross-domain flows

- [`instagram-account-connect-flow`](src/FLOWS.md#instagram-account-connect-flow) — connect an Instagram
  account across `app` (the account, its token and settings), `tenancy` (the permission gate and the
  team check), `audit`, and the Instagram client.

Planned: the reconnect notice (R7), added to [src/FLOWS.md](src/FLOWS.md) with the row that builds it.
Cross-domain reads and writes go through the other domain's service, passed into `createAppContainer`
as parameters — never its repository or schema.
