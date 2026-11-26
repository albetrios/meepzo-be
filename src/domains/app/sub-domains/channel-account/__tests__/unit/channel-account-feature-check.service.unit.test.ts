import { describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';
import { PRO_PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import { ChannelAccountService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type {
  ChannelAccountRepository,
  ChannelAccountRow,
} from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  CHANNEL_FEATURE_KEYS,
  type ChannelFeature,
} from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import { channelFeatureRefusalError } from '@/domains/app/sub-domains/channel-account/channel-account-error.util.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/infrastructure/database/contexts/database-context.js')>();
  return {
    ...original,
    withAppDatabaseContext: vi.fn(async ({ callback }: { callback: () => Promise<unknown> }) =>
      callback(),
    ),
  };
});

const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: 'org_k7x9m2pqr4w8n1v3a1b2c',
});
const ALL_SCOPES = ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'];

/** The service with only the feature check's inputs stubbed. */
function serviceWith({
  channel = 'instagram',
  scopes = ALL_SCOPES,
  features = CREATOR_PLAN_FEATURES,
  untested = [],
  hasAccount = true,
}: {
  channel?: string;
  scopes?: string[];
  features?: PlanFeatures | null;
  untested?: ChannelFeature[];
  hasAccount?: boolean;
}): ChannelAccountService {
  const account = { id: 5, channel, channel_connection_id: 9 } as ChannelAccountRow;
  const accountRepository = {
    findById: vi.fn(async () => (hasAccount ? account : null)),
  } as unknown as ChannelAccountRepository;
  const connectionRepository = {
    findByIds: vi.fn(async () => [{ id: 9, scopes }]),
  } as unknown as ChannelConnectionRepository;
  const planAccessService = {
    getPlanAccess: vi.fn(async () => ({
      state: 'active' as const,
      graceEndsAt: null,
      trialEndsAt: null,
      plan: features === null ? null : { publicId: 'pln_x', name: 'Plan' },
      features,
      isPlanChoiceRequired: false,
    })),
  };
  const unused = {} as never;
  return new ChannelAccountService(
    accountRepository,
    unused,
    unused,
    unused,
    connectionRepository,
    unused,
    unused,
    planAccessService,
    undefined,
    undefined,
    new Set(untested),
  );
}

async function check(service: ChannelAccountService, feature: ChannelFeature) {
  return service.canChannelAccountUseFeature({
    scope,
    organizationId: 7,
    channelAccountId: 5,
    feature,
  });
}

describe('ChannelAccountService.canChannelAccountUseFeature (CA11, P50, P61)', () => {
  it('allows every feature on Creator with every permission and nothing untested', async () => {
    const service = serviceWith({});
    for (const feature of CHANNEL_FEATURE_KEYS) {
      expect(await check(service, feature)).toEqual({ isAllowed: true });
    }
  });

  it('refuses a channel without the feature with channel_lacks_feature', async () => {
    expect(await check(serviceWith({ channel: 'tiktok' }), 'broadcasts')).toEqual({
      isAllowed: false,
      reason: 'channel_lacks_feature',
    });
  });

  it('refuses a connection without the permission with permission_not_granted', async () => {
    expect(await check(serviceWith({ scopes: ['instagram_basic'] }), 'email_ask')).toEqual({
      isAllowed: false,
      reason: 'permission_not_granted',
    });
    // A feature that needs no extra permission passes the same connection.
    expect(await check(serviceWith({ scopes: ['instagram_basic'] }), 'segments')).toEqual({
      isAllowed: true,
    });
  });

  it('refuses every PRO switch on Free and allows it on Creator (P83), segments included (P76)', async () => {
    const free = serviceWith({ features: FREE_PLAN_FEATURES });
    const creator = serviceWith({ features: CREATOR_PLAN_FEATURES });
    for (const feature of PRO_PLAN_FEATURE_KEYS) {
      expect(await check(free, feature)).toEqual({
        isAllowed: false,
        reason: 'plan_lacks_feature',
      });
      expect(await check(creator, feature)).toEqual({ isAllowed: true });
    }
    expect(await check(free, 'segments')).toEqual({
      isAllowed: false,
      reason: 'plan_lacks_feature',
    });
    expect(await check(free, 'starter_questions')).toEqual({ isAllowed: true });
  });

  it('refuses every feature with plan_lacks_feature when the organization has no readable plan', async () => {
    expect(await check(serviceWith({ features: null }), 'starter_questions')).toEqual({
      isAllowed: false,
      reason: 'plan_lacks_feature',
    });
  });

  it('refuses an untested feature with feature_not_offered (P36)', async () => {
    expect(await check(serviceWith({ untested: ['mark_seen'] }), 'mark_seen')).toEqual({
      isAllowed: false,
      reason: 'feature_not_offered',
    });
  });

  it('answers the first reason in order when several fail', async () => {
    const all = serviceWith({
      scopes: [],
      features: FREE_PLAN_FEATURES,
      untested: ['mark_seen'],
    });
    expect(await check(all, 'email_ask')).toMatchObject({ reason: 'permission_not_granted' });
    expect(
      await check(
        serviceWith({ features: FREE_PLAN_FEATURES, untested: ['email_ask'] }),
        'email_ask',
      ),
    ).toMatchObject({ reason: 'plan_lacks_feature' });
    expect(await check(serviceWith({ channel: 'tiktok', scopes: [] }), 'email_ask')).toMatchObject({
      reason: 'channel_lacks_feature',
    });
  });

  it('answers 404 channel_account_not_found for an account not in the organization', async () => {
    await expect(check(serviceWith({ hasAccount: false }), 'segments')).rejects.toMatchObject({
      reason: 'channel_account_not_found',
    });
  });

  it('lists every refusal of a whole automation in one read of each input', async () => {
    const service = serviceWith({ features: FREE_PLAN_FEATURES, untested: ['mark_seen'] });
    const problems = await service.listChannelAccountFeatureProblems({
      scope,
      organizationId: 7,
      channelAccountId: 5,
      features: ['email_ask', 'starter_questions', 'mark_seen', 'email_ask'],
    });
    expect(problems).toEqual([
      { feature: 'email_ask', reason: 'plan_lacks_feature' },
      { feature: 'mark_seen', reason: 'feature_not_offered' },
    ]);
  });
});

describe('channelFeatureRefusalError (P61)', () => {
  const refuse = (reason: Parameters<typeof channelFeatureRefusalError>[0]['reason']) =>
    channelFeatureRefusalError({ reason, feature: 'broadcasts' });

  it('maps each reason to its status: 422 · 409 · 403 · 422', () => {
    expect(refuse('channel_lacks_feature').statusCode).toBe(422);
    expect(refuse('permission_not_granted').statusCode).toBe(409);
    expect(refuse('plan_lacks_feature').statusCode).toBe(403);
    expect(refuse('feature_not_offered').statusCode).toBe(422);
    expect(refuse('plan_lacks_feature').reason).toBe('plan_lacks_feature');
  });

  it('P269: names the plan feature key; only plan_lacks_feature asks for an upgrade', () => {
    expect(refuse('plan_lacks_feature').fields).toEqual({
      feature: 'broadcasts',
      upgrade_required: true,
    });
    for (const reason of [
      'channel_lacks_feature',
      'permission_not_granted',
      'feature_not_offered',
    ] as const) {
      expect(refuse(reason).fields).toEqual({ feature: 'broadcasts' });
    }
  });
});
