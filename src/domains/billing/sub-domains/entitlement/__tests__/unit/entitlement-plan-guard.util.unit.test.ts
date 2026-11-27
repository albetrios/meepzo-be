import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlanGuardRouteHook,
  createPlanReadOnlyGuard,
  declaresReadOnlyPlanGate,
  isPlanReadOnlyGuard,
} from '@/domains/billing/sub-domains/entitlement/entitlement-plan-guard.util.js';
import { buildEntitlementSnapshot } from '@/domains/billing/sub-domains/entitlement/entitlement-snapshot.util.js';
import type {
  EntitlementSnapshot,
  PlanGateDeclaration,
} from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import { FREE_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type {
  PlanAccess,
  PlanAccessState,
} from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const GRACE_ENDED_AT = new Date('2026-11-01T00:00:00.000Z');

function snapshotIn(state: PlanAccessState): EntitlementSnapshot {
  const planAccess: PlanAccess = {
    state,
    graceEndsAt: state === 'active' ? null : GRACE_ENDED_AT,
    trialEndsAt: null,
    plan: { publicId: 'pln_free', name: 'Free' },
    features: FREE_PLAN_FEATURES,
    seatLimit: null,
    defaultedKeys: [],
    overrides: [],
    isPlanChoiceRequired: false,
  };
  return buildEntitlementSnapshot({ planAccess });
}

function requestOf(organizationPublicId: string | undefined): FastifyRequest {
  return {
    principalScope: { userPublicId: 'usr_owner', organizationPublicId },
    entitlementSnapshot: null,
  } as unknown as FastifyRequest;
}

const REPLY = {} as FastifyReply;

describe('createPlanReadOnlyGuard (change-plan-gates RG3, RG5, P29)', () => {
  it('refuses a read-only organization with 403 organization_read_only, built by the refusal builder', async () => {
    const resolve = vi.fn().mockResolvedValue(snapshotIn('read_only'));
    const guard = createPlanReadOnlyGuard({ entitlementService: { resolve } });
    const request = requestOf('org_lapsed');

    const refusal = await guard(request, REPLY).catch((error: unknown) => error);

    expect(resolve).toHaveBeenCalledExactlyOnceWith({ organizationPublicId: 'org_lapsed' });
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({
      statusCode: 403,
      messageKey: 'errors:organizationReadOnly',
      reason: 'organization_read_only',
    });
    expect((refusal as ForbiddenError).fields).toEqual({
      grace_ends_at: GRACE_ENDED_AT.toISOString(),
      upgrade_required: true,
    });
    expect(request.entitlementSnapshot).toBeNull();
  });

  it.each(['active', 'grace'] as const)(
    'lets a %s organization write and hands its one snapshot on (P24)',
    async (state) => {
      const snapshot = snapshotIn(state);
      const resolve = vi.fn().mockResolvedValue(snapshot);
      const guard = createPlanReadOnlyGuard({ entitlementService: { resolve } });
      const request = requestOf('org_paying');

      await expect(guard(request, REPLY)).resolves.toBeUndefined();

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(request.entitlementSnapshot).toBe(snapshot);
    },
  );

  it('answers the scope accessor errors before any plan read', async () => {
    const resolve = vi.fn();
    const guard = createPlanReadOnlyGuard({ entitlementService: { resolve } });

    await expect(
      guard({ principalScope: undefined } as unknown as FastifyRequest, REPLY),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(guard(requestOf(undefined), REPLY)).rejects.toBeInstanceOf(ForbiddenError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('marks the guard it builds — and nothing else', () => {
    const guard = createPlanReadOnlyGuard({ entitlementService: { resolve: vi.fn() } });

    expect(isPlanReadOnlyGuard(guard)).toBe(true);
    expect(isPlanReadOnlyGuard(async () => undefined)).toBe(false);
    expect(isPlanReadOnlyGuard(undefined)).toBe(false);
  });
});

describe('createPlanGuardRouteHook (change-plan-gates RG3, P4)', () => {
  const guard = createPlanReadOnlyGuard({ entitlementService: { resolve: vi.fn() } });
  const permission = async (): Promise<void> => undefined;
  const idempotencyClaim = async (): Promise<void> => undefined;

  function routeWith({
    planGate,
    preHandler,
  }: {
    planGate: PlanGateDeclaration | undefined;
    preHandler: RouteOptions['preHandler'];
  }): RouteOptions {
    return {
      method: 'POST',
      url: testApiPath('/app/broadcasts/:broadcast_id/send'),
      handler: async () => undefined,
      config: planGate === undefined ? {} : { planGate },
      preHandler,
    } as RouteOptions;
  }

  it('puts the guard first on a route declaring read_only — before the permission and the claim', () => {
    const route = routeWith({
      planGate: { gates: ['read_only', 'feature:broadcasts', 'limit:message_month_limit'] },
      preHandler: [permission, idempotencyClaim],
    });

    createPlanGuardRouteHook({ guard })(route);

    expect(route.preHandler).toEqual([guard, permission, idempotencyClaim]);
  });

  it('wraps a single preHandler and a missing one', () => {
    const single = routeWith({ planGate: { gates: ['read_only'] }, preHandler: permission });
    const none = routeWith({ planGate: { gates: ['read_only'] }, preHandler: undefined });

    createPlanGuardRouteHook({ guard })(single);
    createPlanGuardRouteHook({ guard })(none);

    expect(single.preHandler).toEqual([guard, permission]);
    expect(none.preHandler).toEqual([guard]);
  });

  it.each([
    ['a feature gate only', { gates: ['feature:segments'] }],
    ['a limit gate only', { gates: ['limit:seats'] }],
    ['an open reason', { open: 'stopping or removing work never needs a plan (D27)' }],
    ['no declaration', undefined],
  ] as const)('leaves a route with %s as it is (P29)', (_label, planGate) => {
    const route = routeWith({ planGate, preHandler: [permission] });

    createPlanGuardRouteHook({ guard })(route);

    expect(route.preHandler).toEqual([permission]);
    expect(declaresReadOnlyPlanGate(planGate)).toBe(false);
  });
});
