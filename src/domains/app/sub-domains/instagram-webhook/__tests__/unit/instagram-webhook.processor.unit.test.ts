import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, outageMarker, unitOfWork } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  outageMarker: Symbol('outage'),
  /** The units of work opened so far, and the one open now (`null` = none). */
  unitOfWork: { openedCount: 0, current: null as number | null },
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  PRINCIPAL_SCOPE: {
    JOB: (identity: Record<string, string>) => ({ ...identity, source: 'job' }),
  },
  // A call inside an open unit joins it, as the real one does for the same organization.
  withAppDatabaseContext: async ({
    callback,
  }: {
    callback: (handle: unknown) => Promise<unknown>;
  }) => {
    if (unitOfWork.current !== null) return callback({});
    unitOfWork.openedCount += 1;
    unitOfWork.current = unitOfWork.openedCount;
    try {
      return await callback({});
    } finally {
      unitOfWork.current = null;
    }
  },
}));

vi.mock('@/infrastructure/database/transaction.js', () => ({
  withSavepoint: (callback: () => Promise<unknown>) => callback(),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runOrganizationScopedWorkerJob: ({
    processor,
  }: {
    processor: (databaseHandle: unknown) => Promise<unknown>;
  }) => processor({ handle: 'job' }),
}));

// An outage is whatever the test marks as one — the real check reads the circuit in Redis.
vi.mock('@/infrastructure/queue/worker-runtime/provider-outage-pause.util.js', () => ({
  toProviderOutageError: async ({ error }: { error: unknown }) =>
    typeof error === 'object' && error !== null && outageMarker in error ? error : null,
}));

vi.mock('@/infrastructure/resilience/circuit-breaker.js', () => ({
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {},
}));

vi.mock(
  '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js',
  () => ({
    readInstagramMediaItem: vi.fn(),
    readInstagramUserProfile: vi.fn(),
  }),
);

vi.mock('@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js', () => ({
  enqueueInstagramWebhookAccountProcessing: vi.fn(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({ logger: loggerMock }));

import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramWebhookProcessingAccount } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { AutomationRunHandlingResult } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import {
  type InstagramWebhookProcessingServices,
  describeInstagramWebhookProcessingError,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
import { InstagramWebhookEventPermanentError } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';

/**
 * Instagram webhook event processing (routes-final § 4.A WH12–WH14, worker-changes WC-1) with fake
 * services: the dispatch per kind through a fake run engine, the contact first, the post and "next
 * post" link before a comment is matched, the order / hold-back / yield rules, the attempt and retry
 * rules, the runs an event that ends failed or skipped left running (D47, D51), the skip reasons, the
 * outage pause and what the log lines may carry (WH6).
 */

const ORGANIZATION_PUBLIC_ID = 'org_acmeshop0000000000001';
const CHANNEL_ACCOUNT_PUBLIC_ID = 'cha_acmeshop0000000000001';
const SENDER = '17841400000000777';
const POST = '17900000000000001';
const COMMENT_TEXT = 'Price please?';
const DM_TEXT = 'jordan@example.com';
const INSTAGRAM_ACCOUNT_KEY = { organizationId: 11, instagramAccountId: 22 };
const MAX_ATTEMPTS = 5;

/** One stored event as the fake events table holds it. */
interface FakeEvent {
  id: number;
  public_id: string;
  event_kind: string;
  event_key: string;
  payload: Record<string, unknown>;
  contact_instagram_user_id: string | null;
  status: string;
  skip_reason: string | null;
  error_message: string | null;
  attempt_count: number;
  isLeased: boolean;
  occurred_at: Date | null;
  created_at: Date;
  request_id: string | null;
}

let nextEventId = 1;

function storedEvent(
  overrides: Partial<FakeEvent> & Pick<FakeEvent, 'event_kind' | 'payload'>,
): FakeEvent {
  const id = nextEventId;
  nextEventId += 1;
  return {
    id,
    public_id: `iwe_event${String(id).padStart(16, '0')}`,
    event_key: `${overrides.event_kind}:${id}`,
    contact_instagram_user_id: SENDER,
    status: 'queued',
    skip_reason: null,
    error_message: null,
    attempt_count: 0,
    isLeased: false,
    occurred_at: new Date('2026-11-22T10:00:00.000Z'),
    created_at: new Date('2026-11-22T10:00:01.000Z'),
    request_id: 'delivery-1',
    ...overrides,
  };
}

function commentEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return storedEvent({
    event_kind: 'comment',
    payload: {
      field: 'comments',
      value: {
        id: '18000000000000001',
        text: COMMENT_TEXT,
        from: { id: SENDER, username: 'acme_customer' },
        media: { id: POST },
      },
    },
    ...overrides,
  });
}

function directMessageEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return storedEvent({
    event_kind: 'message',
    payload: { sender: { id: SENDER }, message: { mid: 'm_1', text: DM_TEXT } },
    ...overrides,
  });
}

/** The events table: oldest first, the claim's lease and attempt count, the guarded marks. */
function fakeEventService(events: FakeEvent[]) {
  const find = (eventId: number) => {
    const event = events.find((candidate) => candidate.id === eventId);
    if (event === undefined) throw new Error(`no event ${eventId}`);
    return event;
  };
  const holdsClaim = (claim: { eventId: number; claimedAttemptCount: number }) => {
    const event = find(claim.eventId);
    return (
      event.isLeased &&
      event.attempt_count === claim.claimedAttemptCount &&
      (event.status === 'received' || event.status === 'queued')
    );
  };
  const finish = (
    claim: { eventId: number; claimedAttemptCount: number },
    changes: Partial<FakeEvent>,
  ) => {
    if (!holdsClaim(claim)) return false;
    Object.assign(find(claim.eventId), { ...changes, isLeased: false });
    return true;
  };
  return {
    claimNextEvent: vi.fn(async () => {
      const head = events.find((event) => event.status === 'received' || event.status === 'queued');
      if (head === undefined || head.isLeased) return null;
      if (head.attempt_count >= MAX_ATTEMPTS) {
        Object.assign(head, { status: 'failed', error_message: 'processing_attempts_exhausted' });
        return { outcome: 'exhausted', event: { ...head } };
      }
      head.attempt_count += 1;
      head.isLeased = true;
      return { outcome: 'claimed', event: { ...head } };
    }),
    markEventProcessed: vi.fn(async ({ claim }) => finish(claim, { status: 'processed' })),
    markEventSkipped: vi.fn(async ({ claim, skipReason }) =>
      finish(claim, { status: 'skipped', skip_reason: skipReason }),
    ),
    markEventFailed: vi.fn(async ({ claim, errorMessage }) =>
      finish(claim, { status: 'failed', error_message: errorMessage }),
    ),
    releaseEventClaim: vi.fn(async ({ claim, isAttemptSpent }) => {
      if (!holdsClaim(claim)) return false;
      const event = find(claim.eventId);
      event.isLeased = false;
      if (isAttemptSpent !== true) event.attempt_count -= 1;
      return true;
    }),
  };
}

function connectedAccount(
  overrides: Partial<InstagramWebhookProcessingAccount> = {},
): InstagramWebhookProcessingAccount {
  return {
    instagramAccount: INSTAGRAM_ACCOUNT_KEY,
    channelAccountId: 33,
    instagramAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
    connectionStatus: 'connected',
    isAutomationEnabled: true,
    encryptedAccessToken: 'v1:fake-ciphertext',
    ...overrides,
  };
}

function engineResult(overrides: Partial<AutomationRunHandlingResult> = {}) {
  return { outcome: 'run_started', runPublicIds: ['run_one'], failedErrorType: null, ...overrides };
}

const callOrder: string[] = [];

function setup({
  events,
  account = connectedAccount(),
  isNewContact = false,
  storedPost = { published_at: new Date('2026-11-20T09:00:00.000Z') },
}: {
  events: FakeEvent[];
  account?: InstagramWebhookProcessingAccount | null;
  isNewContact?: boolean;
  storedPost?: { published_at: Date } | null;
}) {
  callOrder.length = 0;
  const eventService = fakeEventService(events);
  const accountService = {
    findWebhookProcessingAccount: vi.fn(async () => account),
    markConnectionBroken: vi.fn(async () => null),
  };
  const contact = { id: 501, public_id: 'con_contact0000000000001' };
  const contactService = {
    recordContactInteraction: vi.fn(async () => {
      callOrder.push('contact');
      return { contact, isNewContact };
    }),
    recordContactProfile: vi.fn(async () => ({ ...contact, full_name: 'Jordan Lee' })),
  };
  const mediaService = {
    findStoredMedia: vi.fn(async () => storedPost),
    upsertFromInstagram: vi.fn(async () => ({
      published_at: new Date('2026-11-21T08:00:00.000Z'),
    })),
  };
  const automationService = {
    linkNextPostAutomations: vi.fn(async () => {
      callOrder.push('link');
      return [];
    }),
  };
  const engine = {
    startCommentRun: vi.fn(async () => {
      callOrder.push('startCommentRun');
      return engineResult();
    }),
    handleDirectMessage: vi.fn(async () => {
      callOrder.push('handleDirectMessage');
      return engineResult();
    }),
    startStoryReplyRun: vi.fn(async () => engineResult()),
    handleButtonClick: vi.fn(async () => engineResult({ outcome: 'run_continued' })),
    failRunsOfFailedEvent: vi.fn(async (_input: unknown): Promise<string[]> => []),
  };
  const instagramClient = {
    readInstagramUserProfile: vi.fn(async () => ({
      name: 'Jordan Lee',
      username: 'jordan.lee',
      profilePictureUrl: null,
      followerCount: 12,
      isUserFollowingBusiness: null,
    })),
    readInstagramMediaItem: vi.fn(async () => ({
      id: POST,
      timestamp: '2026-11-21T08:00:00+0000',
    })),
  };
  const enqueueFollowUp = vi.fn(async () => undefined);
  const services = {
    instagramAccountService: accountService,
    instagramWebhookEventService: eventService,
    contactService,
    instagramMediaService: mediaService,
    automationService,
    automationRunService: engine,
  } as unknown as InstagramWebhookProcessingServices;
  const run = () =>
    processInstagramWebhookAccountJob({
      jobData: {
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
      },
      services,
      jobId: 'job-1',
      instagramClient: instagramClient as never,
      enqueueFollowUp,
    });
  return {
    run,
    eventService,
    accountService,
    contactService,
    mediaService,
    automationService,
    engine,
    instagramClient,
    enqueueFollowUp,
  };
}

/** An Instagram error of one class, as the client throws it. */
function instagramError({
  errorClass,
  code = null,
  subcode = null,
}: {
  errorClass: 'auth' | 'throttled' | 'refused' | 'outage';
  code?: number | null;
  subcode?: number | null;
}): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass,
    category: 'http_4xx',
    connectionStatus: errorClass === 'auth' ? 'expired' : null,
    httpStatus: 400,
    details: { code, subcode, type: null, fbtraceId: 'trace-1' },
    fallbackMessage: 'Instagram failed',
  });
}

/** An error the (mocked) provider-outage check reads as an Instagram outage. */
function outageError(): Error {
  return Object.assign(new Error('instagram circuit open'), { [outageMarker]: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  nextEventId = 1;
  unitOfWork.openedCount = 0;
  unitOfWork.current = null;
});

describe('processInstagramWebhookAccountJob — dispatch per kind (WH13)', () => {
  it('a comment: the contact first, its post kept, "next post" linking, then one run started', async () => {
    const event = commentEvent();
    const { run, engine, automationService, contactService, instagramClient, eventService } = setup(
      { events: [event] },
    );

    const result = await run();

    expect(result).toEqual({
      outcome: 'drained',
      processedEventCount: 1,
      skippedEventCount: 0,
      failedEventCount: 0,
    });
    expect(callOrder).toEqual(['contact', 'link', 'startCommentRun']);
    expect(contactService.recordContactInteraction).toHaveBeenCalledWith({
      databaseHandle: { handle: 'job' },
      organizationId: 11,
      instagramAccountId: 22,
      instagramUserId: SENDER,
      username: 'acme_customer',
      occurredAt: event.occurred_at,
      interactionKind: 'comment',
    });
    // The post was stored already: no Instagram read; the link takes its publish time.
    expect(instagramClient.readInstagramMediaItem).not.toHaveBeenCalled();
    expect(automationService.linkNextPostAutomations).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      instagramAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
      instagramMediaId: POST,
      publishedAt: new Date('2026-11-20T09:00:00.000Z'),
    });
    expect(engine.startCommentRun).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      instagramAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
      contact: { id: 501, public_id: 'con_contact0000000000001' },
      event: {
        eventKey: event.event_key,
        occurredAt: event.occurred_at,
        isLastAttempt: false,
        requestId: 'job-1',
      },
      instagramCommentId: '18000000000000001',
      instagramMediaId: POST,
      text: COMMENT_TEXT,
      commenterUsername: 'acme_customer',
    });
    expect(event.status).toBe('processed');
    expect(eventService.markEventProcessed).toHaveBeenCalledTimes(1);
  });

  it('a comment on a post not stored yet: read from Instagram, stored, then linked', async () => {
    const { run, mediaService, instagramClient, automationService } = setup({
      events: [commentEvent()],
      storedPost: null,
    });

    await run();

    expect(instagramClient.readInstagramMediaItem).toHaveBeenCalledWith({
      encryptedAccessToken: 'v1:fake-ciphertext',
      instagramMediaId: POST,
      requestId: 'job-1',
    });
    expect(mediaService.upsertFromInstagram).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      instagramAccount: INSTAGRAM_ACCOUNT_KEY,
      mediaItem: { id: POST, timestamp: '2026-11-21T08:00:00+0000' },
    });
    expect(automationService.linkNextPostAutomations).toHaveBeenCalledWith(
      expect.objectContaining({ publishedAt: new Date('2026-11-21T08:00:00.000Z') }),
    );
  });

  it('a failed post read or link is logged and the comment is still matched (D18)', async () => {
    const readFailure = setup({ events: [commentEvent()], storedPost: null });
    readFailure.instagramClient.readInstagramMediaItem.mockRejectedValueOnce(
      instagramError({ errorClass: 'refused', code: 100 }),
    );
    await readFailure.run();
    expect(readFailure.automationService.linkNextPostAutomations).not.toHaveBeenCalled();
    expect(readFailure.engine.startCommentRun).toHaveBeenCalledTimes(1);

    const linkFailure = setup({ events: [commentEvent()] });
    linkFailure.automationService.linkNextPostAutomations.mockRejectedValueOnce(
      new Error('deadlock detected'),
    );
    const result = await linkFailure.run();
    expect(linkFailure.engine.startCommentRun).toHaveBeenCalledTimes(1);
    expect(result.processedEventCount).toBe(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failure: 'processing_error:Error' }),
      'app.instagram_webhook.next_post_link_failed',
    );
  });

  it('a DM (or a `messages` change): handleDirectMessage with the text and the answers', async () => {
    const { run, engine } = setup({
      events: [
        directMessageEvent(),
        storedEvent({
          event_kind: 'message',
          payload: {
            field: 'messages',
            value: {
              sender: { id: SENDER },
              message: { mid: 'm_2', quick_reply: { payload: 'x' } },
            },
          },
        }),
      ],
    });

    await run();

    expect(engine.handleDirectMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        instagramAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
        text: DM_TEXT,
        quickReplyPayload: null,
        attachmentEmail: null,
      }),
    );
    expect(engine.handleDirectMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: null, quickReplyPayload: 'x' }),
    );
    expect(engine.startCommentRun).not.toHaveBeenCalled();
  });

  it('a story reply: startStoryReplyRun with the story id', async () => {
    const { run, engine, contactService } = setup({
      events: [
        storedEvent({
          event_kind: 'story_reply',
          payload: {
            sender: { id: SENDER },
            message: {
              mid: 'm_3',
              text: 'love it',
              reply_to: { story: { id: '17950000000000001' } },
            },
          },
        }),
      ],
    });

    await run();

    expect(contactService.recordContactInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ interactionKind: 'story_reply', username: null }),
    );
    expect(engine.startStoryReplyRun).toHaveBeenCalledWith(
      expect.objectContaining({ instagramStoryId: '17950000000000001', text: 'love it' }),
    );
  });

  it.each(['live_comment', 'ice_breaker', 'referral', 'reaction', 'echo'])(
    'a %s (saved received since R17) is marked processed with nothing done until intake per kind (R38)',
    async (eventKind) => {
      const event = storedEvent({ event_kind: eventKind, payload: { sender: { id: SENDER } } });
      const { run, engine, contactService } = setup({ events: [event] });

      await run();

      expect(event.status).toBe('processed');
      expect(contactService.recordContactInteraction).not.toHaveBeenCalled();
      expect(engine.handleDirectMessage).not.toHaveBeenCalled();
      expect(engine.handleButtonClick).not.toHaveBeenCalled();
      expect(engine.startCommentRun).not.toHaveBeenCalled();
    },
  );

  it('a button click: handleButtonClick with the payload ids; a foreign payload runs nothing', async () => {
    const automationPublicId = 'aut_acmeshop0000000000001';
    const runPublicId = 'run_acmeshop0000000000001';
    const ours = storedEvent({
      event_kind: 'postback',
      payload: {
        sender: { id: SENDER },
        postback: { mid: 'm_4', payload: `${automationPublicId}::${runPublicId}` },
      },
    });
    const foreign = storedEvent({
      event_kind: 'postback',
      payload: { sender: { id: SENDER }, postback: { mid: 'm_5', payload: 'GET_STARTED' } },
    });
    const { run, engine, contactService } = setup({ events: [ours, foreign] });

    const result = await run();

    expect(engine.handleButtonClick).toHaveBeenCalledTimes(1);
    expect(engine.handleButtonClick).toHaveBeenCalledWith(
      expect.objectContaining({ automationPublicId, runPublicId }),
    );
    // Both clicks still record the contact first (WH13), and both are handled.
    expect(contactService.recordContactInteraction).toHaveBeenCalledTimes(2);
    expect(result.processedEventCount).toBe(2);
    expect([ours.status, foreign.status]).toEqual(['processed', 'processed']);
  });
});

describe('the contact first — a new contact gets its profile (CQ3)', () => {
  it('reads and saves the profile of a contact this event created', async () => {
    const { run, instagramClient, contactService, engine } = setup({
      events: [directMessageEvent()],
      isNewContact: true,
    });

    await run();

    expect(instagramClient.readInstagramUserProfile).toHaveBeenCalledWith({
      encryptedAccessToken: 'v1:fake-ciphertext',
      instagramScopedUserId: SENDER,
      requestId: 'job-1',
    });
    expect(contactService.recordContactProfile).toHaveBeenCalledWith({
      databaseHandle: { handle: 'job' },
      organizationId: 11,
      contactId: 501,
      profile: { username: 'jordan.lee', fullName: 'Jordan Lee', followersCount: 12 },
      checkedAt: expect.any(Date),
    });
    expect(engine.handleDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contact: expect.objectContaining({ full_name: 'Jordan Lee' }) }),
    );
  });

  it('never reads the profile of a contact it already had', async () => {
    const { run, instagramClient } = setup({ events: [directMessageEvent()] });
    await run();
    expect(instagramClient.readInstagramUserProfile).not.toHaveBeenCalled();
  });

  it('fails open on a profile read that fails — the contact is kept, the event handled', async () => {
    const { run, instagramClient, contactService, engine } = setup({
      events: [directMessageEvent()],
      isNewContact: true,
    });
    instagramClient.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'refused', code: 100 }),
    );

    const result = await run();

    expect(contactService.recordContactProfile).not.toHaveBeenCalled();
    expect(engine.handleDirectMessage).toHaveBeenCalledTimes(1);
    expect(result.processedEventCount).toBe(1);
  });

  it('a refused token on the profile read breaks the connection and fails the event at once', async () => {
    const event = directMessageEvent();
    const { run, instagramClient, accountService, engine } = setup({
      events: [event],
      isNewContact: true,
    });
    instagramClient.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'auth', code: 190, subcode: 463 }),
    );

    await run();

    expect(accountService.markConnectionBroken).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
      instagramAccount: INSTAGRAM_ACCOUNT_KEY,
      connectionStatus: 'expired',
      requestId: 'job-1',
    });
    expect(engine.handleDirectMessage).not.toHaveBeenCalled();
    expect(event).toMatchObject({ status: 'failed', error_message: 'instagram_api:190/463' });
    expect(event.attempt_count).toBe(1);
  });
});

describe('order, hold-back and yield (WH12, WQ3)', () => {
  it('handles one account’s events one at a time, oldest stored first', async () => {
    const first = directMessageEvent();
    const second = commentEvent();
    const third = directMessageEvent();
    const { run, eventService } = setup({ events: [first, second, third] });

    const result = await run();

    expect(result.processedEventCount).toBe(3);
    const handledIds = eventService.markEventProcessed.mock.calls.map(
      ([input]) => (input as { claim: { eventId: number } }).claim.eventId,
    );
    expect(handledIds).toEqual([first.id, second.id, third.id]);
  });

  it('a temporary failure holds the account’s later events back: the lease ends, the attempt stays, the job retries', async () => {
    const failing = directMessageEvent();
    const later = directMessageEvent();
    const { run, engine, eventService } = setup({ events: [failing, later] });
    engine.handleDirectMessage.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(run()).rejects.toThrow('connection terminated');

    expect(eventService.claimNextEvent).toHaveBeenCalledTimes(1);
    expect(eventService.releaseEventClaim).toHaveBeenCalledWith(
      expect.objectContaining({ isAttemptSpent: true }),
    );
    expect(failing).toMatchObject({ status: 'queued', attempt_count: 1, isLeased: false });
    expect(later).toMatchObject({ status: 'queued', attempt_count: 0 });
  });

  it('yields after 25 events and adds one follow-up job for the account', async () => {
    const events = Array.from({ length: 26 }, () => directMessageEvent());
    const { run, enqueueFollowUp } = setup({ events });

    const result = await run();

    expect(result).toMatchObject({ outcome: 'yielded', processedEventCount: 25 });
    expect(events.at(-1)?.status).toBe('queued');
    expect(enqueueFollowUp).toHaveBeenCalledTimes(1);
    expect(enqueueFollowUp).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: CHANNEL_ACCOUNT_PUBLIC_ID,
      requestId: 'job-1',
    });
  });

  it('a failed follow-up add is logged — the stuck-event pick-up adds the job again', async () => {
    const events = Array.from({ length: 25 }, () => directMessageEvent());
    const { run, enqueueFollowUp } = setup({ events });
    enqueueFollowUp.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(run()).resolves.toMatchObject({ outcome: 'yielded' });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.anything(),
      'app.instagram_webhook.follow_up_enqueue_failed',
    );
  });

  it('adds no follow-up when the account has nothing left to wait', async () => {
    const { run, enqueueFollowUp } = setup({ events: [directMessageEvent()] });
    await expect(run()).resolves.toMatchObject({ outcome: 'drained' });
    expect(enqueueFollowUp).not.toHaveBeenCalled();
  });
});

describe('attempts and retries (WH14)', () => {
  it('passes isLastAttempt on the 5th attempt; its failure marks the event failed and the next one runs', async () => {
    const failing = directMessageEvent({ attempt_count: MAX_ATTEMPTS - 1 });
    const next = directMessageEvent();
    const { run, engine } = setup({ events: [failing, next] });
    engine.handleDirectMessage.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await run();

    expect(engine.handleDirectMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: expect.objectContaining({ isLastAttempt: true }) }),
    );
    expect(engine.handleDirectMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: expect.objectContaining({ isLastAttempt: false }) }),
    );
    expect(failing).toMatchObject({
      status: 'failed',
      error_message: 'processing_error:Error',
      attempt_count: 5,
    });
    expect(next.status).toBe('processed');
    expect(result).toMatchObject({ processedEventCount: 1, failedEventCount: 1 });
  });

  it('fails a head whose attempts already ran out and moves on (processing_attempts_exhausted)', async () => {
    const exhausted = directMessageEvent({ attempt_count: MAX_ATTEMPTS });
    const next = directMessageEvent();
    const { run, engine } = setup({ events: [exhausted, next] });

    const result = await run();

    expect(exhausted).toMatchObject({
      status: 'failed',
      error_message: 'processing_attempts_exhausted',
    });
    expect(engine.handleDirectMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processedEventCount: 1, failedEventCount: 1 });
  });

  it('fails an unreadable event at once, on its first attempt', async () => {
    const unreadable = commentEvent({ payload: { field: 'comments', value: { id: '1' } } });
    const { run, engine } = setup({ events: [unreadable] });

    await run();

    expect(engine.startCommentRun).not.toHaveBeenCalled();
    expect(unreadable).toMatchObject({
      status: 'failed',
      error_message: 'event_payload_invalid:comment_media_missing',
      attempt_count: 1,
    });
  });

  it('fails the event at once when the engine reports a dead token (failedErrorType token)', async () => {
    const event = directMessageEvent();
    const { run, engine } = setup({ events: [event] });
    engine.handleDirectMessage.mockResolvedValueOnce(
      engineResult({ outcome: 'run_started', failedErrorType: 'token' }) as never,
    );

    await run();

    expect(event).toMatchObject({ status: 'failed', error_message: 'instagram_api:token' });
  });

  it('marks the event processed when a run failed for any other reason — the run shows it', async () => {
    const event = directMessageEvent();
    const { run, engine } = setup({ events: [event] });
    engine.handleDirectMessage.mockResolvedValueOnce(
      engineResult({ failedErrorType: 'instagram_api' }) as never,
    );

    await run();

    expect(event.status).toBe('processed');
  });
});

describe('an event marked failed fails the runs it left running (WH14 rev 4, AU19, D47)', () => {
  type ProcessorSetup = ReturnType<typeof setup>;

  it.each<{
    ending: string;
    event: () => FakeEvent;
    isNewContact?: boolean;
    arrange?: (fakes: ProcessorSetup) => void;
    errorCode: string;
  }>([
    {
      ending: 'its 5th failed attempt',
      event: () => directMessageEvent({ attempt_count: MAX_ATTEMPTS - 1 }),
      arrange: ({ engine }) =>
        engine.handleDirectMessage.mockRejectedValueOnce(new Error('connection terminated')),
      errorCode: 'processing_error:Error',
    },
    {
      ending: 'attempts that ran out',
      event: () => directMessageEvent({ attempt_count: MAX_ATTEMPTS }),
      errorCode: 'processing_attempts_exhausted',
    },
    {
      ending: 'an event no retry can handle',
      event: () => commentEvent({ payload: { field: 'comments', value: { id: '1' } } }),
      errorCode: 'event_payload_invalid:comment_media_missing',
    },
    {
      ending: 'a request Instagram refused for good',
      event: () => directMessageEvent({ attempt_count: 2 }),
      arrange: ({ engine }) =>
        engine.handleDirectMessage.mockRejectedValueOnce(
          instagramError({ errorClass: 'refused', code: 10, subcode: 2534022 }),
        ),
      errorCode: 'instagram_api:10/2534022',
    },
    {
      ending: 'a dead token a run met',
      event: () => directMessageEvent(),
      arrange: ({ engine }) =>
        engine.handleDirectMessage.mockResolvedValueOnce(
          engineResult({ failedErrorType: 'token' }) as never,
        ),
      errorCode: 'instagram_api:token',
    },
    {
      ending: 'a token refused on a read',
      event: () => directMessageEvent({ attempt_count: 1 }),
      isNewContact: true,
      arrange: ({ instagramClient }) =>
        instagramClient.readInstagramUserProfile.mockRejectedValueOnce(
          instagramError({ errorClass: 'auth', code: 190, subcode: 463 }),
        ),
      errorCode: 'instagram_api:190/463',
    },
  ])(
    'after $ending: in the unit that marks it, with its key and its code',
    async ({ event, isNewContact = false, arrange, errorCode }) => {
      const failing = event();
      const fakes = setup({ events: [failing], isNewContact });
      const { run, engine } = fakes;
      arrange?.(fakes);
      const unitsOf: Array<number | null> = [];
      const statusesSeen: string[] = [];
      engine.failRunsOfFailedEvent.mockImplementationOnce(async () => {
        unitsOf.push(unitOfWork.current);
        statusesSeen.push(failing.status);
        return ['run_left'];
      });

      const result = await run();

      expect(failing).toMatchObject({ status: 'failed', error_message: errorCode });
      expect(result.failedEventCount).toBe(1);
      expect(engine.failRunsOfFailedEvent).toHaveBeenCalledExactlyOnceWith({
        scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
        organizationId: INSTAGRAM_ACCOUNT_KEY.organizationId,
        eventKey: failing.event_key,
        errorCode,
      });
      // Marked first, the runs failed after it, both in one unit: both or neither (D47).
      expect(statusesSeen).toEqual(['failed']);
      expect(unitsOf).toEqual([expect.any(Number)]);
    },
  );

  it.each<{ ending: string; arrange: (fakes: ProcessorSetup) => void }>([
    { ending: 'processed', arrange: () => undefined },
    {
      ending: 'processed although a run of it failed',
      arrange: ({ engine }) =>
        engine.handleDirectMessage.mockResolvedValueOnce(
          engineResult({ failedErrorType: 'instagram_api' }) as never,
        ),
    },
    {
      ending: 'to be retried',
      arrange: ({ engine }) => engine.handleDirectMessage.mockRejectedValueOnce(new Error('blip')),
    },
    {
      ending: 'released for an outage',
      arrange: ({ engine }) => engine.handleDirectMessage.mockRejectedValueOnce(outageError()),
    },
    {
      ending: 'another run’s by now (its claim lost)',
      arrange: ({ engine, eventService }) => {
        engine.handleDirectMessage.mockRejectedValueOnce(
          instagramError({ errorClass: 'refused', code: 10 }),
        );
        eventService.markEventFailed.mockResolvedValueOnce(false);
      },
    },
  ])('an event $ending tells the engine nothing', async ({ arrange }) => {
    const fakes = setup({ events: [directMessageEvent()] });
    arrange(fakes);

    await fakes.run().catch(() => undefined);

    expect(fakes.engine.failRunsOfFailedEvent).not.toHaveBeenCalled();
  });

  it('a failure to fail the runs fails the job: the mark goes back with it', async () => {
    const failing = directMessageEvent({ attempt_count: MAX_ATTEMPTS - 1 });
    const { run, engine } = setup({ events: [failing, directMessageEvent()] });
    engine.handleDirectMessage.mockRejectedValueOnce(new Error('connection terminated'));
    engine.failRunsOfFailedEvent.mockRejectedValueOnce(new Error('still terminated'));

    await expect(run()).rejects.toThrow('still terminated');

    expect(engine.handleDirectMessage).toHaveBeenCalledTimes(1);
  });
});

describe('an event skipped after a claim fails the runs an earlier attempt left running (D51)', () => {
  type ProcessorSetup = ReturnType<typeof setup>;

  it.each<{
    reason: string;
    account?: InstagramWebhookProcessingAccount;
    arrange?: (fakes: ProcessorSetup) => void;
    skipReason: 'automation_disabled' | 'account_disconnected';
  }>([
    {
      reason: 'the automation switch turned off',
      account: connectedAccount({ isAutomationEnabled: false }),
      skipReason: 'automation_disabled',
    },
    {
      reason: 'the account disconnected',
      account: connectedAccount({ connectionStatus: 'revoked', encryptedAccessToken: null }),
      skipReason: 'account_disconnected',
    },
    {
      reason: 'the account gone since the job started',
      arrange: ({ accountService }) =>
        accountService.findWebhookProcessingAccount
          .mockResolvedValueOnce(connectedAccount())
          .mockResolvedValueOnce(null),
      skipReason: 'account_disconnected',
    },
    {
      reason: 'the engine finding the account unavailable',
      arrange: ({ engine }) =>
        engine.handleDirectMessage.mockResolvedValueOnce(
          engineResult({ outcome: 'account_unavailable', runPublicIds: [] }) as never,
        ),
      skipReason: 'account_disconnected',
    },
  ])(
    'after $reason: in the unit that marks it, with its key and the skip reason',
    async ({ account, arrange, skipReason }) => {
      const skipped = directMessageEvent({ attempt_count: 1 });
      const fakes = setup({ events: [skipped], ...(account === undefined ? {} : { account }) });
      arrange?.(fakes);
      const unitsOf: Array<number | null> = [];
      const statusesSeen: string[] = [];
      fakes.engine.failRunsOfFailedEvent.mockImplementationOnce(async () => {
        unitsOf.push(unitOfWork.current);
        statusesSeen.push(skipped.status);
        return ['run_left'];
      });

      const result = await fakes.run();

      expect(skipped).toMatchObject({ status: 'skipped', skip_reason: skipReason });
      expect(result).toMatchObject({ skippedEventCount: 1, failedEventCount: 0 });
      expect(fakes.engine.failRunsOfFailedEvent).toHaveBeenCalledExactlyOnceWith({
        scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'job' },
        organizationId: INSTAGRAM_ACCOUNT_KEY.organizationId,
        eventKey: skipped.event_key,
        errorCode: skipReason,
      });
      expect(statusesSeen).toEqual(['skipped']);
      expect(unitsOf).toEqual([expect.any(Number)]);
    },
  );

  it('a skip whose claim is lost tells the engine nothing', async () => {
    const { run, engine, eventService } = setup({
      events: [directMessageEvent()],
      account: connectedAccount({ isAutomationEnabled: false }),
    });
    eventService.markEventSkipped.mockResolvedValueOnce(false);

    await run();

    expect(engine.failRunsOfFailedEvent).not.toHaveBeenCalled();
  });

  it('a failure to fail the runs fails the job: the skip goes back with it', async () => {
    const { run, engine } = setup({
      events: [directMessageEvent(), directMessageEvent()],
      account: connectedAccount({ isAutomationEnabled: false }),
    });
    engine.failRunsOfFailedEvent.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(run()).rejects.toThrow('connection terminated');

    expect(engine.failRunsOfFailedEvent).toHaveBeenCalledTimes(1);
  });
});

describe('the account checked again before each event (WH12 step 2)', () => {
  it.each([
    {
      name: 'the automation switch off',
      account: connectedAccount({ isAutomationEnabled: false }),
      skipReason: 'automation_disabled',
    },
    {
      name: 'an error account',
      account: connectedAccount({ connectionStatus: 'error', encryptedAccessToken: null }),
      skipReason: 'account_disconnected',
    },
    {
      name: 'a revoked account',
      account: connectedAccount({ connectionStatus: 'revoked', encryptedAccessToken: null }),
      skipReason: 'account_disconnected',
    },
  ])('skips with $skipReason for $name — no contact, no run', async ({ account, skipReason }) => {
    const event = commentEvent();
    const { run, engine, contactService } = setup({ events: [event], account });

    const result = await run();

    expect(event).toMatchObject({ status: 'skipped', skip_reason: skipReason });
    expect(contactService.recordContactInteraction).not.toHaveBeenCalled();
    expect(engine.startCommentRun).not.toHaveBeenCalled();
    expect(result.skippedEventCount).toBe(1);
  });

  it('skips account_disconnected when the account disappears between the job start and the event', async () => {
    const event = directMessageEvent();
    const { run, accountService } = setup({ events: [event] });
    accountService.findWebhookProcessingAccount
      .mockResolvedValueOnce(connectedAccount())
      .mockResolvedValueOnce(null);

    await run();

    expect(event).toMatchObject({ status: 'skipped', skip_reason: 'account_disconnected' });
  });

  it('skips account_disconnected when the engine finds the account unavailable (AU27)', async () => {
    const event = directMessageEvent();
    const { run, engine } = setup({ events: [event] });
    engine.handleDirectMessage.mockResolvedValueOnce(
      engineResult({ outcome: 'account_unavailable', runPublicIds: [] }) as never,
    );

    await run();

    expect(event).toMatchObject({ status: 'skipped', skip_reason: 'account_disconnected' });
  });

  it('claims nothing when the organization holds no account with the job’s public id', async () => {
    const { run, eventService } = setup({ events: [directMessageEvent()], account: null });

    await expect(run()).resolves.toMatchObject({ outcome: 'account_not_found' });
    expect(eventService.claimNextEvent).not.toHaveBeenCalled();
  });
});

describe('an Instagram outage (WH14)', () => {
  it('gives the claim back with its attempt and rethrows, so the queue pauses', async () => {
    const event = directMessageEvent({ attempt_count: 2 });
    const later = directMessageEvent();
    const { run, engine, eventService } = setup({ events: [event, later] });
    const outage = outageError();
    engine.handleDirectMessage.mockRejectedValueOnce(outage);

    await expect(run()).rejects.toBe(outage);

    expect(eventService.releaseEventClaim).toHaveBeenCalledWith(
      expect.not.objectContaining({ isAttemptSpent: true }),
    );
    expect(event).toMatchObject({ status: 'queued', attempt_count: 2, isLeased: false });
    expect(later.attempt_count).toBe(0);
  });
});

describe('log lines (WH6, WHC5)', () => {
  it('never carry the payload, a message or comment text, or an email', async () => {
    const { run } = setup({
      events: [commentEvent(), directMessageEvent(), commentEvent({ payload: { field: 'x' } })],
      isNewContact: true,
    });

    await run();

    const logged = JSON.stringify([
      ...loggerMock.info.mock.calls,
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
    ]);
    expect(logged).not.toContain(COMMENT_TEXT);
    expect(logged).not.toContain(DM_TEXT);
    expect(logged).not.toContain('"payload"');
    expect(logged).not.toContain('acme_customer');
    expect(logged).toContain('app.instagram_webhook.event_processed');
    expect(logged).toContain('event_payload_invalid:comment_value_missing');
  });
});

describe('describeInstagramWebhookProcessingError', () => {
  it('keeps a code and a short reason — never an error message', () => {
    expect(
      describeInstagramWebhookProcessingError(
        new InstagramWebhookEventPermanentError('event_payload_invalid:message_missing'),
      ),
    ).toBe('event_payload_invalid:message_missing');
    expect(
      describeInstagramWebhookProcessingError(
        instagramError({ errorClass: 'refused', code: 10, subcode: 2534022 }),
      ),
    ).toBe('instagram_api:10/2534022');
    expect(describeInstagramWebhookProcessingError(instagramError({ errorClass: 'outage' }))).toBe(
      'instagram_api:outage',
    );
    expect(
      describeInstagramWebhookProcessingError(
        Object.assign(new Error('duplicate key value (jordan@example.com)'), { code: '23505' }),
      ),
    ).toBe('processing_error:Error:23505');
  });
});
