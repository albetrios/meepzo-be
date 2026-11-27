import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';

const { messages, attempts, dayCounts, minuteCounts, monthCounts, afterCommit } = vi.hoisted(
  () => ({
    messages: {
      claimWaiting: vi.fn(),
      finishSending: vi.fn(),
      putBackWaiting: vi.fn(),
      endWaiting: vi.fn(),
    },
    attempts: { start: vi.fn(), finish: vi.fn() },
    dayCounts: { addToToday: vi.fn() },
    minuteCounts: { subtractFromMinute: vi.fn() },
    monthCounts: { subtractFromMonth: vi.fn() },
    afterCommit: vi.fn(),
  }),
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({ handle: 'unit' }),
    ),
  };
});
vi.mock('@/core/events/event-bus.js', () => ({ runEnqueueAfterCommit: afterCommit }));
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.repository.js',
  () => ({
    InstagramOutgoingMessageRepository: vi.fn(function construct() {
      return messages;
    }),
  }),
);
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-send-attempt.repository.js',
  () => ({
    InstagramSendAttemptRepository: vi.fn(function construct() {
      return attempts;
    }),
  }),
);
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/instagram-send-day-count.repository.js',
  () => ({
    InstagramSendDayCountRepository: vi.fn(function construct() {
      return dayCounts;
    }),
  }),
);
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/instagram-send-minute-count.repository.js',
  () => ({
    InstagramSendMinuteCountRepository: vi.fn(function construct() {
      return minuteCounts;
    }),
  }),
);
vi.mock('@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js', () => ({
  MessageMonthCountRepository: vi.fn(function construct() {
    return monthCounts;
  }),
}));
vi.mock('@/domains/app/sub-domains/instagram-sending/message-month-count.cache.js', () => ({
  invalidateCachedMessageMonthCount: vi.fn(),
}));

import { InstagramOutgoingMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.service.js';
import type {
  InstagramOutgoingMessageBroadcastResultPort,
  InstagramOutgoingMessageOpeningPort,
  InstagramOutgoingMessageRunResultPort,
  InstagramSendResultInput,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.types.js';

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.JOB({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const STARTED_AT = new Date('2026-11-25T08:00:00.000Z');
const KEY = {
  organizationId: 7,
  publicId: 'igm_aaaaaaaaaaaaaaaaaaaaa',
  automationRunStartedAt: STARTED_AT,
};

/** A message row as the repository answers it; a run's list message 2 unless overridden. */
function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    public_id: KEY.publicId,
    organization_id: 7,
    channel_account_id: 11,
    automation_id: 5,
    automation_run_id: 9,
    automation_run_started_at: STARTED_AT,
    broadcast_id: null,
    contact_id: 3,
    message_type: 'message',
    message_number: 2,
    is_counted_as_direct_message: true,
    ...overrides,
  };
}

function resultInput(overrides: Partial<InstagramSendResultInput> = {}): InstagramSendResultInput {
  return {
    scope,
    key: KEY,
    attempt: { organizationId: 7, id: 100, startedAt: STARTED_AT },
    status: 'sent',
    reason: null,
    instagramMessageId: 'mid-1',
    errorCode: null,
    errorSubcode: null,
    resultGroup: 'sent',
    httpStatus: 200,
    durationMilliseconds: 120,
    ...overrides,
  } as InstagramSendResultInput;
}

/**
 * Instagram's message service with its repositories and the database unit faked (routes-final
 * § 6.B — SN3, SN4; AC-7.2–AC-7.9; BC18): the claim opens an attempt only for a claimed row, the one
 * result save reports a run's message to the engine and a broadcast's to its recipients in the same
 * unit, a "back to waiting" reports nothing and gives the claim's counts back, a repeat save does
 * nothing, an opening DM moves the contact's bookkeeping, and cancel / skip refuse an unknown
 * reason. The database side is `instagram-outgoing-message.service.db.unit.test.ts` and
 * `instagram-outgoing-message.repository.db.unit.test.ts`.
 */
describe('InstagramOutgoingMessageService', () => {
  let recordRunMessageResult: ReturnType<typeof vi.fn<InstagramOutgoingMessageRunResultPort>>;
  let recordBroadcastMessageResult: ReturnType<
    typeof vi.fn<InstagramOutgoingMessageBroadcastResultPort>
  >;
  let recordContactOpeningMessage: ReturnType<typeof vi.fn<InstagramOutgoingMessageOpeningPort>>;
  let service: InstagramOutgoingMessageService;

  beforeEach(() => {
    vi.clearAllMocks();
    recordRunMessageResult = vi.fn<InstagramOutgoingMessageRunResultPort>(async () => {});
    recordBroadcastMessageResult = vi.fn<InstagramOutgoingMessageBroadcastResultPort>(
      async () => {},
    );
    recordContactOpeningMessage = vi.fn<InstagramOutgoingMessageOpeningPort>(async () => {});
    service = new InstagramOutgoingMessageService({
      recordRunMessageResult,
      recordBroadcastMessageResult,
      recordContactOpeningMessage,
    });
    messages.finishSending.mockResolvedValue(messageRow());
    messages.putBackWaiting.mockResolvedValue(messageRow());
  });

  it('opens an attempt only when the waiting row was claimed', async () => {
    const claim = {
      scope,
      key: KEY,
      lane: 'fast' as const,
      channel: 'direct' as const,
      countGroup: 'fast' as const,
    };
    messages.claimWaiting.mockResolvedValueOnce(null);
    expect(await service.claimMessage(claim as never)).toBeNull();
    expect(attempts.start).not.toHaveBeenCalled();

    messages.claimWaiting.mockResolvedValueOnce(messageRow({ status: 'sending' }));
    attempts.start.mockResolvedValueOnce({ id: 100, startedAt: STARTED_AT });
    const claimed = await service.claimMessage(claim as never);
    expect(claimed?.attempt).toEqual({ id: 100, startedAt: STARTED_AT });
    expect(attempts.start).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 41, lane: 'fast', countGroup: 'fast' }),
    );
  });

  it("reports a run's message to the engine, never to the broadcast recipients", async () => {
    await service.saveSendResult(resultInput());
    expect(attempts.finish).toHaveBeenCalledTimes(1);
    expect(recordRunMessageResult).toHaveBeenCalledWith(
      expect.objectContaining({
        automationRunId: 9,
        messagePublicId: KEY.publicId,
        messageNumber: 2,
        result: 'sent',
        databaseHandle: { handle: 'unit' },
      }),
    );
    expect(recordBroadcastMessageResult).not.toHaveBeenCalled();
  });

  it("reports a broadcast's message to its recipients in the same unit, `expired` as skipped (R23)", async () => {
    messages.finishSending.mockResolvedValueOnce(
      messageRow({
        automation_run_id: null,
        automation_id: null,
        broadcast_id: 21,
        message_type: 'broadcast',
        message_number: 1,
      }),
    );
    await service.saveSendResult(resultInput({ status: 'expired', reason: 'expired' }));
    expect(recordBroadcastMessageResult).toHaveBeenCalledWith({
      databaseHandle: { handle: 'unit' },
      organizationId: 7,
      broadcastId: 21,
      contactId: 3,
      messagePublicId: KEY.publicId,
      messageNumber: 1,
      result: 'skipped',
      reason: 'expired',
      occurredAt: expect.any(Date),
    });
    expect(recordRunMessageResult).not.toHaveBeenCalled();
  });

  it('a message back to waiting reports nothing and gives the claim counts back', async () => {
    const claimedAt = new Date('2026-11-25T09:00:00.000Z');
    await service.saveSendResult(
      resultInput({
        status: 'waiting',
        instagramMessageId: null,
        isTryUsed: true,
        giveBack: { countGroup: 'fast', claimedAt },
      }),
    );
    expect(messages.putBackWaiting).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY, isTryUsed: true }),
    );
    expect(minuteCounts.subtractFromMinute).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: 11,
      countGroup: 'fast',
      count: 1,
      claimedAt,
    });
    expect(monthCounts.subtractFromMonth).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: 11,
      count: 1,
    });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(dayCounts.addToToday).not.toHaveBeenCalled();
    expect(recordRunMessageResult).not.toHaveBeenCalled();
    expect(recordBroadcastMessageResult).not.toHaveBeenCalled();
  });

  it('a repeat save for a settled message changes nothing', async () => {
    messages.finishSending.mockResolvedValueOnce(null);
    expect(await service.saveSendResult(resultInput())).toBeNull();
    expect(attempts.finish).not.toHaveBeenCalled();
    expect(recordRunMessageResult).not.toHaveBeenCalled();
  });

  it("an opening DM sent moves the contact's opening bookkeeping", async () => {
    messages.finishSending.mockResolvedValueOnce(messageRow({ message_type: 'opening_message' }));
    await service.saveSendResult(resultInput({ attempt: null }));
    expect(recordContactOpeningMessage).toHaveBeenCalledWith({
      databaseHandle: { handle: 'unit' },
      organizationId: 7,
      contactId: 3,
      sentAt: expect.any(Date),
    });
    expect(attempts.finish).not.toHaveBeenCalled();
  });

  it('cancels and skips with a known reason, and refuses an unknown one', async () => {
    messages.endWaiting.mockResolvedValue(2);
    const selection = { organizationId: 7, by: 'run' as const, id: 9 };
    expect(
      await service.cancelWaitingMessages({ ...selection, reason: 'cancelled_by_owner' }),
    ).toBe(2);
    expect(messages.endWaiting).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'cancelled', reason: 'cancelled_by_owner' }),
    );
    await service.skipWaitingMessages({ ...selection, reason: 'replaced' });
    expect(messages.endWaiting).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'skipped', reason: 'replaced' }),
    );
    await expect(
      service.cancelWaitingMessages({ ...selection, reason: 'no_such_reason' }),
    ).rejects.toThrow('unknown reason');
  });
});
