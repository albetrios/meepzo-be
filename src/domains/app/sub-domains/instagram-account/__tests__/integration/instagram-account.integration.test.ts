import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  instagramAccountSettingsPath,
  buildInstagramProfile,
  createInstagramTeam,
  endPaidPlanWithoutPaying,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
  readInstagramSettingsRows,
  type InstagramTeamFixture,
  type TestInstagramProfile,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  AUTOMATIONS_PATH,
  automationActionPath,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * The Instagram account over HTTP: a read-only plan leaving the connect, the settings change and the
 * disconnect open (D27), and the guarded status change (IA9). The launch's routes 2 and 4 moved to
 * the channel account at feat-instagram-dm-sending R5 (routes 7, 8 — CA2); their suite is
 * `channel-account.integration.test.ts`. The
 * launch's connect (route 1) is retired (feat-instagram-dm-sending RC-6): accounts connect through a
 * channel connection — its own suite is `channel-connection.integration.test.ts`. Meta is mocked
 * with nock; the database, Redis, auth, permissions and idempotency are real.
 */
describe('Instagram account (read-only plan, guarded break)', () => {
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
        url: instagramAccountSettingsPath(String(account.id)),
        token: team.ownerToken,
        payload: { is_automation_enabled: false },
      });
      expect(changed.statusCode).toBe(200);
      expect(await readInstagramSettingsRows(team.organization.id)).toEqual([
        expect.objectContaining({ is_automation_enabled: false }),
      ]);

      // The plan is read-only all along: a draft on that account saves (P10), its go-live is refused.
      const draft = await injectAuthenticated(app, {
        method: 'POST',
        url: AUTOMATIONS_PATH,
        token: team.ownerToken,
        payload: commentAutomationBody({ channelAccountPublicId: String(account.id) }),
        headers: { 'x-idempotency-key': `ig-read-only-${generatePublicId('automation')}` },
      });
      expect(draft.statusCode).toBe(200);
      const refused = await injectAuthenticated(app, {
        method: 'POST',
        url: automationActionPath({
          automationPublicId: (draft.json() as { data: { id: string } }).data.id,
          action: 'go-live',
        }),
        token: team.ownerToken,
      });
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');

      mockInstagramUnsubscribe({ instagramUserId: profile.id });
      const disconnected = await injectAuthenticated(app, {
        method: 'DELETE',
        url: await organizationChannelAccountPath(team.organization.id),
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
        SELECT c.connection_status FROM app.instagram_accounts AS i
        INNER JOIN app.channel_accounts AS c
          ON c.organization_id = i.organization_id AND c.id = i.channel_account_id
        WHERE i.id = ${Number(row?.id)}`;
      expect(after?.connection_status).toBe('error');
    });
  });
});
