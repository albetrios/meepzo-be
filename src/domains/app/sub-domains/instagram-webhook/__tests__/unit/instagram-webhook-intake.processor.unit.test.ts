import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contextCalls } = vi.hoisted(() => ({ contextCalls: { count: 0 } }));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/infrastructure/database/contexts/database-context.js')>();
  return {
    ...actual,
    withAppDatabaseContext: async ({ callback }: { callback: (handle: unknown) => unknown }) => {
      contextCalls.count += 1;
      return callback({ fake: 'handle' });
    },
  };
});

vi.mock('@/infrastructure/database/transaction.js', () => ({
  withSavepoint: (callback: () => Promise<unknown>) => callback(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  type InstagramWebhookIntakeServices,
  describeInstagramWebhookIntakeError,
  processInstagramWebhookIntakeJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-intake.processor.js';
import { InstagramWebhookEventPermanentError } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';

/**
 * Intake per kind with fakes (feat-instagram-dm-sending § 5 WH10, WH12, WH13, WH27; WHC7–WHC9,
 * WHC16): which entry point each normalized kind reaches and with what, the owner's echo and quiet
 * time, the follow-ups per group (comments in every slot, the lowest priority while flooded), the
 * new contact's profile read after the commit, the late comment's time failing open, the database
 * limiter around each unit, and the error codes.
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop0000000000001';
const ACCOUNT_PUBLIC_ID = 'cha_acmeshop0000000000001';
const SENDER = '17841400000000777';

const CONTACT = {
  id: 41,
  public_id: 'con_acmeshop0000000000001',
  channel_account_id: 13,
  first_message_at: null,
};

interface FakeEvent {
  event_kind: string;
  payload: Record<string, unknown>;
  created_at?: Date;
  occurred_at?: Date | null;
}

let queue: FakeEvent[];
let services: InstagramWebhookIntakeServices;
let engine: {
  startCommentRun: ReturnType<typeof vi.fn>;
  handleDirectMessage: ReturnType<typeof vi.fn>;
  handleButtonClick: ReturnType<typeof vi.fn>;
};
let messages: {
  findOwnSentMessageIds: ReturnType<typeof vi.fn>;
  matchEchoedMessage: ReturnType<typeof vi.fn>;
};
let events: Record<string, ReturnType<typeof vi.fn>>;
let isNewContact: boolean;

function stored(event: FakeEvent, index: number) {
  return {
    id: index + 1,
    public_id: `iwe_${index}`,
    event_kind: event.event_kind,
    event_key: `${event.event_kind}:${index}`,
    payload: event.payload,
    contact_instagram_user_id: SENDER,
    attempt_count: 1,
    created_at: event.created_at ?? new Date(),
    occurred_at: event.occurred_at ?? null,
  };
}

beforeEach(() => {
  contextCalls.count = 0;
  queue = [];
  isNewContact = false;
  let claimedCount = 0;
  events = {
    claimNextEvent: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) return null;
      claimedCount += 1;
      return { outcome: 'claimed', event: stored(next, claimedCount) };
    }),
    markEventProcessed: vi.fn(async () => true),
    markEventSkipped: vi.fn(async () => true),
    markEventFailed: vi.fn(async () => true),
    releaseEventClaim: vi.fn(async () => true),
    countContactMessageEventsSince: vi.fn(async () => 0),
    listEchoMessageIdsSince: vi.fn(async () => []),
    countWaitingEvents: vi.fn(async () => 0),
  };
  engine = {
    startCommentRun: vi.fn(async () => ({ outcome: 'run_started', runPublicIds: ['run_1'] })),
    handleDirectMessage: vi.fn(async () => ({ outcome: 'run_started', runPublicIds: [] })),
    handleButtonClick: vi.fn(async () => ({ outcome: 'run_continued', runPublicIds: [] })),
  };
  messages = {
    findOwnSentMessageIds: vi.fn(async () => new Set<string>()),
    matchEchoedMessage: vi.fn(async () => 'none'),
  };
  services = {
    instagramAccountService: {
      findWebhookProcessingAccount: vi.fn(async () => ({
        instagramAccount: { organizationId: 7, instagramAccountId: 3 },
        channelAccountId: 13,
        instagramAccountPublicId: ACCOUNT_PUBLIC_ID,
        connectionStatus: 'connected',
        isAutomationEnabled: true,
        encryptedAccessToken: null,
      })),
    },
    channelAccountService: { markAccountBroken: vi.fn(async () => true) },
    broadcastRecipientService: {
      recordContactReply: vi.fn(async () => 0),
      handleChatOpened: vi.fn(async () => 0),
    },
    instagramAccountSettingsService: {
      findSettings: vi.fn(async () => ({ extra_stop_words: ['basta'] })),
    },
    instagramWebhookEventService: events,
    contactService: {
      lockInboundContact: vi.fn(async () => true),
      recordInboundContactEvent: vi.fn(async () => ({
        contact: CONTACT,
        isNewContact,
        isFirstMessage: true,
      })),
      recordContactOptOut: vi.fn(async () => CONTACT),
    },
    instagramMediaService: {
      findStoredMedia: vi.fn(async () => null),
      upsertFromInstagram: vi.fn(async () => null),
    },
    automationService: { linkNextPostAutomations: vi.fn(async () => []) },
    automationRunService: engine,
    instagramMessageService: messages,
  } as unknown as InstagramWebhookIntakeServices;
});

function run({
  intakeKind = 'messages',
  ...options
}: Partial<Parameters<typeof processInstagramWebhookIntakeJob>[0]> & {
  intakeKind?: 'messages' | 'live' | 'comments';
} = {}) {
  return processInstagramWebhookIntakeJob({
    jobData: {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      intakeKind,
    },
    services,
    jobId: 'job-1',
    enqueueFollowUp: async () => undefined,
    ...options,
  });
}

const messaging = (item: Record<string, unknown>) => ({ sender: { id: SENDER }, ...item });

describe('processInstagramWebhookIntakeJob — the entry point of each kind (WH27)', () => {
  it('a DM reaches handleDirectMessage with her first message and the quiet time', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_1', text: 'hi' } }),
    });
    events.listEchoMessageIdsSince?.mockResolvedValueOnce(['m_owner']);

    await expect(run()).resolves.toMatchObject({ processedEventCount: 1 });

    expect(engine.handleDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message',
        text: 'hi',
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        isFirstMessage: true,
        isOwnerChatting: true,
      }),
    );
    expect(services.contactService.recordInboundContactEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message', providerUserId: SENDER, channelAccountId: 13 }),
    );
  });

  it('a DM records her reply to a broadcast and her chat opening in its commit (BC17); a comment does not', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_r', text: 'hi' } }),
    });
    await run();
    queue.push({
      event_kind: 'comment',
      payload: { field: 'comments', value: { id: '18000009', media: { id: '17900009' } } },
    });
    await run({ intakeKind: 'comments' });

    expect(services.broadcastRecipientService.recordContactReply).toHaveBeenCalledTimes(1);
    expect(services.broadcastRecipientService.recordContactReply).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT.id, organizationId: 7 }),
    );
    // Her chat opened: the "when her chat opens" hook runs in the same commit (BC17, R47).
    expect(services.broadcastRecipientService.handleChatOpened).toHaveBeenCalledTimes(1);
    expect(services.broadcastRecipientService.handleChatOpened).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT.id, organizationId: 7, isOwnerChatting: false }),
    );
  });

  it('an echo of ours (the 6-hour window) does not count as the owner chatting', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_2', text: 'hi' } }),
    });
    events.listEchoMessageIdsSince?.mockResolvedValueOnce(['m_ours']);
    messages.findOwnSentMessageIds.mockResolvedValueOnce(new Set(['m_ours']));

    await run();

    expect(engine.handleDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ isOwnerChatting: false }),
    );
  });

  it.each([
    {
      name: 'a starter question',
      event_kind: 'ice_breaker',
      payload: messaging({ postback: { title: 'Prices?', payload: 'starter:x' } }),
      expected: { kind: 'starter_question', starterQuestion: 'Prices?' },
    },
    {
      name: 'a link',
      event_kind: 'referral',
      payload: messaging({ referral: { ref: 'SPRING' } }),
      expected: { kind: 'ref_link', refCode: 'SPRING', adId: null },
    },
    {
      name: 'an ad "Send message"',
      event_kind: 'referral',
      payload: messaging({ referral: { ad_id: '238500001', source: 'ADS' } }),
      expected: { kind: 'ad_message', refCode: null, adId: '238500001' },
    },
  ])('$name reaches handleButtonClick', async ({ event_kind, payload, expected }) => {
    queue.push({ event_kind, payload });

    await run();

    expect(engine.handleButtonClick).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it('a Live comment and an ad comment reach startCommentRun with their kinds', async () => {
    queue.push({
      event_kind: 'live_comment',
      payload: { field: 'live_comments', value: { id: '18000001', media: { id: '17900001' } } },
    });
    await run({ intakeKind: 'live' });
    queue.push({
      event_kind: 'comment',
      payload: {
        field: 'comments',
        value: { id: '18000002', media: { id: '17900002', ad_id: '2385' }, from: { id: SENDER } },
      },
    });
    await run({ intakeKind: 'comments' });

    expect(engine.startCommentRun.mock.calls.map(([input]) => input.kind)).toEqual([
      'live_comment',
      'ad_comment',
    ]);
    expect(engine.startCommentRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ adId: '2385', commentId: '18000002', isOwnComment: false }),
    );
  });

  it('a reaction refreshes her window only — no engine call', async () => {
    queue.push({ event_kind: 'reaction', payload: messaging({ reaction: { mid: 'm_3' } }) });

    await run();

    expect(services.contactService.recordInboundContactEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reaction' }),
    );
    expect(Object.values(engine).every((call) => call.mock.calls.length === 0)).toBe(true);
  });

  it('the owner’s echo matches our unconfirmed message or starts the quiet time — no contact, no engine (WH10)', async () => {
    queue.push({ event_kind: 'echo', payload: { message: { mid: 'm_echo', is_echo: true } } });

    await expect(run()).resolves.toMatchObject({ processedEventCount: 1 });

    expect(messages.matchEchoedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactInstagramUserId: SENDER,
        instagramMessageId: 'm_echo',
        withinMinutes: 10,
      }),
    );
    expect(services.contactService.recordInboundContactEvent).not.toHaveBeenCalled();
    expect(engine.handleDirectMessage).not.toHaveBeenCalled();
  });

  it('a stop word (the account’s own too) opts her out and starts nothing', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_4', text: 'Basta' } }),
    });

    await run();

    expect(services.contactService.recordContactOptOut).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT.id }),
    );
    expect(engine.handleDirectMessage).not.toHaveBeenCalled();
    expect(events.markEventProcessed).toHaveBeenCalled();
  });

  it('a flood skips the event `flood` — a stop word inside it still opts her out (WH16)', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_5', text: 'stop' } }),
    });
    events.countContactMessageEventsSince?.mockResolvedValueOnce(21);

    await expect(run()).resolves.toMatchObject({ skippedEventCount: 1 });

    expect(events.markEventSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: 'flood' }),
    );
    expect(services.contactService.recordContactOptOut).toHaveBeenCalled();
    expect(engine.handleDirectMessage).not.toHaveBeenCalled();
  });

  it('an event another job already marked changes nothing (the guarded first statement)', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_6', text: 'hi' } }),
    });
    events.markEventProcessed?.mockResolvedValueOnce(false);

    await expect(run()).resolves.toMatchObject({ processedEventCount: 0 });

    expect(services.contactService.recordInboundContactEvent).not.toHaveBeenCalled();
    expect(engine.handleDirectMessage).not.toHaveBeenCalled();
  });
});

describe('processInstagramWebhookIntakeJob — around the transaction (WH12, S11, WH25)', () => {
  it('a new contact’s profile read is handed to a task after the commit, never read here', async () => {
    isNewContact = true;
    queue.push({ event_kind: 'message', payload: messaging({ message: { mid: 'm_7' } }) });
    const enqueueProfileRead = vi.fn(async () => undefined);

    await run({ enqueueProfileRead });

    expect(enqueueProfileRead).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      contactPublicId: CONTACT.public_id,
    });
  });

  it('a late comment reads its own time, failing open to the received time when the read throws', async () => {
    const createdAt = new Date();
    const occurredAt = new Date(createdAt.getTime() - 2 * 60 * 60_000);
    queue.push({
      event_kind: 'comment',
      created_at: createdAt,
      occurred_at: occurredAt,
      payload: { field: 'comments', value: { id: '18000003', media: { id: '17900003' } } },
    });
    const readLateCommentTime = vi.fn(async () => {
      throw new Error('circuit open');
    });

    await expect(run({ intakeKind: 'comments', readLateCommentTime })).resolves.toMatchObject({
      processedEventCount: 1,
    });

    expect(readLateCommentTime).toHaveBeenCalledWith(
      expect.objectContaining({ instagramCommentId: '18000003' }),
    );
    expect(engine.startCommentRun).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ occurredAt }) }),
    );
  });

  it('after 25 events comments go on in every slot, at the lowest priority while over 500 wait', async () => {
    for (let index = 0; index < 25; index += 1) {
      queue.push({
        event_kind: 'comment',
        payload: { field: 'comments', value: { id: `1800${index}`, media: { id: '17900004' } } },
      });
    }
    events.countWaitingEvents?.mockResolvedValueOnce(501);
    const enqueueFollowUp = vi.fn(
      async (_request: { slot?: number; priority?: number }) => undefined,
    );

    await expect(run({ intakeKind: 'comments', enqueueFollowUp })).resolves.toMatchObject({
      outcome: 'yielded',
    });

    expect(
      enqueueFollowUp.mock.calls.map(([request]) => [request?.slot, request?.priority]),
    ).toEqual([
      [0, 10],
      [1, 10],
      [2, 10],
      [3, 10],
    ]);
  });

  it('every unit of work takes a database slot (SN24)', async () => {
    queue.push({ event_kind: 'message', payload: messaging({ message: { mid: 'm_8' } }) });
    const runInSlot = vi.fn(({ callback }: { callback: () => Promise<unknown> }) => callback());

    await run({ limiter: { runInSlot } as never });

    // account, claim, account again, the reads, the transaction, the last empty claim
    expect(runInSlot.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('a refusal fails the event at once with no next try; the error codes carry no text', async () => {
    queue.push({ event_kind: 'message', payload: messaging({}) });

    await expect(run()).resolves.toMatchObject({ failedEventCount: 1 });

    expect(events.markEventFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'event_payload_invalid:message_missing',
        retryAfterMinutes: null,
      }),
    );
    expect(
      describeInstagramWebhookIntakeError(new InstagramWebhookEventPermanentError('x:y')),
    ).toBe('x:y');
    expect(
      describeInstagramWebhookIntakeError(Object.assign(new Error('secret'), { code: '40P01' })),
    ).toBe('processing_error:Error:40P01');
  });

  it('a deadlock retries the transaction (3 times at most) without using a try', async () => {
    queue.push({
      event_kind: 'message',
      payload: messaging({ message: { mid: 'm_9', text: 'hi' } }),
    });
    engine.handleDirectMessage.mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    await expect(run()).resolves.toMatchObject({ processedEventCount: 1 });

    expect(engine.handleDirectMessage).toHaveBeenCalledTimes(2);
    expect(events.releaseEventClaim).not.toHaveBeenCalled();
  });
});
