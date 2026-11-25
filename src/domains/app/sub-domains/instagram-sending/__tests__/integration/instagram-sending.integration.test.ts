import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  mockInstagramUnsubscribe,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type TestAssignedAccount,
  connectInstagramAccountsThroughRoutes,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  channelAccountActionPath,
  channelAccountPath,
  insertChannelAccount,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  APP_USAGE_PATH,
  insertLanes,
  readLaneRows,
  readStopRows,
  sendingStatusPath,
  setMonthCount,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { invalidateCachedMessageMonthCount } from '@/domains/app/sub-domains/instagram-sending/message-month-count.cache.js';

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17843${suffix}`, username: `sender.${suffix}` };
}

/** `data` of a JSON answer. */
function dataOf<TData = Record<string, unknown>>(response: InjectHttpResult): TData {
  return (response.json() as { data: TData }).data;
}

/** `error.reason` of an error answer. */
function reasonOf(response: InjectHttpResult): string | undefined {
  return (response.json() as { error: { reason?: string } }).error.reason;
}

/** The parts of route 63's object this suite reads. */
interface SendingStatusAnswer {
  channel_account_id: string;
  is_paused: boolean;
  is_suspended: boolean;
  new_account_limit_until: string | null;
  lanes: Array<{
    lane: string;
    state: string;
    waiting_count: number;
    stop: { reason: string; until: string | null; started_at: string | null } | null;
    plan_stop: { reason: string } | null;
  }>;
  all_accounts_stop: unknown;
  estimate: { waiting: number; will_go: number; may_expire: number } | null;
  today: Record<string, number>;
}

/** Route 64's object. */
interface AppUsageAnswer {
  direct_messages: { used: number; limit: number | null; resets_on: string; state: string };
  channel_accounts: { used: number; maximum: number };
  notices: Array<{ kind: string; ends_on: string | null }>;
}

/**
 * The sending sub-domain's root over HTTP (feat-instagram-dm-sending routes-final § 6.A, ROUTE row
 * R18): route 63's banner fields from seeded rows (AC-7.12), route 64's meter (AC-10.1) with the
 * five tests its Redis copy owes, the lanes a pick makes (AC-1.7), and the lane steps of routes 8–11
 * (AC-2.2, AC-2.3, AC-2.6, AC-2.7). Meta is mocked with nock; the database, Redis, auth and
 * permissions are real.
 */
describe('Instagram sending routes and lane steps', () => {
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
    vi.restoreAllMocks();
    nock.cleanAll();
    await metaGraphCircuit.reset();
  });

  async function connect(accounts: TestAssignedAccount[]): Promise<string[]> {
    const { pick } = await connectInstagramAccountsThroughRoutes({
      app,
      token: team.ownerToken,
      accounts,
    });
    const results = pick.results as Array<{ channel_account: { id: string } | null }>;
    return results.map((result) => result.channel_account?.id ?? '');
  }

  async function internalIdOf(channelAccountPublicId: string): Promise<number> {
    const rows = await operatorQuery<Array<{ id: string }>>`
      SELECT id FROM app.channel_accounts WHERE public_id = ${channelAccountPublicId}`;
    return Number(rows[0]?.id);
  }

  function readStatus(channelAccountPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, { url: sendingStatusPath(channelAccountPublicId), token });
  }

  function readUsage(token = team.ownerToken) {
    return injectAuthenticated(app, { url: APP_USAGE_PATH, token });
  }

  function act({
    channelAccountPublicId,
    action,
    payload,
  }: {
    channelAccountPublicId: string;
    action: 'pause' | 'resume' | 'activate';
    payload?: Record<string, unknown>;
  }) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: channelAccountActionPath({ channelAccountPublicId, action }),
      token: team.ownerToken,
      ...(payload === undefined ? {} : { payload }),
      ...(action === 'activate' ? { headers: { 'x-idempotency-key': randomUUID() } } : {}),
    });
  }

  describe('the pick (route 3, AC-1.7)', () => {
    it('gives a newly picked account four ready lanes in the pick commit', async () => {
      const [id] = await connect([nextAccount()]);
      const lanes = await readLaneRows(await internalIdOf(id ?? ''));
      expect(lanes.map((lane) => [lane.lane, lane.state])).toEqual([
        ['slow', 'ready'],
        ['reply', 'ready'],
        ['fast', 'ready'],
        ['broadcast', 'ready'],
      ]);
    });
  });

  describe('GET …/{channel_account_id}/sending-status (route 63, AC-7.12)', () => {
    it('answers every banner field from the lane, stop, day and account rows — a Viewer too', async () => {
      const account = await insertChannelAccount({
        organizationId: team.organization.id,
        providerAccountId: '17841499000000001',
        planStopReason: 'plan_limit',
      });
      await insertLanes({ organizationId: team.organization.id, channelAccountId: account.id });
      await operatorQuery`
        UPDATE app.instagram_send_lanes
        SET state = 'stopped', stop_reason = 'too_fast', stop_until = now() + interval '15 minutes',
            stop_count = 1, wait_reason = 'stop'
        WHERE channel_account_id = ${account.id} AND lane = 'fast'`;
      await operatorQuery`
        INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason, stop_until)
        VALUES (${team.organization.id}, ${account.id}, 'fast', 'too_fast', now() + interval '15 minutes')`;
      await operatorQuery`
        UPDATE app.instagram_send_lanes
        SET estimated_at = now(), estimate_waiting_count = 30, estimate_will_go_count = 25,
            estimate_may_expire_count = 5, estimate_done_at = now() + interval '2 hours'
        WHERE channel_account_id = ${account.id} AND lane = 'slow'`;
      await operatorQuery`
        INSERT INTO app.instagram_send_day_counts
          (organization_id, channel_account_id, day_date, sent_count, unknown_count, skipped_count,
           skipped_window_closed_count, expired_count)
        SELECT ${team.organization.id}, ${account.id}, (now() AT TIME ZONE timezone)::date, 42, 1, 3, 2, 4
        FROM tenancy.organizations WHERE id = ${team.organization.id}`;
      await operatorQuery`
        UPDATE app.channel_accounts SET paused_at = now() WHERE id = ${account.id}`;

      const response = await readStatus(account.public_id, team.viewerToken);
      expect(response.statusCode, response.body).toBe(200);
      const status = dataOf<SendingStatusAnswer>(response);
      expect(status).toMatchObject({
        channel_account_id: account.public_id,
        is_paused: true,
        is_suspended: false,
        all_accounts_stop: null,
        estimate: { waiting: 30, will_go: 25, may_expire: 5 },
        today: { sent: 42, unknown: 1, skipped: 3, skipped_window_closed: 2, expired: 4 },
      });
      expect(status.new_account_limit_until).not.toBeNull();
      const byLane = Object.fromEntries(status.lanes.map((lane) => [lane.lane, lane]));
      expect(byLane.fast?.stop?.reason).toBe('too_fast');
      expect(byLane.fast?.stop?.started_at).not.toBeNull();
      // plan_limit holds slow, fast and broadcast; the reply lane goes on (D62).
      expect(byLane.slow?.plan_stop?.reason).toBe('plan_limit');
      expect(byLane.reply?.plan_stop).toBeNull();
      expect(byLane.reply?.stop).toBeNull();
      expect(status.lanes.every((lane) => lane.waiting_count === 0)).toBe(true);
    });

    it("answers 404 instagram_not_connected for another organization's or a revoked account, and 400 for a malformed id", async () => {
      const other = await createInstagramTeam();
      const foreign = await insertChannelAccount({
        organizationId: other.organization.id,
        providerAccountId: '17841499000000002',
      });
      const revoked = await insertChannelAccount({
        organizationId: team.organization.id,
        providerAccountId: '17841499000000003',
        connectionStatus: 'revoked',
      });
      const foreignResponse = await readStatus(foreign.public_id);
      expect(foreignResponse.statusCode).toBe(404);
      expect(reasonOf(foreignResponse)).toBe('instagram_not_connected');
      const revokedResponse = await readStatus(revoked.public_id);
      expect(revokedResponse.statusCode).toBe(404);
      expect(reasonOf(revokedResponse)).toBe('instagram_not_connected');
      const malformed = await readStatus('not-an-id');
      expect(malformed.statusCode).toBe(400);
    });

    it('answers 404 team_organization_required on a personal organization and 401 without a token', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ],
      });
      const account = await insertChannelAccount({
        organizationId: personal.organization.id,
        providerAccountId: '17841499000000004',
      });
      const response = await readStatus(account.public_id, personal.token);
      expect(response.statusCode).toBe(404);
      expect(reasonOf(response)).toBe('team_organization_required');
      const anonymous = await injectUnauthenticated(app, {
        method: 'GET',
        url: sendingStatusPath(account.public_id),
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('GET /app/usage (route 64, AC-10.1, AC-10.8)', () => {
    it('answers used, limit, the reset day and the accounts used — nearly at 80 %, reached at 100 %', async () => {
      // A Free plan subscription: 1,000 messages a month, one account (P37).
      const free = await createTestPlan({
        name: 'Free',
        priceMonthly: '0.00',
        priceYearly: '0.00',
      });
      await createTestSubscription({
        organizationId: team.organization.id,
        planId: free.id,
        status: 'ACTIVE',
      });
      await insertChannelAccount({
        organizationId: team.organization.id,
        providerAccountId: '17841499000000010',
      });
      await setMonthCount({ organizationId: team.organization.id, count: 799 });
      const ok = dataOf<AppUsageAnswer>(await readUsage());
      expect(ok.direct_messages).toMatchObject({ used: 799, limit: 1000, state: 'ok' });
      expect(ok.direct_messages.resets_on).toMatch(/^\d{4}-\d{2}-01$/);
      expect(ok.channel_accounts).toEqual({ used: 1, maximum: 1 });
      expect(ok.notices).toEqual([]);

      await invalidateCachedMessageMonthCount(team.organization.public_id);
      await setMonthCount({ organizationId: team.organization.id, count: 800 });
      const nearly = dataOf<AppUsageAnswer>(await readUsage());
      expect(nearly.direct_messages.state).toBe('nearly');
      expect(nearly.notices.map((notice) => notice.kind)).toEqual(['direct_message_limit_nearly']);

      await invalidateCachedMessageMonthCount(team.organization.public_id);
      await setMonthCount({ organizationId: team.organization.id, count: 1000 });
      const reached = dataOf<AppUsageAnswer>(await readUsage());
      expect(reached.direct_messages.state).toBe('reached');
      expect(reached.notices[0]?.kind).toBe('direct_message_limit_reached');
      // A Viewer sees the meter and the notices (AC-10.8).
      const viewerSees = dataOf<AppUsageAnswer>(await readUsage(team.viewerToken));
      expect(viewerSees.direct_messages).toMatchObject({
        used: 1000,
        limit: 1000,
        state: 'reached',
      });
      expect(viewerSees.notices[0]?.kind).toBe('direct_message_limit_reached');
    });

    it('answers 404 team_organization_required on a personal organization', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      const response = await readUsage(personal.token);
      expect(response.statusCode).toBe(404);
      expect(reasonOf(response)).toBe('team_organization_required');
    });

    describe('its 10-second Redis copy (be-read-cache-guard)', () => {
      it('serves a warm entry Postgres has since changed', async () => {
        await setMonthCount({ organizationId: team.organization.id, count: 10 });
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(10);
        await setMonthCount({ organizationId: team.organization.id, count: 11 });
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(10);
      });

      it('is invalidated by the one writer, the month add', async () => {
        const account = await insertChannelAccount({
          organizationId: team.organization.id,
          providerAccountId: '17841499000000011',
        });
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(0);
        await app.appDomain.messageMonthCountService.addMessages({
          scope: PRINCIPAL_SCOPE.JOB({
            organizationPublicId: team.organization.public_id,
          }) as OrganizationPrincipalDatabaseScope,
          organizationId: team.organization.id,
          channelAccountId: account.id,
          count: 3,
        });
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(3);
      });

      it('keys on the organization, so one warm entry never answers another', async () => {
        const other = await createInstagramTeam();
        await setMonthCount({ organizationId: team.organization.id, count: 5 });
        await setMonthCount({ organizationId: other.organization.id, count: 7 });
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(5);
        expect(dataOf<AppUsageAnswer>(await readUsage(other.ownerToken)).direct_messages.used).toBe(
          7,
        );
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(5);
        expect(dataOf<AppUsageAnswer>(await readUsage(other.ownerToken)).direct_messages.used).toBe(
          7,
        );
      });

      it('refuses an unauthenticated read with the entry warm', async () => {
        await setMonthCount({ organizationId: team.organization.id, count: 5 });
        expect((await readUsage()).statusCode).toBe(200);
        const anonymous = await injectUnauthenticated(app, { method: 'GET', url: APP_USAGE_PATH });
        expect(anonymous.statusCode).toBe(401);
      });

      it('falls back to Postgres when Redis is unreachable', async () => {
        await setMonthCount({ organizationId: team.organization.id, count: 9 });
        vi.spyOn(redisConnection, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
        vi.spyOn(redisConnection, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(9);
        expect(dataOf<AppUsageAnswer>(await readUsage()).direct_messages.used).toBe(9);
      });
    });
  });

  describe('the lane steps of routes 8–11', () => {
    it('resume wakes every lane with no error stop; an error stop and a team suspend stay (AC-2.2, AC-2.3, AC-2.7)', async () => {
      const [id = ''] = await connect([nextAccount()]);
      const accountId = await internalIdOf(id);
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET state = 'sleeping', next_run_at = now() + interval '1 hour'
        WHERE channel_account_id = ${accountId} AND lane <> 'fast'`;
      await operatorQuery`
        UPDATE app.instagram_send_lanes
        SET state = 'stopped', stop_reason = 'blocked', wait_reason = 'stop'
        WHERE channel_account_id = ${accountId} AND lane = 'fast'`;
      await operatorQuery`UPDATE app.channel_accounts SET suspended_at = now() WHERE id = ${accountId}`;
      expect((await act({ channelAccountPublicId: id, action: 'pause' })).statusCode).toBe(200);
      const paused = dataOf<SendingStatusAnswer>(await readStatus(id));
      expect(paused.is_paused).toBe(true);

      const resumed = await act({ channelAccountPublicId: id, action: 'resume' });
      expect(resumed.statusCode, resumed.body).toBe(200);
      const lanes = await readLaneRows(accountId);
      expect(lanes.map((lane) => [lane.lane, lane.state, lane.stop_reason])).toEqual([
        ['slow', 'ready', null],
        ['reply', 'ready', null],
        ['fast', 'stopped', 'blocked'],
        ['broadcast', 'ready', null],
      ]);
      expect(lanes.find((lane) => lane.lane === 'slow')?.turn_number).toBe('1');
      const status = dataOf<SendingStatusAnswer>(await readStatus(id));
      expect(status).toMatchObject({ is_paused: false, is_suspended: true });
    });

    it('a swap stops the named account with plan_downgrade and wakes the activated one (AC-2.6)', async () => {
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
      const [kept = '', outside = ''] = await connect([nextAccount(), nextAccount()]);
      await operatorQuery`DELETE FROM billing.subscriptions WHERE organization_id = ${team.organization.id}`;
      await operatorQuery`
        UPDATE app.channel_accounts SET plan_stop_reason = 'plan_downgrade', plan_stopped_at = now()
        WHERE public_id = ${outside}`;
      const outsideId = await internalIdOf(outside);
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET state = 'stopped', wait_reason = 'stop'
        WHERE channel_account_id = ${outsideId}`;
      await operatorQuery`
        INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason)
        VALUES (${team.organization.id}, ${outsideId}, 'all', 'plan_downgrade')`;

      const swapped = await act({
        channelAccountPublicId: outside,
        action: 'activate',
        payload: { stop_channel_account_id: kept },
      });
      expect(swapped.statusCode, swapped.body).toBe(200);

      const keptId = await internalIdOf(kept);
      expect((await readLaneRows(keptId)).every((lane) => lane.state === 'stopped')).toBe(true);
      expect(await readStopRows(keptId)).toMatchObject([
        { lane: 'all', reason: 'plan_downgrade', ended_at: null },
      ]);
      expect((await readLaneRows(outsideId)).every((lane) => lane.state === 'ready')).toBe(true);
      expect(await readStopRows(outsideId)).toMatchObject([
        { lane: 'all', reason: 'plan_downgrade', ended_by: 'owner' },
      ]);
      const keptStatus = dataOf<SendingStatusAnswer>(await readStatus(kept));
      expect(keptStatus.lanes.every((lane) => lane.plan_stop?.reason === 'plan_downgrade')).toBe(
        true,
      );
    });

    it('a disconnect stops every lane with no turn (route 8)', async () => {
      const assigned = nextAccount();
      const [id = ''] = await connect([assigned]);
      const accountId = await internalIdOf(id);
      mockInstagramUnsubscribe({ instagramUserId: assigned.id });
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelAccountPath(id),
        token: team.ownerToken,
      });
      expect(response.statusCode, response.body).toBe(204);
      const lanes = await readLaneRows(accountId);
      expect(lanes.every((lane) => lane.state === 'stopped' && lane.next_run_at === null)).toBe(
        true,
      );
    });
  });
});
