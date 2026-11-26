import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { PLAN_ACCESS_STATE } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import { requireOrganizationScope } from '@/shared/utils/http/request.util.js';
import { buildPlanRefusal } from './entitlement-refusal.util.js';
import type { EntitlementService } from './entitlement.service.js';
import type { PlanGateDeclaration } from './entitlement.types.js';

/**
 * The mark {@link createPlanReadOnlyGuard} puts on the guard it builds, so the plan-gate coverage
 * test can tell from a registered route's `preHandler` list that the guard really runs there.
 *
 * @remarks
 * `Symbol.for`, so the mark survives a second copy of this module in a test runner. Read it with
 * {@link isPlanReadOnlyGuard}; `src/tests/global/plan-gate-coverage.global.test.ts` does.
 */
export const PLAN_READ_ONLY_GUARD_MARK: unique symbol = Symbol.for(
  'meepzo.billing.entitlement.plan-read-only-guard',
);

/** The one entitlement read the plan guard calls — structural, so a test can stub it. */
export type PlanGuardEntitlementService = Pick<EntitlementService, 'resolve'>;

/** A route `preHandler` — the shape of the plan guard. */
export type PlanGuardPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Builds the one read-only plan guard (change-plan-gates RG3, RG5, P4, P24, P29): a `preHandler`
 * that refuses a write from an organization whose plan is read-only, and otherwise hands the
 * resolved entitlement snapshot on through `request.entitlementSnapshot`.
 *
 * @remarks
 * - **Algorithm:** reads the active organization from the request's verified scope (the signed `org`
 *   claim, `requireOrganizationScope`), resolves its entitlement once
 *   (`EntitlementService.resolve` — one plan read under the verified-scope context, as the
 *   guard it replaces), refuses `read_only` with {@link buildPlanRefusal}; `active` and `grace`
 *   pass and the snapshot is attached to the request for the controller to pass to its service
 *   (K2: one plan read per request).
 * - **Failure modes:** `403 organization_read_only` (`grace_ends_at`, `upgrade_required`); `401` /
 *   `403` from the scope accessor when the request carries no organization; a plan read failure
 *   propagates — no write goes through unchecked.
 * - **Side effects:** sets `request.entitlementSnapshot`. With `LAPSED_PLAN_READ_ONLY_ENABLED` off
 *   (the default, P5) the state is always `active`, so nothing is refused.
 * - **Notes:** enforces `read_only` only (P29) — `feature:` and `limit:` declarations are enforced
 *   where they are used. Attached by {@link createPlanGuardRouteHook} to every route declaring
 *   `read_only` (today go-live and the broadcast send, P10), first in the route's `preHandler`, so
 *   it runs after authentication and before the permission check and the idempotency claim — a
 *   refused write holds no idempotency key.
 */
export function createPlanReadOnlyGuard({
  entitlementService,
}: {
  entitlementService: PlanGuardEntitlementService;
}): PlanGuardPreHandler {
  const guard = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const scope = requireOrganizationScope(request);
    const snapshot = await entitlementService.resolve({
      organizationPublicId: scope.organizationPublicId,
    });
    if (snapshot.state === PLAN_ACCESS_STATE.READ_ONLY) {
      throw buildPlanRefusal({
        reason: 'organization_read_only',
        graceEndsAt: snapshot.graceEndsAt,
      });
    }
    request.entitlementSnapshot = snapshot;
  };
  return Object.assign(guard, { [PLAN_READ_ONLY_GUARD_MARK]: true as const });
}

/**
 * Whether a route hook is the plan guard {@link createPlanReadOnlyGuard} built — by its
 * {@link PLAN_READ_ONLY_GUARD_MARK}.
 */
export function isPlanReadOnlyGuard(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as unknown as Record<symbol, unknown>)[PLAN_READ_ONLY_GUARD_MARK] === true
  );
}

/** Whether a route's plan-gate declaration names `read_only` — the routes the plan guard runs on. */
export function declaresReadOnlyPlanGate(planGate: PlanGateDeclaration | undefined): boolean {
  return planGate?.gates?.includes('read_only') === true;
}

/**
 * Builds the one route hook that attaches the plan guard (change-plan-gates RG3, P4): an `onRoute`
 * hook that puts `guard` first in the `preHandler` list of every route whose `config.planGate`
 * declares `read_only`.
 *
 * @remarks
 * - **Algorithm:** reads the route's declaration ({@link declaresReadOnlyPlanGate}); on a match,
 *   prepends the guard to the route's existing `preHandler` hooks. Prepending keeps the order
 *   authenticate (`onRequest`) → plan guard → the route's own permission check → the idempotency
 *   claim, whatever order the `onRoute` hooks run in (the idempotency plugin appends its claim).
 * - **Failure modes:** none — a route without the declaration is left as it is.
 * - **Side effects:** rewrites the matching route's `preHandler` option before Fastify builds it.
 * - **Notes:** registered once, in `src/routes.ts`, after the domain containers and before the
 *   domain route plugins, so every domain route (and the MCP route registered later) passes it.
 */
export function createPlanGuardRouteHook({
  guard,
}: {
  guard: PlanGuardPreHandler;
}): (routeOptions: RouteOptions) => void {
  return (routeOptions) => {
    if (!declaresReadOnlyPlanGate(routeOptions.config?.planGate)) return;
    const existingPreHandlers = [routeOptions.preHandler ?? []].flat();
    routeOptions.preHandler = [guard, ...existingPreHandlers];
  };
}
