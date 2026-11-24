import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  NOTIFICATION_QUEUE_NAME,
  type NotificationJobData,
  closeNotificationQueue,
} from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { processNotificationJob } from '@/domains/notify/sub-domains/notification/workers/notification.worker.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createDomainContainers, type DomainContainers } from '@/worker-containers.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import {
  type InstagramAccountKey,
  InstagramAccountRepository,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import {
  INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
  type InstagramReconnectNoticeJobData,
  closeInstagramReconnectNoticeQueue,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { processInstagramReconnectNoticeJob } from '@/domains/app/sub-domains/instagram-account/workers/instagram-reconnect-notice.processor.js';
import {
  type InstagramTeamFixture,
  type TestInstagramProfile,
  buildInstagramProfile,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/**
 * The reconnect notice (launch R7 — routes-final § 1 IA9, IAC9; AC-11.7–AC-11.10) against real
 * Postgres and Redis: only the guarded change that wins enqueues, after its commit, one notice job
 * per account and break; the job sends an in-app notification (with the email channel) in the
 * organization's language to every active member holding `instagram-account:manage`, once; a new
 * break after a reconnect is told again.
 */

describe('Instagram reconnect notice (IA9)', () => {
  let containers: DomainContainers;
  let team: InstagramTeamFixture;
  const noticeQueue = new Queue<InstagramReconnectNoticeJobData>(
    INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    { connection: getBullMQConnectionOptions(), prefix: getBullMQKeyPrefix() },
  );
  const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
    connection: getBullMQConnectionOptions(),
    prefix: getBullMQKeyPrefix(),
  });

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
    containers = createDomainContainers();
  });

  afterAll(async () => {
    await closeInstagramReconnectNoticeQueue();
    await noticeQueue.close();
    await closeNotificationQueue();
    await notificationQueue.close();
  });

  beforeEach(async () => {
    // Start from an empty queue: an earlier file on this Vitest worker (account, settings) breaks
    // connections too, and its notice jobs share this worker's queue prefix.
    await noticeQueue.obliterate({ force: true });
    await notificationQueue.obliterate({ force: true });
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
  });

  afterEach(async () => {
    await noticeQueue.obliterate({ force: true });
  });

  const scope = () =>
    PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: team.organization.public_id });

  /** Connects `profile` (or a new one) the way the pick does — a reconnect reuses the row. */
  async function connectAccount(
    profile: TestInstagramProfile = buildInstagramProfile(),
  ): Promise<{ key: InstagramAccountKey; profile: TestInstagramProfile }> {
    const connection = await insertChannelConnection({
      organizationId: team.organization.id,
      plainToken: 'EAAG-reconnect-notice-token',
    });
    return withAppDatabaseContext({
      scope: scope(),
      callback: async () => {
        const channelAccount = await insertChannelAccount({
          organizationId: team.organization.id,
          providerAccountId: profile.user_id,
          channelConnectionId: connection.id,
        });
        const account = await new InstagramAccountRepository().upsertAtPick(
          buildInstagramPickValues({
            organizationId: team.organization.id,
            channelAccountId: channelAccount.id,
            instagramUserId: profile.user_id,
            username: profile.username,
          }),
        );
        const key = { organizationId: team.organization.id, instagramAccountId: account.id };
        return { key, profile };
      },
    });
  }

  function breakConnection(
    key: InstagramAccountKey,
    connectionStatus: 'expired' | 'error' = 'error',
  ) {
    return containers.appDomain.instagramAccountService.markConnectionBroken({
      scope: scope(),
      instagramAccount: key,
      connectionStatus,
    });
  }

  async function noticeJobs() {
    return noticeQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'completed']);
  }

  function runNotice(jobData: InstagramReconnectNoticeJobData) {
    return processInstagramReconnectNoticeJob({
      jobData,
      services: {
        membershipService: containers.tenancyDomain.membershipService,
        organizationSettingsService: containers.tenancyDomain.organizationSettingsService,
        notificationService: containers.notifyDomain.notificationService,
      },
    });
  }

  async function readNotices() {
    return operatorQuery<
      Array<{
        user_id: string;
        type: string;
        title: string;
        message: string;
        action_url: string | null;
        data: { channels?: string[]; locale?: string; dedupe_key?: string };
      }>
    >`
      SELECT user_id, type, title, message, action_url, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} ORDER BY id`;
  }

  it('enqueues one notice per break: only the guarded change that wins does (AC-11.8)', async () => {
    const { key } = await connectAccount();

    const winner = await breakConnection(key, 'error');
    const loser = await breakConnection(key, 'expired');

    expect(winner?.connection_status).toBe('error');
    expect(loser).toBeNull();
    const jobs = await noticeJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({
      organizationPublicId: team.organization.public_id,
      instagramAccountPublicId: winner?.public_id,
      connectionStatus: 'error',
    });
  });

  it('enqueues nothing when the break rolls back with the unit of work around it', async () => {
    const { key } = await connectAccount();

    await expect(
      withAppDatabaseContext({
        scope: scope(),
        callback: async () => {
          await breakConnection(key);
          throw new Error('the caller failed after the break');
        },
      }),
    ).rejects.toThrow('the caller failed after the break');

    expect(await noticeJobs()).toHaveLength(0);
    const [row] = await operatorQuery<Array<{ connection_status: string }>>`
      SELECT c.connection_status FROM app.instagram_accounts AS i
      INNER JOIN app.channel_accounts AS c
        ON c.organization_id = i.organization_id AND c.id = i.channel_account_id
      WHERE i.id = ${key.instagramAccountId}`;
    expect(row?.connection_status).toBe('connected');
  });

  it('tells every active holder of instagram-account:manage, in the app and by email, once (AC-11.7, AC-11.9)', async () => {
    // A custom role holding the code is told; a suspended holder is not.
    const customRole = await createRoleWithPermissions({
      organizationId: team.organization.id,
      permissionCodes: [APP_PERMISSIONS.INSTAGRAM_ACCOUNT_MANAGE],
    });
    const customHolder = await createTestUser();
    await createMembership({
      userId: customHolder.id,
      organizationId: team.organization.id,
      roleId: customRole.id,
    });
    const suspendedHolder = await createTestUser();
    await createMembership({
      userId: suspendedHolder.id,
      organizationId: team.organization.id,
      roleId: customRole.id,
      status: MEMBERSHIP_STATUS.SUSPENDED,
    });
    const { key } = await connectAccount();
    await breakConnection(key);
    const [job] = await noticeJobs();
    if (job === undefined) throw new Error('no notice job was enqueued');

    // Owner, Admin and the custom holder — not the Editor, not the suspended holder.
    await expect(runNotice(job.data)).resolves.toEqual({ outcome: 'sent', recipientCount: 3 });

    const notices = await readNotices();
    const recipients = notices.map((notice) => Number(notice.user_id));
    expect(recipients).toHaveLength(3);
    expect(recipients).toContain(team.owner.id);
    expect(recipients).toContain(customHolder.id);
    expect(recipients).not.toContain(team.editor.id);
    expect(recipients).not.toContain(suspendedHolder.id);
    for (const notice of notices) {
      expect(notice.type).toBe('instagram.reconnect_required');
      expect(notice.title).toBe('Reconnect Instagram');
      expect(notice.action_url).toMatch(/\/instagram$/);
      expect(notice.data.channels).toEqual(['in_app', 'email']);
      expect(notice.data.locale).toBe('en');
    }

    // The same job run again (a stalled job after its commit) sends nothing more.
    await expect(runNotice(job.data)).resolves.toEqual({ outcome: 'deduplicated' });
    expect(await readNotices()).toHaveLength(3);
  });

  it('enqueues one dispatch job per recipient, and each sends that recipient one email (AC-11.7)', async () => {
    const { key } = await connectAccount();
    await breakConnection(key);
    const [job] = await noticeJobs();
    if (job === undefined) throw new Error('no notice job was enqueued');

    await runNotice(job.data);

    // Owner and Admin: one notification each …
    const notices = await operatorQuery<
      Array<{ public_id: string; user_public_id: string; email: string }>
    >`
      SELECT notifications.public_id, users.public_id AS user_public_id, users.email
      FROM notify.notifications AS notifications
      JOIN auth.users AS users ON users.id = notifications.user_id
      WHERE notifications.organization_id = ${team.organization.id} ORDER BY notifications.id`;
    expect(notices).toHaveLength(2);
    // … one dispatch job each, named by its notification and carrying public ids only …
    const dispatchJobs = await notificationQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'prioritized',
      'completed',
    ]);
    expect(dispatchJobs.map((dispatchJob) => dispatchJob.id).sort()).toEqual(
      notices.map((notice) => notice.public_id).sort(),
    );
    for (const notice of notices) {
      const dispatchJob = dispatchJobs.find(({ id }) => id === notice.public_id);
      expect(dispatchJob?.data).toMatchObject({
        notificationPublicId: notice.public_id,
        organizationPublicId: team.organization.public_id,
        userPublicId: notice.user_public_id,
      });
    }
    // … and each job puts one email to its recipient in the mail outbox.
    for (const dispatchJob of dispatchJobs) {
      await expect(processNotificationJob({ jobData: dispatchJob.data })).resolves.toEqual({
        outcome: 'dispatched',
        channels: ['in_app:persisted', expect.stringMatching(/^email:/)],
      });
    }
    const emails = await operatorQuery<Array<{ to_addresses: string[]; subject: string }>>`
      SELECT to_addresses, subject FROM auth.mail_outbox`;
    expect(emails.map((email) => email.subject)).toEqual([
      'Reconnect Instagram',
      'Reconnect Instagram',
    ]);
    expect(emails.flatMap((email) => email.to_addresses).sort()).toEqual(
      notices.map((notice) => notice.email).sort(),
    );
  });

  it("writes the notice in the organization's language (AC-11.7)", async () => {
    await containers.tenancyDomain.organizationSettingsService.update({
      scope: scope(),
      body: { default_locale: 'es' },
    });
    const { key } = await connectAccount();
    await breakConnection(key, 'expired');
    const [job] = await noticeJobs();
    if (job === undefined) throw new Error('no notice job was enqueued');

    await runNotice(job.data);

    const notices = await readNotices();
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.title).toBe('Vuelve a conectar Instagram');
      expect(notice.data.locale).toBe('es');
    }
  });

  it('a new break after a reconnect is told again (AC-11.8, AC-11.10)', async () => {
    const { key, profile } = await connectAccount();
    await breakConnection(key);
    const [firstJob] = await noticeJobs();
    if (firstJob === undefined) throw new Error('no notice job was enqueued');
    await runNotice(firstJob.data);
    const toldOnce = (await readNotices()).length;

    // Reconnecting the same Instagram account makes it connected again (AC-11.10) ...
    await connectAccount(profile);
    const [reconnected] = await operatorQuery<Array<{ connection_status: string }>>`
      SELECT c.connection_status FROM app.instagram_accounts AS i
      INNER JOIN app.channel_accounts AS c
        ON c.organization_id = i.organization_id AND c.id = i.channel_account_id
      WHERE i.id = ${key.instagramAccountId}`;
    expect(reconnected?.connection_status).toBe('connected');
    // ... so the next break is a new one, with its own job and its own notices.
    await breakConnection(key, 'expired');
    const jobs = await noticeJobs();
    expect(jobs).toHaveLength(2);
    const secondJob = jobs.find((job) => job.id !== firstJob.id);
    if (secondJob === undefined) throw new Error('the second break enqueued no notice');

    await expect(runNotice(secondJob.data)).resolves.toMatchObject({ outcome: 'sent' });
    expect(await readNotices()).toHaveLength(toldOnce * 2);
  });

  it('tells nobody about a break that is over by the time its job runs', async () => {
    const { key, profile } = await connectAccount();
    await breakConnection(key);
    const [job] = await noticeJobs();
    if (job === undefined) throw new Error('no notice job was enqueued');
    await connectAccount(profile);

    await expect(runNotice(job.data)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'break_over',
    });
    expect(await readNotices()).toHaveLength(0);
  });
});
