import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accountRepository, tokenRepository, instagramClient, taskQueue } = vi.hoisted(() => ({
  accountRepository: { findByPublicIdInOrganization: vi.fn() },
  tokenRepository: { findByConnection: vi.fn() },
  instagramClient: {
    subscribeInstagramWebhookFields: vi.fn(),
    readInstagramWebhookSubscribedFields: vi.fn(),
    setInstagramIceBreakers: vi.fn(),
    deleteInstagramIceBreakers: vi.fn(),
    probeInstagramMessageAccess: vi.fn(),
    readMetaAppSettings: vi.fn(() => ({ appId: '222' })),
  },
  taskQueue: { enqueueInstagramTask: vi.fn() },
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  PRINCIPAL_SCOPE: {
    JOB: (identity: Record<string, string>) => ({ ...identity, source: 'job' }),
  },
}));

// Each unit of work runs its callback with a stand-in handle; the repositories are stubs.
vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runOrganizationScopedWorkerJob: ({
    processor,
  }: {
    processor: (databaseHandle: unknown) => Promise<unknown>;
  }) => processor({}),
  runGlobalRetentionWorkerJob: (processor: (databaseHandle: unknown) => Promise<unknown>) =>
    processor({}),
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ...instagramClient,
  }),
);

vi.mock('@/domains/app/sub-domains/instagram-account/instagram-account.repository.js', () => ({
  createWorkerInstagramAccountRepository: () => accountRepository,
  createRetentionInstagramAccountRepository: () => ({ listConnectedForDailyCheck: vi.fn() }),
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js',
  () => ({ createWorkerChannelConnectionTokenRepository: () => tokenRepository }),
);

vi.mock(
  '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js',
  () => taskQueue,
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readMetaGraphErrorResponse } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import {
  INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
  INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
  INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME,
  enqueueInstagramWebhookSubscriptionChecks,
} from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-tasks.queue.js';
import {
  type InstagramAccountTaskServices,
  buildInstagramAccountTaskHandlers,
  buildInstagramIceBreakers,
  processInstagramAccountSetupTask,
  processInstagramStarterQuestionSyncTask,
  processInstagramWebhookSubscriptionCheckTask,
  runInstagramWebhookSubscriptionCheckSweep,
} from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-tasks.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * The account jobs on `instagram-tasks` (feat-instagram-dm-sending IA6, IAC3, ROUTE row R40) with
 * their database steps, Meta and the queue mocked: the set-up (WC-30, AC-1.7) and its retry ladder
 * 1/5/15/60 then hourly with one email, the subscription check (WC-25, AC-16.22) — a field off
 * re-runs the set-up — and the starter-question sync (WC-31, AC-6.11) writing the whole list, twice
 * landing in the same state.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop00000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop00000000000001';
const MINUTE = 60_000;

const refusedError = () =>
  readMetaGraphErrorResponse({
    httpStatus: 400,
    body: JSON.stringify({ error: { message: 'Unsupported request', code: 100 } }),
    retryAfterHeader: null,
  });
const tokenRefusedError = () =>
  readMetaGraphErrorResponse({
    httpStatus: 400,
    body: JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }),
    retryAfterHeader: null,
  });

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    public_id: ACCOUNT_PUBLIC_ID,
    organization_id: 7,
    channel_account_id: 9,
    connection_status: 'connected',
    instagram_user_id: '17841400000000001',
    username: 'acme.shop',
    channel_connection_id: 5,
    webhook_subscribed_at: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

const context = {
  jobId: 'job-1',
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => callback(),
  // The account jobs never put their ticket back (R42's return is for the sends).
  returnTicket: async (delayMilliseconds: number): Promise<never> => {
    throw new Error(`unexpected ticket return after ${delayMilliseconds} ms`);
  },
};

const markConnectionBroken = vi.fn();
const extensionService = {
  recordWebhookSubscribed: vi.fn(),
  recordWebhookSubscriptionLost: vi.fn(),
  recordStarterQuestionsSet: vi.fn(),
};
const listLiveStarterQuestions = vi.fn();
const lookForMissedComments = vi.fn();
const createOrganizationNotifications = vi.fn();
let isNoticeWired = true;

const services: InstagramAccountTaskServices = {
  accountService: { markConnectionBroken },
  extensionService,
  starterQuestionSource: { listLiveStarterQuestions },
  readMissedCommentPort: () => ({ lookForMissedComments }),
  readNoticeServices: () =>
    isNoticeWired
      ? {
          membershipService: { findActiveUserIdsWithPermission: vi.fn(async () => [3, 4]) },
          organizationSettingsService: {
            resolveDefaultLocaleForOrganization: vi.fn(async () => 'en' as const),
          },
          notificationService: { createOrganizationNotifications },
        }
      : null,
};

const setup = (tryNumber = 0) =>
  processInstagramAccountSetupTask({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, chainKey: 'setup-chain', tryNumber },
    context,
    services,
  });
const sync = (tryNumber = 0) =>
  processInstagramStarterQuestionSyncTask({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, chainKey: 'starters-chain', tryNumber },
    context,
    services,
  });
const check = () =>
  processInstagramWebhookSubscriptionCheckTask({
    organizationPublicId: ORGANIZATION_PUBLIC_ID,
    channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    context,
    services,
  });

const ALL_FIELDS = [
  'comments',
  'live_comments',
  'messages',
  'messaging_postbacks',
  'messaging_referral',
  'message_reactions',
];

beforeEach(() => {
  vi.clearAllMocks();
  isNoticeWired = true;
  accountRepository.findByPublicIdInOrganization.mockResolvedValue(connectedAccount());
  tokenRepository.findByConnection.mockResolvedValue({ encryptedAccessToken: 'v1:ciphertext' });
  instagramClient.subscribeInstagramWebhookFields.mockResolvedValue(undefined);
  instagramClient.setInstagramIceBreakers.mockResolvedValue(undefined);
  instagramClient.deleteInstagramIceBreakers.mockResolvedValue(undefined);
  instagramClient.probeInstagramMessageAccess.mockResolvedValue('on');
  instagramClient.readInstagramWebhookSubscribedFields.mockResolvedValue(ALL_FIELDS);
  instagramClient.readMetaAppSettings.mockReturnValue({ appId: '222' });
  listLiveStarterQuestions.mockResolvedValue([]);
  createOrganizationNotifications.mockResolvedValue({ createdCount: 2, deduplicated: false });
  taskQueue.enqueueInstagramTask.mockResolvedValue(undefined);
});

describe('the account set-up (WC-30, AC-1.7)', () => {
  it('subscribes the six fields, stamps the account, writes its starter questions and probes once', async () => {
    listLiveStarterQuestions.mockResolvedValue([
      { automationPublicId: 'aut_one', questions: ['Price?', 'Shipping?'] },
    ]);
    await expect(setup()).resolves.toEqual({
      outcome: 'set_up',
      starterQuestions: 'set',
      messageAccess: 'on',
    });
    expect(instagramClient.subscribeInstagramWebhookFields).toHaveBeenCalledTimes(1);
    expect(extensionService.recordWebhookSubscribed).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      instagramAccount: { organizationId: 7, instagramAccountId: 41 },
    });
    expect(instagramClient.setInstagramIceBreakers).toHaveBeenCalledWith(
      expect.objectContaining({
        iceBreakers: [
          { question: 'Price?', payload: 'starter:aut_one' },
          { question: 'Shipping?', payload: 'starter:aut_one' },
        ],
      }),
    );
    expect(extensionService.recordStarterQuestionsSet).toHaveBeenCalledWith(
      expect.objectContaining({ isSet: true }),
    );
    expect(instagramClient.probeInstagramMessageAccess).toHaveBeenCalledTimes(1);
  });

  it('leaves the starter questions alone when none is live, and logs message access off', async () => {
    instagramClient.probeInstagramMessageAccess.mockResolvedValue('off');
    await expect(setup()).resolves.toMatchObject({
      starterQuestions: 'none',
      messageAccess: 'off',
    });
    expect(instagramClient.setInstagramIceBreakers).not.toHaveBeenCalled();
    expect(instagramClient.deleteInstagramIceBreakers).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'app.instagram_account.setup.message_access_off',
    );
  });

  it('skips an account that is no longer connected, calling nothing', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      connectedAccount({ connection_status: 'revoked' }),
    );
    await expect(setup()).resolves.toEqual({ outcome: 'skipped', reason: 'not_connected' });
    expect(instagramClient.subscribeInstagramWebhookFields).not.toHaveBeenCalled();
  });

  it.each([
    [0, 1],
    [1, 5],
    [2, 15],
    [3, 60],
    [4, 60],
    [7, 60],
  ])('a refused try %i is tried again after %i minutes', async (tryNumber, minutes) => {
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(refusedError());
    await expect(setup(tryNumber)).resolves.toMatchObject({
      outcome: 'retrying',
      nextTryNumber: tryNumber + 1,
      delayMinutes: minutes,
    });
    expect(taskQueue.enqueueInstagramTask).toHaveBeenCalledWith({
      jobName: INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
      jobId: `setup-chain-try-${tryNumber + 1}`,
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      taskInput: {
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        chainKey: 'setup-chain',
        tryNumber: tryNumber + 1,
      },
      delayMilliseconds: minutes * MINUTE,
    });
    // The account stays connected and shown as not subscribed: nothing stamps or breaks it.
    expect(extensionService.recordWebhookSubscribed).not.toHaveBeenCalled();
    expect(markConnectionBroken).not.toHaveBeenCalled();
  });

  it('emails the owners once, when the 60-minute try failed too — never before or after', async () => {
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(refusedError());
    for (const tryNumber of [0, 1, 2, 3]) {
      await expect(setup(tryNumber)).resolves.toMatchObject({ notified: false });
    }
    await expect(setup(4)).resolves.toMatchObject({ notified: true });
    expect(createOrganizationNotifications).toHaveBeenCalledTimes(1);
    expect(createOrganizationNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: [3, 4],
        dedupeKey: 'setup-chain-failed',
        notification: expect.objectContaining({
          type: 'instagram.reconnect_required',
          channels: ['in_app', 'email'],
        }),
      }),
    );
    await expect(setup(5)).resolves.toMatchObject({ notified: false });
    expect(createOrganizationNotifications).toHaveBeenCalledTimes(1);
  });

  it('logs, and sends nothing, when the email services are not wired', async () => {
    isNoticeWired = false;
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(refusedError());
    await expect(setup(4)).resolves.toMatchObject({ outcome: 'retrying', notified: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'app.instagram_account.setup.notice_unwired',
    );
  });

  it('breaks the account at once when Meta refuses the token, without a retry', async () => {
    instagramClient.subscribeInstagramWebhookFields.mockRejectedValue(tokenRefusedError());
    await expect(setup()).resolves.toEqual({ outcome: 'broken' });
    expect(markConnectionBroken).toHaveBeenCalledWith(
      expect.objectContaining({ connectionStatus: 'error', requestId: 'job-1' }),
    );
    expect(taskQueue.enqueueInstagramTask).not.toHaveBeenCalled();
  });

  it('hands a refused starter-question write to its own sync chain and finishes the set-up', async () => {
    listLiveStarterQuestions.mockResolvedValue([
      { automationPublicId: 'aut_one', questions: ['Price?'] },
    ]);
    instagramClient.setInstagramIceBreakers.mockRejectedValue(refusedError());
    await expect(setup()).resolves.toMatchObject({
      outcome: 'set_up',
      starterQuestions: 'retrying',
    });
    expect(taskQueue.enqueueInstagramTask).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
        delayMilliseconds: MINUTE,
      }),
    );
  });

  it('run twice lands in the same state (twice = once)', async () => {
    await setup();
    await setup();
    expect(extensionService.recordWebhookSubscribed).toHaveBeenCalledTimes(2);
    expect(extensionService.recordWebhookSubscribed.mock.calls[0]).toEqual(
      extensionService.recordWebhookSubscribed.mock.calls[1],
    );
  });
});

describe('the starter-question sync (WC-31, AC-6.11)', () => {
  it("writes the account's whole list, oldest automation first, at most four", async () => {
    listLiveStarterQuestions.mockResolvedValue([
      { automationPublicId: 'aut_old', questions: ['A?', 'B?', 'C?'] },
      { automationPublicId: 'aut_new', questions: ['D?', 'E?'] },
    ]);
    await expect(sync()).resolves.toEqual({ outcome: 'synced', questionCount: 4 });
    expect(instagramClient.setInstagramIceBreakers).toHaveBeenCalledWith(
      expect.objectContaining({
        iceBreakers: [
          { question: 'A?', payload: 'starter:aut_old' },
          { question: 'B?', payload: 'starter:aut_old' },
          { question: 'C?', payload: 'starter:aut_old' },
          { question: 'D?', payload: 'starter:aut_new' },
        ],
      }),
    );
    expect(extensionService.recordStarterQuestionsSet).toHaveBeenCalledWith(
      expect.objectContaining({ isSet: true }),
    );
  });

  it('removes the list and empties the stamp when no starter automation is live', async () => {
    await expect(sync()).resolves.toEqual({ outcome: 'synced', questionCount: 0 });
    expect(instagramClient.deleteInstagramIceBreakers).toHaveBeenCalledTimes(1);
    expect(extensionService.recordStarterQuestionsSet).toHaveBeenCalledWith(
      expect.objectContaining({ isSet: false }),
    );
  });

  it('twice = once: two syncs write the same list', async () => {
    listLiveStarterQuestions.mockResolvedValue([
      { automationPublicId: 'aut_one', questions: ['Price?'] },
    ]);
    await sync();
    await sync();
    const [first, second] = instagramClient.setInstagramIceBreakers.mock.calls;
    expect(first).toEqual(second);
  });

  it('a refused write retries along the ladder and sends no email', async () => {
    instagramClient.deleteInstagramIceBreakers.mockRejectedValue(refusedError());
    await expect(sync(4)).resolves.toMatchObject({ outcome: 'retrying', notified: false });
    expect(taskQueue.enqueueInstagramTask).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
        jobId: 'starters-chain-try-5',
        delayMilliseconds: 60 * MINUTE,
      }),
    );
    expect(createOrganizationNotifications).not.toHaveBeenCalled();
    expect(extensionService.recordStarterQuestionsSet).not.toHaveBeenCalled();
  });

  it('builds the ice breakers with the starter payload the webhook classifier reads', () => {
    expect(
      buildInstagramIceBreakers([{ automationPublicId: 'aut_x', questions: ['Hi?'] }]),
    ).toEqual([{ question: 'Hi?', payload: 'starter:aut_x' }]);
  });
});

describe('the webhook subscription check (WC-25, AC-16.22)', () => {
  it('finds every field on and does nothing more', async () => {
    await expect(check()).resolves.toEqual({ outcome: 'subscribed', recovered: false });
    expect(instagramClient.readInstagramWebhookSubscribedFields).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '222' }),
    );
    expect(taskQueue.enqueueInstagramTask).not.toHaveBeenCalled();
  });

  it('a field off on a subscribed account: shown not subscribed, set-up again, team told, missed comments looked for', async () => {
    instagramClient.readInstagramWebhookSubscribedFields.mockResolvedValue(
      ALL_FIELDS.filter((field) => field !== 'comments'),
    );
    await expect(check()).resolves.toEqual({
      outcome: 'resubscribing',
      missingFields: ['comments'],
    });
    expect(extensionService.recordWebhookSubscriptionLost).toHaveBeenCalledTimes(1);
    expect(taskQueue.enqueueInstagramTask).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
        taskInput: expect.objectContaining({ tryNumber: 0 }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ missingFields: ['comments'] }),
      'app.instagram_account.webhook_subscription_lost',
    );
    expect(lookForMissedComments).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    });
  });

  it('leaves a not-yet-subscribed account to its set-up tries', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      connectedAccount({ webhook_subscribed_at: null }),
    );
    instagramClient.readInstagramWebhookSubscribedFields.mockResolvedValue([]);
    await expect(check()).resolves.toMatchObject({ outcome: 'setup_pending' });
    expect(taskQueue.enqueueInstagramTask).not.toHaveBeenCalled();
  });

  it('stamps a not-stamped account whose fields are all on', async () => {
    accountRepository.findByPublicIdInOrganization.mockResolvedValue(
      connectedAccount({ webhook_subscribed_at: null }),
    );
    await expect(check()).resolves.toEqual({ outcome: 'subscribed', recovered: true });
    expect(extensionService.recordWebhookSubscribed).toHaveBeenCalledTimes(1);
  });

  it('skips the window when Meta does not answer; breaks the account on a refused token', async () => {
    instagramClient.readInstagramWebhookSubscribedFields.mockRejectedValueOnce(refusedError());
    await expect(check()).resolves.toEqual({ outcome: 'unavailable' });
    instagramClient.readInstagramWebhookSubscribedFields.mockRejectedValueOnce(tokenRefusedError());
    await expect(check()).resolves.toEqual({ outcome: 'broken' });
    expect(markConnectionBroken).toHaveBeenCalledTimes(1);
  });
});

describe('the handlers and the 10-minute sweep', () => {
  it('registers the three account jobs as Meta-calling task handlers', () => {
    const handlers = buildInstagramAccountTaskHandlers(services);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        INSTAGRAM_ACCOUNT_SETUP_JOB_NAME,
        INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
        INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME,
      ].sort(),
    );
    for (const handler of Object.values(handlers)) expect(handler.callsMeta).toBe(true);
  });

  it('adds nothing while this deployment may not send (the task worker is off)', async () => {
    await expect(runInstagramWebhookSubscriptionCheckSweep()).resolves.toEqual({
      outcome: 'skipped',
      reason: 'sending_disabled',
    });
  });

  it('one check per account and window, spread by account id', async () => {
    const windowStart = new Date('2026-11-25T10:10:00.000Z');
    await enqueueInstagramWebhookSubscriptionChecks({
      targets: [
        { id: 41, organizationPublicId: ORGANIZATION_PUBLIC_ID, channelAccountPublicId: 'cha_a' },
        { id: 641, organizationPublicId: ORGANIZATION_PUBLIC_ID, channelAccountPublicId: 'cha_b' },
      ],
      windowStart,
    });
    expect(taskQueue.enqueueInstagramTask.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        jobName: INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_JOB_NAME,
        jobId: `subscription-check-cha_a-${windowStart.getTime()}`,
        delayMilliseconds: 41_000,
      }),
      expect.objectContaining({
        jobId: `subscription-check-cha_b-${windowStart.getTime()}`,
        delayMilliseconds: 41_000,
      }),
    ]);
  });
});
