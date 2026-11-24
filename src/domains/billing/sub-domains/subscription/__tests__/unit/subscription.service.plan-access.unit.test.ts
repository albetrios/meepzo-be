import { afterEach, describe, expect, it, vi } from 'vitest';

// The service opens the organization context around its one read; a unit test has no database, so
// the wrapper runs the callback inline (as the other subscription service suites mock it).
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
  };
});

import { env } from '@/shared/config/env.config.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { PaymentProvider } from '@/domains/billing/sub-domains/subscription/payment-provider.port.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { PlanAccessSubject } from '@/domains/billing/sub-domains/subscription/subscription.types.js';

import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

const DAY = 24 * 60 * 60 * 1000;

function serviceReading(subject: PlanAccessSubject | null) {
  const repository = { findPlanAccessSubject: vi.fn().mockResolvedValue(subject) };
  const service = new SubscriptionService(
    {} as OrganizationService,
    {} as PlanService,
    repository as unknown as SubscriptionRepository,
    {} as PaymentProvider,
  );
  return { service, repository };
}

const FREE = {
  public_id: 'pln_free',
  name: 'Free',
  price_monthly: '0.00',
  price_yearly: '0.00',
  features: FREE_PLAN_FEATURES,
};
const CREATOR = {
  public_id: 'pln_creator',
  name: 'Creator',
  price_monthly: '29.00',
  price_yearly: '276.00',
  features: CREATOR_PLAN_FEATURES,
};

/** A TEAM organization whose Creator plan's payment failed, its period ended `days` ago. */
const dunningOrganization = (days: number): PlanAccessSubject => ({
  organization: { type: 'TEAM' },
  subscription: {
    status: 'PAST_DUE',
    current_period_end: new Date(Date.now() - days * DAY),
    trial_end: null,
    plan: CREATOR,
  },
  freePlan: FREE,
});

describe('SubscriptionService plan access — the plan entitlement (D3, BL2)', () => {
  const originalEnforced = env.BILLING_READ_ONLY_ENFORCED;
  afterEach(() => {
    env.BILLING_READ_ONLY_ENFORCED = originalEnforced;
  });

  it('with BILLING_READ_ONLY_ENFORCED off, every organization is active — the plan is still read', async () => {
    env.BILLING_READ_ONLY_ENFORCED = false;
    const { service, repository } = serviceReading(dunningOrganization(400));

    await expect(service.getPlanAccess({ organizationPublicId: 'org_old' })).resolves.toEqual({
      state: 'active',
      graceEndsAt: null,
      trialEndsAt: null,
      plan: { publicId: 'pln_free', name: 'Free' },
      features: FREE_PLAN_FEATURES,
    });
    await expect(
      service.assertOrganizationWritable({ organizationPublicId: 'org_old' }),
    ).resolves.toBeUndefined();
    expect(repository.findPlanAccessSubject).toHaveBeenCalledTimes(2);
  });

  it('a TEAM organization with no subscription is active on Free — Free never ends', async () => {
    env.BILLING_READ_ONLY_ENFORCED = true;
    const { service, repository } = serviceReading({
      organization: { type: 'TEAM' },
      subscription: null,
      freePlan: FREE,
    });

    const access = await service.getPlanAccess({ organizationPublicId: 'org_new' });

    expect(repository.findPlanAccessSubject).toHaveBeenCalledExactlyOnceWith('org_new');
    expect(access).toEqual({
      state: 'active',
      graceEndsAt: null,
      trialEndsAt: null,
      plan: { publicId: 'pln_free', name: 'Free' },
      features: FREE_PLAN_FEATURES,
    });
  });

  it('refuses a write from a read-only organization with 403 organization_read_only', async () => {
    env.BILLING_READ_ONLY_ENFORCED = true;
    const { service } = serviceReading(dunningOrganization(40));

    const refusal = await service
      .assertOrganizationWritable({ organizationPublicId: 'org_old' })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({
      statusCode: 403,
      messageKey: 'errors:organizationReadOnly',
      reason: 'organization_read_only',
    });
  });

  it('lets an organization in its grace write', async () => {
    env.BILLING_READ_ONLY_ENFORCED = true;
    const { service } = serviceReading(dunningOrganization(3));

    await expect(
      service.assertOrganizationWritable({ organizationPublicId: 'org_new' }),
    ).resolves.toBeUndefined();
  });
});
