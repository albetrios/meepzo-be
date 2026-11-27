import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { organization_entitlement_overrides } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { EntitlementsOutput } from '@/domains/billing/sub-domains/entitlement/entitlement.types.js';
import { PLAN_FEATURE_KEYS } from '@/domains/billing/sub-domains/plan/plan.constants.js';
import type { PlanFeatures } from '@/domains/billing/sub-domains/plan/plan.types.js';

const ENTITLEMENTS_PATH = testApiPath('/billing/entitlements');

/**
 * `GET /api/v1/billing/entitlements` (plan-gating close, P271): the plan state, the plan, its features
 * after overrides, each limit with its usage, the dates and the active overrides — `subscription:read`.
 */
describe('GET /billing/entitlements (P271)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    await createTestPlan({
      features: FREE_PLAN_FEATURES,
      priceMonthly: '0.00',
      priceYearly: '0.00',
    });
    team = await createInstagramTeam();
  });

  async function readEntitlements(token: string) {
    const response = await injectAuthenticated(app, { url: ENTITLEMENTS_PATH, token });
    return { response, data: (response.json() as { data: EntitlementsOutput }).data };
  }

  it('answers a Free team: active, Free limits, nothing used, no overrides', async () => {
    const { response, data } = await readEntitlements(team.ownerToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(data).toMatchObject({
      state: 'active',
      features: FREE_PLAN_FEATURES,
      limits: {
        direct_messages: { used: 0, limit: FREE_PLAN_FEATURES.message_month_limit },
        channel_accounts: { used: 0, limit: FREE_PLAN_FEATURES.channel_accounts_max },
        seats: { limit: null },
      },
      trial_ends_at: null,
      grace_ends_at: null,
      is_plan_choice_required: false,
      overrides: [],
    });
    expect(data.plan?.id).toMatch(/^pln_/);
    expect(data.limits.direct_messages.resets_on).toMatch(/^\d{4}-\d{2}-01$/);
    // The four members of the fixture (owner, admin, editor, viewer).
    expect(data.limits.seats.used).toBeGreaterThanOrEqual(1);
    // change-plan-gates EN6: the Free row carries every key, so each value's source is the plan.
    expect(data.sources).toEqual({
      ...Object.fromEntries(PLAN_FEATURE_KEYS.map((key) => [key, 'plan'])),
      message_month_limit: 'plan',
      channel_accounts_max: 'plan',
      seats: 'plan',
    });
  });

  it('change-plan-gates P19: a switch the plan row lacks reads off with source default', async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    const { mark_seen: _dropped, ...switchesWithoutMarkSeen } = FREE_PLAN_FEATURES.feature_switches;
    expect(FREE_PLAN_FEATURES.feature_switches.mark_seen).toBe(true);
    await createTestPlan({
      features: {
        ...FREE_PLAN_FEATURES,
        feature_switches: switchesWithoutMarkSeen,
      } as unknown as PlanFeatures,
      priceMonthly: '0.00',
      priceYearly: '0.00',
    });
    team = await createInstagramTeam();
    const { response, data } = await readEntitlements(team.ownerToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(data.features?.feature_switches.mark_seen).toBe(false);
    expect(data.sources.mark_seen).toBe('default');
    expect(data.sources.starter_questions).toBe('plan');
  });

  it('answers a paid trial with its plan and trial end, and lays an active override over it', async () => {
    const creator = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: creator.id,
      status: 'TRIALING',
    });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await getOperatorDatabase()
      .insert(organization_entitlement_overrides)
      .values([
        {
          public_id: generatePublicId('organizationEntitlementOverride'),
          organization_id: team.organization.id,
          key: 'channel_accounts_max',
          value: 7,
          expires_at: expiresAt,
          reason: 'Agency deal',
        },
        {
          public_id: generatePublicId('organizationEntitlementOverride'),
          organization_id: team.organization.id,
          key: 'broadcasts',
          value: false,
          expires_at: new Date(Date.now() - 60_000),
          reason: 'Ended',
          created_at: new Date(Date.now() - 120_000),
          updated_at: new Date(Date.now() - 120_000),
        },
      ]);
    const { response, data } = await readEntitlements(team.ownerToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(data.plan?.id).toBe(creator.public_id);
    expect(data.limits.channel_accounts.limit).toBe(7);
    expect(data.features?.channel_accounts_max).toBe(7);
    // The expired override is not merged and not listed.
    expect(data.features?.feature_switches.broadcasts).toBe(true);
    expect(data.overrides).toEqual([
      { key: 'channel_accounts_max', expires_at: expiresAt.toISOString() },
    ]);
    // change-plan-gates EN6: the active override is the source; the expired one falls back to the plan.
    expect(data.sources).toMatchObject({
      channel_accounts_max: 'override',
      broadcasts: 'plan',
      message_month_limit: 'plan',
      seats: 'plan',
    });
  });

  it('refuses a member without subscription:read with 403', async () => {
    const { response } = await readEntitlements(team.viewerToken);
    expect(response.statusCode).toBe(403);
  });
});
