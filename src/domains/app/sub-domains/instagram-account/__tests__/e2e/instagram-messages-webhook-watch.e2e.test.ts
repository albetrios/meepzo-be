import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  channelConnectCallbackPath,
  channelConnectStartPath,
  channelReconnectPath,
  mockMetaLogin,
  readStateFromLoginUrl,
} from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  type InstagramTeamFixture,
  type TestInstagramProfile,
  buildInstagramProfile,
  connectInstagramAccount,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { channelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { InstagramAccountExtensionService } from '@/domains/app/sub-domains/instagram-account/instagram-account-extension.service.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { processInstagramWebhookSubscriptionCheckTask } from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-tasks.processor.js';

/**
 * Meta's Unified Login limit for an account shared without its linked Facebook Page (owner decision
 * 2026-11-26, P358) end to end, with the real database and Meta mocked: the subscription check
 * finds conversations moving with no messaging webhook since the subscription → the account is
 * flagged (`is_messages_webhook_missing` on route 7) and the owners told once (in-app and email);
 * the reconnect asks for the Page configuration (`with_page: true` → `META_PAGE_CONFIG_ID`, kept by
 * the callback), and refuses it with `400 instagram_page_login_not_configured` while unset.
 */

const PAGE_CONFIG_ID = 'page-config-id-358';
const MINUTE = 60_000;
const CONTEXT = {
  jobId: 'job-messages-webhook-watch',
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => callback(),
  returnTicket: async (delayMilliseconds: number): Promise<never> => {
    throw new Error(`unexpected ticket return after ${delayMilliseconds} ms`);
  },
};

/** A clock in the first 10-minute window of the current hour (the watch's one read an hour). */
function firstWindowOfThisHour(): Date {
  const hour = 60 * MINUTE;
  return new Date(Math.floor(Date.now() / hour) * hour + 3 * MINUTE);
}

describe('missing messaging webhooks: detect, tell once, reconnect with the Page (P358)', () => {
  let app: FastifyInstance;
  let containers: DomainContainers;
  let team: InstagramTeamFixture;
  let profile: TestInstagramProfile;
  let channelAccountPublicId: string;
  let channelConnectionPublicId: string;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
    ({ app } = await createTestApp());
    containers = createDomainContainers();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
    profile = buildInstagramProfile();
    const connected = await connectInstagramAccount({ app, token: team.ownerToken, profile });
    channelAccountPublicId = connected.instagramAccountPublicId;
    channelConnectionPublicId = connected.channelConnectionPublicId;
    // Subscribed two days ago (the set-up task's stamp), no messaging item seen since.
    await operatorQuery`
      UPDATE app.instagram_accounts SET webhook_subscribed_at = now() - interval '2 days'
      WHERE organization_id = ${team.organization.id}`;
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
    delete process.env.META_PAGE_CONFIG_ID;
    resetEnvCacheForTests();
  });

  /** Mocks the check's two Meta reads: every field on, and the newest conversation's time. */
  function mockMeta(latestConversationAt: Date | null): nock.Scope {
    return nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/${profile.user_id}/subscribed_apps`)
      .query(true)
      .reply(200, {
        data: [
          {
            id: getEnv().META_APP_ID,
            subscribed_fields: [
              'comments',
              'live_comments',
              'messages',
              'messaging_postbacks',
              'messaging_referral',
              'message_reactions',
            ],
          },
        ],
      })
      .get(`/${META_GRAPH_VERSION}/${profile.user_id}/conversations`)
      .query({ platform: 'instagram', fields: 'updated_time', limit: '5', appsecret_proof: /.+/ })
      .reply(200, {
        data:
          latestConversationAt === null
            ? []
            : [{ id: 't_1', updated_time: latestConversationAt.toISOString() }],
      });
  }

  function runCheck(now: Date = firstWindowOfThisHour()) {
    return processInstagramWebhookSubscriptionCheckTask({
      organizationPublicId: team.organization.public_id,
      channelAccountPublicId,
      context: CONTEXT,
      now,
      services: {
        channelAccountService: containers.appDomain.channelAccountService,
        extensionService: new InstagramAccountExtensionService(new InstagramAccountRepository()),
        starterQuestionSource: { listLiveStarterQuestions: async () => [] },
        readMissedCommentPort: () => null,
        readNoticeServices: () => ({
          membershipService: containers.tenancyDomain.membershipService,
          organizationSettingsService: containers.tenancyDomain.organizationSettingsService,
          notificationService: containers.notifyDomain.notificationService,
        }),
      },
    });
  }

  async function readNotices() {
    return operatorQuery<Array<{ user_id: string; type: string; title: string; data: unknown }>>`
      SELECT user_id, type, title, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
  }

  async function readAccount() {
    const response = await injectAuthenticated(app, {
      url: channelAccountPath(channelAccountPublicId),
      token: team.ownerToken,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: { instagram: Record<string, unknown> } }).data.instagram;
  }

  it('flags the account and tells its managers once; a quiet inbox is never flagged', async () => {
    expect(await readAccount()).toMatchObject({ is_messages_webhook_missing: false });

    // No conversation since the subscription: nothing proves the webhooks missing.
    mockMeta(new Date(Date.now() - 3 * 24 * 60 * MINUTE));
    await expect(runCheck()).resolves.toMatchObject({ messagesWebhook: 'quiet' });
    expect(await readNotices()).toHaveLength(0);

    // Conversations moved an hour ago, no messaging webhook since the subscription.
    mockMeta(new Date(Date.now() - 60 * MINUTE));
    await expect(runCheck()).resolves.toMatchObject({
      outcome: 'subscribed',
      messagesWebhook: 'flagged',
    });
    expect(await readAccount()).toMatchObject({ is_messages_webhook_missing: true });
    const notices = await readNotices();
    // The Owner and the Admin (channel-account:manage), in the app and by email.
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.type).toBe('instagram.reconnect_required');
      expect(notice.title).toBe('Reconnect Instagram with its Facebook Page');
      expect(notice.data).toMatchObject({ channels: ['in_app', 'email'] });
    }

    // The next hour: already flagged — no conversations read, no second notice.
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/${profile.user_id}/subscribed_apps`)
      .query(true)
      .reply(200, {
        data: [
          {
            id: getEnv().META_APP_ID,
            subscribed_fields: [
              'comments',
              'live_comments',
              'messages',
              'messaging_postbacks',
              'messaging_referral',
              'message_reactions',
            ],
          },
        ],
      });
    await expect(
      runCheck(new Date(firstWindowOfThisHour().getTime() + 60 * MINUTE)),
    ).resolves.toMatchObject({ messagesWebhook: 'already_flagged' });
    expect(nock.pendingMocks()).toEqual([]);
    expect(await readNotices()).toHaveLength(2);
  });

  it('the reconnect asks for the Page configuration; the callback keeps it on the connection', async () => {
    process.env.META_PAGE_CONFIG_ID = PAGE_CONFIG_ID;
    resetEnvCacheForTests();

    const reconnect = await injectAuthenticated(app, {
      method: 'POST',
      url: channelReconnectPath(channelConnectionPublicId),
      token: team.ownerToken,
      payload: { with_page: true },
    });
    expect(reconnect.statusCode).toBe(200);
    const loginUrl = (reconnect.json() as { data: { login_url: string } }).data.login_url;
    expect(new URL(loginUrl).searchParams.get('config_id')).toBe(PAGE_CONFIG_ID);

    const [connection] = await operatorQuery<Array<{ client_business_id: string }>>`
      SELECT client_business_id FROM app.channel_connections
      WHERE public_id = ${channelConnectionPublicId}`;
    mockMetaLogin({
      clientBusinessId: connection?.client_business_id ?? '',
      assignedAccounts: [{ id: profile.user_id, username: profile.username }],
    });
    const state = readStateFromLoginUrl(loginUrl);
    const callback = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectCallbackPath(),
      token: team.ownerToken,
      payload: { code: `AQB-${randomUUID()}#_`, state },
      headers: { 'x-idempotency-key': `channel-connect:${state}` },
    });
    expect(callback.statusCode).toBe(200);
    const [stored] = await operatorQuery<Array<{ config_id: string }>>`
      SELECT config_id FROM app.channel_connections WHERE public_id = ${channelConnectionPublicId}`;
    expect(stored?.config_id).toBe(PAGE_CONFIG_ID);

    // The start without the flag keeps the default configuration.
    const start = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectStartPath(),
      token: team.ownerToken,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    const startUrl = (start.json() as { data: { login_url: string } }).data.login_url;
    expect(new URL(startUrl).searchParams.get('config_id')).toBe(getEnv().META_CONFIG_ID);
  });

  it('answers 400 instagram_page_login_not_configured on start and reconnect while META_PAGE_CONFIG_ID is unset', async () => {
    for (const url of [
      channelConnectStartPath(),
      channelReconnectPath(channelConnectionPublicId),
    ]) {
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url,
        token: team.ownerToken,
        payload: { with_page: true },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error: { reason?: string; errors?: Array<{ field: string }> };
      };
      expect(body.error.reason).toBe('instagram_page_login_not_configured');
      expect(body.error.errors?.map((item) => item.field)).toEqual(['with_page']);
    }
  });

  it('answers 400 for a with_page that is not a boolean', async () => {
    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: channelConnectStartPath(),
      token: team.ownerToken,
      payload: { with_page: 'yes' },
    });
    expect(response.statusCode).toBe(400);
  });
});
