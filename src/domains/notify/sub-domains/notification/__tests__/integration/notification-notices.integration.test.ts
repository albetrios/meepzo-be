import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getBullMQKeyPrefix,
  getBullMQProducerConnectionOptions,
} from '@/infrastructure/queue/connection.js';
import {
  notifyOrganizationKind,
  sendTeamAlertEmail,
} from '@/domains/notify/sub-domains/notification/notification-notice.service.js';
import {
  type WeeklySummary,
  processNotificationWeeklySummaryJob,
  runNotificationWeeklySummarySweepJob,
} from '@/domains/notify/sub-domains/notification/workers/notification-weekly-summary.processor.js';
import { processNotificationContactDetailsJob } from '@/domains/notify/sub-domains/notification/workers/notification-contact-details.processor.js';
import {
  buildNotificationContactDetailsJobId,
  closeNotificationContactDetailsQueue,
  enqueueNotificationContactDetails,
} from '@/domains/notify/sub-domains/notification/queues/notification-contact-details.queue.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The notices of 11.D and the kinds' recipients against Postgres (feat-instagram-dm-sending UN12,
 * UN13, UN2, WC-58, WC-63, ROUTE row R53 — AC-14.8, AC-14.9, AC-8.8): the weekly summary's sweep
 * by each organization's own Monday 09:00, the summary once per member and week, the grouped
 * contact-details note in-app only by default, one pending note per account, the "past comments
 * done" notice to who started it plus Owner and Admin, and the team's alert email.
 */
describe('Notification notices — weekly summary, grouped notes, kinds (R53)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The app wires the dispatch, the recipients resolver and the notices (notify container).
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await closeNotificationContactDetailsQueue();
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** An organization with an Owner (every code), an Editor (`automation:update`) and a Viewer. */
  async function setupTeam(timezone = 'UTC') {
    await seedAllPermissions();
    const owner = await createTestUser();
    const editor = await createTestUser();
    const viewer = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    await operatorQuery`UPDATE tenancy.organizations SET timezone = ${timezone} WHERE id = ${organization.id}`;
    const ownerRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [
        APP_PERMISSIONS.AUTOMATION_UPDATE,
        BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
        TENANCY_PERMISSIONS.MEMBERSHIP_UPDATE,
      ],
    });
    const editorRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [APP_PERMISSIONS.AUTOMATION_UPDATE],
    });
    const viewerRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
    });
    await createMembership({
      userId: owner.id,
      organizationId: organization.id,
      roleId: ownerRole.id,
    });
    await createMembership({
      userId: editor.id,
      organizationId: organization.id,
      roleId: editorRole.id,
    });
    await createMembership({
      userId: viewer.id,
      organizationId: organization.id,
      roleId: viewerRole.id,
    });
    return { owner, editor, viewer, organization };
  }

  async function inboxOf(organizationId: number, type: string) {
    return operatorQuery<{ user_id: number; message: string; data: Record<string, unknown> }[]>`
      SELECT user_id::int AS user_id, message, data FROM notify.notifications
      WHERE organization_id = ${organizationId} AND type = ${type} ORDER BY user_id`;
  }

  async function outboxWith(prefix: string) {
    return operatorQuery<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM auth.mail_outbox WHERE dedupe_key LIKE ${`${prefix}%`} ORDER BY dedupe_key`;
  }

  const busyWeek: WeeklySummary = {
    accounts: [
      {
        channelAccountPublicId: 'cha_weeklysummarytest001',
        username: 'acme.shop',
        runsStarted: 12,
        directMessagesSent: 30,
        tappedPercent: 25,
        newContacts: 5,
        emailsCollected: 3,
        phonesCollected: 1,
        topAutomationName: 'Price reply',
      },
    ],
    monthUsed: 400,
    monthLimit: 1000,
  };

  it('the sweep adds a summary for an organization at Monday 09:30 in its time zone, and none at 10:00 or for a personal one (AC-14.8)', async () => {
    const { organization, owner } = await setupTeam('America/New_York');
    await createTestOrganization({ ownerUserId: owner.id, type: 'PERSONAL' });
    const enqueue = vi.fn(async () => undefined);

    // 2026-11-23 is a Monday; 14:30 UTC is 09:30 in New York (EST).
    await runNotificationWeeklySummarySweepJob({ now: new Date('2026-11-23T14:30:00Z'), enqueue });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      organizationPublicId: organization.public_id,
      weekStart: '2026-11-23',
    });

    enqueue.mockClear();
    await runNotificationWeeklySummarySweepJob({ now: new Date('2026-11-23T15:00:00Z'), enqueue });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a busy week emails every member once — in-app off by default — and a second run sends nothing more; a quiet week sends nothing (AC-14.8)', async () => {
    const { organization } = await setupTeam();
    const jobData = { organizationPublicId: organization.public_id, weekStart: '2026-11-23' };
    const prefix = `notification:report.weekly_summary:weekly:${organization.public_id}:2026-11-23:`;

    const quiet = await processNotificationWeeklySummaryJob({
      jobData,
      port: {
        readWeeklySummary: async () => ({
          accounts: [
            {
              ...busyWeek.accounts[0]!,
              runsStarted: 0,
              directMessagesSent: 0,
              newContacts: 0,
              emailsCollected: 0,
              phonesCollected: 0,
            },
          ],
          monthUsed: 400,
          monthLimit: 1000,
        }),
      },
    });
    expect(quiet).toEqual({ outcome: 'quiet' });
    expect(await outboxWith(prefix)).toHaveLength(0);

    const port = {
      readWeeklySummary: vi.fn(async (_input: { since: Date; until: Date }) => busyWeek),
    };
    const first = await processNotificationWeeklySummaryJob({ jobData, port });
    expect(first).toMatchObject({ outcome: 'sent', recipientCount: 3 });
    expect(await outboxWith(prefix)).toHaveLength(3);
    expect(await inboxOf(organization.id, 'report.weekly_summary')).toHaveLength(0);

    // A restart runs the job again: the outbox keeps one email per member.
    await processNotificationWeeklySummaryJob({ jobData, port });
    expect(await outboxWith(prefix)).toHaveLength(3);
    const [since, until] = [
      port.readWeeklySummary.mock.calls[0]![0]!.since,
      port.readWeeklySummary.mock.calls[0]![0]!.until,
    ];
    expect(until.getTime() - since.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('three details in an hour make one in-app note of 3 for Owner and Editor, no email by default; none left makes nothing (AC-14.9)', async () => {
    const { organization, owner, editor } = await setupTeam();
    const jobData = {
      organizationPublicId: organization.public_id,
      channelAccountPublicId: 'cha_contactdetailstest01',
      windowStartedAt: '2026-11-23T10:00:00.000Z',
    };

    const none = await processNotificationContactDetailsJob({
      jobData,
      port: { countContactsWithDetailsLeft: async () => ({ count: 0, username: 'acme.shop' }) },
    });
    expect(none).toEqual({ outcome: 'skipped', reason: 'none_left' });

    const sent = await processNotificationContactDetailsJob({
      jobData,
      port: { countContactsWithDetailsLeft: async () => ({ count: 3, username: 'acme.shop' }) },
    });
    expect(sent).toMatchObject({ outcome: 'sent', count: 3 });
    const inbox = await inboxOf(organization.id, 'contact.details_left');
    expect(inbox.map((row) => row.user_id).sort()).toEqual([owner.id, editor.id].sort());
    expect(inbox[0]!.message).toBe('3 new contacts left details on @acme.shop.');
    expect(await outboxWith('notification:contact.details_left:')).toHaveLength(0);
  });

  it('one pending note per account: a second detail adds nothing, a detail after the note opens a new window (UN13)', async () => {
    const queue = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection: getBullMQProducerConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
    });
    try {
      const account = `cha_${String(Date.now()).padStart(21, '0')}`;
      const jobId = buildNotificationContactDetailsJobId(account);
      await queue.remove(jobId);
      const first = new Date();
      await enqueueNotificationContactDetails({
        organizationPublicId: 'org_contactdetailstest01',
        channelAccountPublicId: account,
        at: first,
      });
      await enqueueNotificationContactDetails({
        organizationPublicId: 'org_contactdetailstest01',
        channelAccountPublicId: account,
        at: new Date(first.getTime() + 60_000),
      });
      const pending = await queue.getJob(jobId);
      expect(pending?.data.windowStartedAt).toBe(first.toISOString());
      expect(await pending?.isDelayed()).toBe(true);

      // The note ran (a finished note is removed): the next detail starts a new window.
      await pending?.remove();
      const later = new Date(first.getTime() + 2 * 60 * 60 * 1000);
      await enqueueNotificationContactDetails({
        organizationPublicId: 'org_contactdetailstest01',
        channelAccountPublicId: account,
        at: later,
      });
      expect((await queue.getJob(jobId))?.data.windowStartedAt).toBe(later.toISOString());
      await queue.remove(jobId);
    } finally {
      await queue.close();
    }
  });

  it('"past comments done" goes in-app to who started it and the Owner, never the Viewer, and emails no one by default (AC-8.8)', async () => {
    const { organization, owner, editor } = await setupTeam();
    const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });
    const notified = await withAppDatabaseContext({
      scope,
      callback: () =>
        notifyOrganizationKind({
          scope,
          type: 'automation.backfill_done',
          copy: {
            key: 'automationBackfillDone',
            values: { automationName: 'Price reply', found: 40, matched: 12, queuedCount: 12 },
          },
          dedupeKey: 'backfill-done:abf_noticetest0000000001',
          subjectUserId: editor.id,
        }),
    });
    expect(notified.recipientCount).toBe(2);
    const inbox = await inboxOf(organization.id, 'automation.backfill_done');
    expect(inbox.map((row) => row.user_id).sort()).toEqual([owner.id, editor.id].sort());
    expect(inbox[0]!.message).toBe(
      'Price reply finished reading past comments: 40 found, 12 matched, 12 replies queued.',
    );
    expect(await outboxWith('notification:automation.backfill_done:')).toHaveLength(0);
  });

  it('a team alert emails the team once per key', async () => {
    const values = {
      callback: 'data_deletion',
      provider: 'meta',
      providerId: '17841400000000001',
      confirmationCode: 'abc123',
      requestId: 'req-1',
    };
    const first = await sendTeamAlertEmail({
      key: 'metaCallbackUnmatched',
      values,
      dedupeKey: 'meta-callback-unmatched:data_deletion:meta:17841400000000001',
    });
    expect(first).toBeGreaterThan(0);
    await sendTeamAlertEmail({
      key: 'metaCallbackUnmatched',
      values,
      dedupeKey: 'meta-callback-unmatched:data_deletion:meta:17841400000000001',
    });
    expect(
      await outboxWith('team-alert:meta-callback-unmatched:data_deletion:meta:17841400000000001:'),
    ).toHaveLength(first);
  });
});
