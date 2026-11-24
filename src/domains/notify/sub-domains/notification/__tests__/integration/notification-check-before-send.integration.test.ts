import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';
import { user_notification_preferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.schema.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  createAndDispatchNotification,
  type DispatchNotificationInput,
} from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';

/**
 * The check before each send (feat-instagram-dm-sending UN11, AC-14.7) against Postgres: the
 * recipients' choices are read through the SECURITY DEFINER resolver from the organization's own
 * RLS context, an email without an inbox row lands in the mail outbox with the caller's dedupe
 * key, and a replay sends nothing twice. Runs as the RLS-subject role in `pnpm test:rls-role`.
 */
describe('Notification dispatch — the check before send (UN11)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The app wires the dispatch singleton (notify container), as in the API and the worker.
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function setup() {
    const owner = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    return { owner, member, organization };
  }

  function dispatchIn(
    organizationPublicId: string,
    input: Omit<DispatchNotificationInput, 'title' | 'message' | 'locale' | 'channels'> &
      Partial<DispatchNotificationInput>,
  ) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
      callback: () =>
        createAndDispatchNotification({
          input: {
            title: 'Automation stopped',
            message: 'It stopped after repeated errors.',
            locale: 'en',
            channels: ['in_app', 'email'],
            ...input,
          },
        }),
    });
  }

  async function choose(options: {
    userId: number;
    types: string[];
    channel: string;
    isEnabled: boolean;
  }) {
    await getOperatorDatabase()
      .insert(user_notification_preferences)
      .values(
        options.types.map((notification_type) => ({
          user_id: options.userId,
          notification_type,
          channel: options.channel,
          is_enabled: options.isEnabled,
        })),
      );
  }

  async function rowsOf(organizationId: number, userId: number) {
    return getOperatorDatabase()
      .select({ data: notifications.data })
      .from(notifications)
      .where(
        and(eq(notifications.organization_id, organizationId), eq(notifications.user_id, userId)),
      );
  }

  async function outboxRows(dedupeKeyPrefix: string) {
    return getOperatorDatabase()
      .select({ to: mail_outbox.to_addresses, dedupeKey: mail_outbox.dedupe_key })
      .from(mail_outbox)
      .where(like(mail_outbox.dedupe_key, `${dedupeKeyPrefix}%`));
  }

  it('in-app off + email on: one email keyed by the caller’s dedupe key, no inbox row; a replay sends nothing twice', async () => {
    const { owner, member, organization } = await setup();
    await choose({
      userId: member.id,
      types: ['automation.stopped', 'instagram.reconnect_required'],
      channel: 'IN_APP',
      isEnabled: false,
    });
    const input = {
      recipientUserIds: [owner.id, member.id],
      organization_id: organization.id,
      type: 'automation.stopped' as const,
      dedupe_key: 'aut_check:stop-1',
    };

    const first = await dispatchIn(organization.public_id, input);
    expect(first.inAppUserIds).toEqual([owner.id]);
    expect(first.emailOnlyUserIds).toEqual([member.id]);
    expect(await rowsOf(organization.id, member.id)).toHaveLength(0);
    const ownerRows = await rowsOf(organization.id, owner.id);
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]!.data).toMatchObject({
      channels: ['in_app', 'email'],
      dedupe_key: 'aut_check:stop-1',
    });

    const memberKey = `notification:automation.stopped:aut_check:stop-1:${member.public_id}`;
    expect(await outboxRows(memberKey)).toEqual([{ to: [member.email], dedupeKey: memberKey }]);

    // The emitter's job runs again: the member's email converges on the same outbox row.
    await dispatchIn(organization.public_id, input);
    expect(await outboxRows(memberKey)).toHaveLength(1);
    expect(await rowsOf(organization.id, member.id)).toHaveLength(0);
  });

  it('both off: nothing is written for that person', async () => {
    const { owner, member, organization } = await setup();
    for (const channel of ['IN_APP', 'EMAIL']) {
      await choose({
        userId: member.id,
        types: ['broadcast.done', 'automation.backfill_done'],
        channel,
        isEnabled: false,
      });
    }
    const result = await dispatchIn(organization.public_id, {
      recipientUserIds: [owner.id, member.id],
      organization_id: organization.id,
      type: 'broadcast.done',
      dedupe_key: 'brd_check',
    });
    expect(result.skippedCount).toBe(1);
    expect(await rowsOf(organization.id, member.id)).toHaveLength(0);
    expect(
      await outboxRows(`notification:broadcast.done:brd_check:${member.public_id}`),
    ).toHaveLength(0);
    // The owner keeps the kind's default: in-app on, email off.
    const ownerRows = await rowsOf(organization.id, owner.id);
    expect(ownerRows[0]!.data).toMatchObject({ channels: ['in_app'] });
  });

  it('the organization’s mute wins over a person’s choice', async () => {
    const { owner, organization } = await setup();
    await getOperatorDatabase()
      .insert(organization_notification_policies)
      .values({
        public_id: generatePublicId('organizationNotificationPolicy'),
        organization_id: organization.id,
        notification_type: 'automation.stopped',
        channel: 'IN_APP',
        muted_until: new Date(Date.now() + 60 * 60 * 1000),
      });
    const result = await dispatchIn(organization.public_id, {
      recipientUserIds: [owner.id],
      organization_id: organization.id,
      type: 'automation.stopped',
      dedupe_key: 'aut_muted',
    });
    expect(result.inAppUserIds).toEqual([]);
    expect(result.emailOnlyUserIds).toEqual([owner.id]);
    expect(await rowsOf(organization.id, owner.id)).toHaveLength(0);
  });
});
