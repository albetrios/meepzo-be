# Launch checklist — meepzo-be

**Status: No-go for a paid launch.** Production deploys run (Railway, from a tagged release with a
manual approval), but the items below block a paid launch. This is the live list: tick an item in
the PR that closes it. The dated files in [`docs/reviews/`](../reviews/) stay point-in-time
snapshots; the frontend's half of this list is
[meepzo-fe's production readiness](https://github.com/albetrios/meepzo-fe/blob/main/docs/deployment/production-readiness.md).

## Blockers

- [ ] **A lapsed plan turns read-only after a grace period.** Decided 2026-10-17 (D3): 14 days of
      grace, then read-only; the owner and admins are never suspended and no data is deleted.
      **Built, switched off:** behind `BILLING_READ_ONLY_ENFORCED` (default `false`) — a TEAM
      organization without a paid plan gets 14 days from its creation (or
      `BILLING_DUNNING_GRACE_DAYS` after a lapsed subscription's period), then every write behind
      the product write guard (`SubscriptionService.assertOrganizationWritable`) answers 403
      `organization_read_only`; `GET /auth/me/context` reports `active_organization.plan_access`
      ([unpaid-organization-read-only-flow](../../src/FLOWS.md#unpaid-organization-read-only-flow)).
      It stays off until organizations can pay — on now, an unpaid organization would have no way
      out. Tick this when the flag is on in production. Switching it on turns every unpaid
      organization already past its grace read-only at once.
- [ ] **Restore drills proven.** The weekly smoke and monthly RTO drills
      ([restore-drill.md](restore-drill.md)) restore and migrate fine; their smoke ran a test suite
      that truncates every table, refused only by a missing privilege on the copy. It now runs the
      non-destructive `pnpm db:restore:smoke`, and the test harness refuses to wipe a database off
      the runner. Tick this when a drill passes. They run in the `production` GitHub Environment, so each run waits for a
      reviewer's approval — approve every run until a drill-only environment exists (decided
      2026-10-17; planned with alerting).
- [ ] **Alerting and on-call.** Sentry alert rules are documented but not applied as code, and
      nothing checks that the API, the worker and the scheduled jobs are alive; nobody is named to
      be paged.
- [ ] **The 2026-09-24 review's open items** —
      [production-readiness-2026-09-24.md](../reviews/production-readiness-2026-09-24.md).

## Done

- [x] **Nightly quality canary green** (2026-10-17) — `validate:constants` and
      `validate:domain:unit-matrix` failed on `main` since 2026-10-14 (#72); both now also run on
      every PR (`pr-ci.yml`).
- [x] **No staff lock-out on a lapsed plan** (2026-10-17) — a lapsed entitlement no longer
      suspends members: the Stripe-event path logs `billing.entitlement_lost`, the hourly
      seat-reconcile job logs `subscription-seat-reconcile.entitlement_lapsed`. The Free plan's
      single seat had suspended every non-owner member.

## Owner actions that don't wait on code

- Run both restore drills once on `main` (Actions → the weekly restore smoke and monthly restore
  RTO workflows → Run workflow) and approve the `production` step.
- Set up the custom domain.

## Go / no-go

**No-go** until every blocker above is ticked. Then run the
[production go-live runbook](runbooks/production-go-live.md), which includes the
path-to-production gate (`/be-release`, skill **be-path-to-production**).
