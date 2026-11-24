import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import { ProviderOutageError } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type {
  InstagramAutomationAccountAccess,
  InstagramWebhookProcessingAccount,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import { InstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  type InstagramWebhookAccountJobResult,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
import {
  insertContact,
  insertInstagramAccount,
  readAccountContactRows,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
  nextInstagramObjectId,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertTestInstagramWebhookEvent,
  readChannelAccountIdOfInstagramAccount,
  readTestInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Instagram webhook event processing end to end against the database (routes-final § 4.A
 * WH12–WH14 — AUC14's integration part): one stored event fixture per trigger — a comment, the
 * button click on its opening message, a DM, a story reply — claimed, its contact recorded first,
 * handled by the real run engine (sub-domain 3) with a fake Instagram client, and marked; then the
 * failure rules on the real claim: a skipped event never runs after the switch is back on, the 5th
 * failure marks the event `failed` and the next one runs, an event that ends failed or is skipped on a
 * retry fails the runs it left running (D47, D51), an Instagram outage spends no attempt. Every unit
 * runs in the organization's own job scope, so the suite also holds under `pnpm test:rls-role`.
 */

const SENDER = '17841400000000777';
const ACCOUNT_INSTAGRAM_USER_ID = '9000000000000001';

/** The engine's fake Instagram client: every send and public reply recorded. */
function fakeEngineInstagramClient() {
  const sentMessages: Array<{ recipient: unknown; message: Record<string, unknown> }> = [];
  const client: AutomationInstagramClient = {
    sendInstagramMessage: vi.fn(async ({ recipient, message }) => {
      sentMessages.push({ recipient, message: message as Record<string, unknown> });
      return { messageId: `m${sentMessages.length}`, recipientId: null };
    }),
    replyToInstagramComment: vi.fn(async () => ({ instagramCommentReplyId: '1' })),
    readInstagramUserProfile: vi.fn(async () => ({
      name: null,
      username: 'jordan.lee',
      profilePictureUrl: null,
      followerCount: null,
      isUserFollowingBusiness: null,
    })),
  };
  return { client, sentMessages };
}

describe('processInstagramWebhookAccountJob (database, the real run engine)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string };
  let processingAccount: InstagramWebhookProcessingAccount;
  let accountService: {
    findWebhookProcessingAccount: ReturnType<typeof vi.fn>;
    findAutomationAccountAccess: ReturnType<typeof vi.fn>;
    markConnectionBroken: ReturnType<typeof vi.fn>;
  };
  let engineInstagram: ReturnType<typeof fakeEngineInstagramClient>;
  let processingInstagram: {
    readInstagramUserProfile: ReturnType<typeof vi.fn>;
    readInstagramMediaItem: ReturnType<typeof vi.fn>;
  };
  let services: Parameters<typeof processInstagramWebhookAccountJob>[0]['services'];

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    processingAccount = {
      instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
      channelAccountId: await readChannelAccountIdOfInstagramAccount(account.id),
      instagramAccountPublicId: account.public_id,
      connectionStatus: 'connected',
      isAutomationEnabled: true,
      encryptedAccessToken: 'v1:fake-ciphertext',
    };
    const access: InstagramAutomationAccountAccess = {
      instagramAccount: processingAccount.instagramAccount,
      channelAccountId: processingAccount.channelAccountId,
      instagramAccountPublicId: account.public_id,
      instagramUserId: '17841400000000999',
      username: 'acme.shop',
      connectionStatus: 'connected',
      encryptedAccessToken: 'v1:fake-ciphertext',
      settings: null,
    };
    accountService = {
      findWebhookProcessingAccount: vi.fn(async () => processingAccount),
      findAutomationAccountAccess: vi.fn(async ({ instagramAccountPublicId }) =>
        instagramAccountPublicId === account.public_id ? access : null,
      ),
      markConnectionBroken: vi.fn(async () => null),
    };
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    const contactService = new ContactService(
      new ContactRepository(),
      organizationService,
      [],
      async () => null,
    );
    engineInstagram = fakeEngineInstagramClient();
    processingInstagram = {
      readInstagramUserProfile: vi.fn(async () => ({
        name: 'Jordan Lee',
        username: 'jordan.lee',
        profilePictureUrl: null,
        followerCount: 42,
        isUserFollowingBusiness: null,
      })),
      readInstagramMediaItem: vi.fn(async ({ instagramMediaId }) => ({
        id: instagramMediaId,
        media_type: 'IMAGE',
        media_product_type: 'FEED',
        timestamp: '2026-11-21T08:00:00+0000',
      })),
    };
    services = {
      instagramAccountService: accountService as unknown as InstagramAccountService,
      instagramWebhookEventService: new InstagramWebhookEventService(
        new InstagramWebhookEventRepository(),
        organizationService,
      ),
      contactService,
      instagramMediaService: new InstagramMediaService(
        new InstagramMediaRepository(),
        accountService as unknown as InstagramAccountService,
        { markConnectionBroken: async () => false },
      ),
      automationService: new AutomationService(
        new AutomationRepository(),
        accountService as unknown as InstagramAccountService,
        organizationService,
        [],
      ),
      automationRunService: new AutomationRunService(
        accountService as unknown as InstagramAccountService,
        contactService,
        new AutomationRunMessageService(
          engineInstagram.client,
          async () => {},
          () => 0,
        ),
        new AutomationPublicReplySafetyService(() => 0),
      ),
    };
  });

  function runJob(): Promise<InstagramWebhookAccountJobResult> {
    return processInstagramWebhookAccountJob({
      jobData: {
        organizationPublicId: organization.public_id,
        channelAccountPublicId: processingAccount.instagramAccountPublicId,
      },
      services,
      jobId: 'job-1',
      instagramClient: processingInstagram as never,
      enqueueFollowUp: async () => undefined,
    });
  }

  function storeEvent({
    eventKind,
    eventKey,
    payload,
    status = 'queued',
    skipReason,
    attemptCount,
  }: {
    eventKind: string;
    eventKey: string;
    payload: Record<string, unknown>;
    status?: string;
    skipReason?: string;
    attemptCount?: number;
  }) {
    return insertTestInstagramWebhookEvent({
      organizationId: organization.id,
      account: { id: account.id, instagramUserId: ACCOUNT_INSTAGRAM_USER_ID },
      eventKind,
      eventKey,
      payload,
      status,
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(attemptCount === undefined ? {} : { attemptCount }),
    });
  }

  function storeComment({ text, postId }: { text: string; postId: string }) {
    const commentId = nextInstagramObjectId();
    return storeEvent({
      eventKind: 'comment',
      eventKey: `comment:${commentId}`,
      payload: {
        field: 'comments',
        value: {
          id: commentId,
          text,
          from: { id: SENDER, username: 'jordan.lee' },
          media: { id: postId },
        },
      },
    });
  }

  function storeDirectMessage(text: string, messageId = `m_${nextInstagramObjectId()}`) {
    return storeEvent({
      eventKind: 'message',
      eventKey: `message:${messageId}`,
      payload: { sender: { id: SENDER }, timestamp: Date.now(), message: { mid: messageId, text } },
    });
  }

  function liveAutomation(
    overrides: Partial<
      Omit<AutomationFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
    >,
  ): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
      ...overrides,
    });
  }

  it('a comment: the contact and its profile, the post stored, one run started from the private reply', async () => {
    const automation = await liveAutomation({ keywords: ['link'], name: 'Spring link' });
    const postId = nextInstagramObjectId();
    const stored = await storeComment({ text: 'Link please', postId });

    const result = await runJob();

    expect(result).toMatchObject({ outcome: 'drained', processedEventCount: 1 });
    expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
      status: 'processed',
      attempt_count: 1,
      error_message: null,
    });
    const [contact] = await readAccountContactRows({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    expect(contact).toMatchObject({
      instagram_user_id: SENDER,
      username: 'jordan.lee',
      full_name: 'Jordan Lee',
      followers_count: 42,
    });
    const [post] = await operatorQuery<Array<{ instagram_media_id: string }>>`
      SELECT instagram_media_id FROM app.instagram_media WHERE organization_id = ${organization.id}`;
    expect(post?.instagram_media_id).toBe(postId);
    const [run] = await readRunRows(organization.id);
    expect(run).toMatchObject({
      automation_id: automation.id,
      contact_id: contact?.id,
      status: 'waiting',
      waiting_for: 'opening_message_button',
    });
    expect(await readCommentLogRows(organization.id)).toHaveLength(1);
    // No DM from this person yet: the opening message is the private reply to the comment.
    expect(engineInstagram.sentMessages).toHaveLength(1);
  });

  it('the button click on that opening message continues the run, in a second job', async () => {
    const automation = await liveAutomation({ keywords: ['link'] });
    await storeComment({ text: 'link', postId: nextInstagramObjectId() });
    await runJob();
    const [waiting] = await readRunRows(organization.id);
    const clickId = `m_${nextInstagramObjectId()}`;
    const click = await storeEvent({
      eventKind: 'postback',
      eventKey: `postback:${clickId}`,
      payload: {
        sender: { id: SENDER },
        timestamp: Date.now(),
        postback: { mid: clickId, payload: `${automation.public_id}::${waiting?.public_id}` },
      },
    });

    await runJob();

    expect((await readTestInstagramWebhookEvent(click.id))?.status).toBe('processed');
    expect((await readRunRows(organization.id))[0]).toMatchObject({
      id: waiting?.id,
      status: 'completed',
    });
  });

  it('a DM with a keyword: the DM automation runs to its final message', async () => {
    const automation = await liveAutomation({
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const stored = await storeDirectMessage('catalog please');

    await runJob();

    expect((await readTestInstagramWebhookEvent(stored.id))?.status).toBe('processed');
    expect((await readRunRows(organization.id))[0]).toMatchObject({
      automation_id: automation.id,
      trigger_type: 'dm',
      status: 'completed',
    });
    // The DM opened the messaging window, so the final message went as a normal DM.
    expect(engineInstagram.sentMessages[0]?.recipient).toEqual({ id: SENDER });
  });

  it('a story reply: the story-reply automation runs for that story', async () => {
    const automation = await liveAutomation({
      trigger_type: 'story_reply',
      keywords: [],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const messageId = `m_${nextInstagramObjectId()}`;
    const stored = await storeEvent({
      eventKind: 'story_reply',
      eventKey: `message:${messageId}`,
      payload: {
        sender: { id: SENDER },
        timestamp: Date.now(),
        message: {
          mid: messageId,
          text: 'love it',
          reply_to: { story: { id: '17910000000000001' } },
        },
      },
    });

    await runJob();

    expect((await readTestInstagramWebhookEvent(stored.id))?.status).toBe('processed');
    expect((await readRunRows(organization.id))[0]).toMatchObject({
      automation_id: automation.id,
      trigger_type: 'story_reply',
      trigger_instagram_story_id: '17910000000000001',
      status: 'completed',
    });
  });

  it('an event stored skipped never runs, even after the switch is back on', async () => {
    await liveAutomation({
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const skipped = await storeEvent({
      eventKind: 'message',
      eventKey: 'message:m_skipped',
      payload: { sender: { id: SENDER }, message: { mid: 'm_skipped', text: 'catalog' } },
      status: 'skipped',
      skipReason: 'automation_disabled',
    });

    await expect(runJob()).resolves.toMatchObject({ outcome: 'drained', processedEventCount: 0 });
    expect(await readTestInstagramWebhookEvent(skipped.id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'automation_disabled',
      attempt_count: 0,
    });
    expect(await readRunRows(organization.id)).toEqual([]);
  });

  it('skips an event whose account was switched off while it waited, and runs nothing', async () => {
    processingAccount = { ...processingAccount, isAutomationEnabled: false };
    const stored = await storeDirectMessage('catalog');

    await runJob();

    expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'automation_disabled',
    });
    expect(
      await readAccountContactRows({
        organizationId: organization.id,
        instagramAccountId: account.id,
      }),
    ).toEqual([]);
  });

  it('the 5th failed attempt marks the event failed, and the account’s next event runs', async () => {
    await liveAutomation({
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const failing = await storeEvent({
      eventKind: 'message',
      eventKey: 'message:m_failing',
      payload: { sender: { id: SENDER }, message: { mid: 'm_failing', text: 'catalog' } },
      attemptCount: 4,
    });
    const next = await storeDirectMessage('catalog again');
    accountService.findAutomationAccountAccess.mockRejectedValueOnce(
      Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }),
    );

    const result = await runJob();

    expect(result).toMatchObject({ processedEventCount: 1, failedEventCount: 1 });
    expect(await readTestInstagramWebhookEvent(failing.id)).toMatchObject({
      status: 'failed',
      attempt_count: 5,
      error_message: 'processing_error:Error:57P01',
    });
    expect((await readTestInstagramWebhookEvent(next.id))?.status).toBe('processed');
  });

  describe('an event that ends failed fails the runs it left running (WH14 rev 4, AU19, D47)', () => {
    /** An Instagram error as the client throws it. */
    function instagramError(errorClass: 'auth' | 'throttled', code: number): MetaGraphApiError {
      return new MetaGraphApiError({
        errorClass,
        category: 'http_4xx',
        connectionStatus: errorClass === 'auth' ? 'expired' : null,
        httpStatus: 400,
        details: {
          code,
          subcode: null,
          type: 'OAuthException',
          fbtraceId: 'trace-1',
        },
        fallbackMessage: 'Instagram failed',
      });
    }

    /** A run the event `eventKey` left `running`, with a comment log when it is a comment's. */
    async function insertLeftRunning({
      automation,
      eventKey,
      commentId,
    }: {
      automation: AutomationFixtureRow;
      eventKey: string;
      commentId?: string;
    }) {
      const owner = { organizationId: organization.id, automationId: automation.id };
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        instagram_user_id: SENDER,
      });
      const run = await insertAutomationRun({
        ...owner,
        contactId: contact.id,
        status: 'running',
        current_step: 'final_dm',
        waiting_for: null,
        waiting_since_at: null,
        last_instagram_event_key: eventKey,
        sending_message_kind: 'final_message',
        sending_started_at: new Date(),
        ...(commentId === undefined
          ? {}
          : {
              trigger_type: 'comment',
              trigger_instagram_comment_id: commentId,
              trigger_instagram_media_id: nextInstagramObjectId(),
            }),
      });
      if (commentId !== undefined) {
        await insertAutomationCommentLog({
          ...owner,
          contactId: contact.id,
          automation_run_id: run.id,
          instagram_comment_id: commentId,
        });
      }
      return { run, contact };
    }

    it('the 5th failed attempt: the run its earlier attempt started is failed with the event’s code', async () => {
      await liveAutomation({
        trigger_type: 'dm',
        keywords: ['catalog'],
        is_opening_message_enabled: false,
        opening_message: null,
      });
      const failing = await storeEvent({
        eventKind: 'message',
        eventKey: 'message:m_failing',
        payload: { sender: { id: SENDER }, message: { mid: 'm_failing', text: 'catalog' } },
        attemptCount: 3,
      });
      // The 4th attempt starts the run; Instagram throttles its message.
      vi.mocked(engineInstagram.client.sendInstagramMessage).mockRejectedValueOnce(
        instagramError('throttled', 4),
      );
      await expect(runJob()).rejects.toThrow();
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({ status: 'running', current_step: 'final_dm' });
      // The 5th dies before it reaches the run.
      accountService.findAutomationAccountAccess.mockRejectedValueOnce(
        Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }),
      );

      expect(await runJob()).toMatchObject({ failedEventCount: 1 });

      expect(await readTestInstagramWebhookEvent(failing.id)).toMatchObject({
        status: 'failed',
        attempt_count: 5,
        error_message: 'processing_error:Error:57P01',
      });
      const failedRun = await readRunRow(run?.id ?? 0);
      expect(failedRun).toMatchObject({
        status: 'failed',
        failed_at: expect.any(Date),
        error_message: 'code:processing_error:Error:57P01',
        sending_message_kind: null,
        sending_started_at: null,
      });
      expect(failedRun?.ended_at).toEqual(failedRun?.failed_at);
      expect(await readRunEventTrail(run?.id ?? 0)).toEqual([
        'status_changed:running',
        'status_changed:failed',
      ]);
    });

    it('attempts that ran out (a crash): the claimed run is failed with its comment log, in the claim’s own unit', async () => {
      const automation = await liveAutomation({ keywords: ['link'] });
      const commentId = nextInstagramObjectId();
      const eventKey = `comment:${commentId}`;
      const exhausted = await storeEvent({
        eventKind: 'comment',
        eventKey,
        payload: { field: 'comments', value: { id: commentId } },
        attemptCount: 5,
      });
      const { run } = await insertLeftRunning({ automation, eventKey, commentId });
      const otherRun = await insertAutomationRun({
        organizationId: organization.id,
        automationId: (await liveAutomation({ name: 'Another one' })).id,
        contactId: run.contact_id,
        waiting_for: 'opening_message_button',
        last_instagram_event_key: eventKey,
      });
      // First the database goes away while the runs are failed: neither is kept.
      const failRuns = vi
        .spyOn(services.automationRunService, 'failRunsOfFailedEvent')
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
      await expect(runJob()).rejects.toThrow('connection terminated');
      expect(await readTestInstagramWebhookEvent(exhausted.id)).toMatchObject({ status: 'queued' });
      expect((await readRunRow(run.id))?.status).toBe('running');
      failRuns.mockRestore();

      expect(await runJob()).toMatchObject({ failedEventCount: 1, processedEventCount: 0 });

      expect(await readTestInstagramWebhookEvent(exhausted.id)).toMatchObject({
        status: 'failed',
        error_message: 'processing_attempts_exhausted',
      });
      expect(await readRunRow(run.id)).toMatchObject({
        status: 'failed',
        error_message: 'code:processing_attempts_exhausted',
        sending_message_kind: null,
      });
      expect(await readRunEventTrail(run.id)).toEqual(['status_changed:failed']);
      expect(await readCommentLogRows(organization.id)).toEqual([
        expect.objectContaining({
          overall_status: 'failed',
          failed_step: 'final_dm',
          error_type: 'code',
          error_message: 'code:processing_attempts_exhausted',
          error_reason: 'processing_attempts_exhausted',
          error_at: expect.any(Date),
        }),
      ]);
      // A waiting run the event moved last keeps waiting.
      expect((await readRunRow(otherRun.id))?.status).toBe('waiting');
      expect(engineInstagram.sentMessages).toHaveLength(0);
    });

    it('a token refused on the retry’s read: the run of the first attempt is failed at once', async () => {
      await liveAutomation({ keywords: ['link'] });
      const stored = await storeComment({ text: 'link', postId: nextInstagramObjectId() });
      // The first attempt: the post cannot be read for now, the run starts, its message is throttled.
      processingInstagram.readInstagramMediaItem.mockRejectedValueOnce(
        instagramError('throttled', 4),
      );
      vi.mocked(engineInstagram.client.sendInstagramMessage).mockRejectedValueOnce(
        instagramError('throttled', 4),
      );
      await expect(runJob()).rejects.toThrow();
      const [run] = await readRunRows(organization.id);
      expect(run?.status).toBe('running');
      processingInstagram.readInstagramMediaItem.mockRejectedValueOnce(instagramError('auth', 190));

      expect(await runJob()).toMatchObject({ failedEventCount: 1 });

      expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
        status: 'failed',
        attempt_count: 2,
      });
      expect(await readRunRow(run?.id ?? 0)).toMatchObject({
        status: 'failed',
        error_message: 'code:instagram_api:190',
      });
      expect(await readCommentLogRows(organization.id)).toEqual([
        expect.objectContaining({ overall_status: 'failed', error_type: 'code' }),
      ]);
    });
  });

  describe('an event skipped on a retry fails the runs it left running (D51)', () => {
    /** The comment's first attempt: its run started, its message not sent for `failure`. */
    async function startRunOfComment(failure: unknown) {
      await liveAutomation({ keywords: ['link'] });
      const stored = await storeComment({ text: 'link', postId: nextInstagramObjectId() });
      vi.mocked(engineInstagram.client.sendInstagramMessage).mockRejectedValueOnce(failure);
      await expect(runJob()).rejects.toThrow();
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({ status: 'running', sending_message_kind: null });
      return { stored, runId: run?.id ?? 0 };
    }

    const throttled = () =>
      new MetaGraphApiError({
        errorClass: 'throttled',
        category: 'http_4xx',
        httpStatus: 429,
        details: { code: 4, subcode: null, type: 'OAuthException', fbtraceId: null },
        fallbackMessage: 'Instagram throttled the message',
      });

    it.each([
      ['automation_disabled', { isAutomationEnabled: false }],
      ['account_disconnected', { connectionStatus: 'revoked', encryptedAccessToken: null }],
    ] as const)(
      '%s between two tries: the event skipped, its run and comment log failed with the reason',
      async (skipReason, accountChange) => {
        const { stored, runId } = await startRunOfComment(throttled());
        processingAccount = { ...processingAccount, ...accountChange };

        expect(await runJob()).toMatchObject({ skippedEventCount: 1, failedEventCount: 0 });

        expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
          status: 'skipped',
          skip_reason: skipReason,
          attempt_count: 2,
          error_message: null,
        });
        expect(await readRunRow(runId)).toMatchObject({
          status: 'failed',
          failed_at: expect.any(Date),
          error_message: `code:${skipReason}`,
        });
        expect(await readRunEventTrail(runId)).toEqual([
          'status_changed:running',
          'status_changed:failed',
        ]);
        expect(await readCommentLogRows(organization.id)).toEqual([
          expect.objectContaining({
            overall_status: 'failed',
            failed_step: 'opening_dm',
            error_type: 'code',
            error_message: `code:${skipReason}`,
            error_reason: skipReason,
            error_at: expect.any(Date),
          }),
        ]);
      },
    );

    it('a try an outage gave back counts too: the run it started is failed by the skip', async () => {
      const { stored, runId } = await startRunOfComment(
        new CircuitBreakerOpenError('meta', 30_000, 'instagram circuit open'),
      );
      expect((await readTestInstagramWebhookEvent(stored.id))?.attempt_count).toBe(0);
      processingAccount = { ...processingAccount, isAutomationEnabled: false };

      await runJob();

      expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
        status: 'skipped',
        attempt_count: 1,
      });
      expect(await readRunRow(runId)).toMatchObject({
        status: 'failed',
        error_message: 'code:automation_disabled',
      });
    });

    it('the skip and the failed runs are kept together, or neither', async () => {
      const { stored, runId } = await startRunOfComment(throttled());
      processingAccount = { ...processingAccount, isAutomationEnabled: false };
      vi.spyOn(services.automationRunService, 'failRunsOfFailedEvent').mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );

      await expect(runJob()).rejects.toThrow('connection terminated');

      expect((await readTestInstagramWebhookEvent(stored.id))?.status).toBe('queued');
      expect((await readRunRow(runId))?.status).toBe('running');
    });
  });

  it('a temporary failure before the last attempt keeps the attempt, ends the lease and holds the next event back', async () => {
    const failing = await storeDirectMessage('catalog');
    const next = await storeDirectMessage('catalog again');
    accountService.findAutomationAccountAccess.mockRejectedValueOnce(
      new Error('deadlock detected'),
    );

    await expect(runJob()).rejects.toThrow('deadlock detected');

    expect(await readTestInstagramWebhookEvent(failing.id)).toMatchObject({
      status: 'queued',
      attempt_count: 1,
      last_attempted_at: null,
    });
    expect(await readTestInstagramWebhookEvent(next.id)).toMatchObject({
      status: 'queued',
      attempt_count: 0,
    });
  });

  it('an Instagram outage gives the claim back without spending its attempt, and pauses the job', async () => {
    const stored = await storeEvent({
      eventKind: 'message',
      eventKey: 'message:m_outage',
      payload: { sender: { id: SENDER }, message: { mid: 'm_outage', text: 'catalog' } },
      attemptCount: 2,
    });
    accountService.findAutomationAccountAccess.mockRejectedValueOnce(
      new CircuitBreakerOpenError('meta', 30_000, 'instagram circuit open'),
    );

    await expect(runJob()).rejects.toBeInstanceOf(ProviderOutageError);

    expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
      status: 'queued',
      attempt_count: 2,
      last_attempted_at: null,
    });
  });
});
