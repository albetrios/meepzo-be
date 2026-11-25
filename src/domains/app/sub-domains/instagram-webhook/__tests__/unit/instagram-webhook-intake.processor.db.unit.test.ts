import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
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
  type InstagramWebhookIntakeJobResult,
  processInstagramWebhookIntakeJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-intake.processor.js';
import type { InstagramWebhookEventIntakeGroup } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
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
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Instagram intake per kind end to end against the database (feat-instagram-dm-sending § 5 WH11–
 * WH16, WH26 — WHC7–WHC9, WHC16; AC-16.7–AC-16.9, AC-16.17): one stored event fixture per kind —
 * a comment, the tap on its opening message, a DM, a story reply — claimed by its group's job, its
 * contact recorded first through the inbound seam, decided by the real run engine (4.B — it saves
 * waiting messages through a recording sending port) and marked, all in one transaction; the
 * failure rules on the real claim (the 5th failed try `failed` with `next_attempt_at`, a database
 * outage spends no try); the flood guard and a stop word; two groups' jobs racing on one contact.
 * Every unit runs in the organization's own job scope, so the suite also holds under
 * `pnpm test:rls-role`.
 */

const SENDER = '17841400000000777';
const ACCOUNT_INSTAGRAM_USER_ID = '9000000000000001';

describe('processInstagramWebhookIntakeJob (database, the real run engine)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string };
  let processingAccount: InstagramWebhookProcessingAccount;
  let accountService: {
    findWebhookProcessingAccount: ReturnType<typeof vi.fn>;
    markConnectionBroken: ReturnType<typeof vi.fn>;
  };
  let profileReads: Array<{ contactPublicId: string }>;
  let runAccountRead: ReturnType<typeof vi.fn>;
  let port: RecordingSendingPort;
  let engine: AutomationRunService;
  let services: Parameters<typeof processInstagramWebhookIntakeJob>[0]['services'];

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
    profileReads = [];
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
      instagramAccountSettingsService: { findSettings: async () => null },
      channelAccountService: { markAccountBroken: async () => true },
      broadcastRecipientService: {
        recordContactReply: async () => 0,
        handleChatOpened: async () => 0,
        findBroadcastTap: async () => null,
        recordBroadcastTap: async () => undefined,
      },
      contactService,
      instagramMediaService: new InstagramMediaService(
        new InstagramMediaRepository(),
        accountService as unknown as InstagramAccountService,
        { markConnectionBroken: async () => false },
      ),
      automationService: createTestAutomationService({ organizationService }),
      automationRunService: engine,
      instagramMessageService: {
        findOwnSentMessageIds: async () => new Set<string>(),
        matchEchoedMessage: async () => 'none',
        markTappedMessageSent: async () => false,
      },
    };
  });

  function runJob(
    intakeKind: InstagramWebhookEventIntakeGroup = 'messages',
  ): Promise<InstagramWebhookIntakeJobResult> {
    return processInstagramWebhookIntakeJob({
      jobData: {
        organizationPublicId: organization.public_id,
        channelAccountPublicId: processingAccount.instagramAccountPublicId,
        intakeKind,
      },
      services,
      jobId: `job-${intakeKind}`,
      enqueueFollowUp: async () => undefined,
      enqueueProfileRead: async ({ contactPublicId }) => {
        profileReads.push({ contactPublicId });
      },
    });
  }

  function storeEvent({
    eventKind,
    eventKey,
    payload,
    status = 'received',
    skipReason,
    attemptCount,
    receivedAt,
  }: {
    eventKind: string;
    eventKey: string;
    payload: Record<string, unknown>;
    status?: string;
    skipReason?: string;
    attemptCount?: number;
    receivedAt?: Date;
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
      ...(receivedAt === undefined ? {} : { receivedAt }),
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

  it('a comment (comment group): the contact, one run started and its hello saved — in one commit, no Meta read, the profile read handed to a task', async () => {
    const automation = await liveAutomation({ keywords: ['link'], name: 'Spring link' });
    const stored = await storeComment({ text: 'Link please', postId: nextInstagramObjectId() });

    // The message group's job never claims a comment (WH11).
    await expect(runJob('messages')).resolves.toMatchObject({ processedEventCount: 0 });
    const result = await runJob('comments');

    expect(result).toMatchObject({ outcome: 'drained', processedEventCount: 1 });
    expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
      status: 'processed',
      attempt_count: 1,
      error_message: null,
      payload: null,
    });
    const [contact] = await readAccountContactRows({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    expect(contact).toMatchObject({ instagram_user_id: SENDER, username: 'jordan.lee' });
    expect(profileReads).toEqual([{ contactPublicId: contact?.public_id }]);
    const [run] = await readRunRows(organization.id);
    expect(run).toMatchObject({
      automation_id: automation.id,
      contact_id: contact?.id,
      status: 'running',
      current_step: 'comment_reply',
    });
    expect(await readCommentLogRows(organization.id)).toHaveLength(1);
    // Intake sends nothing: the hello waits for sub-domain 6 (AC-16.7).
    expect(port.steps()).toEqual(['hello']);
  });

  /** Stores the account's post, as the pickers or an earlier comment's read would have. */
  async function storePost(instagramMediaId: string): Promise<void> {
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
      callback: () =>
        new InstagramMediaRepository().upsertForAccount({
          organizationId: organization.id,
          channelAccountId: processingAccount.channelAccountId,
          instagramMediaId,
          shortcode: null,
          mediaType: 'image',
          mediaProductType: 'feed',
          caption: null,
          mediaUrl: null,
          thumbnailUrl: null,
          permalink: null,
          publishedAt: new Date(Date.now() - 60 * 60_000),
          commentsCount: 0,
          likeCount: 0,
          isCommentEnabled: undefined,
          graphData: { id: instagramMediaId },
        }),
    });
  }

  async function readWatch(instagramMediaId: string) {
    const [row] = await operatorQuery<
      Array<{ comments_next_check_at: Date | null; last_comment_at: Date | null }>
    >`
      SELECT comments_next_check_at, last_comment_at FROM app.instagram_media
      WHERE organization_id = ${organization.id} AND instagram_media_id = ${instagramMediaId}`;
    return row;
  }

  it('a comment a live automation takes starts its post’s missed-comment watch, once; an unmatched one does not (WH17)', async () => {
    await liveAutomation({ keywords: ['link'] });
    const watchedPost = nextInstagramObjectId();
    const quietPost = nextInstagramObjectId();
    await storePost(watchedPost);
    await storePost(quietPost);
    await storeComment({ text: 'link please', postId: watchedPost });
    await storeComment({ text: 'nice photo', postId: quietPost });

    const before = Date.now();
    await runJob('comments');

    const watch = await readWatch(watchedPost);
    expect(watch?.comments_next_check_at?.getTime()).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(watch?.last_comment_at).toBeInstanceOf(Date);
    expect(await readWatch(quietPost)).toEqual({
      comments_next_check_at: null,
      last_comment_at: null,
    });

    // A later comment on the watched post leaves the row as it is (no hot row write per comment).
    await storeComment({ text: 'link again', postId: watchedPost });
    await runJob('comments');
    expect(await readWatch(watchedPost)).toEqual(watch);
  });

  it('the tap on that opening message continues the run, in the message group’s job', async () => {
    const automation = await liveAutomation({ keywords: ['link'] });
    await storeComment({ text: 'link', postId: nextInstagramObjectId() });
    await runJob('comments');
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

    await runJob('messages');

    expect((await readTestInstagramWebhookEvent(click.id))?.status).toBe('processed');
    expect(port.steps().at(-1)).toBe('messages#1');
  });

  it("a tap on a broadcast button: its message `sent`, the automation it names starts for her, the broadcast's taps + 1 (§ 7.A.10, R44, R45)", async () => {
    const automation = await liveAutomation({
      trigger_type: 'dm',
      keywords: ['nothing-typed'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const broadcastPublicId = generatePublicId('broadcast');
    const messagePublicId = generatePublicId('instagramMessage');
    const tapped: string[] = [];
    const taps: number[] = [];
    services = {
      ...services,
      broadcastRecipientService: {
        ...services.broadcastRecipientService,
        findBroadcastTap: async ({ broadcastPublicId: named }) =>
          named === broadcastPublicId
            ? { broadcastId: 77, startAutomationPublicId: automation.public_id }
            : null,
        recordBroadcastTap: async ({ broadcastId }) => {
          taps.push(broadcastId);
        },
      },
      instagramMessageService: {
        ...services.instagramMessageService,
        markTappedMessageSent: async ({ messagePublicId: named }) => {
          tapped.push(named);
          return true;
        },
      },
    };
    const clickId = `m_${nextInstagramObjectId()}`;
    const click = await storeEvent({
      eventKind: 'postback',
      eventKey: `postback:${clickId}`,
      payload: {
        sender: { id: SENDER },
        timestamp: Date.now(),
        postback: { mid: clickId, payload: `${broadcastPublicId}::${messagePublicId}` },
      },
    });

    await runJob('messages');

    expect((await readTestInstagramWebhookEvent(click.id))?.status).toBe('processed');
    expect(tapped).toEqual([messagePublicId]);
    expect(taps).toEqual([77]);
    expect((await readRunRows(organization.id))[0]).toMatchObject({ automation_id: automation.id });
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
    const [contact] = await readAccountContactRows({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    expect(contact?.first_message_at).not.toBeNull();
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
      once_key: 'story:17910000000000001',
    });
  });

  it('an event stored skipped never runs, even after the switch is back on', async () => {
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
      attempt_count: 0,
    });
  });

  it('skips an event whose account was switched off while it waited, and records no contact', async () => {
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

  it('an account in error is still taken in — its messages wait in its stopped lanes (WH3)', async () => {
    processingAccount = { ...processingAccount, connectionStatus: 'error' };
    const stored = await storeDirectMessage('hello');

    await runJob();

    expect((await readTestInstagramWebhookEvent(stored.id))?.status).toBe('processed');
  });

  it('the 5th failed try marks the event failed with its hourly retry, and the group’s next event runs', async () => {
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
    runAccountRead.mockRejectedValueOnce(new TypeError('boom'));

    const result = await runJob();

    expect(result).toMatchObject({ processedEventCount: 1, failedEventCount: 1 });
    const failed = await readTestInstagramWebhookEvent(failing.id);
    expect(failed).toMatchObject({
      status: 'failed',
      attempt_count: 5,
      error_message: 'processing_error:TypeError',
    });
    expect(failed?.next_attempt_at).not.toBeNull();
    expect((await readTestInstagramWebhookEvent(next.id))?.status).toBe('processed');
  });

  it('a failure before the last try keeps the try, ends the lease and holds the group back', async () => {
    const failing = await storeDirectMessage('catalog');
    const next = await storeDirectMessage('catalog again');
    runAccountRead.mockRejectedValueOnce(new TypeError('boom'));

    await expect(runJob()).rejects.toThrow('boom');

    expect(await readTestInstagramWebhookEvent(failing.id)).toMatchObject({
      status: 'received',
      attempt_count: 1,
      last_attempted_at: null,
    });
    expect(await readTestInstagramWebhookEvent(next.id)).toMatchObject({ attempt_count: 0 });
  });

  it('Postgres unreachable gives the claim back without using a try', async () => {
    const stored = await storeEvent({
      eventKind: 'message',
      eventKey: 'message:m_down',
      payload: { sender: { id: SENDER }, message: { mid: 'm_down', text: 'catalog' } },
      attemptCount: 2,
    });
    runAccountRead.mockRejectedValueOnce(
      Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }),
    );

    await expect(runJob()).rejects.toThrow('connection terminated unexpectedly');

    expect(await readTestInstagramWebhookEvent(stored.id)).toMatchObject({
      status: 'received',
      attempt_count: 2,
      last_attempted_at: null,
    });
  });

  it('a failing comment does not hold back her tap: the groups have their own jobs (WH11)', async () => {
    const comment = await storeComment({ text: 'link', postId: nextInstagramObjectId() });
    const message = await storeDirectMessage('hi');
    runAccountRead.mockRejectedValueOnce(new TypeError('boom'));

    await expect(runJob('comments')).rejects.toThrow('boom');
    await runJob('messages');

    expect((await readTestInstagramWebhookEvent(comment.id))?.status).toBe('received');
    expect((await readTestInstagramWebhookEvent(message.id))?.status).toBe('processed');
  });

  it('more than 20 of her message events in a minute: the next is skipped `flood` and starts nothing (AC-16.17)', async () => {
    await liveAutomation({
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    for (let index = 0; index < 21; index += 1) {
      await storeEvent({
        eventKind: 'message',
        eventKey: `message:m_seen_${index}`,
        payload: {},
        status: 'processed',
      });
    }
    const flooded = await storeDirectMessage('catalog');

    await runJob();

    expect(await readTestInstagramWebhookEvent(flooded.id)).toMatchObject({
      status: 'skipped',
      skip_reason: 'flood',
    });
    expect(await readRunRows(organization.id)).toEqual([]);
  });

  it('a stop word opts her out and starts nothing', async () => {
    await liveAutomation({
      trigger_type: 'dm',
      keywords: ['stop'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const stored = await storeDirectMessage(' STOP ');

    await runJob();

    expect((await readTestInstagramWebhookEvent(stored.id))?.status).toBe('processed');
    const [contact] = await readAccountContactRows({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    expect(contact?.opted_out_at).not.toBeNull();
    expect(await readRunRows(organization.id)).toEqual([]);
  });

  it('her DM and her comment taken in by two jobs at once never deadlock and lose nothing (WH26, AC-16.8)', async () => {
    await liveAutomation({ keywords: ['link'] });
    await liveAutomation({
      trigger_type: 'dm',
      keywords: ['catalog'],
      is_opening_message_enabled: false,
      opening_message: null,
    });
    const comments = await Promise.all(
      [0, 1, 2].map(() => storeComment({ text: 'link', postId: nextInstagramObjectId() })),
    );
    const messages = await Promise.all([0, 1, 2].map(() => storeDirectMessage('catalog')));

    const results = await Promise.all([runJob('comments'), runJob('messages')]);

    expect(results.map((result) => result.failedEventCount)).toEqual([0, 0]);
    for (const event of [...comments, ...messages]) {
      expect((await readTestInstagramWebhookEvent(event.id))?.status).toBe('processed');
    }
    const contacts = await readAccountContactRows({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    expect(contacts).toHaveLength(1);
    const runs = await readRunRows(organization.id);
    const openRunsPerAutomation = new Map<number, number>();
    for (const run of runs.filter((row) => ['running', 'waiting'].includes(row.status))) {
      openRunsPerAutomation.set(
        run.automation_id,
        (openRunsPerAutomation.get(run.automation_id) ?? 0) + 1,
      );
    }
    expect([...openRunsPerAutomation.values()].every((count) => count === 1)).toBe(true);
  });
});
