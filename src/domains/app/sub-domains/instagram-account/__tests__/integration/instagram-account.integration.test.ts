import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  INSTAGRAM_ACCOUNT_SETTINGS_PATH,
  TEST_INSTAGRAM_LONG_LIVED_TOKEN,
  buildInstagramProfile,
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endPaidPlanWithoutPaying,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  readInstagramTokenCiphertexts,
  readStagedAuditRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  AUTOMATIONS_PATH,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * Routes 2 and 4 of the Instagram account (routes-final § 1.A, ROUTE R3) over HTTP: every success
 * and error of 1.A.9 and 1.5, team-only (K1), the Editor role (AC-1.7), another organization's data,
 * and a read-only plan leaving the connect, the settings change and the disconnect open (D27). The
 * launch's connect (route 1) is retired (feat-instagram-dm-sending RC-6): accounts connect through a
 * channel connection — its own suite is `channel-connection.integration.test.ts`. Meta is mocked
 * with nock; the database, Redis, auth, permissions and idempotency are real.
 */
describe('Instagram account routes (read, disconnect)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  const seededIdempotencyKeys: string[] = [];

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
    vi.restoreAllMocks();
    await metaGraphCircuit.reset();
    if (seededIdempotencyKeys.length > 0) {
      await redisConnection.del(...seededIdempotencyKeys);
      seededIdempotencyKeys.length = 0;
    }
  });

  /** Connects `profile` for the team's Owner (start, callback, pick) and returns the account as route 2 reads it. */
  async function connectAccount(profile: TestInstagramProfile, token = team.ownerToken) {
    return (await connectInstagramAccount({ app, token, profile })).account;
  }

  function errorOf(response: InjectHttpResult): {
    code?: string;
    reason?: string;
    detail?: string;
    errors?: Array<{ field: string }>;
  } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  describe('GET /app/social/instagram/account (route 2)', () => {
    it('returns the connected account with its settings — never the token', async () => {
      const profile = buildInstagramProfile();
      const connected = await connectAccount(profile);

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(TEST_INSTAGRAM_LONG_LIVED_TOKEN);
      const { data } = response.json() as { data: Record<string, unknown> };
      expect(data).toEqual(connected);
    });

    it('lets an Editor read it (AC-1.7)', async () => {
      const connected = await connectAccount(buildInstagramProfile());

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.editorToken,
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: { id: string } }).data.id).toBe(connected.id);
    });

    it('still returns an expired account, so the page shows the reconnect card (IA13)', async () => {
      const connected = await connectAccount(buildInstagramProfile());
      const [row] = await readInstagramAccountRows(team.organization.id);
      const broken = await app.appDomain.instagramAccountService.markConnectionBroken({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(row?.id),
        },
        connectionStatus: 'expired',
      });
      expect(broken?.connection_status).toBe('expired');

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(200);
      const { data } = response.json() as { data: { id: string; connection_status: string } };
      expect(data).toMatchObject({ id: connected.id, connection_status: 'expired' });
    });

    it('answers 404 instagram_not_connected when no account was ever connected', async () => {
      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it("never shows another organization's account (404 instagram_not_connected)", async () => {
      await connectAccount(buildInstagramProfile());
      const otherTeam = await createInstagramTeam();

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: otherTeam.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
    });

    it('answers 404 team_organization_required on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: personal.token,
      });

      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('team_organization_required');
    });

    it('answers 403 missing_permission to a caller without instagram-account:read', async () => {
      const owner = await createTestUser();
      const { organization } = await provisionOrganizationWithOwner({
        name: 'Personal',
        slug: null,
        type: 'PERSONAL',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, { url: INSTAGRAM_ACCOUNT_PATH, token });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
    });
  });

  describe('DELETE /app/social/instagram/account (route 4)', () => {
    it('disconnects: revoked, token erased, settings and profile kept, audit staged — and 204', async () => {
      const profile = buildInstagramProfile();
      const connected = await connectAccount(profile);
      const unsubscribe = mockInstagramUnsubscribe({ instagramAppUserId: profile.id });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(unsubscribe.isDone()).toBe(true);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row).toMatchObject({
        public_id: connected.id,
        connection_status: 'revoked',
        username: profile.username,
        token_expires_at: null,
        webhook_subscribed_at: null,
      });
      expect(row?.disconnected_at).not.toBeNull();
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toEqual([]);
      expect(await readInstagramSettingsRows(team.organization.id)).toHaveLength(1);
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.instagram_account.disconnect',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        severity: 'WARNING',
        resource_type: 'instagram_account',
        metadata: { instagram_account_public_id: connected.id },
      });

      const read = await injectAuthenticated(app, {
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(read.statusCode).toBe(404);
      expect(errorOf(read).reason).toBe('instagram_not_connected');
    });

    it('still disconnects when the unsubscribe fails', async () => {
      const profile = buildInstagramProfile();
      await connectAccount(profile);
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id, outcome: 'failure' });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });

      expect(response.statusCode).toBe(204);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('revoked');
    });

    it('answers 404 instagram_not_connected with nothing connected, and again after a disconnect', async () => {
      const none = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(none.statusCode).toBe(404);
      expect(errorOf(none).reason).toBe('instagram_not_connected');

      const profile = buildInstagramProfile();
      await connectAccount(profile);
      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const first = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(first.statusCode).toBe(204);

      const again = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(again.statusCode).toBe(404);
      expect(errorOf(again).reason).toBe('instagram_not_connected');
    });

    it('refuses an Editor with 403 missing_permission and leaves the account connected (AC-1.7)', async () => {
      await connectAccount(buildInstagramProfile());

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.editorToken,
      });

      expect(response.statusCode).toBe(403);
      expect(errorOf(response).reason).toBe('missing_permission');
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
    });

    it('answers 422 on a personal organization, even with the code (IA3)', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes();

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: personal.token,
      });

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('unprocessable_entity');
    });

    it("never touches another organization's account", async () => {
      await connectAccount(buildInstagramProfile());
      const otherTeam = await createInstagramTeam();

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: otherTeam.ownerToken,
      });

      expect(response.statusCode).toBe(404);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('connected');
      expect(await readInstagramTokenCiphertexts(team.organization.id)).toHaveLength(1);
    });
  });

  describe('a read-only plan (D27, AC-2.25)', () => {
    const enforced = env.BILLING_READ_ONLY_ENFORCED;

    afterEach(() => {
      env.BILLING_READ_ONLY_ENFORCED = enforced;
    });

    it('leaves connect, the settings change and disconnect open — only the automation writes are refused', async () => {
      await endPaidPlanWithoutPaying(team.organization.id);
      env.BILLING_READ_ONLY_ENFORCED = true;

      const profile = buildInstagramProfile();
      const account = await connectAccount(profile);
      expect(account.connection_status).toBe('connected');

      const changed = await injectAuthenticated(app, {
        method: 'PATCH',
        url: INSTAGRAM_ACCOUNT_SETTINGS_PATH,
        token: team.ownerToken,
        payload: { is_automation_enabled: false },
      });
      expect(changed.statusCode).toBe(200);
      expect(await readInstagramSettingsRows(team.organization.id)).toEqual([
        expect.objectContaining({ is_automation_enabled: false }),
      ]);

      // The plan is read-only all along: creating an automation on that account is refused.
      const refused = await injectAuthenticated(app, {
        method: 'POST',
        url: AUTOMATIONS_PATH,
        token: team.ownerToken,
        payload: commentAutomationBody(),
        headers: { 'x-idempotency-key': `ig-read-only-${generatePublicId('automation')}` },
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');

      mockInstagramUnsubscribe({ instagramAppUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: INSTAGRAM_ACCOUNT_PATH,
        token: team.ownerToken,
      });
      expect(disconnected.statusCode).toBe(204);
      const [row] = await readInstagramAccountRows(team.organization.id);
      expect(row?.connection_status).toBe('revoked');

      // A reconnect is a connect too.
      const reconnected = await connectAccount(profile);
      expect(reconnected).toMatchObject({ id: account.id, connection_status: 'connected' });
    });
  });

  describe('markConnectionBroken (IA9)', () => {
    it('moves a connected account once; a second call loses the race and changes nothing', async () => {
      await connectAccount(buildInstagramProfile());
      const [row] = await readInstagramAccountRows(team.organization.id);
      const target = {
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id }),
        instagramAccount: {
          organizationId: team.organization.id,
          instagramAccountId: Number(row?.id),
        },
      };

      const first = await app.appDomain.instagramAccountService.markConnectionBroken({
        ...target,
        connectionStatus: 'error',
      });
      const second = await app.appDomain.instagramAccountService.markConnectionBroken({
        ...target,
        connectionStatus: 'expired',
      });

      expect(first?.connection_status).toBe('error');
      expect(second).toBeNull();
      const [after] = await operatorQuery<Array<{ connection_status: string }>>`
        SELECT connection_status FROM app.instagram_accounts WHERE id = ${Number(row?.id)}`;
      expect(after?.connection_status).toBe('error');
    });
  });
});
