import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { APP_UNTESTED_META_FEATURES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { CHANNEL_FEATURE_KEYS } from '@/domains/app/sub-domains/channel-account/channel-account-capabilities.constants.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { connectInstagramAccountsThroughRoutes } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  channelAccountActionPath,
  channelAccountPath,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';

/** Route 153's answer, as this suite reads it. */
interface CapabilitiesAnswer {
  channel_account_id: string;
  channel: string;
  scopes_source: 'account' | 'connection';
  features: Array<{
    feature: string;
    is_allowed: boolean;
    reason: string | null;
    permission: string | null;
    plan_switch: string | null;
    fix: string | null;
  }>;
  blockers: Array<{ blocker: string; since: string | null; fix: string }>;
}

let accountSequence = 0;

/** A fresh assigned Instagram account id (unique per call). */
function nextAccountId(): string {
  accountSequence += 1;
  return `17843${`${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0')}`;
}

/**
 * Route 153 — `GET /social/channel-accounts/{channel_account_id}/capabilities` (feat-meta-connect-flow
 * routes-final § 2, AC1–AC5, ROUTE R4) over HTTP: every feature through the one feature check with
 * its reason, Meta permission, plan switch and fix; the blockers read from stored states; the
 * account's own permissions over the connection's; the gate, team-only and another organization's
 * account. Meta is mocked with nock (connect only); route 153 itself calls no Meta.
 */
describe('Channel account capabilities (route 153)', () => {
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
    team = await createInstagramTeam();
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  async function useCreatorPlan(): Promise<void> {
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
    });
  }

  async function connectOne(fixture: InstagramTeamFixture = team): Promise<string> {
    const id = nextAccountId();
    const { pick } = await connectInstagramAccountsThroughRoutes({
      app,
      token: fixture.ownerToken,
      accounts: [{ id, username: `shop.${id.slice(-6)}` }],
    });
    const [result] = pick.results as Array<{ channel_account: { id: string } | null }>;
    return result?.channel_account?.id ?? '';
  }

  function capabilities(channelAccountPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, {
      url: `${channelAccountPath(channelAccountPublicId)}/capabilities`,
      token,
    });
  }

  function dataOf(response: InjectHttpResult): CapabilitiesAnswer {
    return (response.json() as { data: CapabilitiesAnswer }).data;
  }

  function featureOf(answer: CapabilitiesAnswer, feature: string) {
    return answer.features.find((item) => item.feature === feature);
  }

  it('lists every feature through the one check on Creator, no blocker, the connection permissions standing', async () => {
    await useCreatorPlan();
    const id = await connectOne();

    const response = await capabilities(id);

    expect(response.statusCode, response.body).toBe(200);
    const answer = dataOf(response);
    expect(answer).toMatchObject({
      channel_account_id: id,
      channel: 'instagram',
      scopes_source: 'connection',
      blockers: [],
    });
    expect(answer.features.map((item) => item.feature)).toEqual([...CHANNEL_FEATURE_KEYS]);
    for (const item of answer.features) {
      if ((APP_UNTESTED_META_FEATURES as readonly string[]).includes(item.feature)) {
        expect(item).toMatchObject({
          is_allowed: false,
          reason: 'feature_not_offered',
          fix: 'none',
        });
      } else {
        expect(item).toEqual({
          feature: item.feature,
          is_allowed: true,
          reason: null,
          permission: null,
          plan_switch: null,
          fix: null,
        });
      }
    }
  });

  it('names the plan switch and the upgrade fix without a plan (plan_lacks_feature)', async () => {
    const id = await connectOne();

    const answer = dataOf(await capabilities(id));

    expect(featureOf(answer, 'past_comments')).toEqual({
      feature: 'past_comments',
      is_allowed: false,
      reason: 'plan_lacks_feature',
      permission: null,
      plan_switch: 'past_comments',
      fix: 'upgrade',
    });
  });

  it("reads the account's own permissions over the connection's and names the missing one (AC4, AC5)", async () => {
    await useCreatorPlan();
    const id = await connectOne();
    await operatorQuery`
      UPDATE app.channel_accounts
      SET scopes = ARRAY['instagram_basic', 'instagram_manage_comments']::text[], scopes_read_at = now()
      WHERE public_id = ${id}`;

    const answer = dataOf(await capabilities(id));

    expect(answer.scopes_source).toBe('account');
    expect(featureOf(answer, 'email_ask')).toEqual({
      feature: 'email_ask',
      is_allowed: false,
      reason: 'permission_not_granted',
      permission: 'instagram_manage_messages',
      plan_switch: null,
      fix: 'reconnect',
    });
    expect(featureOf(answer, 'past_comments')?.is_allowed).toBe(true);
    expect(featureOf(answer, 'segments')?.is_allowed).toBe(true);
  });

  it('lists the stored blockers with their start and fix: error, plan stop, missing webhooks, pause (AC2)', async () => {
    await useCreatorPlan();
    const id = await connectOne();
    const paused = await injectAuthenticated(app, {
      method: 'POST',
      url: channelAccountActionPath({ channelAccountPublicId: id, action: 'pause' }),
      token: team.ownerToken,
    });
    expect(paused.statusCode, paused.body).toBe(200);
    await operatorQuery`
      UPDATE app.channel_accounts
      SET connection_status = 'error', plan_stop_reason = 'plan_limit', plan_stopped_at = now()
      WHERE public_id = ${id}`;
    await operatorQuery`
      UPDATE app.instagram_accounts
      SET messages_webhook_missing_at = now()
      WHERE channel_account_id = (SELECT id FROM app.channel_accounts WHERE public_id = ${id})`;

    const answer = dataOf(await capabilities(id));

    expect(answer.blockers.map(({ blocker, fix }) => ({ blocker, fix }))).toEqual([
      { blocker: 'connection_error', fix: 'reconnect' },
      { blocker: 'plan_limit', fix: 'upgrade' },
      { blocker: 'messages_webhook_missing', fix: 'reconnect_with_page' },
      { blocker: 'paused', fix: 'resume' },
    ]);
    const pausedBlocker = answer.blockers.find((item) => item.blocker === 'paused');
    expect(Number.isNaN(Date.parse(pausedBlocker?.since ?? ''))).toBe(false);
  });

  it('lets a viewer read it; answers 404 for another organization and on a personal one', async () => {
    const id = await connectOne();
    expect((await capabilities(id, team.viewerToken)).statusCode).toBe(200);

    const otherTeam = await createInstagramTeam();
    const foreign = await capabilities(id, otherTeam.ownerToken);
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { error: { reason?: string } }).error.reason).toBe(
      'channel_account_not_found',
    );

    const personal = await createPersonalOrganizationWithInstagramCodes({
      permissionCodes: [APP_PERMISSIONS.CHANNEL_ACCOUNT_READ],
    });
    const personalRead = await capabilities(id, personal.token);
    expect(personalRead.statusCode).toBe(404);
    expect((personalRead.json() as { error: { reason?: string } }).error.reason).toBe(
      'team_organization_required',
    );
  });
});
