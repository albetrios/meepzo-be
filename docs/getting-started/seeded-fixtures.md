# Seeded fixtures (`pnpm db:seed:full`)

The **full** seed (`src/scripts/seed/full.ts`) runs the reference seed (permissions, plans) and adds:

- a demo user, a demo organization and the common tenancy flows, for local exploration and the API
  smoke test.

It creates no subscriptions, notifications, webhooks or audit rows — those come from using the
API (or from `pnpm db:seed:bulk`).

## Credentials

| Field | Value |
| ----- | ----- |
| Email | `demo@example.com` |
| Sign-in | No password (passwords are off, P84): sign in by email code — `POST /auth/email/send-code` echoes the code under TEST_MODE |

The API smoke test (`pnpm test:api-smoke`) and the k6 auth scenario read the same `DEMO_EMAIL`
(default `demo@example.com`) and sign it in by email code against a server running with TEST_MODE.

## Demo organization

| Field | Value |
| ----- | ----- |
| Name | Demo Organization |
| Slug | `demo-org` |
| Role | Admin (every system permission) |

Use its id (`org_…`, in the seed log) with `POST /auth/switch-to-organization`.

## Tenancy flows

- **Second organization** — a generated organization owned by the demo user, with a `Member` role and
  one generated member.
- **Pending invitation** — an `invited` membership in the demo organization for a generated invitee,
  with a membership invitation that expires in 7 days.

## Plans

- **Plans** — the reference catalog (`plan.reference.seed.ts`).

## Commands

```bash
pnpm compose:up && pnpm compose:wait
pnpm db:seed:full   # create, migrate, the database logins, then the full seed
pnpm dev
```

For the minimal reference data only (permissions + plans), use `pnpm db:seed`.
