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
import { instagramCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  INSTAGRAM_GRAPH_API_VERSION,
  INSTAGRAM_GRAPH_BASE_URL,
} from '@/infrastructure/social/instagram.client.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';
import {
  type InstagramAccountKey,
  InstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountTokenRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.repository.js';
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
  TEST_INSTAGRAM_TOKEN_LIFETIME_SECONDS,
  buildInstagramProfile,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/**
 * The daily account check (launch R7 — routes-final § 1 IA8, IAC8; AC-11.1–AC-11.6) against real
 * Postgres and Redis, Instagram mocked with nock: a token ending within 7 days is renewed and one
 * ending later is left alone; Instagram down keeps the account `connected` with the error kept;
 * Instagram refusing the token makes it `error`; a token past its end becomes `expired` without a
 * call; a reconnect's newer token is kept; twice equals once; the sweep hands one check per
 * connected account to the queue, once a day.
 */

const DAY_MS = 86_400_000;
const STORED_PLAIN_TOKEN = 'IGAA-daily-check-stored-token';
const RENEWED_PLAIN_TOKEN = 'IGAA-daily-check-renewed-token';
const RECONNECT_PLAIN_TOKEN = 'IGAA-daily-check-reconnect-token';

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
    await instagramCircuit.reset();
    await noticeQueue.obliterate({ force: true });
    await dailyCheckQueue.obliterate({ force: true });
  });

  function scopeOf(organizationPublicId: string) {
    return PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId });
  }

  /** A connected account with a stored (encrypted) token ending in `tokenEndsInDays` days. */
  async function seedConnectedAccount({
    tokenEndsInDays,
    isWebhookSubscribed = true,
    organization = team.organization,
  }: {
    tokenEndsInDays: number;
    isWebhookSubscribed?: boolean;
    organization?: { id: number; public_id: string };
  }): Promise<{ key: InstagramAccountKey; publicId: string; profile: TestInstagramProfile }> {
    const profile = buildInstagramProfile();
    const expiresAt = new Date(Date.now() + tokenEndsInDays * DAY_MS);
    const accountRepository = new InstagramAccountRepository();
    return withAppDatabaseContext({
      scope: scopeOf(organization.public_id),
      callback: async () => {
        const { account } = await accountRepository.upsertConnected({
          organizationId: organization.id,
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
          tokenExpiresAt: expiresAt,
          connectedByUserId: null,
        });
        const key = { organizationId: organization.id, instagramAccountId: account.id };
        await new InstagramAccountTokenRepository().upsert({
          ...key,
          encryptedAccessToken: encryptFieldSecret(STORED_PLAIN_TOKEN),
          expiresAt,
        });
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
    const [token] = await operatorQuery<
      Array<{
        encrypted_access_token: string;
        expires_at: Date | null;
        last_refreshed_at: Date | null;
        last_refresh_error: string | null;
      }>
    >`
      SELECT encrypted_access_token, expires_at, last_refreshed_at, last_refresh_error
      FROM app.instagram_account_tokens WHERE instagram_account_id = ${instagramAccountId}`;
    return { account, token };
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

  function mockRenewal(plainToken = RENEWED_PLAIN_TOKEN): nock.Scope {
    return nock(INSTAGRAM_GRAPH_BASE_URL).get('/refresh_access_token').query(true).reply(200, {
      access_token: plainToken,
      token_type: 'bearer',
      expires_in: TEST_INSTAGRAM_TOKEN_LIFETIME_SECONDS,
    });
  }

  function mockProfile(profile: TestInstagramProfile): nock.Scope {
    return nock(INSTAGRAM_GRAPH_BASE_URL)
      .get(`/${INSTAGRAM_GRAPH_API_VERSION}/me`)
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

  it('renews a token ending within 7 days: new token and end, copied onto the account (AC-11.1)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    const renewal = mockRenewal();
    const refreshedProfile = {
      ...target.profile,
      name: 'Acme Shop Renamed',
      followers_count: 2048,
    };
    mockProfile(refreshedProfile);

    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'checked',
      renewal: 'renewed',
      profile: 'refreshed',
      subscription: 'already_subscribed',
    });

    expect(renewal.isDone()).toBe(true);
    const { account, token } = await readState(target.key.instagramAccountId);
    expect(decryptFieldSecret(token?.encrypted_access_token ?? '')).toBe(RENEWED_PLAIN_TOKEN);
    expect(token?.expires_at?.getTime()).toBeGreaterThan(Date.now() + 59 * DAY_MS);
    expect(account?.token_expires_at?.getTime()).toBe(token?.expires_at?.getTime());
    expect(token?.last_refreshed_at).not.toBeNull();
    expect(token?.last_refresh_error).toBeNull();
    expect(account?.connection_status).toBe('connected');
    // AC-11.2: the profile and its refresh time.
    expect(account?.name).toBe('Acme Shop Renamed');
    expect(account?.followers_count).toBe(2048);
    expect(account?.profile_synced_at).not.toBeNull();
  });

  it('leaves a token ending later alone and still refreshes the profile (AC-11.1, AC-11.2)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 30 });
    const before = await readState(target.key.instagramAccountId);
    mockProfile(target.profile);

    await expect(runCheck(target)).resolves.toMatchObject({ renewal: 'not_due' });

    const after = await readState(target.key.instagramAccountId);
    expect(after.token?.encrypted_access_token).toBe(before.token?.encrypted_access_token);
    expect(after.token?.expires_at?.getTime()).toBe(before.token?.expires_at?.getTime());
  });

  it('subscribes an account that is not subscribed to the webhook fields again (AC-11.3)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 30, isWebhookSubscribed: false });
    mockProfile(target.profile);
    const subscription = nock(INSTAGRAM_GRAPH_BASE_URL)
      .post(`/${INSTAGRAM_GRAPH_API_VERSION}/${target.profile.id}/subscribed_apps`)
      .query(true)
      .reply(200, { success: true });

    await expect(runCheck(target)).resolves.toMatchObject({ subscription: 'subscribed' });

    expect(subscription.isDone()).toBe(true);
    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.webhook_subscribed_at).not.toBeNull();
  });

  it('keeps the account connected when Instagram is down: the error is kept, the job waits (AC-11.4)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    const before = await readState(target.key.instagramAccountId);
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(503, { error: { message: 'Service temporarily unavailable', code: 2 } });

    await expect(runCheck(target)).rejects.toThrow();

    const after = await readState(target.key.instagramAccountId);
    expect(after.account?.connection_status).toBe('connected');
    expect(after.token?.encrypted_access_token).toBe(before.token?.encrypted_access_token);
    expect(after.token?.last_refresh_error).toContain('outage');
    expect(after.token?.last_refresh_error).not.toContain(STORED_PLAIN_TOKEN);
    expect(await noticeJobOf(target)).toBeUndefined();
  });

  it('marks the account error at once when Instagram refuses the token, and tells it (AC-11.5)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(400, {
        error: { message: 'Error validating access token', code: 190, error_subcode: 460 },
      });

    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'broken',
      connectionStatus: 'error',
      step: 'renewal',
    });

    const { account, token } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('error');
    expect(token?.last_refresh_error).toContain('code 190');
    const notice = await noticeJobOf(target);
    expect(notice?.data).toMatchObject({
      organizationPublicId: team.organization.public_id,
      instagramAccountPublicId: target.publicId,
      connectionStatus: 'error',
    });
  });

  it('marks the account expired when Instagram says the token expired (subcode 463)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(400, { error: { message: 'Session has expired', code: 190, error_subcode: 463 } });

    await expect(runCheck(target)).resolves.toMatchObject({ connectionStatus: 'expired' });
    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('expired');
  });

  it('marks a token whose end has passed expired without calling Instagram (AC-11.5)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: -1 });

    // No interceptor: a call to Instagram would fail the check.
    await expect(runCheck(target)).resolves.toEqual({
      outcome: 'broken',
      connectionStatus: 'expired',
      step: 'token_ended',
    });

    const { account } = await readState(target.key.instagramAccountId);
    expect(account?.connection_status).toBe('expired');
    expect((await noticeJobOf(target))?.data).toMatchObject({ connectionStatus: 'expired' });
  });

  it("keeps a reconnect's newer token: the renewal finishing after it writes nothing (AC-11.6)", async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    const reconnectExpiresAt = new Date(Date.now() + 60 * DAY_MS);
    // While Instagram renews, a reconnect stores a new token (as route 1's transaction does).
    nock(INSTAGRAM_GRAPH_BASE_URL)
      .get('/refresh_access_token')
      .query(true)
      .reply(async () => {
        await withAppDatabaseContext({
          scope: scopeOf(team.organization.public_id),
          callback: () =>
            new InstagramAccountTokenRepository().upsert({
              ...target.key,
              encryptedAccessToken: encryptFieldSecret(RECONNECT_PLAIN_TOKEN),
              expiresAt: reconnectExpiresAt,
            }),
        });
        return [
          200,
          {
            access_token: RENEWED_PLAIN_TOKEN,
            token_type: 'bearer',
            expires_in: TEST_INSTAGRAM_TOKEN_LIFETIME_SECONDS,
          },
        ];
      });

    await expect(runCheck(target)).resolves.toEqual({ outcome: 'superseded' });

    const { token } = await readState(target.key.instagramAccountId);
    expect(decryptFieldSecret(token?.encrypted_access_token ?? '')).toBe(RECONNECT_PLAIN_TOKEN);
    expect(token?.expires_at?.getTime()).toBe(reconnectExpiresAt.getTime());
  });

  it('run twice the same day changes nothing more: one renewal, the same state (AC-11.6)', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    const renewal = mockRenewal();
    mockProfile(target.profile);
    mockProfile(target.profile);

    await runCheck(target);
    const afterFirst = await readState(target.key.instagramAccountId);
    // The renewal interceptor answers once; a second renewal would find none and fail the run.
    await expect(runCheck(target)).resolves.toMatchObject({ renewal: 'not_due' });
    const afterSecond = await readState(target.key.instagramAccountId);

    expect(renewal.isDone()).toBe(true);
    expect(afterSecond.token?.encrypted_access_token).toBe(
      afterFirst.token?.encrypted_access_token,
    );
    expect(afterSecond.account?.token_expires_at?.getTime()).toBe(
      afterFirst.account?.token_expires_at?.getTime(),
    );
    expect(afterSecond.account?.connection_status).toBe('connected');
  });

  it('skips an account that is no longer connected', async () => {
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
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
    const target = await seedConnectedAccount({ tokenEndsInDays: 3 });
    const otherTeam = await createInstagramTeam();

    await expect(runCheck(target, otherTeam.organization.public_id)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'not_connected',
    });
  });

  it('the sweep hands one check per connected account to the queue, once a day (IA8)', async () => {
    const first = await seedConnectedAccount({ tokenEndsInDays: 30 });
    const otherTeam = await createInstagramTeam();
    const second = await seedConnectedAccount({
      tokenEndsInDays: 30,
      organization: otherTeam.organization,
    });
    const brokenTeam = await createInstagramTeam();
    const broken = await seedConnectedAccount({
      tokenEndsInDays: 30,
      organization: brokenTeam.organization,
    });
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
