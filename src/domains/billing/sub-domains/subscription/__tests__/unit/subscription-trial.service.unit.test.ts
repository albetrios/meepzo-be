import { describe, expect, it, vi } from 'vitest';
import { SubscriptionTrialService } from '@/domains/billing/sub-domains/subscription/subscription-trial.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { TrialAccountRepository } from '@/domains/billing/sub-domains/subscription/trial-account.repository.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { ConflictError } from '@/shared/errors/index.js';

function build(options: {
  hasOrganizationTrialled?: boolean;
  trialled?: string[];
  written?: number;
  activeSubscription?: { id: number; plan_id: number; status: string } | null;
}) {
  const trialAccountRepository = {
    findTrialledInstagramUserIds: vi.fn(async () => options.trialled ?? []),
    insertMany: vi.fn(async (values: { instagramUserIds: readonly string[] }) =>
      options.written === undefined ? values.instagramUserIds.length : options.written,
    ),
  };
  const subscriptionRepository = {
    hasOrganizationTrialled: vi.fn(async () => options.hasOrganizationTrialled ?? false),
    findActiveByOrganization: vi.fn(async () => options.activeSubscription ?? null),
  };
  const service = new SubscriptionTrialService(
    trialAccountRepository as unknown as TrialAccountRepository,
    subscriptionRepository as unknown as SubscriptionRepository,
  );
  return { service, trialAccountRepository, subscriptionRepository };
}

const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictError);
    return (error as ConflictError).reason;
  }
  return 'no error';
};

const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa' });

describe('SubscriptionTrialService — one trial per organization and per Instagram account (BL7, BL18)', () => {
  it('route 102: a fresh organization with fresh accounts may trial', async () => {
    const { service, trialAccountRepository } = build({});
    await expect(
      service.assertOrganizationMayTrial({ organizationId: 1, instagramUserIds: ['17841'] }),
    ).resolves.toBeUndefined();
    expect(trialAccountRepository.findTrialledInstagramUserIds).toHaveBeenCalledWith(['17841']);
  });

  it('route 102: an organization that had a trial, or an account that had one elsewhere → trial_already_used', async () => {
    const organizationTrialled = build({ hasOrganizationTrialled: true });
    expect(
      await reasonOf(() =>
        organizationTrialled.service.assertOrganizationMayTrial({
          organizationId: 1,
          instagramUserIds: [],
        }),
      ),
    ).toBe('trial_already_used');
    const accountTrialled = build({ trialled: ['17841'] });
    expect(
      await reasonOf(() =>
        accountTrialled.service.assertOrganizationMayTrial({
          organizationId: 1,
          instagramUserIds: ['17841', '17842'],
        }),
      ),
    ).toBe('trial_already_used');
  });

  it('route 102: a lost race on the unique account key → trial_already_used', async () => {
    const { service } = build({ written: 1 });
    expect(
      await reasonOf(() =>
        service.recordTrialStart({
          organizationId: 1,
          planId: 2,
          subscriptionId: 3,
          instagramUserIds: ['1', '2'],
        }),
      ),
    ).toBe('trial_already_used');
  });

  it('the pick: an account that had a trial anywhere → trial_used_by_account', async () => {
    const { service } = build({ trialled: ['17841'] });
    expect(
      await reasonOf(() => service.assertAccountsMayTrial({ providerAccountIds: ['17841'] })),
    ).toBe('trial_used_by_account');
  });

  it('the pick records its accounts against the trialing subscription, and nothing once it ended', async () => {
    const trialing = build({ activeSubscription: { id: 7, plan_id: 2, status: 'TRIALING' } });
    await trialing.service.recordTrialAccounts({
      scope,
      organizationId: 1,
      providerAccountIds: ['17841'],
    });
    expect(trialing.trialAccountRepository.insertMany).toHaveBeenCalledWith({
      organizationId: 1,
      planId: 2,
      subscriptionId: 7,
      instagramUserIds: ['17841'],
    });

    const ended = build({ activeSubscription: { id: 7, plan_id: 2, status: 'ACTIVE' } });
    await ended.service.recordTrialAccounts({
      scope,
      organizationId: 1,
      providerAccountIds: ['17841'],
    });
    expect(ended.trialAccountRepository.insertMany).not.toHaveBeenCalled();

    const raced = build({
      activeSubscription: { id: 7, plan_id: 2, status: 'TRIALING' },
      written: 0,
    });
    expect(
      await reasonOf(() =>
        raced.service.recordTrialAccounts({ scope, organizationId: 1, providerAccountIds: ['1'] }),
      ),
    ).toBe('trial_used_by_account');
  });
});
