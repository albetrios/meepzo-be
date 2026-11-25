import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  nextInstagramObjectId,
  readRunRow,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertInstagramMessage,
  readInstagramMessages,
  readInstagramSendAttempts,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Instagram's messages against the database (feat-instagram-dm-sending routes-final § 6.B — SNC13,
 * SNC14; AC-7.2–AC-7.9, AC-7.13): the run engine saving through the real `ChannelSendingPort`, the
 * lane rule (a private reply vs a DM — P133), every status move (claim, result save, cancel, skip,
 * lane move), an `unknown` never sent again by itself, the own-echo lookup, and the failed-message
 * summary and retry with each reason it cannot go. Every unit runs in the organization's own job
 * scope (`pnpm test:rls-role` safe).
 */

const HOUR = 60 * 60 * 1000;

describe('InstagramMessageService (database)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };
  let contact: ContactFixtureRow;
  let engine: AutomationRunService;
  let messages: InstagramMessageService;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      username: 'riya.k',
    });
    messages = new InstagramMessageService({
      recordRunMessageResult: (input) => engine.recordMessageResult(input),
    });
    const runAccount = (): AutomationRunChannelAccount => ({
      organizationId: organization.id,
      id: account.channel_account_id,
      public_id: account.public_id,
      channel: 'instagram',
      connection_status: 'connected',
      is_automation_enabled: true,
      time_zone: 'UTC',
      is_comment_reply_trigger_enabled: true,
      is_once_per_person_per_post_enabled: true,
    });
    engine = new AutomationRunService({
      channelAccountService: {
        readAutomationRunAccount: async ({ channelAccountPublicId }) =>
          channelAccountPublicId === account.public_id ? runAccount() : null,
      },
      contactService: new ContactService(
        new ContactRepository(),
        {} as OrganizationService,
        [],
        async () => null,
      ),
      planAccessService: { getPlanAccess: (async () => ({ features: null })) as never },
      countService: new AutomationCountService(new AutomationCountRepository()),
      replyStateService: new AutomationReplyStateService(new AutomationReplyStateRepository()),
      sendingPorts: { instagram: messages },
      drawInteger: () => 0,
    });
  });

  async function commentOn(who: ContactFixtureRow) {
    const commentId = nextInstagramObjectId();
    const fresh = await readContactRow(who.id);
    await engine.startCommentRun({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      contact: fresh!,
      event: {
        eventKey: `comment:${commentId}`,
        eventId: commentId,
        occurredAt: new Date(),
        isLastAttempt: false,
      },
      kind: 'comment',
      commentId,
      mediaId: '17900000000000001',
      parentCommentId: null,
      text: 'guide please',
      commenterUsername: who.username ?? 'someone',
    });
  }

  async function liveCommentAutomation() {
    return insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      keywords: ['guide'],
      steps: {
        hello: {
          on: true,
          versions: [{ text: 'Hi!', buttons: [{ title: 'Go', action: 'next' }] }],
        },
        messages: [{ kind: 'text', wait_minutes: 0, text: 'Here it is' }],
      },
    });
  }

  function keyOf(row: { public_id: string; automation_run_started_at: Date }) {
    return {
      organizationId: organization.id,
      publicId: row.public_id,
      automationRunStartedAt: row.automation_run_started_at,
    };
  }

  describe('the lane rule (SN22, P133)', () => {
    it("saves a comment's opening DM with her chat closed as a waiting private reply in the slow lane", async () => {
      await liveCommentAutomation();
      await commentOn(contact);
      const [row] = await readInstagramMessages(organization.id);
      expect(row).toMatchObject({
        message_type: 'opening_message',
        lane: 'slow',
        channel: 'private_reply',
        status: 'waiting',
        is_counted_as_direct_message: true,
        version_number: 1,
      });
      expect(row!.public_id).toMatch(/^igm_[a-z0-9]{21}$/);
      expect(row!.not_before).not.toBeNull();
    });

    it('saves it as a plain DM in the fast lane while her chat is open', async () => {
      await liveCommentAutomation();
      const chatting = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        username: 'open.chat',
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
      await commentOn(chatting);
      const [row] = await readInstagramMessages(organization.id);
      expect(row).toMatchObject({ lane: 'fast', channel: 'direct', status: 'waiting' });
    });

    it('answers skipped window_closed for a DM step whose chat is closed, writing nothing', async () => {
      const automation = await liveCommentAutomation();
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const result = await withAppDatabaseContext({
        scope: scope(),
        callback: (databaseHandle) =>
          messages.saveWaitingMessage({
            databaseHandle,
            organizationId: organization.id,
            channelAccountId: account.channel_account_id,
            contactId: contact.id,
            source: {
              automationId: automation.id,
              automationRunId: run.id,
              automationRunStartedAt: run.started_at,
            },
            step: 'messages',
            messageNumber: 1,
            versionNumber: null,
            wordingNumber: null,
            messageKind: 'text',
            content: { stepPath: 'steps.messages.0', uploadPublicIds: [] },
            notBefore: null,
            triggerOccurredAt: run.trigger_occurred_at,
            answersEventId: null,
          }),
      });
      expect(result).toEqual({ messagePublicId: null, status: 'skipped', reason: 'window_closed' });
      expect(await readInstagramMessages(organization.id)).toEqual([]);
    });
  });

  describe('status moves (SN16, SNC13)', () => {
    it('claims a waiting row once, saves its result once and moves the run on (sent)', async () => {
      await liveCommentAutomation();
      await commentOn(contact);
      const [waiting] = await readInstagramMessages(organization.id);
      const claimed = await messages.claimMessage({
        scope: scope(),
        key: keyOf(waiting!),
        lane: 'slow',
        channel: 'private_reply',
        countGroup: 'open',
      });
      expect(claimed?.message.status).toBe('sending');
      // A second claim of the same row misses: it is no longer waiting.
      expect(
        await messages.claimMessage({
          scope: scope(),
          key: keyOf(waiting!),
          lane: 'slow',
          channel: 'private_reply',
          countGroup: 'open',
        }),
      ).toBeNull();
      const saved = await messages.saveSendResult({
        scope: scope(),
        key: keyOf(waiting!),
        attempt: { organizationId: organization.id, ...claimed!.attempt },
        status: 'sent',
        reason: null,
        instagramMessageId: 'aWdfZAG1mid001',
        errorCode: null,
        errorSubcode: null,
        resultGroup: 'sent',
        httpStatus: 200,
        durationMilliseconds: 420,
      });
      expect(saved).toMatchObject({ status: 'sent', instagram_message_id: 'aWdfZAG1mid001' });
      expect(saved!.sent_at).not.toBeNull();
      expect(saved!.sending_at).toBeNull();
      const [attempt] = await readInstagramSendAttempts(organization.id);
      expect(attempt).toMatchObject({
        lane: 'slow',
        count_group: 'open',
        result_group: 'sent',
        http_status: 200,
        duration_milliseconds: 420,
        instagram_message_id: waiting!.id,
      });
      // The engine took the result in the same commit: her first DM is on the run.
      const run = await readRunRow(waiting!.automation_run_id!);
      expect(run?.direct_message_sent_at).not.toBeNull();
      // A repeat save of a settled message changes nothing.
      expect(
        await messages.saveSendResult({
          scope: scope(),
          key: keyOf(waiting!),
          attempt: null,
          status: 'failed',
          reason: 'bad_text',
          instagramMessageId: null,
          errorCode: 100,
          errorSubcode: null,
          resultGroup: 'bad_text',
          httpStatus: 400,
          durationMilliseconds: 10,
        }),
      ).toBeNull();
    });

    it('never sends an unknown again by itself; her next action reopens the same row once (D17, AC-7.13)', async () => {
      await liveCommentAutomation();
      await commentOn(contact);
      const [waiting] = await readInstagramMessages(organization.id);
      const claimed = await messages.claimMessage({
        scope: scope(),
        key: keyOf(waiting!),
        lane: 'slow',
        channel: 'private_reply',
        countGroup: 'open',
      });
      await messages.saveSendResult({
        scope: scope(),
        key: keyOf(waiting!),
        attempt: { organizationId: organization.id, ...claimed!.attempt },
        status: 'unknown',
        reason: 'no_answer',
        instagramMessageId: null,
        errorCode: null,
        errorSubcode: null,
        resultGroup: 'no_answer',
        httpStatus: null,
        durationMilliseconds: 15_000,
      });
      // Nothing claims it again: it is not waiting.
      expect(
        await messages.claimMessage({
          scope: scope(),
          key: keyOf(waiting!),
          lane: 'slow',
          channel: 'private_reply',
          countGroup: 'open',
        }),
      ).toBeNull();
      let [row] = await readInstagramMessages(organization.id);
      expect(row).toMatchObject({ status: 'unknown', reason: 'no_answer' });
      // The engine saves the step once more on her next message or tap: the same row waits again.
      const run = await readRunRow(waiting!.automation_run_id!);
      const again = await withAppDatabaseContext({
        scope: scope(),
        callback: (databaseHandle) =>
          messages.saveWaitingMessage({
            databaseHandle,
            organizationId: organization.id,
            channelAccountId: account.channel_account_id,
            contactId: contact.id,
            source: {
              automationId: run!.automation_id,
              automationRunId: run!.id,
              automationRunStartedAt: run!.started_at,
            },
            step: 'hello',
            messageNumber: null,
            versionNumber: 1,
            wordingNumber: null,
            messageKind: 'text',
            content: { stepPath: 'steps.hello.versions.0', uploadPublicIds: [] },
            notBefore: null,
            triggerOccurredAt: run!.trigger_occurred_at,
            answersEventId: run!.trigger_instagram_comment_id,
          }),
      });
      expect(again).toEqual({ messagePublicId: waiting!.public_id, status: 'waiting' });
      const rows = await readInstagramMessages(organization.id);
      expect(rows).toHaveLength(1);
      [row] = rows;
      expect(row).toMatchObject({ status: 'waiting', reason: null, asks: 0 });
    });

    it('cancels and skips waiting rows only, and moves a waiting row between lanes', async () => {
      const automation = await liveCommentAutomation();
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const waiting = await insertInstagramMessage({
        run,
        channelAccountId: account.channel_account_id,
        message_type: 'opening_message',
        message_number: null,
        lane: 'slow',
        channel: 'private_reply',
        status: 'waiting',
        reason: null,
      });
      const sent = await insertInstagramMessage({
        run,
        channelAccountId: account.channel_account_id,
        message_number: 1,
        status: 'sent',
        reason: null,
        sent_at: new Date(),
      });
      expect(
        await messages.moveMessageLane({
          scope: scope(),
          key: keyOf(waiting),
          lane: 'fast',
          channel: 'direct',
        }),
      ).toBe(true);
      expect(
        await messages.moveMessageLane({
          scope: scope(),
          key: keyOf(sent),
          lane: 'slow',
          channel: 'private_reply',
        }),
      ).toBe(false);
      const cancelled = await withAppDatabaseContext({
        scope: scope(),
        callback: (databaseHandle) =>
          messages.cancelWaitingMessages({
            databaseHandle,
            organizationId: organization.id,
            by: 'automation',
            id: automation.id,
            reason: 'automation_deleted',
          }),
      });
      expect(cancelled).toBe(1);
      const rows = await readInstagramMessages(organization.id);
      expect(rows.map((row) => [row.status, row.reason, row.lane])).toEqual([
        ['cancelled', 'automation_deleted', 'fast'],
        ['sent', null, 'fast'],
      ]);
      // An unknown reason is a caller's bug.
      await expect(
        messages.skipWaitingMessages({
          organizationId: organization.id,
          by: 'contact',
          id: contact.id,
          reason: 'no_such_reason',
        }),
      ).rejects.toThrow(/unknown reason/);
    });

    it('finds our own sent messages by Meta id, per account (WHQ1, P62)', async () => {
      const automation = await liveCommentAutomation();
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      await insertInstagramMessage({
        run,
        channelAccountId: account.channel_account_id,
        status: 'sent',
        reason: null,
        sent_at: new Date(),
        instagram_message_id: 'mid.ours',
      });
      const found = await messages.findOwnSentMessageIds({
        scope: scope(),
        channelAccount: {
          organizationId: organization.id,
          channelAccountId: account.channel_account_id,
        },
        messageIds: ['mid.ours', 'mid.hers'],
      });
      expect([...found]).toEqual(['mid.ours']);
      const other = await insertInstagramAccount({ organizationId: organization.id });
      const elsewhere = await messages.findOwnSentMessageIds({
        scope: scope(),
        channelAccount: {
          organizationId: organization.id,
          channelAccountId: other.channel_account_id,
        },
        messageIds: ['mid.ours'],
      });
      expect([...elsewhere]).toEqual([]);
    });
  });

  describe('failed messages: summary and retry (SN18, AC-7.2–AC-7.9)', () => {
    it('counts each reason it cannot go, retries exactly the allowed ones once, and changes nothing on a count', async () => {
      const automation = await liveCommentAutomation();
      const open = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        username: 'open',
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
      const optedOut = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        username: 'stopped',
        opted_out_at: new Date(),
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
      const runOf = (who: ContactFixtureRow) =>
        insertAutomationRun({
          organizationId: organization.id,
          automationId: automation.id,
          contactId: who.id,
          isOpenKeyLeftOut: true,
          status: 'failed',
          failed_at: new Date(),
          waiting_for: null,
          waiting_since_at: null,
        });
      const openRun = await runOf(open);
      const closedRun = await runOf(contact);
      const optedOutRun = await runOf(optedOut);
      const channelAccountId = account.channel_account_id;
      // Retryable: a DM to her open chat, and a fresh opening private reply.
      await insertInstagramMessage({ run: openRun, channelAccountId, message_number: 1 });
      await insertInstagramMessage({
        run: closedRun,
        channelAccountId,
        message_type: 'opening_message',
        message_number: null,
        lane: 'slow',
        channel: 'private_reply',
        trigger_occurred_at: new Date(Date.now() - HOUR),
      });
      // Cannot: chat closed, too old, final for her (opted out; a person error), already retried.
      await insertInstagramMessage({ run: closedRun, channelAccountId, message_number: 1 });
      const oldRun = await runOf(contact);
      await insertInstagramMessage({
        run: oldRun,
        channelAccountId,
        message_type: 'opening_message',
        message_number: null,
        lane: 'slow',
        channel: 'private_reply',
        trigger_occurred_at: new Date(Date.now() - 8 * 24 * HOUR),
      });
      await insertInstagramMessage({ run: optedOutRun, channelAccountId, message_number: 1 });
      await insertInstagramMessage({
        run: openRun,
        channelAccountId,
        message_number: 2,
        error_code: 100,
        error_subcode: 2_534_014,
      });
      await insertInstagramMessage({
        run: openRun,
        channelAccountId,
        message_number: 3,
        owner_retry_at: new Date(Date.now() - HOUR),
      });
      // Never counted: an unknown and a skipped message.
      await insertInstagramMessage({
        run: openRun,
        channelAccountId,
        message_number: 4,
        status: 'unknown',
        reason: 'no_answer',
      });
      await insertInstagramMessage({
        run: openRun,
        channelAccountId,
        message_number: 5,
        status: 'skipped',
        reason: 'window_closed',
      });
      const target = {
        scope: scope(),
        organizationId: organization.id,
        by: 'automation' as const,
        id: automation.id,
      };
      const summary = await messages.summarizeFailedMessages(target);
      expect(summary).toEqual({
        failedCount: 7,
        retryableCount: 2,
        notRetryable: {
          too_old: 1,
          chat_closed: 1,
          final_for_person: 2,
          text_refused: 0,
          broadcast: 0,
          already_retried: 1,
        },
        horizonDays: 30,
      });
      const before = await readInstagramMessages(organization.id);
      expect(await messages.summarizeFailedMessages(target)).toEqual(summary);
      expect(await readInstagramMessages(organization.id)).toEqual(before);

      const retry = await messages.retryFailedMessages(target);
      expect(retry).toMatchObject({ expectedRetryCount: 2, isQueued: false });
      const after = await readInstagramMessages(organization.id);
      const retried = after.filter((row) => row.status === 'waiting');
      expect(retried).toHaveLength(2);
      expect(retried.every((row) => row.owner_retry_at !== null && row.reason === null)).toBe(true);
      // A second press retries nothing twice.
      expect((await messages.retryFailedMessages(target)).expectedRetryCount).toBe(0);
      // Route 63's last retry: two went back; five failed ones of the automation are still there.
      const lastRetry = await messages.findLastRetry({
        scope: scope(),
        organizationId: organization.id,
        channelAccountId,
      });
      expect(lastRetry).toMatchObject({ automation_id: automation.public_id, retried: 2 });
      expect(
        await messages.countWaitingByLane({
          scope: scope(),
          organizationId: organization.id,
          channelAccountId,
        }),
      ).toEqual({ fast: 1, slow: 1 });
    });

    it('retries nothing while the automation is stopped for a refused text, and a retried one that fails again stays failed (AC-7.7, AC-7.8)', async () => {
      const automation = await insertAutomation({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        keywords: ['guide'],
        stopped_reason: 'bad_text',
        stopped_at: new Date(),
      });
      const open = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
        username: 'open',
        last_direct_message_received_at: new Date(Date.now() - HOUR),
      });
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: open.id,
        isOpenKeyLeftOut: true,
        status: 'failed',
        failed_at: new Date(),
        waiting_for: null,
        waiting_since_at: null,
      });
      await insertInstagramMessage({ run, channelAccountId: account.channel_account_id });
      const target = {
        scope: scope(),
        organizationId: organization.id,
        by: 'automation' as const,
        id: automation.id,
      };
      expect((await messages.summarizeFailedMessages(target)).notRetryable.text_refused).toBe(1);
      expect((await messages.retryFailedMessages(target)).expectedRetryCount).toBe(0);
      expect((await readInstagramMessages(organization.id))[0]?.status).toBe('failed');

      // Fixed text: it goes once; when it fails again it stays failed and is never retried again.
      const contactTarget = { ...target, by: 'contact' as const, id: open.id };
      await insertInstagramMessage({
        run,
        channelAccountId: account.channel_account_id,
        message_number: 2,
        owner_retry_at: new Date(),
      });
      expect(
        (await messages.summarizeFailedMessages(contactTarget)).notRetryable.already_retried,
      ).toBe(1);
    });
  });
});
