import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DomainEvent, eventBus } from '@/core/events/event-bus.js';
import { audit_outbox } from '@/domains/audit/audit-outbox.schema.js';
import { organization_entitlement_overrides } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';
import {
  type PlanStateChangedPayload,
  SUBSCRIPTION_EVENT,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { FREE_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { generateSuperAdminToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

const OVERRIDES_PATH = testApiPath('/billing/entitlement-overrides');

interface OverrideBody {
  id: string;
  organization_id: string;
  key: string;
  value: boolean | number;
  expires_at: string | null;
  is_active: boolean;
  reason: string;
}

/**
 * Per-organization plan overrides (plan-gating close, P270): the global admin's list, set and
 * remove, the merge into the one plan read (`GET /auth/me/context`'s `plan_access`), expiry, the
 * plan-change event, the audit rows, and that only a SUPER_ADMIN reaches the routes.
 */
describe('Billing entitlement overrides (P270)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let adminToken: string;
  const events: PlanStateChangedPayload[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp());
    eventBus.on({
      eventType: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
      handler: async (event: DomainEvent<unknown>) => {
        events.push(event.payload as PlanStateChangedPayload);
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    // The catalog's Free plan (one account; every PRO switch off but broadcasts and segments, P13) — the
    // plan every override lays over here.
    await createTestPlan({
      features: FREE_PLAN_FEATURES,
      priceMonthly: '0.00',
      priceYearly: '0.00',
    });
    team = await createInstagramTeam();
    const admin = await createTestUser({ email: 'ops@example.com', isEmailVerified: true });
    adminToken = await generateSuperAdminToken(admin.public_id);
    events.length = 0;
  });

  function setOverride(body: Record<string, unknown>, token = adminToken) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: OVERRIDES_PATH,
      token,
      payload: { organization_id: team.organization.public_id, reason: 'Support deal', ...body },
    });
  }

  function listOverrides(token = adminToken) {
    return injectAuthenticated(app, {
      method: 'GET',
      url: OVERRIDES_PATH,
      token,
      query: { organization_id: team.organization.public_id },
    });
  }

  function removeOverride(overridePublicId: string, token = adminToken) {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: `${OVERRIDES_PATH}/${overridePublicId}`,
      token,
    });
  }

  function dataOf<T>(response: InjectHttpResult): T {
    return (response.json() as { data: T }).data;
  }

  async function planFeatures() {
    const response = await injectAuthenticated(app, {
      url: testApiPath('/auth/me/context'),
      token: team.ownerToken,
    });
    expect(response.statusCode, response.body).toBe(200);
    return dataOf<{
      active_organization: {
        plan_access: {
          features: {
            channel_accounts_max: number;
            feature_switches: Record<string, boolean>;
          };
        };
      };
    }>(response).active_organization.plan_access.features;
  }

  async function auditRows(action: string) {
    return getOperatorDatabase().select().from(audit_outbox).where(eq(audit_outbox.action, action));
  }

  it('turns a feature on and a limit up over Free, in the one plan read, and lists them', async () => {
    // A switch Free keeps off (broadcasts and segments are on for Free since change-plan-gates P13).
    const before = await planFeatures();
    expect(before.feature_switches.past_comments).toBe(false);
    expect(before.channel_accounts_max).toBe(1);

    const feature = await setOverride({ key: 'past_comments', value: true });
    expect(feature.statusCode, feature.body).toBe(200);
    expect(dataOf<OverrideBody>(feature)).toMatchObject({
      organization_id: team.organization.public_id,
      key: 'past_comments',
      value: true,
      expires_at: null,
      is_active: true,
      reason: 'Support deal',
    });
    expect(dataOf<OverrideBody>(feature).id).toMatch(/^ovr_[a-z0-9]{21}$/);
    const limit = await setOverride({
      key: 'channel_accounts_max',
      value: 3,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(limit.statusCode, limit.body).toBe(200);

    const after = await planFeatures();
    expect(after.feature_switches.past_comments).toBe(true);
    expect(after.channel_accounts_max).toBe(3);
    // Every other switch stays the plan's.
    expect(after.feature_switches.segments).toBe(before.feature_switches.segments);

    const listed = dataOf<OverrideBody[]>(await listOverrides());
    expect(listed.map((override) => override.key)).toEqual([
      'channel_accounts_max',
      'past_comments',
    ]);
    // Both raised the features: the app is told as for an upgrade (BL8).
    expect(events.map((event) => event.change)).toEqual(['upgraded', 'upgraded']);
  });

  it('replaces the live override of a key in place and lowers with moved_down', async () => {
    const first = dataOf<OverrideBody>(
      await setOverride({ key: 'channel_accounts_max', value: 5 }),
    );
    const second = await setOverride({ key: 'channel_accounts_max', value: 2, reason: 'Lowered' });
    expect(second.statusCode, second.body).toBe(200);
    expect(dataOf<OverrideBody>(second)).toMatchObject({
      id: first.id,
      value: 2,
      reason: 'Lowered',
    });
    expect(dataOf<OverrideBody[]>(await listOverrides())).toHaveLength(1);
    expect((await planFeatures()).channel_accounts_max).toBe(2);
    expect(events.map((event) => event.change)).toEqual(['upgraded', 'moved_down']);
  });

  it('never merges an expired override; the list marks it inactive', async () => {
    await getOperatorDatabase()
      .insert(organization_entitlement_overrides)
      .values({
        public_id: generatePublicId('organizationEntitlementOverride'),
        organization_id: team.organization.id,
        key: 'past_comments',
        value: true,
        expires_at: new Date(Date.now() - 60_000),
        reason: 'Ended trial deal',
        created_at: new Date(Date.now() - 120_000),
        updated_at: new Date(Date.now() - 120_000),
      });
    expect((await planFeatures()).feature_switches.past_comments).toBe(false);
    const [listed] = dataOf<OverrideBody[]>(await listOverrides());
    expect(listed).toMatchObject({ key: 'past_comments', is_active: false });
  });

  it('removes an override: back to the plan, 204, then 404 entitlement_override_not_found', async () => {
    const created = dataOf<OverrideBody>(await setOverride({ key: 'extra_delay', value: true }));
    expect((await planFeatures()).feature_switches.extra_delay).toBe(true);

    const removed = await removeOverride(created.id);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await planFeatures()).feature_switches.extra_delay).toBe(false);
    expect(dataOf<OverrideBody[]>(await listOverrides())).toEqual([]);
    expect(events.map((event) => event.change)).toEqual(['upgraded', 'moved_down']);

    const again = await removeOverride(created.id);
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: { reason?: string } }).error.reason).toBe(
      'entitlement_override_not_found',
    );
  });

  it('audits each set and remove in the organization log, naming the admin, key and values', async () => {
    const created = dataOf<OverrideBody>(
      await setOverride({ key: 'message_month_limit', value: 50_000 }),
    );
    await removeOverride(created.id);
    const [set] = await auditRows('billing.entitlement_override.set');
    expect(set).toMatchObject({
      resource_type: 'entitlement_override',
      severity: 'WARNING',
      organization_public_id: team.organization.public_id,
      metadata: {
        entitlement_override_public_id: created.id,
        key: 'message_month_limit',
        value: 50_000,
        previous_value: null,
        reason: 'Support deal',
      },
    });
    const [remove] = await auditRows('billing.entitlement_override.remove');
    expect(remove).toMatchObject({
      organization_public_id: team.organization.public_id,
      metadata: { key: 'message_month_limit', value: null, previous_value: 50_000 },
    });
  });

  it('refuses a value of the wrong type, out of bounds or a past end with 400', async () => {
    for (const body of [
      { key: 'broadcasts', value: 3 },
      { key: 'channel_accounts_max', value: true },
      { key: 'channel_accounts_max', value: 0 },
      { key: 'channel_accounts_max', value: 101 },
      { key: 'message_month_limit', value: -1 },
    ]) {
      const response = await setOverride(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const past = await setOverride({
      key: 'broadcasts',
      value: true,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
    const unknownKey = await setOverride({ key: 'has_priority_support', value: true });
    expect(unknownKey.statusCode).toBe(400);
    expect(dataOf<OverrideBody[]>(await listOverrides())).toEqual([]);
  });

  it('answers 404 for an unknown organization', async () => {
    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: OVERRIDES_PATH,
      token: adminToken,
      payload: {
        organization_id: generatePublicId('organization'),
        key: 'broadcasts',
        value: true,
        reason: 'Nobody',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses every route to a non-admin, the organization owner included, with 403', async () => {
    const created = dataOf<OverrideBody>(await setOverride({ key: 'broadcasts', value: true }));
    for (const response of [
      await listOverrides(team.ownerToken),
      await setOverride({ key: 'segments', value: true }, team.ownerToken),
      await removeOverride(created.id, team.ownerToken),
    ]) {
      expect(response.statusCode).toBe(403);
    }
    expect(dataOf<OverrideBody[]>(await listOverrides())).toHaveLength(1);
  });
});
