import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { requireOrganizationScope } from '@/shared/utils/http/request.util.js';

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
 *   `organization_read_only`); `401` / `403` from the scope accessor when the request carries no
 *   organization; a plan-access read failure propagates — no write goes through unchecked.
 * - **Side effects:** none — with `LAPSED_PLAN_READ_ONLY_ENABLED` off nothing is read.
 * - **Notes:** attached to the automation writes only — create, edit, delete (routes 12, 14, 15).
 *   The app domain's other writes stay open (D27): a read-only team can still connect or disconnect
 *   Instagram, change its settings and erase a contact's personal data. Listed FIRST in a route's
 *   `preHandler`, so it runs before the permission gate and before the idempotency claim the
 *   middleware appends — a refused write holds no idempotency key (`unpaid-organization-read-only-flow`
 *   in `src/FLOWS.md`).
 */
export function createAppPlanAccessPreHandler(
  subscriptionService: AppPlanAccessGuardService,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const scope = requireOrganizationScope(request);
    await subscriptionService.assertOrganizationWritable({
      organizationPublicId: scope.organizationPublicId,
    });
  };
}
