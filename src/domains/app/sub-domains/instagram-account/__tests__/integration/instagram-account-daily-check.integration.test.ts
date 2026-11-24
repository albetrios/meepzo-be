import { Queue } from 'bullmq';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { metaGraphCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';
import {
  type InstagramAccountKey,
  InstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import {
  INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
  buildInstagramAccountDailyCheckJobId,
  closeInstagramAccountDailyCheckQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js';
import {
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  buildInstagramReconnectNoticeJobId,
  closeInstagramReconnectNoticeQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import {
  processInstagramAccountDailyCheckJob,
  runInstagramAccountDailyCheckSweep,
} from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-daily-check.processor.js';
import {
  type InstagramTeamFixture,
  type TestInstagramProfile,
  buildInstagramProfile,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/**
 * The daily account check (launch R7 — routes-final § 1 IA8, IAC8; AC-11.2–AC-11.5) against real
 * Postgres and Redis, Meta mocked with nock, after feat-instagram-dm-sending R3 took the token renewal
 * out (WC-35 — the connection's token never ends): the profile is refreshed through
 * `GET /{instagram_user_id}` with the connection's token; an unsubscribed account is subscribed
 * again; Meta down keeps the account `connected`; Meta refusing the token makes it `error`; twice
 * equals once; the sweep hands one check per connected account to the queue, once a day.
 */

const STORED_PLAIN_TOKEN = 'EAAG-daily-check-stored-token';

describe('Instagram account daily check (IA8)', () => {
  let containers: DomainContainers;
  let team: InstagramTeamFixture;
  const noticeQueue = new Queue(INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME, {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
  });
  const dailyCheckQueue = new Queue(INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME, {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
  });

  beforeAll(() => {
    containers = createDomainContainers();
  });

  afterAll(async () => {
    await closeInstagramReconnectNoticeQueue();
    await closeInstagramAccountDailyCheckQueue();
    await noticeQueue.close();
    await dailyCheckQueue.close();
  });

  beforeEach(async () => {
    // Start from empty queues: an earlier file on this Vitest worker (account, settings) breaks
    // connections too, and its notice jobs share this worker's queue prefix.
    await noticeQueue.obliterate({ force: true });
    await dailyCheckQueue.obliterate({ force: true });
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
  });

  afterEach(async () => {
    nock.cleanAll();
    await metaGraphCircuit.reset();
    await noticeQueue.obliterate({ force: true });
    await dailyCheckQueue.obliterate({ force: true });
  });

  function scopeOf(organizationPublicId: string) {
    return PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId });
  }

  /** A connected account through a connection with a stored (encrypted) token. */
  async function seedConnectedAccount({
    isWebhookSubscribed = true,
    organization = team.organization,
  }: {
    isWebhookSubscribed?: boolean;
    organization?: { id: number; public_id: string };
  } = {}): Promise<{ key: InstagramAccountKey; publicId: string; profile: TestInstagramProfile }> {
    const profile = buildInstagramProfile();
    const connection = await insertChannelConnection({
      organizationId: organization.id,
      plainToken: STORED_PLAIN_TOKEN,
    });
    const accountRepository = new InstagramAccountRepository();
    return withAppDatabaseContext({
      scope: scopeOf(organization.public_id),
      callback: async () => {
        const { account } = await accountRepository.upsertConnected({
          organizationId: organization.id,
          channelConnectionId: connection.id,
          instagramUserId: profile.user_id,
          instagramAppUserId: profile.id,
          username: profile.username,
          name: profile.name,
          biography: null,
          website: null,
          profilePictureUrl: null,
          followersCount: 10,
          followsCount: 5,
          mediaCount: 1,
          scopes: [],
          connectedByUserId: null,
        });
        const key = { organizationId: organization.id, instagramAccountId: account.id };
        if (isWebhookSubscribed) await accountRepository.recordWebhookSubscribed(key);
        return { key, publicId: account.public_id, profile };
      },
    });
  }

  async function readState(instagramAccountId: number) {
    const [account] = await operatorQuery<
      Array<{
        connection_status: string;
        connection_status_changed_at: Date;
        token_expires_at: Date | null;
        name: string | null;
        followers_count: number;
        profile_synced_at: Date | null;
        webhook_subscribed_at: Date | null;
      }>
    >`
      SELECT connection_status, connection_status_changed_at, token_expires_at, name,
             followers_count, profile_synced_at, webhook_subscribed_at
      FROM app.instagram_accounts WHERE id = ${instagramAccountId}`;
    return { account };
  }

  function runCheck(
    target: { publicId: string },
    organizationPublicId = team.organization.public_id,
  ) {
    return processInstagramAccountDailyCheckJob({
      jobData: { organizationPublicId, instagramAccountPublicId: target.publicId },
      accountService: containers.appDomain.instagramAccountService,
      requestId: 'daily-check-integration',
    });
  }

  function mockProfile(profile: TestInstagramProfile): nock.Scope {
    return nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/${profile.user_id}`)
      .query(true)
      .reply(200, profile);
  }

  async function noticeJobOf(target: { key: InstagramAccountKey; publicId: string }) {
    const { account } = await readState(target.key.instagramAccountId);
    if (account === undefined) return undefined;
    return noticeQueue.getJob(
      buildInstagramReconnectNoticeJobId({
        instagramAccountPublicId: target.publicId,
        connectionStatusChangedAt: account.connection_status_changed_at,
      }),
    );
  }

  it('refreshes the profile through the connection token, with no renewal (AC-11.2, WC-35)', async () => {
    const target = await seedConnectedAccount();
    const profileRead = mockProfile({
      ...target.profile,
      name: 'Acme Shop Renamed',
      followers_count: 2048,
    });

    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'checked',
      profile: 'refreshed',
      subscription: 'already_subscribed',
    });

    expect(profileRead.isDone()).toBe(true);
    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('connected');
    expect(account?.token_expires_at).toBeNull();
    expect(account?.name).toBe('Acme Shop Renamed');
    expect(account?.followers_count).toBe(2048);
    expect(account?.profile_synced_at).not.toBeNull();
  });

  it('subscribes an account that is not subscribed to the webhook fields again (AC-11.3)', async () => {
    const target = await seedConnectedAccount({ isWebhookSubscribed: false });
    mockProfile(target.profile);
    const subscription = nock(META_GRAPH_BASE_URL)
      .post(`/${META_GRAPH_VERSION}/${target.profile.id}/subscribed_apps`)
      .query(true)
      .reply(200, { success: true });

    await expect(runCheck(target)).resolves.toMatchObject({ subscription: 'subscribed' });

    expect(subscription.isDone()).toBe(true);
    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.webhook_subscribed_at).not.toBeNull();
  });

  it('keeps the account connected when Meta is down: the job waits (AC-11.4)', async () => {
    const target = await seedConnectedAccount();
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/${target.profile.user_id}`)
      .query(true)
      .reply(503, { error: { message: 'Service temporarily unavailable', code: 2 } });

    await expect(runCheck(target)).rejects.toThrow();

    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('connected');
    expect(await noticeJobOf(target)).toBeUndefined();
  });

  it('marks the account error at once when Meta refuses the token, and tells it (AC-11.5)', async () => {
    const target = await seedConnectedAccount();
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/${target.profile.user_id}`)
      .query(true)
      .reply(400, {
        error: { message: 'Error validating access token', code: 190, error_subcode: 460 },
      });

    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'broken',
      connectionStatus: 'error',
      step: 'profile',
    });

    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('error');
    const notice = await noticeJobOf(target);
    expect(notice?.data).toMatchObject({
      organizationPublicId: team.organization.public_id,
      instagramAccountPublicId: target.publicId,
      connectionStatus: 'error',
    });
  });

  it('run twice the same day changes nothing more (AC-11.6)', async () => {
    const target = await seedConnectedAccount();
    mockProfile(target.profile);
    mockProfile(target.profile);

    await runCheck(target);
    const afterFirst = await readState(target.key.instagramAccountId);
    await expect(runCheck(target)).resolves.toMatchObject({ profile: 'refreshed' });
    const afterSecond = await readState(target.key.instagramAccountId);

    expect(afterSecond.account?.connection_status).toBe('connected');
    expect(afterSecond.account?.name).toBe(afterFirst.account?.name);
  });

  it('skips an account that is no longer connected', async () => {
    const target = await seedConnectedAccount();
    await containers.appDomain.instagramAccountService.markConnectionBroken({
      scope: scopeOf(team.organization.public_id),
      instagramAccount: target.key,
      connectionStatus: 'error',
    });

    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'not_connected',
    });
  });

  it("never reaches another organization's account by its public id", async () => {
    const target = await seedConnectedAccount();
    const otherTeam = await createInstagramTeam();

    await expect(runCheck(target, otherTeam.organization.public_id)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'not_connected',
    });
  });

  it('the sweep hands one check per connected account to the queue, once a day (IA8)', async () => {
    const first = await seedConnectedAccount();
    const otherTeam = await createInstagramTeam();
    const second = await seedConnectedAccount({ organization: otherTeam.organization });
    const brokenTeam = await createInstagramTeam();
    const broken = await seedConnectedAccount({ organization: brokenTeam.organization });
    await containers.appDomain.instagramAccountService.markConnectionBroken({
      scope: scopeOf(brokenTeam.organization.public_id),
      instagramAccount: broken.key,
      connectionStatus: 'expired',
    });
    const now = new Date();

    await expect(runInstagramAccountDailyCheckSweep({ now })).resolves.toEqual({
      listedCount: 2,
      addedCount: 2,
      capped: false,
    });

    for (const [target, organization] of [
      [first, team.organization],
      [second, otherTeam.organization],
    ] as const) {
      const job = await dailyCheckQueue.getJob(
        buildInstagramAccountDailyCheckJobId({
          instagramAccountPublicId: target.publicId,
          checkedOn: now,
        }),
      );
      expect(job?.data).toMatchObject({
        organizationPublicId: organization.public_id,
        instagramAccountPublicId: target.publicId,
      });
    }
    const brokenJob = await dailyCheckQueue.getJob(
      buildInstagramAccountDailyCheckJobId({
        instagramAccountPublicId: broken.publicId,
        checkedOn: now,
      }),
    );
    expect(brokenJob).toBeUndefined();

    // A second sweep the same day adds no second job: the ids are the day's.
    await runInstagramAccountDailyCheckSweep({ now });
    const jobs = await dailyCheckQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs).toHaveLength(2);
  });
});
