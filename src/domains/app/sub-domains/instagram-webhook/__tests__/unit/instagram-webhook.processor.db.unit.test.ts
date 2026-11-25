import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import { ProviderOutageError } from '@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramWebhookProcessingAccount } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import {
  RecordingSendingPort,
  reportMessageResult,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { InstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  type InstagramWebhookAccountJobResult,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
import {
  insertInstagramAccount,
  readAccountContactRows,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureOverrides,
  type AutomationFixtureRow,
  createTestAutomationService,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  nextInstagramObjectId,
  readCommentLogRows,
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
 * handled by the real run engine (4.B — it saves waiting messages through a recording sending port,
 * R14), and marked; then the failure rules on the real claim: a skipped event never runs after the
 * switch is back on, the 5th failure marks the event `failed` and the next one runs, an outage spends
 * no attempt. (Since R14 an event's engine work is one commit, so a failed event leaves no run behind
 * — the launch's "fail the runs it left running" cases retired with it.) Every unit
 * runs in the organization's own job scope, so the suite also holds under `pnpm test:rls-role`.
 */

const SENDER = '17841400000000777';
const ACCOUNT_INSTAGRAM_USER_ID = '9000000000000001';

describe('processInstagramWebhookAccountJob (database, the real run engine)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string };
  let processingAccount: InstagramWebhookProcessingAccount;
  let accountService: {
    findWebhookProcessingAccount: ReturnType<typeof vi.fn>;
    markConnectionBroken: ReturnType<typeof vi.fn>;
  };
  let runAccountRead: ReturnType<typeof vi.fn>;
  let port: RecordingSendingPort;
  let engine: AutomationRunService;
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
    const runAccount: AutomationRunChannelAccount = {
      organizationId: organization.id,
      id: processingAccount.channelAccountId,
      public_id: account.public_id,
      channel: 'instagram',
      connection_status: 'connected',
      is_automation_enabled: true,
      time_zone: 'UTC',
      is_comment_reply_trigger_enabled: true,
      is_once_per_person_per_post_enabled: true,
    };
    runAccountRead = vi.fn(
      async ({ channelAccountPublicId }: { channelAccountPublicId: string }) =>
        channelAccountPublicId === account.public_id ? runAccount : null,
    );
    accountService = {
      findWebhookProcessingAccount: vi.fn(async () => processingAccount),
      markConnectionBroken: vi.fn(async () => null),
    };
    port = new RecordingSendingPort();
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    const contactService = new ContactService(
      new ContactRepository(),
      organizationService,
      [],
      async () => null,
    );
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
    engine = new AutomationRunService({
      channelAccountService: { readAutomationRunAccount: runAccountRead as never },
      contactService,
      planAccessService: { getPlanAccess: (async () => ({ features: null })) as never },
      countService: new AutomationCountService(new AutomationCountRepository()),
      replyStateService: new AutomationReplyStateService(new AutomationReplyStateRepository()),
      sendingPorts: { instagram: port },
    });
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
      automationService: createTestAutomationService({ organizationService }),
      automationRunService: engine,
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

  /** The channel reports the last saved message of `step` sent (AU35). */
  function reportSent(step: Parameters<RecordingSendingPort['last']>[0]) {
    return reportMessageResult({
      service: engine,
      scope: { organizationPublicId: organization.public_id, source: 'job' } as never,
      organizationId: organization.id,
      message: port.last(step),
      result: 'sent',
    });
  }

  function liveAutomation(overrides: AutomationFixtureOverrides): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: organization.id,
      instagramAccountId: account.id,
      status: 'live',
      ...overrides,
    });
  }

  it('a comment: the contact and its profile, the post stored, one run started — its hello saved to answer the comment', async () => {
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
      status: 'running',
      current_step: 'comment_reply',
    });
    expect(await readCommentLogRows(organization.id)).toHaveLength(1);
    // The engine sends nothing: the hello waits for the channel, answering the comment.
    expect(port.steps()).toEqual(['hello']);
    expect(port.last('hello').answersEventId).toBe(run?.trigger_instagram_comment_id);
  });

  it('the button click on that opening message continues the run, in a second job', async () => {
    const automation = await liveAutomation({ keywords: ['link'] });
    await storeComment({ text: 'link', postId: nextInstagramObjectId() });
    await runJob();
    await reportSent('hello');
    const [waiting] = await readRunRows(organization.id);
    expect(waiting?.status).toBe('waiting');
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
    expect(port.steps().at(-1)).toBe('messages#1');
    await reportSent('messages');
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
    expect(port.last('messages')).toMatchObject({ messageNumber: 1, answersEventId: null });
    await reportSent('messages');
    expect((await readRunRows(organization.id))[0]).toMatchObject({
      automation_id: automation.id,
      trigger_type: 'dm_keyword',
      status: 'completed',
    });
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
      status: 'running',
      once_key: 'story:17910000000000001',
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
    runAccountRead.mockRejectedValueOnce(
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

  it('a temporary failure before the last attempt keeps the attempt, ends the lease and holds the next event back', async () => {
    const failing = await storeDirectMessage('catalog');
    const next = await storeDirectMessage('catalog again');
    runAccountRead.mockRejectedValueOnce(new Error('deadlock detected'));

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
    runAccountRead.mockRejectedValueOnce(
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
