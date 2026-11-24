import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';

const { scheduleCommitDispatchMock, recordOutboxEmailMock, isMailConfiguredMock } = vi.hoisted(
  () => ({
    scheduleCommitDispatchMock: vi.fn(),
    recordOutboxEmailMock: vi.fn(),
    isMailConfiguredMock: vi.fn(),
  }),
);

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, scheduleCommitDispatch: scheduleCommitDispatchMock };
});
// No Postgres in the unit lane: each savepoint runs its callback directly.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withSavepoint: vi.fn(async (callback: () => Promise<unknown>) => callback()),
}));
vi.mock('@/infrastructure/mail/queues/mail.queue.js', () => ({
  recordOutboxEmail: recordOutboxEmailMock,
}));
vi.mock('@/infrastructure/mail/mail.service.js', () => ({
  isMailConfigured: isMailConfiguredMock,
}));

import {
  buildNotificationEmailDedupeKey,
  createNotificationDispatch,
  type DispatchNotificationInput,
} from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';

const NOTIFICATION_PUBLIC_ID = 'ntf_9z3rura5kqvcv8zggriym';
const MAIL_OUTBOX_TOKEN = '6b1d2e8f-3c4a-4b5d-8e9f-0a1b2c3d4e5f'; // gitleaks:allow

type Choice = { user_id: number; notification_type: string; channel: string; is_enabled: boolean };

function setup({
  choices = [] as Choice[],
  mutedChannels = [] as string[],
  recipients = [
    { id: 1, publicId: 'usr_one', email: 'one@example.com' },
    { id: 2, publicId: 'usr_two', email: 'two@example.com' },
  ] as { id: number; publicId: string; email: string | null }[],
} = {}) {
  const repository = {
    findOrganizationPublicIdByOrganizationId: vi.fn(async () => 'org_public'),
    resolveRecipientsForDispatch: vi.fn(async () => recipients),
    listNotificationChoices: vi.fn(async () => choices),
    listMutedNotificationChannels: vi.fn(async () => mutedChannels),
    create: vi.fn(async () => ({ publicId: NOTIFICATION_PUBLIC_ID })),
  };
  const dispatch = createNotificationDispatch(repository as unknown as NotificationRepository);
  return { repository, dispatch };
}

function input(overrides: Partial<DispatchNotificationInput> = {}): DispatchNotificationInput {
  return {
    recipientUserIds: [1, 2],
    organization_id: 7,
    type: 'automation.stopped',
    title: 'Automation stopped',
    message: 'Body',
    action_url: 'https://app.example.com/automations',
    channels: ['in_app', 'email'],
    locale: 'en',
    dedupe_key: 'aut_once:stop-1',
    ...overrides,
  };
}

// The email template's own copy comes from the locale files.
beforeAll(async () => {
  await initializeI18nextForBackgroundWork();
});

describe('NotificationDispatch — the check before send (UN11, AC-14.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMailConfiguredMock.mockReturnValue(true);
    recordOutboxEmailMock.mockResolvedValue(MAIL_OUTBOX_TOKEN);
  });

  it('reads every recipient’s choices for the kind’s types in ONE query', async () => {
    const { dispatch, repository } = setup();
    await dispatch.createAndDispatchNotification({ input: input() });
    expect(repository.listNotificationChoices).toHaveBeenCalledExactlyOnceWith({
      userInternalIds: [1, 2],
      types: ['automation.stopped', 'instagram.reconnect_required'],
    });
  });

  it('with the defaults writes the inbox row carrying the email channel and the dedupe key', async () => {
    const { dispatch, repository } = setup();
    const result = await dispatch.createAndDispatchNotification({ input: input() });

    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 1,
        organization_id: 7,
        type: 'automation.stopped',
        data: { channels: ['in_app', 'email'], locale: 'en', dedupe_key: 'aut_once:stop-1' },
      }),
    );
    expect(scheduleCommitDispatchMock).toHaveBeenCalledWith({
      task: {
        type: 'notification',
        notificationPublicId: NOTIFICATION_PUBLIC_ID,
        organizationPublicId: 'org_public',
        userPublicId: 'usr_one',
      },
      options: undefined,
    });
    expect(recordOutboxEmailMock).not.toHaveBeenCalled();
    expect(result.inAppUserPublicIds).toEqual(['usr_one', 'usr_two']);
  });

  it('in-app off + email on: one email with the caller’s dedupe key, no inbox row', async () => {
    const { dispatch, repository } = setup({
      choices: [
        {
          user_id: 1,
          notification_type: 'automation.stopped',
          channel: 'IN_APP',
          is_enabled: false,
        },
        {
          user_id: 1,
          notification_type: 'instagram.reconnect_required',
          channel: 'IN_APP',
          is_enabled: false,
        },
      ],
      recipients: [{ id: 1, publicId: 'usr_one', email: 'one@example.com' }],
    });

    const result = await dispatch.createAndDispatchNotification({
      input: input({ recipientUserIds: [1] }),
    });

    expect(repository.create).not.toHaveBeenCalled();
    expect(recordOutboxEmailMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'one@example.com',
        subject: 'Automation stopped',
        dedupeKey: 'notification:automation.stopped:aut_once:stop-1:usr_one',
      }),
    );
    expect(scheduleCommitDispatchMock).toHaveBeenCalledWith({
      task: { type: 'mail_outbox', mailOutboxToken: MAIL_OUTBOX_TOKEN, lane: 'bulk' },
      options: undefined,
    });
    expect(result.emailOnlyUserIds).toEqual([1]);
  });

  it('both off: nothing is written or sent', async () => {
    const { dispatch, repository } = setup({
      choices: ['IN_APP', 'EMAIL'].flatMap((channel) =>
        ['automation.stopped', 'instagram.reconnect_required'].map((notification_type) => ({
          user_id: 1,
          notification_type,
          channel,
          is_enabled: false,
        })),
      ),
      recipients: [{ id: 1, publicId: 'usr_one', email: 'one@example.com' }],
    });
    const result = await dispatch.createAndDispatchNotification({
      input: input({ recipientUserIds: [1] }),
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(recordOutboxEmailMock).not.toHaveBeenCalled();
    expect(scheduleCommitDispatchMock).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it('a kind’s default applies: contact details are in-app only unless chosen', async () => {
    const { dispatch, repository } = setup();
    await dispatch.createAndDispatchNotification({
      input: input({ type: 'contact.details_left' }),
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channels: ['in_app'] }) }),
    );
  });

  it('the organization’s mute wins over a person’s choice', async () => {
    const { dispatch, repository } = setup({ mutedChannels: ['IN_APP'] });
    await dispatch.createAndDispatchNotification({ input: input() });
    expect(repository.create).not.toHaveBeenCalled();
    expect(recordOutboxEmailMock).toHaveBeenCalledTimes(2);
  });

  it('billing email is locked on: sent whatever a stored row says', async () => {
    const { dispatch } = setup({
      choices: [
        {
          user_id: 1,
          notification_type: 'billing.payment_failed',
          channel: 'EMAIL',
          is_enabled: false,
        },
        {
          user_id: 1,
          notification_type: 'billing.payment_failed',
          channel: 'IN_APP',
          is_enabled: false,
        },
      ],
      recipients: [{ id: 1, publicId: 'usr_one', email: 'one@example.com' }],
    });
    await dispatch.createAndDispatchNotification({
      input: input({ recipientUserIds: [1], type: 'billing.payment_failed' }),
    });
    expect(recordOutboxEmailMock).toHaveBeenCalledOnce();
  });

  it('a type outside the grid (security.alert) goes out on every offered channel', async () => {
    const { dispatch, repository } = setup();
    await dispatch.createAndDispatchNotification({ input: input({ type: 'security.alert' }) });
    expect(repository.listNotificationChoices).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledTimes(2);
  });

  it('the emitter’s offered channels stay an upper bound (an in-app-only notice sends no email)', async () => {
    const { dispatch, repository } = setup();
    await dispatch.createAndDispatchNotification({ input: input({ channels: ['in_app'] }) });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channels: ['in_app'] }) }),
    );
  });

  it('one unresolved recipient is skipped and counted; all failing rethrows', async () => {
    const { dispatch } = setup({ recipients: [{ id: 1, publicId: 'usr_one', email: null }] });
    const result = await dispatch.createAndDispatchNotification({ input: input() });
    expect(result).toMatchObject({ inAppUserIds: [1], failedCount: 1 });

    await expect(
      dispatch.createAndDispatchNotification({ input: input({ recipientUserIds: [2] }) }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a missing organization fails before any write', async () => {
    const { dispatch, repository } = setup();
    repository.findOrganizationPublicIdByOrganizationId.mockResolvedValueOnce(null as never);
    await expect(dispatch.createAndDispatchNotification({ input: input() })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('the email dedupe key is the same for a replay — the outbox keeps it once', () => {
    const key = (userPublicId: string) =>
      buildNotificationEmailDedupeKey({ type: 'broadcast.done', dedupeKey: 'brd_1', userPublicId });
    expect(key('usr_one')).toBe('notification:broadcast.done:brd_1:usr_one');
    expect(key('usr_one')).toBe(key('usr_one'));
    expect(key('usr_two')).not.toBe(key('usr_one'));
  });
});

describe('createAndDispatchNotification (module singleton)', () => {
  it('refuses to run before the container wired the dispatch', async () => {
    vi.resetModules();
    const fresh = await import(
      '@/domains/notify/sub-domains/notification/notification-dispatch.service.js'
    );
    await expect(fresh.createAndDispatchNotification({ input: input() })).rejects.toThrow(
      /Notification dispatch is not configured/,
    );
  });
});
