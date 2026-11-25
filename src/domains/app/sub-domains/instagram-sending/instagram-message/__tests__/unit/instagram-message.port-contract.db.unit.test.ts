import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { ChannelMessageResultInput } from '@/domains/app/app.channel-ports.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import type { InstagramSendResultInput } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.types.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { insertInstagramMessage } from '@/domains/app/sub-domains/instagram-sending/instagram-message/__tests__/factories/instagram-message.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The outbound seam's contract run against Instagram's implementation (feat-instagram-dm-sending
 * routes-final § 6.C SNC16, SN22; AU35): every final status of a run's message reaches the engine's
 * `recordMessageResult` exactly once, in the result's own commit, mapped to the engine's result; a
 * repeat save of a settled message reaches it no more. The lane of each step and the `skipped`
 * answer are proved by `instagram-message.util.unit.test.ts` and
 * `instagram-message.service.db.unit.test.ts` (ROUTE row R19).
 */
describe('ChannelSendingPort — Instagram reports each result to the engine once (SNC16)', () => {
  let organization: { id: number; public_id: string };
  let channelAccountId: number;
  let recorded: ChannelMessageResultInput[];
  let messages: InstagramMessageService;
  let run: Awaited<ReturnType<typeof insertAutomationRun>>;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    const account = await insertInstagramAccount({ organizationId: organization.id });
    channelAccountId = account.channel_account_id;
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      last_direct_message_received_at: new Date(),
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId,
      status: 'live',
    });
    run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
    });
    recorded = [];
    messages = new InstagramMessageService({
      recordRunMessageResult: async (input) => {
        recorded.push(input);
      },
    });
  });

  /** One waiting list message of the run, claimed in the fast lane. */
  async function claimedMessage(messageNumber: number) {
    const row = await insertInstagramMessage({
      run,
      channelAccountId,
      message_number: messageNumber,
      status: 'waiting',
      reason: null,
    });
    const key = {
      organizationId: organization.id,
      publicId: row.public_id,
      automationRunStartedAt: row.automation_run_started_at,
    };
    const claimed = await messages.claimMessage({
      scope: scope(),
      key,
      lane: 'fast',
      channel: 'direct',
      countGroup: 'fast',
    });
    expect(claimed?.message.status).toBe('sending');
    return { key, attempt: { organizationId: organization.id, ...claimed!.attempt } };
  }

  function resultOf(
    claimed: Awaited<ReturnType<typeof claimedMessage>>,
    values: Pick<InstagramSendResultInput, 'status' | 'reason'> & Partial<InstagramSendResultInput>,
  ): InstagramSendResultInput {
    return {
      scope: scope(),
      key: claimed.key,
      attempt: claimed.attempt,
      instagramMessageId: null,
      errorCode: null,
      errorSubcode: null,
      resultGroup: values.status === 'sent' ? 'sent' : 'no_answer',
      httpStatus: null,
      durationMilliseconds: 300,
      ...values,
    };
  }

  it('maps sent, failed, unknown and skipped to the engine once each, and never twice', async () => {
    const cases = [
      { messageNumber: 1, status: 'sent', reason: null, instagramMessageId: 'mid.sent' },
      { messageNumber: 2, status: 'failed', reason: 'bad_text', errorCode: 100 },
      { messageNumber: 3, status: 'unknown', reason: null },
      { messageNumber: 4, status: 'skipped', reason: 'window_closed' },
    ] as const;
    for (const { messageNumber, ...values } of cases) {
      const claimed = await claimedMessage(messageNumber);
      expect(await messages.saveSendResult(resultOf(claimed, values))).not.toBeNull();
      // A second save of the settled message is refused and reaches the engine no more.
      expect(
        await messages.saveSendResult(resultOf(claimed, { status: 'failed', reason: 'bad_text' })),
      ).toBeNull();
    }

    expect(
      recorded.map(({ messageNumber, step, result, reason, automationRunId }) => ({
        messageNumber,
        step,
        result,
        reason,
        automationRunId,
      })),
    ).toEqual([
      { messageNumber: 1, step: 'messages', result: 'sent', reason: null, automationRunId: run.id },
      {
        messageNumber: 2,
        step: 'messages',
        result: 'failed',
        reason: 'bad_text',
        automationRunId: run.id,
      },
      {
        messageNumber: 3,
        step: 'messages',
        result: 'unknown',
        reason: null,
        automationRunId: run.id,
      },
      {
        messageNumber: 4,
        step: 'messages',
        result: 'skipped',
        reason: 'window_closed',
        automationRunId: run.id,
      },
    ]);
  });
});
