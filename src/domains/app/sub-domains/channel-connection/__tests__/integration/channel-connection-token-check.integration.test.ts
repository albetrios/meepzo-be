import { readChannelAccountRows } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
  buildChannelConnectionTokenCheckJobId,
  closeChannelConnectionTokenCheckQueue,
} from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js';
import {
  type ChannelConnectionTokenCheckServices,
  processChannelConnectionTokenCheckJob,
  runChannelConnectionTokenCheckSweep,
} from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.processor.js';
import {
  type InstagramReconnectNoticeJobData,
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  closeInstagramReconnectNoticeQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
  readInstagramAccountRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type TestAssignedAccount,
  connectInstagramAccountsThroughRoutes,
  insertChannelConnection,
  readChannelConnectionRows,
  readChannelConnectionTokenCiphertexts,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';

/** The Graph path prefix every mocked call takes. */
const GRAPH_PATH = `/${META_GRAPH_VERSION}`;

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17841${suffix}`, username: `check.${suffix}` };
}

const TOKEN_REFUSED = {
  error: {
    message: 'Error validating access token',
    type: 'OAuthException',
    code: 190,
    error_subcode: 460,
  },
};

/**
 * The channel connection's daily token check (routes-final § 1 MC10, MC11, MCC6; WC-34, WC-46;
 * AC-1.14, AC-10.7) against real Postgres and Redis, Meta mocked with nock: the hourly sweep hands
 * one check per due connection to the queue; a passing check clears the error and refreshes each
 * account's profile and display name (P17); an account missing from the assigned list breaks alone;
 * Meta refusing the token breaks the connection and every account, stops their lanes and gives each
 * account one reconnect notice; Meta down changes nothing; twice equals once; a token on an old key
 * version is re-encrypted (S26).
 */
describe('Channel connection token check (MC10)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let services: ChannelConnectionTokenCheckServices;
  const noticeQueue = new Queue<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    { connection: getBullMQConnectionOptions(), prefix: getBullMQKeyPrefix() },
  );
  const checkQueue = new Queue(CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME, {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
  });

  beforeAll(async () => {
    ({ app } = await createTestApp());
    services = {
      connectionService: app.appDomain.channelConnectionService,
      accountPort: app.appDomain.channelAccountService,
      usageService: app.appDomain.channelConnectionUsageService,
    };
  });

  afterAll(async () => {
    await app.close();
    await closeInstagramReconnectNoticeQueue();
    await closeChannelConnectionTokenCheckQueue();
    await noticeQueue.close();
    await checkQueue.close();
  });

  beforeEach(async () => {
    await noticeQueue.obliterate({ force: true });
    await checkQueue.obliterate({ force: true });
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
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
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
    await noticeQueue.obliterate({ force: true });
    await checkQueue.obliterate({ force: true });
  });

  /** Connects two accounts through routes 1–3. */
  async function connectTwoAccounts() {
    const accounts = [nextAccount(), nextAccount()];
    const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
      app,
      token: team.ownerToken,
      accounts,
    });
    return { channelConnectionPublicId, accounts };
  }

  function runCheck(channelConnectionPublicId: string) {
    return processChannelConnectionTokenCheckJob({
      jobData: { organizationPublicId: team.organization.public_id, channelConnectionPublicId },
      services,
      requestId: 'token-check-integration',
    });
  }

  function mockAssigned(accounts: readonly TestAssignedAccount[]): nock.Scope {
    return nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(200, { data: accounts });
  }

  function mockProfile(account: TestAssignedAccount, username = account.username): nock.Scope {
    return nock(META_GRAPH_BASE_URL).get(`${GRAPH_PATH}/${account.id}`).query(true).reply(200, {
      id: account.id,
      username,
      biography: 'Renamed in the token check.',
      followers_count: 4096,
    });
  }

  async function noticeJobs() {
    return noticeQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active', 'completed']);
  }

  async function readStops() {
    return operatorQuery<
      Array<{ channel_account_id: string; reason: string; ended_at: Date | null }>
    >`
      SELECT DISTINCT channel_account_id, reason, ended_at FROM app.instagram_send_stops
      WHERE organization_id = ${team.organization.id} ORDER BY channel_account_id`;
  }

  async function makeDue({ lastCheckError = null }: { lastCheckError?: string | null } = {}) {
    await operatorQuery`
      UPDATE app.channel_connections
      SET last_checked_at = NOW() - INTERVAL '25 hours', last_check_error = ${lastCheckError}
      WHERE organization_id = ${team.organization.id}`;
  }

  it('the sweep hands one check per due connection to the queue, once an hour; a fresh one is not due', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    const sweptAt = new Date();

    // Connected just now: its last check is the connect itself (MC5), so it is not due.
    await expect(runChannelConnectionTokenCheckSweep({ now: sweptAt })).resolves.toEqual({
      listedCount: 0,
      addedCount: 0,
      capped: false,
    });

    await makeDue();
    await expect(runChannelConnectionTokenCheckSweep({ now: sweptAt })).resolves.toMatchObject({
      listedCount: 1,
    });
    await runChannelConnectionTokenCheckSweep({ now: sweptAt });

    const jobs = await checkQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(
      buildChannelConnectionTokenCheckJobId({ channelConnectionPublicId, sweptAt }),
    );
    expect(jobs[0]?.data).toMatchObject({
      organizationPublicId: team.organization.public_id,
      channelConnectionPublicId,
    });
  });

  it('a passing check clears the error and refreshes each profile and display name (P17)', async () => {
    const { channelConnectionPublicId, accounts } = await connectTwoAccounts();
    await makeDue({ lastCheckError: 'refused (code 100, HTTP 400)' });
    const [first, second] = accounts as [TestAssignedAccount, TestAssignedAccount];
    const graph = mockAssigned(accounts);
    mockProfile(first, `${first.username}.renamed`);
    mockProfile(second);

    await expect(runCheck(channelConnectionPublicId)).resolves.toEqual({
      outcome: 'checked',
      refreshedCount: 2,
      missingCount: 0,
      permissionRefusedCount: 0,
      isListComplete: true,
      isExpiringSoon: false,
      reencrypted: false,
    });

    expect(graph.isDone()).toBe(true);
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('connected');
    expect(connection?.last_check_error).toBeNull();
    expect(connection?.last_checked_at?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const channelAccounts = await readChannelAccountRows(team.organization.id);
    expect(channelAccounts.map((account) => account.display_name)).toEqual([
      `@${first.username}.renamed`,
      `@${second.username}`,
    ]);
    const [biography] = await operatorQuery<
      Array<{ biography: string | null; followers_count: number }>
    >`
      SELECT biography, followers_count FROM app.instagram_accounts
      WHERE organization_id = ${team.organization.id} ORDER BY id LIMIT 1`;
    expect(biography).toEqual({ biography: 'Renamed in the token check.', followers_count: 4096 });
    expect(await noticeJobs()).toHaveLength(0);
  });

  it('an account missing from the assigned list breaks alone, with its notice and its lanes stopped', async () => {
    const { channelConnectionPublicId, accounts } = await connectTwoAccounts();
    const [kept, missing] = accounts as [TestAssignedAccount, TestAssignedAccount];
    mockAssigned([kept]);
    mockProfile(kept);

    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'checked',
      refreshedCount: 1,
      missingCount: 1,
    });

    const rows = await readInstagramAccountRows(team.organization.id);
    const byInstagramId = new Map(rows.map((row) => [row.instagram_user_id, row]));
    expect(byInstagramId.get(kept.id)?.connection_status).toBe('connected');
    expect(byInstagramId.get(missing.id)?.connection_status).toBe('error');
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('connected');
    const jobs = await noticeJobs();
    expect(jobs.map((job) => job.data.instagramAccountPublicId)).toEqual([
      byInstagramId.get(missing.id)?.public_id,
    ]);
    const stops = await readStops();
    expect(stops.map((stop) => stop.reason)).toEqual(['account_not_shared']);
    expect(stops.every((stop) => stop.ended_at === null)).toBe(true);
  });

  it('Meta refusing the token breaks the connection and every account, one notice each (AC-1.14, AC-10.7)', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(400, TOKEN_REFUSED);

    await expect(runCheck(channelConnectionPublicId)).resolves.toEqual({
      outcome: 'broken',
      step: 'assigned_accounts',
      isWinner: true,
      reencrypted: false,
    });

    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('error');
    expect(connection?.last_check_error).toBe('auth (code 190, subcode 460, HTTP 400)');
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status)).toEqual(['error', 'error']);
    const jobs = await noticeJobs();
    expect(jobs.map((job) => job.data.instagramAccountPublicId).sort()).toEqual(
      rows.map((row) => row.public_id).sort(),
    );
    const stops = await readStops();
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.reason === 'login_expired' && stop.ended_at === null)).toBe(
      true,
    );

    // Twice = once: the broken connection is skipped, nobody is told again.
    await expect(runCheck(channelConnectionPublicId)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'not_connected',
    });
    expect(await noticeJobs()).toHaveLength(2);
  });

  it('account #101 on the second page of the assigned list stays connected (P353)', async () => {
    const { channelConnectionPublicId, accounts } = await connectTwoAccounts();
    const [first, second] = accounts as [TestAssignedAccount, TestAssignedAccount];
    const graph = nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query((query) => query.after === undefined)
      .reply(200, {
        data: [{ id: first.id, username: first.username }],
        paging: {
          cursors: { after: 'page-two' },
          next: `${META_GRAPH_BASE_URL}${GRAPH_PATH}/me/assigned_instagram_accounts?after=page-two`,
        },
      })
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query((query) => query.after === 'page-two')
      .reply(200, { data: [{ id: second.id, username: second.username }] });
    mockProfile(first);
    mockProfile(second);

    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'checked',
      refreshedCount: 2,
      missingCount: 0,
    });
    expect(graph.isDone()).toBe(true);
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status)).toEqual(['connected', 'connected']);
    expect(await readStops()).toHaveLength(0);
  });

  it('Meta refusing one account for its type (code 10) breaks that account alone — the connection stays (P354)', async () => {
    const { channelConnectionPublicId, accounts } = await connectTwoAccounts();
    const [personal, business] = accounts as [TestAssignedAccount, TestAssignedAccount];
    mockAssigned(accounts);
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/${personal.id}`)
      .query(true)
      .reply(400, {
        error: {
          message:
            '(#10) Access is denied because the instagram account type is not business or creator.',
          type: 'OAuthException',
          code: 10,
        },
      });
    mockProfile(business);

    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'checked',
      refreshedCount: 1,
      permissionRefusedCount: 1,
    });
    const [connection] = await readChannelConnectionRows(team.organization.id);
    expect(connection?.status).toBe('connected');
    const rows = await readInstagramAccountRows(team.organization.id);
    const byInstagramId = new Map(rows.map((row) => [row.instagram_user_id, row]));
    expect(byInstagramId.get(personal.id)?.connection_status).toBe('error');
    expect(byInstagramId.get(business.id)?.connection_status).toBe('connected');
    expect((await noticeJobs()).map((job) => job.data.instagramAccountPublicId)).toEqual([
      byInstagramId.get(personal.id)?.public_id,
    ]);
    expect((await readStops()).map((stop) => stop.reason)).toEqual(['wrong_permission']);
  });

  it('a token refused at a profile read breaks the connection too', async () => {
    const { channelConnectionPublicId, accounts } = await connectTwoAccounts();
    mockAssigned(accounts);
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/${accounts[0]?.id}`)
      .query(true)
      .reply(400, TOKEN_REFUSED);

    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'broken',
      step: 'profile',
    });
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status)).toEqual(['error', 'error']);
  });

  it('Meta down or too fast changes nothing: the check is deferred to a later sweep', async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    await makeDue();
    const before = await readChannelConnectionRows(team.organization.id);
    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(503, { error: { message: 'Service temporarily unavailable', code: 2 } });

    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'deferred',
      step: 'assigned_accounts',
    });

    nock(META_GRAPH_BASE_URL)
      .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
      .query(true)
      .reply(429, { error: { message: 'Application request limit reached', code: 4 } });
    await expect(runCheck(channelConnectionPublicId)).resolves.toMatchObject({
      outcome: 'deferred',
    });

    const after = await readChannelConnectionRows(team.organization.id);
    expect(after[0]?.status).toBe('connected');
    expect(after[0]?.last_checked_at).toEqual(before[0]?.last_checked_at);
    const rows = await readInstagramAccountRows(team.organization.id);
    expect(rows.map((row) => row.connection_status)).toEqual(['connected', 'connected']);
    expect(await noticeJobs()).toHaveLength(0);
    expect(await readStops()).toHaveLength(0);
  });

  it("never reaches another organization's connection by its public id", async () => {
    const { channelConnectionPublicId } = await connectTwoAccounts();
    const otherTeam = await createInstagramTeam();

    await expect(
      processChannelConnectionTokenCheckJob({
        jobData: {
          organizationPublicId: otherTeam.organization.public_id,
          channelConnectionPublicId,
        },
        services,
        requestId: 'token-check-integration',
      }),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'not_connected' });
  });

  describe('a token still on an old key version (S26)', () => {
    const originalSecretsKeys = process.env.SECRETS_ENCRYPTION_KEYS;
    const originalCurrentVersion = process.env.SECRETS_ENCRYPTION_CURRENT_VERSION;

    function useKeyVersion(version: 'v1' | 'v2'): void {
      process.env.SECRETS_ENCRYPTION_KEYS = JSON.stringify({
        v1: '11'.repeat(32),
        v2: '22'.repeat(32),
      });
      process.env.SECRETS_ENCRYPTION_CURRENT_VERSION = version;
      resetEnvCacheForTests();
    }

    function restoreEnvVar(name: string, original: string | undefined): void {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }

    afterEach(() => {
      restoreEnvVar('SECRETS_ENCRYPTION_KEYS', originalSecretsKeys);
      restoreEnvVar('SECRETS_ENCRYPTION_CURRENT_VERSION', originalCurrentVersion);
      resetEnvCacheForTests();
    });

    it('is re-encrypted onto the current version, and Meta still gets the same token', async () => {
      useKeyVersion('v1');
      const plainToken = 'EAAG-token-check-old-key-version';
      const connection = await insertChannelConnection({
        organizationId: team.organization.id,
        plainToken,
      });
      useKeyVersion('v2');
      const graph = nock(META_GRAPH_BASE_URL, {
        reqheaders: { authorization: `Bearer ${plainToken}` },
      })
        .get(`${GRAPH_PATH}/me/assigned_instagram_accounts`)
        .query(true)
        .reply(200, { data: [] });

      await expect(runCheck(connection.public_id)).resolves.toMatchObject({
        outcome: 'checked',
        reencrypted: true,
      });

      expect(graph.isDone()).toBe(true);
      const [stored] = await readChannelConnectionTokenCiphertexts({
        organizationId: team.organization.id,
        channelConnectionId: connection.id,
      });
      expect(stored?.startsWith('v2:')).toBe(true);
      expect(decryptFieldSecret(stored ?? '')).toBe(plainToken);

      // A second check finds it current and writes nothing.
      mockAssigned([]);
      await expect(runCheck(connection.public_id)).resolves.toMatchObject({ reencrypted: false });
    });
  });
});
