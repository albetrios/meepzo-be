import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { InstagramApiError } from '@/infrastructure/social/instagram-error.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import type { AutomationRunEvent } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  nextInstagramObjectId,
  readCommentLogRows,
  readRunEventTrail,
  readRunRow,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The run engine end to end against the database, with a fake Instagram client (routes-final
 * § 3.B — AU16–AU24, AQ5, D14, D16, D18, D26): a comment answered by one automation, the click,
 * the email and the completion; AU17's reasons; the automations queued behind an email; the
 * claim → send → record cycle at every crash point, a retry never sending twice; DMs, story
 * replies, the follow check, invalid answers and a closed messaging window; a run whose step was
 * turned off going on (D48) and the runs of an event that ended failed (D47). Every unit runs in the
 * organization's own job scope, so the suite also holds under `pnpm test:rls-role`.
 */

const POST = '17900000000000001';

/** The fake Instagram client: every call recorded; failures and follow answers queued. */
function fakeInstagramClient() {
  const sentMessages: Array<{ recipient: unknown; message: Record<string, unknown> }> = [];
  const publicReplies: Array<{ instagramCommentId: string; text: string }> = [];
  const sendFailures: unknown[] = [];
  const followAnswers: Array<boolean | null> = [];
  const client: AutomationInstagramClient = {
    sendInstagramMessage: vi.fn(async ({ recipient, message }) => {
      const failure = sendFailures.shift();
      if (failure !== undefined) throw failure;
      sentMessages.push({ recipient, message: message as Record<string, unknown> });
      return { messageId: `m${sentMessages.length}`, recipientId: null };
    }),
    replyToInstagramComment: vi.fn(async ({ instagramCommentId, text }) => {
      publicReplies.push({ instagramCommentId, text });
      return { instagramCommentReplyId: '1' };
    }),
    readInstagramUserProfile: vi.fn(async () => ({
      name: null,
      username: 'jordan.lee',
      profilePictureUrl: null,
      followerCount: null,
      isUserFollowingBusiness: followAnswers.shift() ?? null,
    })),
  };
  return { client, sentMessages, publicReplies, sendFailures, followAnswers };
}

/** An Instagram error of one class, as the client throws it. */
function instagramError({
  errorClass,
  category = 'http_4xx',
  code = null,
  subcode = null,
}: {
  errorClass: 'auth' | 'throttled' | 'refused' | 'outage';
  category?: ConstructorParameters<typeof InstagramApiError>[0]['category'];
  code?: number | null;
  subcode?: number | null;
}): InstagramApiError {
  return new InstagramApiError({
    errorClass,
    category,
    connectionStatus: errorClass === 'auth' ? 'error' : null,
    httpStatus: 400,
    details: { code, subcode, type: null, fbtraceId: 'trace-1' },
    fallbackMessage: 'Instagram failed',
  });
}

describe('AutomationRunService (database, fake Instagram client)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string };
  let contact: ContactFixtureRow;
  let instagram: ReturnType<typeof fakeInstagramClient>;
  let accountService: {
    findAutomationAccountAccess: ReturnType<typeof vi.fn>;
    markConnectionBroken: ReturnType<typeof vi.fn>;
  };
  let service: AutomationRunService;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      username: 'jordan.lee',
    });
    const access: InstagramAutomationAccountAccess = {
      instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
      instagramAccountPublicId: account.public_id,
      instagramAppUserId: '17841400000000999',
      username: 'acme.shop',
      connectionStatus: 'connected',
      encryptedAccessToken: 'v1:fake-ciphertext',
      settings: null,
    };
    accountService = {
      findAutomationAccountAccess: vi.fn(async ({ instagramAccountPublicId }) =>
        instagramAccountPublicId === account.public_id ? access : null,
      ),
      markConnectionBroken: vi.fn(async () => null),
    };
    instagram = fakeInstagramClient();
    const contactService = new ContactService(
      new ContactRepository(),
      {} as OrganizationService,
      [],
      async () => null,
    );
    service = new AutomationRunService(
      accountService as unknown as InstagramAccountService,
      contactService,
      new AutomationRunMessageService(
        instagram.client,
        async () => {},
        () => 0,
      ),
      new AutomationPublicReplySafetyService(() => 0),
    );
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  function event(eventKey: string, isLastAttempt = false): AutomationRunEvent {
    return { eventKey, occurredAt: new Date(), isLastAttempt };
  }

  /** The contact as event processing hands it over — fresh, after `recordContactInteraction`. */
  async function freshContact(): Promise<ContactFixtureRow> {
    const row = await readContactRow(contact.id);
    if (row === undefined) throw new Error('contact vanished');
    return row;
  }

  /** The contact DMed the account just now — its messaging window is open (CT10). */
  async function openMessagingWindow(): Promise<void> {
    await getOperatorDatabase()
      .update(contacts)
      .set({ last_direct_message_received_at: new Date() })
      .where(eq(contacts.id, contact.id));
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

  /** A live DM automation on `keyword` whose flow is the final message only. */
  function dmAutomation(
    keyword: string,
    overrides: Partial<
      Omit<AutomationFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
    > = {},
  ): Promise<AutomationFixtureRow> {
    return liveAutomation({
      trigger_type: 'dm',
      keywords: [keyword],
      is_opening_message_enabled: false,
      opening_message: null,
      ...overrides,
    });
  }

  async function comment({
    commentId,
    text,
    eventKey = `comment:${commentId}`,
  }: {
    commentId: string;
    text: string;
    eventKey?: string;
  }) {
    return service.startCommentRun({
      scope: scope(),
      instagramAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(eventKey),
      instagramCommentId: commentId,
      instagramMediaId: POST,
      text,
      commenterUsername: 'jordan.lee',
    });
  }

  async function directMessage({
    text,
    eventKey,
    isLastAttempt = false,
  }: {
    text: string;
    eventKey: string;
    isLastAttempt?: boolean;
  }) {
    return service.handleDirectMessage({
      scope: scope(),
      instagramAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(eventKey, isLastAttempt),
      text,
      quickReplyPayload: null,
      attachmentEmail: null,
    });
  }

  async function click({
    automationPublicId,
    runPublicId,
    eventKey,
  }: {
    automationPublicId: string;
    runPublicId: string;
    eventKey: string;
  }) {
    return service.handleButtonClick({
      scope: scope(),
      instagramAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(eventKey),
      automationPublicId,
      runPublicId,
    });
  }

  describe('a comment, the click, the email, the completion (AU16–AU18, AU24)', () => {
    it('one automation answers — the post-linked one — and the flow runs to the end', async () => {
      const anyPost = await liveAutomation({ keywords: ['link'], name: 'Any post' });
      const specific = await liveAutomation({
        name: 'Spring post',
        keywords: ['link'],
        target_scope: 'specific',
        target_instagram_media_id: POST,
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent!', 'Check your DMs'],
        is_email_collection_enabled: true,
        tags: ['spring'],
      });
      const commentId = nextInstagramObjectId();

      const started = await comment({ commentId, text: 'Link please' });

      expect(started.outcome).toBe('run_started');
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({
        automation_id: specific.id,
        status: 'waiting',
        waiting_for: 'opening_message_button',
        current_step: 'comment_reply',
        sending_message_kind: null,
      });
      expect(started.runPublicIds).toEqual([run?.public_id]);
      expect(instagram.publicReplies).toEqual([{ instagramCommentId: commentId, text: 'Sent!' }]);
      // No DM window yet: the opening message is the private reply to the comment.
      expect(instagram.sentMessages).toHaveLength(1);
      expect(instagram.sentMessages[0]?.recipient).toEqual({ comment_id: commentId });
      expect(JSON.stringify(instagram.sentMessages[0]?.message)).toContain(
        `${specific.public_id}::${run?.public_id}`,
      );
      const logs = await readCommentLogRows(organization.id);
      expect(
        logs.map((log) => [log.automation_id, log.overall_status, log.ignored_reason]),
      ).toEqual(
        expect.arrayContaining([
          [specific.id, 'waiting', null],
          [anyPost.id, 'ignored', 'comment_already_answered'],
        ]),
      );
      expect(logs.find((log) => log.automation_id === specific.id)).toMatchObject({
        automation_run_id: run?.id,
        public_reply_status: 'sent',
        public_reply_text: 'Sent!',
        opening_dm_status: 'waiting',
        waiting_for: 'opening_message_button',
      });
      expect((await readAutomationRow(specific.public_id))?.last_triggered_at).not.toBeNull();
      expect((await readAutomationRow(anyPost.public_id))?.last_triggered_at).toBeNull();

      // A retried comment chooses nothing new and sends nothing (AU16, AU19).
      const retried = await comment({ commentId, text: 'Link please' });
      expect(retried.outcome).toBe('already_handled');
      expect(await readCommentLogRows(organization.id)).toHaveLength(2);
      expect(instagram.sentMessages).toHaveLength(1);
      expect(instagram.publicReplies).toHaveLength(1);

      // The click opens the DM window (event processing recorded it) and continues the run.
      await openMessagingWindow();
      const clicked = await click({
        automationPublicId: specific.public_id,
        runPublicId: run?.public_id ?? '',
        eventKey: 'postback:click-1',
      });
      expect(clicked.outcome).toBe('run_continued');
      expect(await readRunRow(run?.id ?? 0)).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        current_step: 'email_collect',
      });
      expect(instagram.sentMessages[1]?.recipient).toEqual({ id: contact.instagram_user_id });
      expect(instagram.sentMessages[1]?.message).toEqual({
        text: 'Please share your email to continue!',
        quick_replies: [{ content_type: 'user_email' }],
      });

      const answered = await directMessage({
        text: ' Jordan@Example.com ',
        eventKey: 'message:m-1',
      });
      expect(answered.outcome).toBe('run_continued');
      const completed = await readRunRow(run?.id ?? 0);
      expect(completed).toMatchObject({ status: 'completed', current_step: 'final_dm' });
      expect(completed?.completed_at).not.toBeNull();
      expect(completed?.ended_at).toEqual(completed?.completed_at);
      expect(await readRunEventTrail(run?.id ?? 0)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'email_received:-',
        'status_changed:completed',
      ]);
      expect((await readAutomationRow(specific.public_id))?.completed_run_count).toBe(1);
      const finalContact = await freshContact();
      expect(finalContact.email).toBe('jordan@example.com');
      expect(finalContact.tags).toEqual(['spring']);
      expect(finalContact.last_message_sent_at).not.toBeNull();
      expect(
        (await readCommentLogRows(organization.id)).find(
          (log) => log.automation_id === specific.id,
        ),
      ).toMatchObject({
        overall_status: 'completed',
        opening_dm_status: 'done',
        email_status: 'done',
        email_received: 'jordan@example.com',
        final_dm_status: 'sent',
        waiting_for: null,
      });

      // Another comment of the same contact: the final run holds it back (AU17 (4), D14).
      const again = await comment({ commentId: nextInstagramObjectId(), text: 'link' });
      expect(again.outcome).toBe('comment_logged');
      const newest = (await readCommentLogRows(organization.id)).slice(-2);
      expect(newest.map((log) => log.ignored_reason).sort()).toEqual([
        'comment_already_answered',
        'previous_run_final',
      ]);
    });

    it('logs AU17 reasons: this automation waits → already_waiting, runs → run_in_progress', async () => {
      const automation = await liveAutomation({ keywords: [] });
      await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        waiting_for: 'opening_message_button',
      });

      expect((await comment({ commentId: nextInstagramObjectId(), text: 'hi' })).outcome).toBe(
        'comment_logged',
      );
      const [log] = await readCommentLogRows(organization.id);
      expect(log).toMatchObject({ overall_status: 'ignored', ignored_reason: 'already_waiting' });
      expect(instagram.sentMessages).toHaveLength(0);
    });

    it('matches nothing for another post, and only the event account’s automations (AU27)', async () => {
      await liveAutomation({
        target_scope: 'specific',
        target_instagram_media_id: '17900000000000009',
      });
      expect((await comment({ commentId: nextInstagramObjectId(), text: 'hi' })).outcome).toBe(
        'nothing_matched',
      );
      const otherAccount = await service.startCommentRun({
        scope: scope(),
        instagramAccountPublicId: 'iga_a1b2c3d4e5f6g7h8i9j0k',
        contact: await freshContact(),
        event: event('comment:other'),
        instagramCommentId: nextInstagramObjectId(),
        instagramMediaId: POST,
        text: 'hi',
        commenterUsername: null,
      });
      expect(otherAccount.outcome).toBe('account_unavailable');
      expect(await readCommentLogRows(organization.id)).toEqual([]);
    });
  });

  describe('automations queued behind an email (AU17 (1), AU21)', () => {
    it('queues the trigger, asks again, and starts it as its own run when the email arrives', async () => {
      await openMessagingWindow();
      const emailFirst = await dmAutomation('catalog', { is_email_collection_enabled: true });
      const commentAutomation = await liveAutomation({ keywords: ['link'], name: 'Comment link' });

      await directMessage({ text: 'catalog please', eventKey: 'message:m-1' });
      const [waitingRun] = await readRunRows(organization.id);
      expect(waitingRun).toMatchObject({ automation_id: emailFirst.id, waiting_for: 'email' });

      const commentId = nextInstagramObjectId();
      const queued = await comment({ commentId, text: 'link' });
      expect(queued.outcome).toBe('question_asked_again');
      const queuedRun = await readRunRow(waitingRun?.id ?? 0);
      expect(queuedRun?.queued_automations).toEqual([
        expect.objectContaining({
          automation_id: commentAutomation.public_id,
          trigger: expect.objectContaining({ type: 'comment', instagram_comment_id: commentId }),
        }),
      ]);
      expect(queuedRun?.sending_message_kind).toBeNull();
      const [ignoredLog] = await readCommentLogRows(organization.id);
      expect(ignoredLog).toMatchObject({
        automation_id: commentAutomation.id,
        overall_status: 'ignored',
        ignored_reason: 'waiting_for_other_email',
        automation_run_id: null,
      });
      // The email question twice: the first ask and the ask again.
      expect(
        instagram.sentMessages.filter((sent) =>
          JSON.stringify(sent.message).includes('Please share your email'),
        ),
      ).toHaveLength(2);

      const answered = await directMessage({ text: 'jordan@example.com', eventKey: 'message:m-2' });
      expect(answered.outcome).toBe('run_continued');
      const runs = await readRunRows(organization.id);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ status: 'completed', queued_automations: [] });
      expect(runs[1]).toMatchObject({
        automation_id: commentAutomation.id,
        trigger_type: 'comment',
        trigger_instagram_comment_id: commentId,
      });
      expect(answered.runPublicIds).toEqual([runs[0]?.public_id, runs[1]?.public_id]);
      const [startedLog] = await readCommentLogRows(organization.id);
      expect(startedLog).toMatchObject({ ignored_reason: null, automation_run_id: runs[1]?.id });
      expect(startedLog?.overall_status).not.toBe('ignored');
    });
  });

  describe('a step turned off while a run waits for it (AU14, AU21, D48)', () => {
    it('goes on at the next comment of the messaging window, its queue with it: logs, counters and tags follow', async () => {
      await openMessagingWindow();
      const finalOnly = { is_opening_message_enabled: false, opening_message: null };
      const emailFirst = await liveAutomation({
        ...finalOnly,
        keywords: ['catalog'],
        is_email_collection_enabled: true,
        tags: ['catalog'],
      });
      const queuedAutomation = await liveAutomation({
        ...finalOnly,
        keywords: ['link'],
        name: 'Comment link',
      });
      await comment({ commentId: nextInstagramObjectId(), text: 'catalog' });
      await comment({ commentId: nextInstagramObjectId(), text: 'link' });
      const [waitingRun] = await readRunRows(organization.id);
      expect(waitingRun).toMatchObject({ waiting_for: 'email' });
      await getOperatorDatabase()
        .update(automations)
        .set({ is_email_collection_enabled: false })
        .where(eq(automations.id, emailFirst.id));
      const sentBefore = instagram.sentMessages.length;

      const result = await comment({ commentId: nextInstagramObjectId(), text: 'lovely post' });

      const [firstRun, queuedRun] = await readRunRows(organization.id);
      expect(result).toEqual({
        outcome: 'run_continued',
        runPublicIds: [firstRun?.public_id, queuedRun?.public_id],
        failedErrorType: null,
      });
      expect(firstRun).toMatchObject({ status: 'completed', queued_automations: [] });
      expect(queuedRun).toMatchObject({
        automation_id: queuedAutomation.id,
        trigger_text: 'link',
        status: 'completed',
      });
      expect(await readRunEventTrail(firstRun?.id ?? 0)).toEqual([
        'status_changed:running',
        'status_changed:waiting',
        'status_changed:running',
        'status_changed:completed',
      ]);
      expect(instagram.sentMessages).toHaveLength(sentBefore + 2);
      expect(await readCommentLogRows(organization.id)).toEqual([
        expect.objectContaining({
          automation_id: emailFirst.id,
          overall_status: 'completed',
          email_status: 'skipped',
          email_received: null,
          waiting_for: null,
        }),
        expect.objectContaining({
          automation_id: queuedAutomation.id,
          overall_status: 'completed',
          ignored_reason: null,
          automation_run_id: queuedRun?.id,
        }),
      ]);
      for (const automation of [emailFirst, queuedAutomation]) {
        expect((await readAutomationRow(automation.public_id))?.completed_run_count).toBe(1);
      }
      expect(await freshContact()).toMatchObject({
        email: null,
        tags: ['catalog', 'Comment link'],
      });

      // A retried event finds them done.
      expect((await directMessage({ text: 'hello', eventKey: 'message:later' })).outcome).toBe(
        'nothing_matched',
      );
    });
  });

  describe('the runs of an event that ended failed (AU19, D47)', () => {
    it('are failed once, in the organization’s own scope; another organization’s run of the same key is not', async () => {
      const automation = await dmAutomation('catalog');
      const eventKey = 'message:m-dead';
      const left = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        status: 'running',
        current_step: 'final_dm',
        waiting_for: null,
        waiting_since_at: null,
        last_instagram_event_key: eventKey,
      });
      const otherOrganization = await createTestOrganization({
        ownerUserId: (await createTestUser()).id,
      });
      const otherAccount = await insertInstagramAccount({ organizationId: otherOrganization.id });
      const otherKey = {
        organizationId: otherOrganization.id,
        instagramAccountId: otherAccount.id,
      };
      const othersRun = await insertAutomationRun({
        organizationId: otherOrganization.id,
        automationId: (await insertAutomation(otherKey)).id,
        contactId: (await insertContact(otherKey)).id,
        status: 'running',
        current_step: 'final_dm',
        waiting_for: null,
        waiting_since_at: null,
        last_instagram_event_key: eventKey,
      });
      const failRuns = () =>
        service.failRunsOfFailedEvent({
          scope: scope(),
          organizationId: organization.id,
          eventKey,
          errorCode: 'processing_error:Error:57P01',
        });

      expect(await failRuns()).toEqual([left.public_id]);
      expect(await failRuns()).toEqual([]);

      expect(await readRunRow(left.id)).toMatchObject({
        status: 'failed',
        error_message: 'code:processing_error:Error:57P01',
      });
      expect(await readRunEventTrail(left.id)).toEqual(['status_changed:failed']);
      expect((await readRunRow(othersRun.id))?.status).toBe('running');
    });
  });

  describe('claim → send → record (AU19, AQ5, D16)', () => {
    it('an unknown outcome fails the step and leaves the claim — a retry sends nothing', async () => {
      await openMessagingWindow();
      await dmAutomation('catalog');
      instagram.sendFailures.push(instagramError({ errorClass: 'outage', category: 'timeout' }));

      const result = await directMessage({ text: 'catalog', eventKey: 'message:m-1' });

      expect(result.failedErrorType).toBe('network');
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({
        status: 'failed',
        sending_message_kind: 'final_message',
        error_message: 'network:send_outcome_unknown',
      });
      expect(await readRunEventTrail(run?.id ?? 0)).toEqual([
        'status_changed:running',
        'status_changed:failed',
      ]);

      const retried = await directMessage({ text: 'catalog', eventKey: 'message:m-1' });
      expect(retried.outcome).toBe('already_handled');
      expect(instagram.client.sendInstagramMessage).toHaveBeenCalledTimes(1);
    });

    it('a temporary error clears the claim and is rethrown; the retry sends once', async () => {
      await openMessagingWindow();
      await dmAutomation('catalog');
      const throttle = instagramError({ errorClass: 'throttled', code: 4 });
      instagram.sendFailures.push(throttle);

      await expect(directMessage({ text: 'catalog', eventKey: 'message:m-1' })).rejects.toBe(
        throttle,
      );
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({
        status: 'running',
        current_step: 'final_dm',
        sending_message_kind: null,
      });

      const retried = await directMessage({ text: 'catalog', eventKey: 'message:m-1' });
      expect(retried.outcome).toBe('run_resumed');
      expect((await readRunRow(run?.id ?? 0))?.status).toBe('completed');
      expect(instagram.sentMessages).toHaveLength(1);
      expect(await readRunRows(organization.id)).toHaveLength(1);
    });

    it("on the event's last attempt a temporary error fails the run instead", async () => {
      await openMessagingWindow();
      await dmAutomation('catalog');
      instagram.sendFailures.push(instagramError({ errorClass: 'throttled', code: 4 }));

      const result = await directMessage({
        text: 'catalog',
        eventKey: 'message:m-1',
        isLastAttempt: true,
      });

      expect(result.failedErrorType).toBe('instagram_api');
      expect((await readRunRows(organization.id))[0]).toMatchObject({
        status: 'failed',
        sending_message_kind: null,
      });
    });

    it('a claim still set when the event comes back fails the step without sending (AQ5)', async () => {
      const automation = await dmAutomation('catalog');
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        status: 'running',
        current_step: 'final_dm',
        waiting_for: null,
        waiting_since_at: null,
        sending_message_kind: 'final_message',
        sending_started_at: new Date(),
        last_instagram_event_key: 'message:crashed',
      });

      const result = await directMessage({ text: 'catalog', eventKey: 'message:crashed' });

      expect(result).toMatchObject({ outcome: 'run_resumed', failedErrorType: 'network' });
      expect(await readRunRow(run.id)).toMatchObject({
        status: 'failed',
        sending_message_kind: 'final_message',
      });
      expect(instagram.client.sendInstagramMessage).not.toHaveBeenCalled();
    });

    it('a refusal fails the run with its codes; a dead token also marks the account broken', async () => {
      await openMessagingWindow();
      await dmAutomation('catalog');
      await dmAutomation('price');
      instagram.sendFailures.push(
        instagramError({ errorClass: 'refused', code: 10, subcode: 2534022 }),
        instagramError({ errorClass: 'auth', code: 190 }),
      );

      const refused = await directMessage({ text: 'catalog', eventKey: 'message:m-1' });
      const token = await directMessage({ text: 'price', eventKey: 'message:m-2' });

      expect(refused.failedErrorType).toBe('instagram_api');
      expect(token.failedErrorType).toBe('token');
      const runs = await readRunRows(organization.id);
      expect(runs.map((run) => [run.status, run.error_message])).toEqual([
        ['failed', 'instagram_api:10/2534022'],
        ['failed', 'token:190/-'],
      ]);
      expect(accountService.markConnectionBroken).toHaveBeenCalledTimes(1);
      expect(accountService.markConnectionBroken).toHaveBeenCalledWith(
        expect.objectContaining({ connectionStatus: 'error' }),
      );
    });
  });

  describe('DMs, story replies, clicks and the follow check (AU16, AU18, D18)', () => {
    it('a DM with no matching keyword starts nothing; an invalid email asks again, an invalid phone waits', async () => {
      await openMessagingWindow();
      await dmAutomation('catalog', { is_email_collection_enabled: true });
      expect((await directMessage({ text: 'hello', eventKey: 'message:m-0' })).outcome).toBe(
        'nothing_matched',
      );

      await directMessage({ text: 'catalog', eventKey: 'message:m-1' });
      const invalid = await directMessage({ text: 'not an email', eventKey: 'message:m-2' });
      expect(invalid.outcome).toBe('answer_invalid');
      expect(instagram.sentMessages.at(-1)?.message).toEqual({
        text: 'Please provide a valid email address. Use the button below to share your email.',
        quick_replies: [{ content_type: 'user_email' }],
      });
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({
        status: 'waiting',
        waiting_for: 'email',
        sending_message_kind: null,
      });

      const phoneAutomation = await dmAutomation('phone', { is_phone_collection_enabled: true });
      // A valid email completes the first run; then a phone automation waits for the phone.
      await directMessage({ text: 'jordan@example.com', eventKey: 'message:m-3' });
      await directMessage({ text: 'phone', eventKey: 'message:m-4' });
      const sentBefore = instagram.sentMessages.length;
      const phoneRun = (await readRunRows(organization.id)).find(
        (row) => row.automation_id === phoneAutomation.id,
      );
      expect(phoneRun).toMatchObject({ status: 'waiting', waiting_for: 'phone' });
      const invalidPhone = await directMessage({ text: '12', eventKey: 'message:m-5' });
      expect(invalidPhone.outcome).toBe('answer_invalid');
      expect(instagram.sentMessages).toHaveLength(sentBefore);
    });

    it('a story reply starts the story automation; a closed messaging window fails the step', async () => {
      const story = await liveAutomation({
        trigger_type: 'story_reply',
        keywords: [],
        is_opening_message_enabled: false,
        opening_message: null,
      });

      const result = await service.startStoryReplyRun({
        scope: scope(),
        instagramAccountPublicId: account.public_id,
        contact: await freshContact(),
        event: event('message:story-1'),
        instagramStoryId: '17910000000000001',
        text: 'love it',
      });

      // The contact never DMed the account and a story reply has no comment to reply to.
      expect(result).toMatchObject({ outcome: 'run_started', failedErrorType: 'instagram_api' });
      expect((await readRunRows(organization.id))[0]).toMatchObject({
        automation_id: story.id,
        trigger_type: 'story_reply',
        trigger_instagram_story_id: '17910000000000001',
        status: 'failed',
        error_message: 'instagram_api:outside_messaging_window',
      });
      expect(instagram.client.sendInstagramMessage).not.toHaveBeenCalled();
    });

    it('the follow check sends the request, and a click that confirms the follow goes on', async () => {
      await openMessagingWindow();
      const automation = await dmAutomation('follow', {
        is_follow_required: true,
        follow_request_message: {
          text: 'Follow us first',
          following_button_title: "I'm following",
          profile_button_title: 'Profile',
        },
      });
      instagram.followAnswers.push(false, true);

      await directMessage({ text: 'follow me', eventKey: 'message:m-1' });
      const [run] = await readRunRows(organization.id);
      expect(run).toMatchObject({ status: 'waiting', waiting_for: 'follow' });
      expect(JSON.stringify(instagram.sentMessages[0]?.message)).toContain(
        'https://www.instagram.com/acme.shop',
      );

      const clicked = await click({
        automationPublicId: automation.public_id,
        runPublicId: run?.public_id ?? '',
        eventKey: 'postback:follow-1',
      });

      expect(clicked.outcome).toBe('run_continued');
      expect((await readRunRow(run?.id ?? 0))?.status).toBe('completed');
      expect((await freshContact()).is_following_account).toBe(true);
    });

    it('ignores a click on a completed run, or naming another automation (D18)', async () => {
      const automation = await dmAutomation('catalog');
      const completed = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        status: 'completed',
        waiting_for: null,
        waiting_since_at: null,
        completed_at: new Date(),
      });
      const other = await dmAutomation('price');
      const waiting = await insertAutomationRun({
        organizationId: organization.id,
        automationId: other.id,
        contactId: contact.id,
        waiting_for: 'opening_message_button',
      });

      expect(
        (
          await click({
            automationPublicId: automation.public_id,
            runPublicId: completed.public_id,
            eventKey: 'postback:c-1',
          })
        ).outcome,
      ).toBe('ignored');
      expect(
        (
          await click({
            automationPublicId: automation.public_id,
            runPublicId: waiting.public_id,
            eventKey: 'postback:c-2',
          })
        ).outcome,
      ).toBe('ignored');
      expect((await readRunRow(waiting.id))?.status).toBe('waiting');
    });

    it('sends nothing for an account that is not connected (AU27)', async () => {
      await dmAutomation('catalog');
      accountService.findAutomationAccountAccess.mockResolvedValueOnce({
        instagramAccount: { organizationId: organization.id, instagramAccountId: account.id },
        instagramAccountPublicId: account.public_id,
        instagramAppUserId: '1',
        username: 'acme.shop',
        connectionStatus: 'error',
        encryptedAccessToken: 'v1:fake',
        settings: null,
      });

      expect((await directMessage({ text: 'catalog', eventKey: 'message:m-1' })).outcome).toBe(
        'account_unavailable',
      );
      expect(await readRunRows(organization.id)).toEqual([]);
    });
  });
});
