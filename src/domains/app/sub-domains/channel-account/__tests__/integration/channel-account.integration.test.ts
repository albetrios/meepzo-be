import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { getPostgresConstraintName } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { CHANNEL_ACCOUNT_UNIQUE_INDEXES } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { env } from '@/shared/config/env.config.js';
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
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endPaidPlanWithoutPaying,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readStagedAuditRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type TestAssignedAccount,
  connectInstagramAccountsThroughRoutes,
  readChannelConnectionRows,
  readChannelConnectionTokenCiphertexts,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  CHANNEL_ACCOUNTS_PATH,
  channelAccountActionPath,
  channelAccountPath,
  readChannelAccountRows,
} from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  AUTOMATIONS_PATH,
  automationActionPath,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  readLaneRows,
  readStopRows,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';

let accountSequence = 0;

/** A fresh assigned Instagram account (unique per call). */
function nextAccount(): TestAssignedAccount {
  accountSequence += 1;
  const suffix = `${Date.now()}${accountSequence}`.slice(-11).padStart(11, '0');
  return { id: `17842${suffix}`, username: `store.${suffix}` };
}

/** `data` of a JSON answer. */
function dataOf<TData = Record<string, unknown>>(response: InjectHttpResult): TData {
  return (response.json() as { data: TData }).data;
}

/** `error` of an error answer. */
function errorOf(response: InjectHttpResult): {
  reason?: string;
  errors?: Array<{ field: string }>;
} {
  return (response.json() as { error: { reason?: string; errors?: Array<{ field: string }> } })
    .error;
}

/** The Channel account object's keys this suite reads. */
interface ChannelAccountAnswer {
  id: string;
  channel: string;
  display_name: string;
  connection_status: string;
  is_paused: boolean;
  is_in_plan: boolean;
  plan_stop_reason: string | null;
  channel_connection: { id: string; provider: string; status: string };
  instagram: { instagram_user_id: string; settings: Record<string, unknown> } | null;
}

/**
 * Routes 6–11 of the channel account (feat-instagram-dm-sending routes-final § 1B, ROUTE R5) over
 * HTTP: every success and error of 1B.9, the gates (AC-2.10), team-only (CA6), another
 * organization's account (AC-2.1), the disconnect that keeps the token while another account uses
 * the connection and erases it with the last (AC-2.4), a revoked account brought back by a pick with
 * its settings (AC-2.5), pause and resume, the swap at the limit and two swaps racing (CA9), the
 * audit entries (AC-2.11). Meta is mocked with nock; the database, Redis, auth, permissions and
 * idempotency are real.
 */
describe('Channel account routes', () => {
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

  /** Gives the organization the Creator plan (3 accounts). */
  async function useCreatorPlan(organizationId = team.organization.id): Promise<void> {
    const plan = await createTestPlan({
      features: CREATOR_PLAN_FEATURES,
      priceMonthly: '29.00',
      priceYearly: '276.00',
    });
    await createTestSubscription({ organizationId, planId: plan.id, status: 'ACTIVE' });
  }

  /** Connects `accounts` through one connection (routes 1–3) and answers their `cha_` ids, in order. */
  async function connect(
    accounts: TestAssignedAccount[],
    fixture: InstagramTeamFixture = team,
  ): Promise<{ ids: string[]; channelConnectionPublicId: string }> {
    const { pick, channelConnectionPublicId } = await connectInstagramAccountsThroughRoutes({
      app,
      token: fixture.ownerToken,
      accounts,
    });
    const results = pick.results as Array<{ channel_account: { id: string } | null }>;
    return {
      ids: results.map((result) => result.channel_account?.id ?? ''),
      channelConnectionPublicId,
    };
  }

  function read(channelAccountPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, { url: channelAccountPath(channelAccountPublicId), token });
  }

  function disconnect(channelAccountPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: channelAccountPath(channelAccountPublicId),
      token,
    });
  }

  function act({
    channelAccountPublicId,
    action,
    token = team.ownerToken,
    payload,
    idempotencyKey,
  }: {
    channelAccountPublicId: string;
    action: 'pause' | 'resume' | 'activate';
    token?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }) {
    const key = idempotencyKey === undefined ? `activate-${randomUUID()}` : idempotencyKey;
    return injectAuthenticated(app, {
      method: 'POST',
      url: channelAccountActionPath({ channelAccountPublicId, action }),
      token,
      ...(payload === undefined ? {} : { payload }),
      ...(action === 'activate' && key !== null ? { headers: { 'x-idempotency-key': key } } : {}),
    });
  }

  /** Puts an account "not in your plan" (D57) as a move down would. */
  async function markNotInPlan(channelAccountPublicId: string): Promise<void> {
    await operatorQuery`
      UPDATE app.channel_accounts SET plan_stop_reason = 'plan_downgrade', plan_stopped_at = now()
      WHERE public_id = ${channelAccountPublicId}`;
  }

  describe('GET /app/social/channel-accounts (route 6)', () => {
    it('lists the not-revoked accounts oldest first, an Editor and a Viewer included (AC-2.1, AC-2.10)', async () => {
      await useCreatorPlan();
      const first = nextAccount();
      const second = nextAccount();
      const { ids, channelConnectionPublicId } = await connect([first, second]);

      for (const token of [team.ownerToken, team.editorToken, team.viewerToken]) {
        const response = await injectAuthenticated(app, { url: CHANNEL_ACCOUNTS_PATH, token });
        expect(response.statusCode, response.body).toBe(200);
        const data = dataOf<Array<Record<string, unknown>>>(response);
        expect(data.map((row) => row.id)).toEqual(ids);
        expect(data[0]).toMatchObject({
          channel: 'instagram',
          display_name: `@${first.username}`,
          connection_status: 'connected',
          channel_connection_id: channelConnectionPublicId,
          is_paused: false,
          is_suspended: false,
          is_in_plan: true,
          is_automation_enabled: true,
          has_sending_stop: false,
        });
      }
    });

    it('filters by channel and refuses an unknown one with 400 channel', async () => {
      await connect([nextAccount()]);
      const filtered = await injectAuthenticated(app, {
        url: `${CHANNEL_ACCOUNTS_PATH}?channel=instagram`,
        token: team.ownerToken,
      });
      expect(dataOf<unknown[]>(filtered)).toHaveLength(1);

      const refused = await injectAuthenticated(app, {
        url: `${CHANNEL_ACCOUNTS_PATH}?channel=instagram,whatsapp`,
        token: team.ownerToken,
      });
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused).errors?.map((error) => error.field)).toEqual(['channel']);
    });

    it('answers 404 team_organization_required on a personal organization', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [
          APP_PERMISSIONS.CHANNEL_ACCOUNT_READ,
          APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE,
        ],
      });
      const response = await injectAuthenticated(app, {
        url: CHANNEL_ACCOUNTS_PATH,
        token: personal.token,
      });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });
  });

  describe('GET /app/social/channel-accounts/{channel_account_id} (route 7)', () => {
    it('answers the account with its connection and Instagram part — never the token', async () => {
      const account = nextAccount();
      const { ids, channelConnectionPublicId } = await connect([account]);

      const response = await read(ids[0] ?? '', team.viewerToken);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const data = dataOf<ChannelAccountAnswer>(response);
      expect(data).toMatchObject({
        id: ids[0],
        channel: 'instagram',
        display_name: `@${account.username}`,
        connection_status: 'connected',
        is_paused: false,
        is_in_plan: true,
        plan_stop_reason: null,
        channel_connection: {
          id: channelConnectionPublicId,
          provider: 'meta',
          status: 'connected',
        },
        instagram: { instagram_user_id: account.id },
      });
      expect(data.id).toMatch(/^cha_[a-z0-9]{21}$/);
      expect(data.instagram?.settings).toMatchObject({ is_automation_enabled: true });
    });

    it('shows the Instagram extension of 2.A.6 and flags a private account (AC-2.1, AC-2.12)', async () => {
      const account = nextAccount();
      const { ids } = await connect([account]);
      // The set-up task (WC-30, R40) stamps the subscription in the worker; stamped here.
      await operatorQuery`
        UPDATE app.instagram_accounts SET is_private = true, account_type = 'creator',
          webhook_subscribed_at = now()
        WHERE instagram_user_id = ${account.id}`;

      const data = dataOf<ChannelAccountAnswer>(await read(ids[0] ?? '', team.viewerToken));

      expect(data.instagram).toMatchObject({
        instagram_user_id: account.id,
        username: account.username,
        account_type: 'creator',
        is_private: true,
        followers_count: expect.any(Number),
        starter_questions_set_at: null,
        is_webhook_subscribed: true,
      });
      expect(Object.keys(data.instagram ?? {}).sort()).toEqual(
        [
          'account_type',
          'followers_count',
          'instagram_user_id',
          'is_private',
          'is_webhook_subscribed',
          'profile_picture_url',
          'profile_synced_at',
          'settings',
          'starter_questions_set_at',
          'username',
        ].sort(),
      );
    });

    it("answers 404 channel_account_not_found for another organization's account and a malformed id 400", async () => {
      const otherTeam = await createInstagramTeam();
      const { ids } = await connect([nextAccount()], otherTeam);

      const foreign = await read(ids[0] ?? '');
      expect(foreign.statusCode).toBe(404);
      expect(errorOf(foreign).reason).toBe('channel_account_not_found');

      const malformed = await read('not-an-id');
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe('DELETE /app/social/channel-accounts/{channel_account_id} (route 8)', () => {
    it('keeps the token while another account uses the connection and erases it with the last (AC-2.4, AC-2.11)', async () => {
      await useCreatorPlan();
      const first = nextAccount();
      const second = nextAccount();
      const { ids } = await connect([first, second]);

      // The starter questions removed before the commit (WC-31, AC-2.4, R40).
      const firstStarterRemoval = nock(META_GRAPH_BASE_URL)
        .delete(`/${META_GRAPH_VERSION}/${first.id}/messenger_profile`, {
          fields: ['ice_breakers'],
        })
        .query(true)
        .reply(200, { result: 'success' });
      mockInstagramUnsubscribe({ instagramUserId: first.id });
      expect((await disconnect(ids[0] ?? '')).statusCode).toBe(204);
      expect(firstStarterRemoval.isDone()).toBe(true);
      expect(
        await readChannelConnectionTokenCiphertexts({ organizationId: team.organization.id }),
      ).toHaveLength(1);
      expect((await readChannelConnectionRows(team.organization.id))[0]?.status).toBe('connected');

      // The starter questions removed before the commit (WC-31, AC-2.4, R40).
      const secondStarterRemoval = nock(META_GRAPH_BASE_URL)
        .delete(`/${META_GRAPH_VERSION}/${second.id}/messenger_profile`, {
          fields: ['ice_breakers'],
        })
        .query(true)
        .reply(200, { result: 'success' });
      mockInstagramUnsubscribe({ instagramUserId: second.id });
      expect((await disconnect(ids[1] ?? '')).statusCode).toBe(204);
      expect(secondStarterRemoval.isDone()).toBe(true);
      expect(
        await readChannelConnectionTokenCiphertexts({ organizationId: team.organization.id }),
      ).toHaveLength(0);
      expect((await readChannelConnectionRows(team.organization.id))[0]?.status).toBe('revoked');

      const rows = await readChannelAccountRows(team.organization.id);
      expect(rows.map((row) => row.connection_status)).toEqual(['revoked', 'revoked']);
      expect(
        (await readInstagramAccountRows(team.organization.id)).map((row) => row.connection_status),
      ).toEqual(['revoked', 'revoked']);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_account.disconnect',
      });
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'channel_account',
        metadata: {
          channel_account_public_id: ids[0],
          old_value: { connection_status: 'connected' },
          new_value: { connection_status: 'revoked' },
        },
      });
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('answers 404 on a repeat, and a new pick brings the account back with its settings (AC-2.5)', async () => {
      const account = nextAccount();
      const { ids } = await connect([account]);
      await operatorQuery`
        UPDATE app.instagram_account_settings SET person_hour_limit = 40
        WHERE organization_id = ${team.organization.id}`;
      mockInstagramUnsubscribe({ instagramUserId: account.id });
      expect((await disconnect(ids[0] ?? '')).statusCode).toBe(204);
      const repeat = await disconnect(ids[0] ?? '');
      expect(repeat.statusCode).toBe(404);
      expect(errorOf(repeat).reason).toBe('channel_account_not_found');
      expect((await read(ids[0] ?? '')).statusCode).toBe(404);

      const { ids: again } = await connect([account]);
      expect(again[0]).toBe(ids[0]);
      const back = dataOf<ChannelAccountAnswer>(await read(again[0] ?? ''));
      expect(back.connection_status).toBe('connected');
      expect(back.instagram?.settings).toMatchObject({ person_hour_limit: 40 });
    });

    it('still disconnects when the unsubscribe fails', async () => {
      const account = nextAccount();
      const { ids } = await connect([account]);
      mockInstagramUnsubscribe({ instagramUserId: account.id, outcome: 'failure' });
      expect((await disconnect(ids[0] ?? '')).statusCode).toBe(204);
      expect((await readChannelAccountRows(team.organization.id))[0]?.connection_status).toBe(
        'revoked',
      );
    });
  });

  describe('the gates (AC-2.10) and team-only (CA6)', () => {
    it('refuses an Editor and a Viewer every write with 403 missing_permission', async () => {
      const { ids } = await connect([nextAccount()]);
      const id = ids[0] ?? '';
      for (const token of [team.editorToken, team.viewerToken]) {
        const responses = [
          await disconnect(id, token),
          await act({ channelAccountPublicId: id, action: 'pause', token }),
          await act({ channelAccountPublicId: id, action: 'resume', token }),
          await act({ channelAccountPublicId: id, action: 'activate', token }),
        ];
        for (const response of responses) {
          expect(response.statusCode).toBe(403);
          expect(errorOf(response).reason).toBe('missing_permission');
        }
      }
      expect((await readChannelAccountRows(team.organization.id))[0]).toMatchObject({
        connection_status: 'connected',
        paused_at: null,
      });
    });

    it("answers 404 channel_account_not_found to every write on another organization's account and changes nothing", async () => {
      const otherTeam = await createInstagramTeam();
      const { ids } = await connect([nextAccount()], otherTeam);
      const foreign = ids[0] ?? '';
      await markNotInPlan(foreign);
      const responses = [
        await disconnect(foreign),
        await act({ channelAccountPublicId: foreign, action: 'pause' }),
        await act({ channelAccountPublicId: foreign, action: 'resume' }),
        await act({ channelAccountPublicId: foreign, action: 'activate' }),
      ];
      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(errorOf(response).reason).toBe('channel_account_not_found');
      }
      expect((await readChannelAccountRows(otherTeam.organization.id))[0]).toMatchObject({
        connection_status: 'connected',
        paused_at: null,
        plan_stop_reason: 'plan_downgrade',
      });
    });

    it('answers 422 to a write from a personal organization', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [APP_PERMISSIONS.CHANNEL_ACCOUNT_MANAGE],
      });
      const response = await act({
        channelAccountPublicId: `cha_${'0'.repeat(21)}`,
        action: 'pause',
        token: personal.token,
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('pause and resume (routes 9, 10)', () => {
    it('pauses once, answers the same on a repeat, and resume clears only the pause (CA7, AC-2.11)', async () => {
      const { ids } = await connect([nextAccount()]);
      const id = ids[0] ?? '';
      await operatorQuery`
        UPDATE app.channel_accounts SET suspended_at = now() WHERE public_id = ${id}`;

      const paused = await act({ channelAccountPublicId: id, action: 'pause' });
      expect(paused.statusCode, paused.body).toBe(200);
      expect(dataOf<ChannelAccountAnswer>(paused).is_paused).toBe(true);
      const [first] = await readChannelAccountRows(team.organization.id);
      expect(Number(first?.paused_by_user_id)).toBe(team.owner.id);

      const again = await act({ channelAccountPublicId: id, action: 'pause' });
      expect(dataOf<ChannelAccountAnswer>(again).is_paused).toBe(true);
      const [second] = await readChannelAccountRows(team.organization.id);
      expect(second?.paused_at?.toISOString()).toBe(first?.paused_at?.toISOString());

      const resumed = await act({ channelAccountPublicId: id, action: 'resume' });
      expect(resumed.statusCode).toBe(200);
      expect(dataOf<{ is_paused: boolean; is_suspended: boolean }>(resumed)).toMatchObject({
        is_paused: false,
        is_suspended: true,
      });

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_account.pause',
      });
      expect(audit[0]).toMatchObject({
        severity: 'INFO',
        metadata: { old_value: { is_paused: false }, new_value: { is_paused: true } },
      });
      expect(
        await readStagedAuditRows({
          organizationPublicId: team.organization.public_id,
          action: 'app.channel_account.resume',
        }),
      ).toHaveLength(1);
    });

    it('pauses an account in error and refuses a body field with 400', async () => {
      const { ids } = await connect([nextAccount()]);
      const id = ids[0] ?? '';
      await operatorQuery`UPDATE app.channel_accounts SET connection_status = 'error' WHERE public_id = ${id}`;
      expect((await act({ channelAccountPublicId: id, action: 'pause' })).statusCode).toBe(200);
      const refused = await act({
        channelAccountPublicId: id,
        action: 'resume',
        payload: { force: true },
      });
      expect(refused.statusCode).toBe(400);
    });
  });

  describe('a read-only plan (P10, AC-2.9)', () => {
    const enforced = env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING;

    afterEach(() => {
      env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING = enforced;
    });

    it('lets the owner pause, resume and disconnect — the lanes stay, wake, then stop — while other writes are refused', async () => {
      const account = nextAccount();
      const { ids } = await connect([account]);
      const id = ids[0] ?? '';
      const [row] = await readChannelAccountRows(team.organization.id);
      const channelAccountId = Number(row?.id);
      // The plan ended: the account holds `plan_ended` and its lanes are stopped, as R24 leaves it.
      await endPaidPlanWithoutPaying(team.organization.id);
      env.ORGANIZATION_READ_ONLY_ENFORCED_EXCEPT_BILLING = true;
      await operatorQuery`
        UPDATE app.channel_accounts SET plan_stop_reason = 'plan_ended', plan_stopped_at = now()
        WHERE id = ${channelAccountId}`;
      await operatorQuery`
        UPDATE app.instagram_send_lanes SET state = 'stopped', wait_reason = 'stop', next_run_at = NULL
        WHERE channel_account_id = ${channelAccountId}`;
      await operatorQuery`
        INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason)
        VALUES (${team.organization.id}, ${channelAccountId}, 'all', 'plan_ended')`;
      const stopped = await readLaneRows(channelAccountId);
      expect(stopped.map((lane) => lane.state)).toEqual([
        'stopped',
        'stopped',
        'stopped',
        'stopped',
      ]);

      // The plan is read-only: a draft still saves (R13, P10), but its go-live is refused.
      const draft = await injectAuthenticated(app, {
        method: 'POST',
        url: AUTOMATIONS_PATH,
        token: team.ownerToken,
        payload: commentAutomationBody({ channelAccountPublicId: id }),
        headers: { 'x-idempotency-key': `read-only-${randomUUID()}` },
      });
      expect(draft.statusCode, draft.body).toBe(200);
      const refused = await injectAuthenticated(app, {
        method: 'POST',
        url: automationActionPath({
          automationPublicId: dataOf<{ id: string }>(draft).id,
          action: 'go-live',
        }),
        token: team.ownerToken,
        headers: { 'x-idempotency-key': `read-only-${randomUUID()}` },
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');

      // Route 9: paused; the lanes are left as they were (every turn reads the account, SN12).
      const paused = await act({ channelAccountPublicId: id, action: 'pause' });
      expect(paused.statusCode, paused.body).toBe(200);
      expect(dataOf<ChannelAccountAnswer>(paused)).toMatchObject({
        is_paused: true,
        plan_stop_reason: 'plan_ended',
      });
      expect(await readLaneRows(channelAccountId)).toEqual(stopped);

      // Route 10: the pause cleared, the plan stop kept (still open), each lane gets one turn again.
      const resumed = await act({ channelAccountPublicId: id, action: 'resume' });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(dataOf<ChannelAccountAnswer>(resumed)).toMatchObject({
        is_paused: false,
        plan_stop_reason: 'plan_ended',
      });
      const woken = await readLaneRows(channelAccountId);
      for (const [index, lane] of woken.entries()) {
        expect(lane.state).toBe('ready');
        expect(Number(lane.turn_number)).toBe(Number(stopped[index]?.turn_number) + 1);
      }
      expect(await readStopRows(channelAccountId)).toEqual([
        { lane: 'all', reason: 'plan_ended', ended_at: null, ended_by: null },
      ]);

      // Route 8: revoked, the lanes stopped, the token erased with the connection's last account.
      mockInstagramUnsubscribe({ instagramUserId: account.id });
      expect((await disconnect(id)).statusCode).toBe(204);
      expect((await readChannelAccountRows(team.organization.id))[0]?.connection_status).toBe(
        'revoked',
      );
      for (const lane of await readLaneRows(channelAccountId)) {
        expect(lane).toMatchObject({ state: 'stopped', working_turn: null, next_run_at: null });
      }
      expect(
        await readChannelConnectionTokenCiphertexts({ organizationId: team.organization.id }),
      ).toHaveLength(0);
    });
  });

  describe('choose active accounts (route 11, CA9)', () => {
    it('answers 409 channel_account_already_active for an account in the plan', async () => {
      const { ids } = await connect([nextAccount()]);
      const response = await act({ channelAccountPublicId: ids[0] ?? '', action: 'activate' });
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('channel_account_already_active');
    });

    it('answers 409 plan_account_limit at the limit with no account named, then swaps one named (AC-2.11)', async () => {
      // Free: one active account. Two connected under Creator, then one left the plan.
      await useCreatorPlan();
      const { ids } = await connect([nextAccount(), nextAccount()]);
      const [kept, outside] = [ids[0] ?? '', ids[1] ?? ''];
      await operatorQuery`DELETE FROM billing.subscriptions WHERE organization_id = ${team.organization.id}`;
      await markNotInPlan(outside);

      const refused = await act({ channelAccountPublicId: outside, action: 'activate' });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('plan_account_limit');

      const swapped = await act({
        channelAccountPublicId: outside,
        action: 'activate',
        payload: { stop_channel_account_id: kept },
      });
      expect(swapped.statusCode, swapped.body).toBe(200);
      expect(dataOf<ChannelAccountAnswer>(swapped)).toMatchObject({
        id: outside,
        is_in_plan: true,
        plan_stop_reason: null,
      });
      const rows = await readChannelAccountRows(team.organization.id);
      expect(rows.find((row) => row.public_id === kept)?.plan_stop_reason).toBe('plan_downgrade');
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.channel_account.activate',
      });
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        metadata: {
          channel_account_public_id: outside,
          stopped_channel_account_public_id: kept,
          old_value: { plan_stop_reason: 'plan_downgrade' },
          new_value: { plan_stop_reason: null },
        },
      });
    });

    it('activates without a swap below the limit', async () => {
      await useCreatorPlan();
      const { ids } = await connect([nextAccount(), nextAccount()]);
      await markNotInPlan(ids[1] ?? '');
      const response = await act({ channelAccountPublicId: ids[1] ?? '', action: 'activate' });
      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf<ChannelAccountAnswer>(response).is_in_plan).toBe(true);
    });

    it('answers 400 stop_channel_account_id for a malformed, the same, a stopped or a foreign account', async () => {
      await useCreatorPlan();
      const { ids } = await connect([nextAccount(), nextAccount()]);
      const otherTeam = await createInstagramTeam();
      const { ids: foreign } = await connect([nextAccount()], otherTeam);
      const outside = ids[1] ?? '';
      await markNotInPlan(outside);
      for (const stop of ['nope', outside, foreign[0] ?? '']) {
        const response = await act({
          channelAccountPublicId: outside,
          action: 'activate',
          payload: { stop_channel_account_id: stop },
        });
        expect(response.statusCode, stop).toBe(400);
        expect(errorOf(response).errors?.map((error) => error.field)).toEqual([
          'stop_channel_account_id',
        ]);
      }
    });

    it('requires X-Idempotency-Key (422) and replays the swap for a retried key', async () => {
      await useCreatorPlan();
      const { ids } = await connect([nextAccount(), nextAccount()]);
      await markNotInPlan(ids[1] ?? '');
      const missing = await act({
        channelAccountPublicId: ids[1] ?? '',
        action: 'activate',
        idempotencyKey: null,
      });
      expect(missing.statusCode).toBe(422);

      const key = `activate-${randomUUID()}`;
      const first = await act({
        channelAccountPublicId: ids[1] ?? '',
        action: 'activate',
        idempotencyKey: key,
      });
      const replay = await act({
        channelAccountPublicId: ids[1] ?? '',
        action: 'activate',
        idempotencyKey: key,
      });
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
    });

    it('lets one of two racing activations pass the limit (the organization lock)', async () => {
      await useCreatorPlan();
      const { ids } = await connect([nextAccount(), nextAccount(), nextAccount()]);
      await operatorQuery`DELETE FROM billing.subscriptions WHERE organization_id = ${team.organization.id}`;
      // Free allows one: ids[0] active, ids[1] and ids[2] outside.
      await markNotInPlan(ids[1] ?? '');
      await markNotInPlan(ids[2] ?? '');
      await operatorQuery`
        UPDATE app.channel_accounts SET connection_status = 'revoked', disconnected_at = now()
        WHERE public_id = ${ids[0] ?? ''}`;

      const answers = await Promise.all([
        act({ channelAccountPublicId: ids[1] ?? '', action: 'activate' }),
        act({ channelAccountPublicId: ids[2] ?? '', action: 'activate' }),
      ]);
      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
      const rows = await readChannelAccountRows(team.organization.id);
      expect(
        rows.filter((row) => row.connection_status !== 'revoked' && row.plan_stop_reason === null),
      ).toHaveLength(1);
    });
  });

  describe('one organization per account (CAQ1, CAC5)', () => {
    it('writes the provider id equal to the Instagram user id, and refuses a second live row elsewhere', async () => {
      const account = nextAccount();
      await connect([account]);
      const [pair] = await operatorQuery<
        Array<{ provider_account_id: string; instagram_user_id: string }>
      >`
        SELECT c.provider_account_id, i.instagram_user_id
        FROM app.channel_accounts AS c
        INNER JOIN app.instagram_accounts AS i ON i.channel_account_id = c.id
        WHERE c.organization_id = ${team.organization.id}`;
      expect(pair?.provider_account_id).toBe(account.id);
      expect(pair?.instagram_user_id).toBe(account.id);

      const otherTeam = await createInstagramTeam();
      const [connection] = await readChannelConnectionRows(team.organization.id);
      await operatorQuery`
        INSERT INTO app.channel_connections (public_id, organization_id, client_business_id, config_id)
        VALUES (${`chc_${'1'.repeat(21)}`}, ${otherTeam.organization.id}, ${connection?.client_business_id ?? '1'}, '1')`;
      const [otherConnection] = await readChannelConnectionRows(otherTeam.organization.id);
      const error = await withAppDatabaseContext({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: otherTeam.organization.public_id }),
        callback: () =>
          new ChannelAccountRepository().upsertConnected({
            organizationId: otherTeam.organization.id,
            channel: 'instagram',
            channelConnectionId: Number(otherConnection?.id),
            providerAccountId: account.id,
            displayName: '@elsewhere',
            connectedByUserId: null,
          }),
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(getPostgresConstraintName(error)).toBe(
        CHANNEL_ACCOUNT_UNIQUE_INDEXES.providerAccountLive,
      );
    });
  });
});
