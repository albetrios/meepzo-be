import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { INSTAGRAM_ACCOUNT_SETUP_JOB_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-tasks.queue.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
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
  readInstagramAccountRows,
  readStagedAuditRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  CHANNEL_CONNECTIONS_PATH,
  TEST_META_SYSTEM_USER_TOKEN,
  type TestAssignedAccount,
  channelAccountPickPath,
  channelConnectCallbackPath,
  channelConnectStartPath,
  channelConnectionPath,
  channelReconnectPath,
  connectInstagramAccountsThroughRoutes,
  mockMetaLogin,
  mockMetaPick,
  nextClientBusinessId,
  readChannelConnectionRows,
  readChannelConnectionTokenCiphertexts,
  readChannelConnectionTokenExpiries,
  readStateFromLoginUrl,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertContact,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  readLaneRows,
  readStopRows,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17841${suffix}`, username: `shop.${suffix}` };
}

/** `data` of a JSON answer. */
function dataOf<TData = Record<string, unknown>>(response: InjectHttpResult): TData {
  return (response.json() as { data: TData }).data;
}

/** `error.reason` of an error answer. */
function reasonOf(response: InjectHttpResult): string | undefined {
  return (response.json() as { error?: { reason?: string } }).error?.reason;
}

/**
 * Routes 1–5, 40 and 42 of the channel connection (feat-instagram-dm-sending routes-final § 1,
 * ROUTE R3) over HTTP: the one-use state, the callback's refusals, one connection per business with
 * its encrypted token, the pick under the plan's limit (the organization lock), connected elsewhere
 * and not assigned, the reconnect that moves an account, the list and one read, "Disconnect
 * business", the gates (P59), team-only and idempotency. Meta is mocked with nock; the database,
 * Redis, auth, permissions and idempotency are real.
 */
describe('Channel connection routes', () => {
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

  /** Gives the team the Creator plan (3 accounts). */
  async function useCreatorPlan(organizationId = team.organization.id): Promise<void> {
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({ organizationId, planId: plan.id, status: 'ACTIVE' });
  }

  /** Route 1, answering the state it minted. */
  async function start(token = team.ownerToken): Promise<string> {
    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectStartPath(),
      token,
    });
    expect(response.statusCode, response.body).toBe(200);
    return readStateFromLoginUrl(dataOf<{ login_url: string }>(response).login_url);
  }

  /** Route 2 with a fresh key. */
  function callback({
    state,
    token = team.ownerToken,
    idempotencyKey = `channel-connect:${state}`,
  }: {
    state: string;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectCallbackPath(),
      token,
      payload: { code: 'AQB-test-code#_', state },
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  /** Route 3 with a fresh key. */
  function pick({
    channelConnectionPublicId,
    providerAccountIds,
    token = team.ownerToken,
    idempotencyKey = `pick-${randomUUID()}`,
  }: {
    channelConnectionPublicId: string;
    providerAccountIds: string[];
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: channelAccountPickPath(channelConnectionPublicId),
      token,
      payload: { channel: 'instagram', provider_account_ids: providerAccountIds },
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
    });
  }

  describe('start (route 1) and the callback (route 2)', () => {
    it('answers the Meta login address with a one-use state and its end', async () => {
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: channelConnectStartPath(),
        token: team.ownerToken,
      });
      expect(response.statusCode).toBe(200);
      const data = dataOf<{ login_url: string; state_expires_at: string }>(response);
      const loginUrl = new URL(data.login_url);
      expect(loginUrl.origin + loginUrl.pathname).toBe('https://www.facebook.com/dialog/oauth');
      expect(loginUrl.searchParams.get('prompt')).toBe('login');
      expect(loginUrl.searchParams.get('response_type')).toBe('code');
      expect(loginUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Date(data.state_expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses any provider but meta with 400 provider', async () => {
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: channelConnectStartPath('tiktok'),
        token: team.ownerToken,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain('provider');
    });

    it('stores one connection with its permissions and an encrypted token, and answers the picker (AC-1.3)', async () => {
      const state = await start();
      const assigned = [nextAccount(), nextAccount()];
      const clientBusinessId = nextClientBusinessId();
      mockMetaLogin({
        clientBusinessId,
        assignedAccounts: assigned,
        grantedPermissions: [
          'instagram_basic',
          'instagram_manage_messages',
          'instagram_manage_comments',
          'ads_read',
        ],
      });
      const response = await callback({ state });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(TEST_META_SYSTEM_USER_TOKEN);
      const data = dataOf<{
        is_reconnect: boolean;
        channel_connection: { id: string; status: string; has_ads_access: boolean };
        accounts: Array<{ provider_account_id: string; state: string }>;
        plan_room: { accounts_max: number; accounts_used: number; accounts_free: number };
      }>(response);
      expect(data.is_reconnect).toBe(false);
      expect(data.channel_connection.id).toMatch(/^chc_[a-z0-9]{21}$/);
      expect(data.channel_connection.status).toBe('connected');
      expect(data.channel_connection.has_ads_access).toBe(true);
      expect(data.accounts.map((account) => account.state)).toEqual(['free', 'free']);
      expect(data.plan_room.accounts_used).toBe(0);
      const [row] = await readChannelConnectionRows(team.organization.id);
      expect(row?.client_business_id).toBe(clientBusinessId);
      const [ciphertext] = await readChannelConnectionTokenCiphertexts({
        organizationId: team.organization.id,
      });
      expect(ciphertext).not.toContain(TEST_META_SYSTEM_USER_TOKEN);
      expect(decryptFieldSecret(ciphertext as string)).toBe(TEST_META_SYSTEM_USER_TOKEN);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_connection.connect',
      });
      expect(audit).toHaveLength(1);
    });

    it("stores the start's login configuration and the token's end from Meta's expires_in (P355, P356)", async () => {
      const state = await start();
      const configAtStart = getEnv().META_CONFIG_ID;
      const saved = process.env.META_CONFIG_ID;
      process.env.META_CONFIG_ID = 'config-changed-meanwhile';
      resetEnvCacheForTests();
      try {
        mockMetaLogin({
          clientBusinessId: nextClientBusinessId(),
          assignedAccounts: [nextAccount()],
          expiresInSeconds: 60 * 24 * 60 * 60,
        });
        const before = Date.now();
        const warnings = vi.spyOn(logger, 'warn');
        const response = await callback({ state });
        expect(response.statusCode, response.body).toBe(200);
        const [row] = await readChannelConnectionRows(team.organization.id);
        expect(row?.config_id).toBe(configAtStart);
        // F4 (AF-8): a dated token is flagged at connect, with the configuration and no token.
        const dated = warnings.mock.calls.filter(
          ([, message]) => message === 'app.channel_connection.token_dated',
        );
        expect(dated).toHaveLength(1);
        expect(dated[0]?.[0]).toMatchObject({
          configId: configAtStart,
          channelConnectionPublicId: row?.public_id,
        });
        expect(JSON.stringify(dated[0]?.[0])).not.toContain(TEST_META_SYSTEM_USER_TOKEN);
        warnings.mockRestore();
        const [expiresAt] = await readChannelConnectionTokenExpiries(team.organization.id);
        expect(expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 60 * 24 * 60 * 60 * 1000);
        expect(expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 24 * 60 * 60 * 1000);
      } finally {
        process.env.META_CONFIG_ID = saved;
        resetEnvCacheForTests();
      }
    });

    it("stores the token's Meta system user on connect, updates it on reconnect, and never answers it (F3, AF-6)", async () => {
      const clientBusinessId = nextClientBusinessId();
      const account = nextAccount();
      mockMetaLogin({ clientBusinessId, assignedAccounts: [account], systemUserId: '20001' });
      const first = await callback({ state: await start() });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.body).not.toContain('provider_user_id');
      expect(first.body).not.toContain('20001');
      const [connected] = await readChannelConnectionRows(team.organization.id);
      expect(connected?.provider_user_id).toBe('20001');

      mockMetaLogin({ clientBusinessId, assignedAccounts: [account], systemUserId: '20002' });
      const again = await callback({ state: await start() });
      expect(again.statusCode, again.body).toBe(200);
      const rows = await readChannelConnectionRows(team.organization.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.provider_user_id).toBe('20002');
    });

    it('keeps no end for a token Meta names none for (a configuration whose token never ends)', async () => {
      const state = await start();
      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [nextAccount()],
      });
      const warnings = vi.spyOn(logger, 'warn');
      expect((await callback({ state })).statusCode).toBe(200);
      expect(await readChannelConnectionTokenExpiries(team.organization.id)).toEqual([null]);
      // F4 (AF-8): a never-ending token is not flagged.
      expect(
        warnings.mock.calls.some(([, message]) => message === 'app.channel_connection.token_dated'),
      ).toBe(false);
      warnings.mockRestore();
    });

    it('refuses a used, foreign or unknown state with 400 channel_connect_state_invalid and saves nothing (AC-1.1)', async () => {
      const state = await start();
      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [nextAccount()],
      });
      expect((await callback({ state })).statusCode).toBe(200);
      const used = await callback({ state, idempotencyKey: `again-${randomUUID()}` });
      expect(used.statusCode).toBe(400);
      expect(reasonOf(used)).toBe('channel_connect_state_invalid');

      const adminState = await start(team.adminToken);
      const foreign = await callback({ state: adminState });
      expect(foreign.statusCode).toBe(400);
      expect(reasonOf(foreign)).toBe('channel_connect_state_invalid');

      const unknown = await callback({ state: 'A'.repeat(43) });
      expect(reasonOf(unknown)).toBe('channel_connect_state_invalid');
      expect(await readChannelConnectionRows(team.organization.id)).toHaveLength(1);
    });

    it('refuses a missing required permission with 422 and saves nothing (AC-1.2)', async () => {
      const state = await start();
      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [nextAccount()],
        grantedPermissions: ['instagram_basic'],
      });
      const response = await callback({ state });
      expect(response.statusCode).toBe(422);
      expect(reasonOf(response)).toBe('provider_permissions_missing');
      expect(await readChannelConnectionRows(team.organization.id)).toHaveLength(0);
    });

    it('answers 422 provider_code_invalid when Meta refuses the code', async () => {
      const state = await start();
      mockMetaLogin({ clientBusinessId: '1', assignedAccounts: [], exchange: 'refused' });
      const response = await callback({ state });
      expect(response.statusCode).toBe(422);
      expect(reasonOf(response)).toBe('provider_code_invalid');
    });

    it('requires the idempotency key and replays the first answer (AC-1.16)', async () => {
      const state = await start();
      const missing = await callback({ state, idempotencyKey: null });
      expect(missing.statusCode).toBe(422);

      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [nextAccount()],
      });
      const first = await callback({ state });
      expect(first.statusCode).toBe(200);
      const replay = await callback({ state });
      expect(replay.statusCode).toBe(200);
      expect(dataOf(replay)).toEqual(dataOf(first));
      expect(await readChannelConnectionRows(team.organization.id)).toHaveLength(1);
    });
  });

  describe('the pick (route 3)', () => {
    it('connects the picks, marks one elsewhere and one not assigned, and keeps the others (AC-1.5, AC-1.6, AC-1.7)', async () => {
      await useCreatorPlan();
      const otherTeam = await createInstagramTeam();
      const elsewhere = nextAccount();
      await connectInstagramAccountsThroughRoutes({
        app,
        token: otherTeam.ownerToken,
        accounts: [elsewhere],
      });

      const state = await start();
      const free = nextAccount();
      const gone = nextAccount();
      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [free, elsewhere],
      });
      const connected = await callback({ state });
      const data = dataOf<{
        channel_connection: { id: string };
        accounts: Array<{ provider_account_id: string; state: string }>;
      }>(connected);
      expect(
        data.accounts.find((account) => account.provider_account_id === elsewhere.id)?.state,
      ).toBe('connected_elsewhere');

      mockMetaPick({ assignedAccounts: [free, elsewhere], pickedAccounts: [free] });
      const response = await pick({
        channelConnectionPublicId: data.channel_connection.id,
        providerAccountIds: [free.id, elsewhere.id, gone.id],
      });
      expect(response.statusCode, response.body).toBe(200);
      const results = dataOf<{
        results: Array<{ provider_account_id: string; result: string }>;
        plan_room: { accounts_used: number; accounts_max: number };
      }>(response);
      expect(results.results.map((item) => item.result)).toEqual([
        'connected',
        'connected_elsewhere',
        'not_assigned',
      ]);
      expect(results.plan_room).toMatchObject({ accounts_used: 1, accounts_max: 3 });
      const rows = await readInstagramAccountRows(team.organization.id);
      expect(rows.map((row) => row.instagram_user_id)).toEqual([free.id]);
      // AC-1.7 (R40): the set-up at Meta is an `instagram-account-setup` task after the commit —
      // until it runs the account stays connected and shown as not subscribed.
      expect(rows[0]?.webhook_subscribed_at).toBeNull();
      expect(rows[0]?.connection_status).toBe('connected');
      const tasksQueue = new Queue(INSTAGRAM_TASKS_QUEUE_NAME, {
        connection: getBullMQConnectionOptions(),
        prefix: getBullMQKeyPrefix(),
      });
      try {
        const jobs = await tasksQueue.getJobs(['waiting', 'delayed', 'prioritized']);
        expect(
          jobs
            .filter((job) => job.name === INSTAGRAM_ACCOUNT_SETUP_JOB_NAME)
            .map((job) => job.data.taskInput?.channelAccountPublicId),
        ).toContain(rows[0]?.public_id);
      } finally {
        await tasksQueue.close();
      }
      const settings = await operatorQuery<Array<{ id: string }>>`
        SELECT id FROM app.instagram_account_settings WHERE organization_id = ${team.organization.id}`;
      expect(settings).toHaveLength(1);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_account.connect',
      });
      expect(audit).toHaveLength(1);
    });

    it('refuses picks over the plan limit with 409 plan_account_limit and saves nothing (AC-1.4)', async () => {
      const state = await start();
      const assigned = [nextAccount(), nextAccount()];
      mockMetaLogin({ clientBusinessId: nextClientBusinessId(), assignedAccounts: assigned });
      const connection = dataOf<{ channel_connection: { id: string } }>(await callback({ state }))
        .channel_connection.id;
      mockMetaPick({ assignedAccounts: assigned, pickedAccounts: assigned, subscription: 'none' });
      const response = await pick({
        channelConnectionPublicId: connection,
        providerAccountIds: assigned.map((account) => account.id),
      });
      expect(response.statusCode).toBe(409);
      expect(reasonOf(response)).toBe('plan_account_limit');
      // The plan refusal contract (P269): Free's one account, none connected yet.
      expect((response.json() as { error: object }).error).toMatchObject({
        limit: 1,
        used: 0,
        upgrade_required: true,
      });
      expect(await readInstagramAccountRows(team.organization.id)).toHaveLength(0);
    });

    it('lets only one of two racing picks pass the limit (the organization lock, AC-1.4)', async () => {
      const state = await start();
      const first = nextAccount();
      const second = nextAccount();
      mockMetaLogin({
        clientBusinessId: nextClientBusinessId(),
        assignedAccounts: [first, second],
      });
      const connection = dataOf<{ channel_connection: { id: string } }>(await callback({ state }))
        .channel_connection.id;
      nock.cleanAll();
      // Both picks read the same assigned list and one profile each.
      mockMetaPick({
        assignedAccounts: [first, second],
        pickedAccounts: [first],
        subscription: 'none',
      });
      mockMetaPick({
        assignedAccounts: [first, second],
        pickedAccounts: [second],
        subscription: 'none',
      });
      nock(/graph\.facebook\.com/)
        .persist()
        .post(/subscribed_apps/)
        .query(true)
        .reply(200, { success: true });
      const answers = await Promise.all([
        pick({ channelConnectionPublicId: connection, providerAccountIds: [first.id] }),
        pick({ channelConnectionPublicId: connection, providerAccountIds: [second.id] }),
      ]);
      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
      const live = (await readInstagramAccountRows(team.organization.id)).filter(
        (row) => row.connection_status !== 'revoked',
      );
      expect(live).toHaveLength(1);
    });

    it('lets only one of two organizations picking the same account at the same moment connect it: the other 409 instagram_account_connected_elsewhere (MC7)', async () => {
      const otherTeam = await createInstagramTeam();
      const shared = nextAccount();
      const connectionOf = async (token: string) => {
        const state = await start(token);
        mockMetaLogin({ clientBusinessId: nextClientBusinessId(), assignedAccounts: [shared] });
        const response = await callback({ state, token });
        expect(response.statusCode, response.body).toBe(200);
        return dataOf<{ channel_connection: { id: string } }>(response).channel_connection.id;
      };
      const ours = await connectionOf(team.ownerToken);
      const theirs = await connectionOf(otherTeam.ownerToken);
      nock.cleanAll();
      // Both picks read "not live elsewhere" before either commits: each profile read is held.
      for (let index = 0; index < 2; index += 1) {
        mockMetaPick({
          assignedAccounts: [shared],
          pickedAccounts: [shared],
          subscription: 'none',
          profileDelayMilliseconds: 500,
        });
      }
      nock(/graph\.facebook\.com/)
        .persist()
        .post(/subscribed_apps/)
        .query(true)
        .reply(200, { success: true });
      const answers = await Promise.all([
        pick({ channelConnectionPublicId: ours, providerAccountIds: [shared.id] }),
        pick({
          channelConnectionPublicId: theirs,
          providerAccountIds: [shared.id],
          token: otherTeam.ownerToken,
        }),
      ]);
      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
      const won = answers.find((answer) => answer.statusCode === 200)!;
      const lost = answers.find((answer) => answer.statusCode === 409)!;
      expect(
        dataOf<{ results: Array<{ result: string }> }>(won).results.map((item) => item.result),
      ).toEqual(['connected']);
      expect(reasonOf(lost)).toBe('instagram_account_connected_elsewhere');
      const live = [
        ...(await readInstagramAccountRows(team.organization.id)),
        ...(await readInstagramAccountRows(otherTeam.organization.id)),
      ].filter((row) => row.connection_status !== 'revoked');
      expect(live.map((row) => row.instagram_user_id)).toEqual([shared.id]);
    });

    it('answers already_connected for an account already here, and requires the key (AC-1.16)', async () => {
      const account = nextAccount();
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [account],
      });
      const missing = await pick({
        channelConnectionPublicId,
        providerAccountIds: [account.id],
        idempotencyKey: null,
      });
      expect(missing.statusCode).toBe(422);
      mockMetaPick({
        assignedAccounts: [account],
        pickedAccounts: [account],
        subscription: 'none',
      });
      const again = await pick({ channelConnectionPublicId, providerAccountIds: [account.id] });
      expect(again.statusCode).toBe(200);
      expect(dataOf<{ results: Array<{ result: string }> }>(again).results[0]?.result).toBe(
        'already_connected',
      );
    });

    it('refuses a malformed body and an unknown connection', async () => {
      const malformed = await injectAuthenticated(app, {
        method: 'POST',
        url: channelAccountPickPath('chc_000000000000000000000'),
        token: team.ownerToken,
        payload: { channel: 'instagram', provider_account_ids: ['1', '1'] },
        headers: { 'x-idempotency-key': `pick-${randomUUID()}` },
      });
      expect(malformed.statusCode).toBe(400);
      const unknown = await pick({
        channelConnectionPublicId: 'chc_000000000000000000000',
        providerAccountIds: ['1'],
      });
      expect(unknown.statusCode).toBe(404);
      expect(reasonOf(unknown)).toBe('channel_connection_not_found');
    });
  });

  describe('reconnect (routes 40 and 2)', () => {
    it('puts an error connection back, reconnects its account, and refuses another business (AC-1.8)', async () => {
      const account = nextAccount();
      const { channelConnectionPublicId, clientBusinessId } =
        await connectInstagramAccountsThroughRoutes({
          app,
          token: team.ownerToken,
          accounts: [account],
        });
      await operatorQuery`
        UPDATE app.channel_connections SET status = 'error' WHERE public_id = ${channelConnectionPublicId}`;
      await operatorQuery`
        UPDATE app.channel_accounts SET connection_status = 'error'
        WHERE organization_id = ${team.organization.id}`;

      const mismatchStart = await injectAuthenticated(app, {
        method: 'POST',
        url: channelReconnectPath(channelConnectionPublicId),
        token: team.ownerToken,
      });
      expect(mismatchStart.statusCode).toBe(200);
      const mismatchState = readStateFromLoginUrl(
        dataOf<{ login_url: string }>(mismatchStart).login_url,
      );
      mockMetaLogin({ clientBusinessId: nextClientBusinessId(), assignedAccounts: [account] });
      const mismatch = await callback({ state: mismatchState });
      expect(mismatch.statusCode).toBe(409);
      expect(reasonOf(mismatch)).toBe('channel_connection_business_mismatch');

      const reconnectStart = await injectAuthenticated(app, {
        method: 'POST',
        url: channelReconnectPath(channelConnectionPublicId),
        token: team.ownerToken,
      });
      const state = readStateFromLoginUrl(dataOf<{ login_url: string }>(reconnectStart).login_url);
      mockMetaLogin({ clientBusinessId, assignedAccounts: [account] });
      const response = await callback({ state });
      expect(response.statusCode, response.body).toBe(200);
      const data = dataOf<{
        is_reconnect: boolean;
        channel_connection: { status: string };
        reconnected_account_ids: string[];
      }>(response);
      expect(data.is_reconnect).toBe(true);
      expect(data.channel_connection.status).toBe('connected');
      expect(data.reconnected_account_ids).toHaveLength(1);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it('moves an account that moved to another portfolio, and revokes the emptied connection (AC-1.9)', async () => {
      const account = nextAccount();
      const { channelConnectionPublicId: oldConnection } =
        await connectInstagramAccountsThroughRoutes({
          app,
          token: team.ownerToken,
          accounts: [account],
        });
      const state = await start();
      mockMetaLogin({ clientBusinessId: nextClientBusinessId(), assignedAccounts: [account] });
      const response = await callback({ state });
      expect(response.statusCode, response.body).toBe(200);
      const newConnection = dataOf<{
        channel_connection: { id: string; channel_accounts: Array<{ id: string }> };
        reconnected_account_ids: string[];
      }>(response);
      expect(newConnection.reconnected_account_ids).toHaveLength(1);
      expect(newConnection.channel_connection.channel_accounts).toHaveLength(1);
      const rows = await readChannelConnectionRows(team.organization.id);
      expect(rows.find((row) => row.public_id === oldConnection)?.status).toBe('revoked');
      const ciphertexts = await readChannelConnectionTokenCiphertexts({
        organizationId: team.organization.id,
      });
      expect(ciphertexts).toHaveLength(1);
    });

    it('answers 404 for a revoked connection', async () => {
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [nextAccount()],
      });
      await operatorQuery`
        UPDATE app.channel_connections SET status = 'revoked', disconnected_at = now()
        WHERE public_id = ${channelConnectionPublicId}`;
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: channelReconnectPath(channelConnectionPublicId),
        token: team.ownerToken,
      });
      expect(response.statusCode).toBe(404);
      expect(reasonOf(response)).toBe('channel_connection_not_found');
    });
  });

  describe('list, read and disconnect (routes 4, 42, 5)', () => {
    it('lists the connections with their accounts, never a token; reads one; another organization reads 404', async () => {
      const account = nextAccount();
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [account],
      });
      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: CHANNEL_CONNECTIONS_PATH,
        token: team.viewerToken,
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain('encrypted_access_token');
      const connections =
        dataOf<
          Array<{ id: string; channel_accounts: Array<{ channel: string; display_name: string }> }>
        >(list);
      expect(connections).toHaveLength(1);
      expect(connections[0]?.channel_accounts[0]).toMatchObject({
        channel: 'instagram',
        display_name: `@${account.username}`,
      });

      const one = await injectAuthenticated(app, {
        method: 'GET',
        url: channelConnectionPath(channelConnectionPublicId),
        token: team.editorToken,
      });
      expect(one.statusCode).toBe(200);

      const otherTeam = await createInstagramTeam();
      const foreign = await injectAuthenticated(app, {
        method: 'GET',
        url: channelConnectionPath(channelConnectionPublicId),
        token: otherTeam.ownerToken,
      });
      expect(foreign.statusCode).toBe(404);
      expect(reasonOf(foreign)).toBe('channel_connection_not_found');
    });

    it('disconnects the business: accounts revoked, token erased, the list hides it; a repeat is 404 (AC-1.10)', async () => {
      const accounts = [nextAccount()];
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts,
      });
      nock('https://graph.facebook.com')
        .delete(/subscribed_apps/)
        .query(true)
        .reply(200, { success: true });
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelConnectionPath(channelConnectionPublicId),
        token: team.ownerToken,
      });
      expect(response.statusCode).toBe(204);
      const rows = await readInstagramAccountRows(team.organization.id);
      expect(rows.every((row) => row.connection_status === 'revoked')).toBe(true);
      expect(
        await readChannelConnectionTokenCiphertexts({ organizationId: team.organization.id }),
      ).toHaveLength(0);
      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: CHANNEL_CONNECTIONS_PATH,
        token: team.ownerToken,
      });
      expect(dataOf<unknown[]>(list)).toHaveLength(0);
      const withRevoked = await injectAuthenticated(app, {
        method: 'GET',
        url: `${CHANNEL_CONNECTIONS_PATH}?include_revoked=true`,
        token: team.ownerToken,
      });
      expect(dataOf<Array<{ status: string }>>(withRevoked)[0]?.status).toBe('revoked');
      const repeat = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelConnectionPath(channelConnectionPublicId),
        token: team.ownerToken,
      });
      expect(repeat.statusCode).toBe(404);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_connection.disconnect',
      });
      expect(audit).toHaveLength(1);
    });

    it("stops every account's sending lanes and keeps their automations, contacts and history (AC-1.10, MC8)", async () => {
      await useCreatorPlan();
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [nextAccount(), nextAccount()],
      });
      const organizationId = team.organization.id;
      const accounts = await readInstagramAccountRows(organizationId);
      expect(accounts).toHaveLength(2);
      const kept = [];
      for (const account of accounts) {
        const channelAccountId = Number(account.channel_account_id);
        // The pick left four ready lanes (SN12).
        expect((await readLaneRows(channelAccountId)).map((lane) => lane.state)).toEqual([
          'ready',
          'ready',
          'ready',
          'ready',
        ]);
        const automation = await insertAutomation({
          organizationId,
          instagramAccountId: Number(account.id),
          status: 'live',
        });
        const contact = await insertContact({
          organizationId,
          instagramAccountId: Number(account.id),
          tags: ['vip'],
          note: 'Asked about the spring sale',
        });
        const run = await insertAutomationRun({
          organizationId,
          automationId: automation.id,
          contactId: contact.id,
        });
        // An ended stop of the account's sending history (SN13).
        await operatorQuery`
          INSERT INTO app.instagram_send_stops
            (organization_id, channel_account_id, lane, reason, started_at, ended_at, ended_by)
          VALUES (${organizationId}, ${channelAccountId}, 'fast', 'too_fast',
                  now() - interval '2 hours', now() - interval '1 hour', 'time')`;
        kept.push({
          channelAccountId,
          automation: await readAutomationRow(automation.public_id),
          contact: await readContactRow(contact.id),
          run: await readRunRow(run.id),
          stops: await readStopRows(channelAccountId),
        });
      }
      nock('https://graph.facebook.com')
        .delete(/subscribed_apps/)
        .query(true)
        .times(2)
        .reply(200, { success: true });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: channelConnectionPath(channelConnectionPublicId),
        token: team.ownerToken,
      });

      expect(response.statusCode, response.body).toBe(204);
      expect(
        (await readInstagramAccountRows(organizationId)).map((row) => row.connection_status),
      ).toEqual(['revoked', 'revoked']);
      expect(await readChannelConnectionTokenCiphertexts({ organizationId })).toHaveLength(0);
      for (const account of kept) {
        const lanes = await readLaneRows(account.channelAccountId);
        expect(lanes).toHaveLength(4);
        for (const lane of lanes) {
          expect(lane).toMatchObject({ state: 'stopped', working_turn: null, next_run_at: null });
        }
        expect(await readAutomationRow(account.automation?.public_id ?? '')).toEqual(
          account.automation,
        );
        expect(await readContactRow(account.contact?.id ?? 0)).toEqual(account.contact);
        expect(await readRunRow(account.run?.id ?? 0)).toEqual(account.run);
        expect(await readStopRows(account.channelAccountId)).toEqual(account.stops);
      }
    });
  });

  describe("another organization's connection (BOLA)", () => {
    it('reads, reconnects, picks and disconnects nothing of another organization: 404, the row unchanged', async () => {
      const { channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
        app,
        token: team.ownerToken,
        accounts: [nextAccount()],
      });
      const otherTeam = await createInstagramTeam();
      const attempts = await Promise.all([
        injectAuthenticated(app, {
          method: 'GET',
          url: channelConnectionPath(channelConnectionPublicId),
          token: otherTeam.ownerToken,
        }),
        injectAuthenticated(app, {
          method: 'POST',
          url: channelReconnectPath(channelConnectionPublicId),
          token: otherTeam.ownerToken,
        }),
        pick({
          channelConnectionPublicId,
          providerAccountIds: ['17841400000000001'],
          token: otherTeam.ownerToken,
        }),
        injectAuthenticated(app, {
          method: 'DELETE',
          url: channelConnectionPath(channelConnectionPublicId),
          token: otherTeam.ownerToken,
        }),
      ]);
      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(reasonOf(attempt)).toBe('channel_connection_not_found');
      }
      const [row] = await readChannelConnectionRows(team.organization.id);
      expect(row?.status).toBe('connected');
      expect(
        await readChannelConnectionTokenCiphertexts({ organizationId: team.organization.id }),
      ).toHaveLength(1);
    });

    it("refuses a state another organization's Owner started, and saves nothing", async () => {
      const otherTeam = await createInstagramTeam();
      const foreignState = await start(otherTeam.ownerToken);
      const response = await callback({ state: foreignState });
      expect(response.statusCode).toBe(400);
      expect(reasonOf(response)).toBe('channel_connect_state_invalid');
      expect(await readChannelConnectionRows(team.organization.id)).toHaveLength(0);
      expect(await readChannelConnectionRows(otherTeam.organization.id)).toHaveLength(0);
    });
  });

  describe('gates and team-only (P59, K1)', () => {
    it('lets an Editor and a Viewer read and refuses them every write with missing_permission (AC-1.15)', async () => {
      for (const token of [team.editorToken, team.viewerToken]) {
        const list = await injectAuthenticated(app, {
          method: 'GET',
          url: CHANNEL_CONNECTIONS_PATH,
          token,
        });
        expect(list.statusCode).toBe(200);
        const writes = await Promise.all([
          injectAuthenticated(app, { method: 'POST', url: channelConnectStartPath(), token }),
          injectAuthenticated(app, {
            method: 'POST',
            url: channelConnectCallbackPath(),
            token,
            payload: { code: 'x', state: 'A'.repeat(43) },
            headers: { 'x-idempotency-key': `k-${randomUUID()}` },
          }),
          injectAuthenticated(app, {
            method: 'POST',
            url: channelReconnectPath('chc_000000000000000000000'),
            token,
          }),
          injectAuthenticated(app, {
            method: 'POST',
            url: channelAccountPickPath('chc_000000000000000000000'),
            token,
            payload: { channel: 'instagram', provider_account_ids: ['1'] },
            headers: { 'x-idempotency-key': `k-${randomUUID()}` },
          }),
          injectAuthenticated(app, {
            method: 'DELETE',
            url: channelConnectionPath('chc_000000000000000000000'),
            token,
          }),
        ]);
        for (const write of writes) {
          expect(write.statusCode).toBe(403);
          expect(reasonOf(write)).toBe('missing_permission');
        }
      }
    });

    it('refuses a personal organization: 422 on a write, 404 team_organization_required on a read', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [
          APP_PERMISSIONS.CHANNEL_ACCOUNT_READ,
          APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE,
        ],
      });
      const write = await injectAuthenticated(app, {
        method: 'POST',
        url: channelConnectStartPath(),
        token: personal.token,
      });
      expect(write.statusCode).toBe(422);
      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: CHANNEL_CONNECTIONS_PATH,
        token: personal.token,
      });
      expect(read.statusCode).toBe(404);
      expect(reasonOf(read)).toBe('team_organization_required');
    });
  });
});
