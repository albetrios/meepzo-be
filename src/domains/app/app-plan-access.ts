import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { requireOrganizationScope } from '@/shared/utils/http/request.util.js';

/**
 * The mark {@link createAppPlanAccessPreHandler} puts on the guard it builds, so a test can tell from
 * a registered route's `preHandler` list that the read-only guard really runs there.
 *
 * @remarks
 * `Symbol.for`, so the mark survives a second copy of this module in a test runner. Read it with
 * {@link isAppPlanAccessPreHandler}; the plan-gate coverage test
 * (`src/tests/global/plan-gate-coverage.global.test.ts`) does.
 */
export const APP_PLAN_ACCESS_GUARD_MARK: unique symbol = Symbol.for('meepzo.app.plan-access-guard');

/** The one billing step the read-only guard calls — structural, so a test can stub it. */
export type AppPlanAccessGuardService = Pick<SubscriptionService, 'assertOrganizationWritable'>;

/**
 * The app domain's read-only plan guard (launch routes-final § 3 AQ8, AUC3; D27): a `preHandler`
 * that refuses a write from an organization whose plan is read-only with
 * `403 organization_read_only`, through `SubscriptionService.assertOrganizationWritable`.
 *
 * @remarks
 * - **Algorithm:** reads the active organization from the request's verified scope (the signed `org`
 *   claim) and asks the subscription service; `active` and `grace` pass, `read_only` throws.
 * - **Failure modes:** `ForbiddenError` (`errors:organizationReadOnly`, reason
 *   `organization_read_only`, with `grace_ends_at` and `upgrade_required` — P269); `401` / `403`
 *   from the scope accessor when the request carries no organization; a plan-access read failure
 *   propagates — no write goes through unchecked.
 * - **Side effects:** none — with `LAPSED_PLAN_READ_ONLY_ENABLED` off the state is always `active`,
 *   so nothing is refused.
 * - **Notes:** attached to two writes only — go-live (`POST …/automations/{automation_id}/go-live`,
 *   route 32) and the broadcast send (`POST …/broadcasts/{broadcast_id}/send`, route 75), P10
 *   (which narrowed launch D27's create / edit / delete). Drafts, edits, pause, duplicate, delete
 *   and the app domain's other writes stay open: a read-only team can still connect or disconnect
 *   Instagram, change its settings and erase a contact's personal data. Listed FIRST in a route's
 *   `preHandler`, so it runs before the permission gate and before the idempotency claim the
 *   middleware appends — a refused write holds no idempotency key (`unpaid-organization-read-only-flow`
 *   in `src/FLOWS.md`).
 */
export function createAppPlanAccessPreHandler(
  subscriptionService: AppPlanAccessGuardService,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const guard = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const scope = requireOrganizationScope(request);
    await subscriptionService.assertOrganizationWritable({
      organizationPublicId: scope.organizationPublicId,
    });
  };
  return Object.assign(guard, { [APP_PLAN_ACCESS_GUARD_MARK]: true as const });
}

/**
 * Whether a route hook is the read-only guard {@link createAppPlanAccessPreHandler} built — by its
 * {@link APP_PLAN_ACCESS_GUARD_MARK}.
 */
export function isAppPlanAccessPreHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as unknown as Record<symbol, unknown>)[APP_PLAN_ACCESS_GUARD_MARK] === true
  );
}
