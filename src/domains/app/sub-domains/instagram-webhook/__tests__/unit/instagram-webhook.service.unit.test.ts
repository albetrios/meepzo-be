import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramWebhookAccountState } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import type { NewInstagramWebhookEvent } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookAccountProcessingEnqueue } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.types.js';

const mockEnvironment = vi.hoisted(() => ({
  META_WEBHOOK_VERIFY_TOKEN: 'unit-test-verify-token-of-thirty-two-chars' as string | undefined,
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const recordUnknownAccountEntry = vi.hoisted(() => vi.fn());
const openedScopes = vi.hoisted(() => [] as unknown[]);

vi.mock('@/shared/config/env.config.js', () => ({ getEnv: () => mockEnvironment }));
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({ logger }));
vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  recordInstagramWebhookUnknownAccountEntry: recordUnknownAccountEntry,
}));
vi.mock('@/infrastructure/database/contexts/database-context.js', () => ({
  PRINCIPAL_SCOPE: {
    VERIFIED: (identity: Record<string, unknown>) => ({ ...identity, source: 'verified' }),
  },
  withAppDatabaseContext: async ({
    scope,
    callback,
  }: {
    scope: unknown;
    callback: () => Promise<unknown>;
  }) => {
    openedScopes.push(scope);
    return callback();
  },
}));

const { InstagramWebhookService } = await import(
  '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.service.js'
);

/**
 * The Instagram webhook receiver's service (routes-final § 4.A, WH7, WH10) with its collaborators
 * faked: the subscription check, and the store of a delivery — what is read, resolved, classified,
 * stored and logged, and R14's enqueue hook. The database-backed path is the integration suite's.
 */

const INSTAGRAM_USER_ID = '17841400000000001';
const ORGANIZATION_PUBLIC_ID = 'org_aaaaaaaaaaaaaaaaaaaaa';
const CONTACT_ID = '17841400000000777';
const REQUEST_ID = 'req-instagram-service';

function accountState(
  overrides: Partial<InstagramWebhookAccountState> = {},
): InstagramWebhookAccountState {
  return {
    instagramAccount: { organizationId: 7, instagramAccountId: 11 },
    channelAccountId: 13,
    channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
    instagramAccountPublicId: 'iga_aaaaaaaaaaaaaaaaaaaaa',
    instagramUserId: INSTAGRAM_USER_ID,
    instagramAppUserId: '9000000000000001',
    connectionStatus: 'connected',
    isAutomationEnabled: true,
    ...overrides,
  };
}

function comment(id: string, text = 'Price please?') {
  return { field: 'comments', value: { id, from: { id: CONTACT_ID }, text } };
}

function delivery(entry: Record<string, unknown>[]): Record<string, unknown> {
  return { object: 'instagram', entry };
}

function setup({
  organizationPublicId = ORGANIZATION_PUBLIC_ID,
  account = accountState(),
  enqueue,
}: {
  organizationPublicId?: string | null;
  account?: InstagramWebhookAccountState | null;
  enqueue?: InstagramWebhookAccountProcessingEnqueue;
} = {}) {
  let nextEventId = 100;
  const accountService = {
    resolveOrganizationPublicIdForInstagramUser: vi.fn(async () => organizationPublicId),
    findWebhookAccountState: vi.fn(async () => account),
  };
  const recordReceivedEvents = vi.fn(
    async ({ events }: { events: readonly NewInstagramWebhookEvent[] }) =>
      events.map((event) => ({
        id: nextEventId++,
        status: event.skipReason === null ? 'received' : 'skipped',
        event_key: event.eventKey,
      })),
  );
  const eventService = {
    recordReceivedEvents,
    markEventsQueued: vi.fn(async () => 0),
    limitStoreStatementTime: vi.fn(async () => undefined),
  };
  const service = new InstagramWebhookService(
    accountService as unknown as InstagramAccountService,
    eventService as unknown as InstagramWebhookEventService,
    enqueue,
  );
  return { service, accountService, eventService };
}

/** The events the service handed to the store (the first call). */
function storedEvents(eventService: {
  recordReceivedEvents: ReturnType<typeof vi.fn>;
}): NewInstagramWebhookEvent[] {
  const firstCall = eventService.recordReceivedEvents.mock.calls[0]?.[0] as
    | { events: NewInstagramWebhookEvent[] }
    | undefined;
  if (firstCall === undefined) throw new Error('nothing was stored');
  return firstCall.events;
}

async function reasonOf(action: () => unknown): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return error instanceof AppError ? error.reason : undefined;
  }
  return undefined;
}

beforeEach(() => {
  mockEnvironment.META_WEBHOOK_VERIFY_TOKEN = 'unit-test-verify-token-of-thirty-two-chars';
  for (const log of Object.values(logger)) log.mockReset();
  recordUnknownAccountEntry.mockReset();
  openedScopes.length = 0;
});

describe('verifySubscription (route 60, WH4)', () => {
  const check = {
    mode: 'subscribe',
    verifyToken: 'unit-test-verify-token-of-thirty-two-chars',
    challenge: '1158201444',
  };

  it('returns the challenge when the mode is subscribe and the token matches', () => {
    expect(setup().service.verifySubscription(check)).toBe('1158201444');
  });

  it.each([
    ['a wrong token', { ...check, verifyToken: 'unit-test-verify-token-of-thirty-two-charz' }],
    ['a token of another length', { ...check, verifyToken: 'short' }],
    ['a mode other than subscribe', { ...check, mode: 'unsubscribe' }],
  ])('refuses %s with 400 invalid_webhook_verify_token', async (_label, input) => {
    const { service } = setup();
    expect(() => service.verifySubscription(input)).toThrow(ValidationError);
    expect(await reasonOf(() => service.verifySubscription(input))).toBe(
      'invalid_webhook_verify_token',
    );
  });

  it('answers 503 instagram_webhook_not_configured without the setting — fails closed', async () => {
    mockEnvironment.META_WEBHOOK_VERIFY_TOKEN = undefined;
    const { service } = setup();
    expect(() => service.verifySubscription(check)).toThrow(ServiceUnavailableError);
    expect(await reasonOf(() => service.verifySubscription(check))).toBe(
      'instagram_webhook_not_configured',
    );
  });
});

describe('receiveDelivery — what is not read (WH10)', () => {
  it('a signed body that is not JSON stores nothing and leaves a warning', async () => {
    const { service, accountService, eventService } = setup();

    const result = await service.receiveDelivery({ body: undefined, requestId: REQUEST_ID });

    expect(result.ignoredBecause).toBe('unreadable_body');
    expect(accountService.resolveOrganizationPublicIdForInstagramUser).not.toHaveBeenCalled();
    expect(eventService.recordReceivedEvents).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { requestId: REQUEST_ID },
      'instagram.webhook.unreadable_body',
    );
  });

  it('an object other than instagram stores nothing and leaves a warning', async () => {
    const { service, eventService } = setup();

    const result = await service.receiveDelivery({
      body: { object: 'page', entry: [{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }] },
      requestId: REQUEST_ID,
    });

    expect(result.ignoredBecause).toBe('unsupported_object');
    expect(eventService.recordReceivedEvents).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { requestId: REQUEST_ID },
      'instagram.webhook.unsupported_object',
    );
  });

  it.each([
    ['no id', { changes: [comment('1')] }],
    ['an id that is not digits', { id: 'abc', changes: [comment('1')] }],
  ])('an entry with %s is dropped with a log line; the others are stored', async (_label, bad) => {
    const { service, eventService } = setup();

    const result = await service.receiveDelivery({
      body: delivery([bad, { id: INSTAGRAM_USER_ID, changes: [comment('2')] }]),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ entryCount: 2, droppedEntryCount: 1, storedEventCount: 1 });
    expect(eventService.recordReceivedEvents).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { requestId: REQUEST_ID, entryIndex: 0 },
      'instagram.webhook.entry_without_account_id',
    );
  });
});

describe('receiveDelivery — an account no team holds (WH4, WQ1)', () => {
  it('an unknown or revoked account (the resolver finds none): 200, one log line, the metric, nothing stored', async () => {
    const { service, accountService, eventService } = setup({ organizationPublicId: null });

    const result = await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1'), comment('2')] }]),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ unknownAccountEntryCount: 1, storedEventCount: 0 });
    expect(accountService.resolveOrganizationPublicIdForInstagramUser).toHaveBeenCalledWith(
      INSTAGRAM_USER_ID,
    );
    expect(accountService.findWebhookAccountState).not.toHaveBeenCalled();
    expect(eventService.recordReceivedEvents).not.toHaveBeenCalled();
    expect(recordUnknownAccountEntry).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { requestId: REQUEST_ID, instagramUserId: INSTAGRAM_USER_ID, eventCount: 2 },
      'instagram.webhook.unknown_account',
    );
  });

  it('an account revoked after the resolver ran (no live account in its scope) is treated the same', async () => {
    const { service, eventService } = setup({ account: null });

    const result = await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }]),
      requestId: REQUEST_ID,
    });

    expect(result.unknownAccountEntryCount).toBe(1);
    expect(eventService.recordReceivedEvents).not.toHaveBeenCalled();
    expect(recordUnknownAccountEntry).toHaveBeenCalledTimes(1);
  });
});

describe('receiveDelivery — the store (WH3, WH9, WH10)', () => {
  it("stores the entry's events in the organization's VERIFIED scope, one call, each classified", async () => {
    const { service, accountService, eventService } = setup();

    const result = await service.receiveDelivery({
      body: delivery([
        {
          id: INSTAGRAM_USER_ID,
          time: 1_763_726_400,
          changes: [comment('18000000000000001')],
          messaging: [
            {
              sender: { id: INSTAGRAM_USER_ID },
              recipient: { id: CONTACT_ID },
              message: { mid: 'm_echo', is_echo: true },
            },
            { sender: { id: CONTACT_ID }, read: { mid: 'm_echo' } },
          ],
        },
      ]),
      requestId: REQUEST_ID,
    });

    const scope = { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'verified' };
    expect(openedScopes).toEqual([scope]);
    expect(accountService.findWebhookAccountState).toHaveBeenCalledWith({
      scope,
      instagramUserId: INSTAGRAM_USER_ID,
    });
    expect(eventService.recordReceivedEvents).toHaveBeenCalledTimes(1);
    expect(eventService.recordReceivedEvents.mock.calls[0]?.[0]).toMatchObject({
      scope,
      channelAccount: { organizationId: 7, channelAccountId: 13 },
      requestId: REQUEST_ID,
    });
    expect(
      storedEvents(eventService).map(({ eventKind, eventKey, skipReason, instagramUserId }) => ({
        eventKind,
        eventKey,
        skipReason,
        instagramUserId,
      })),
    ).toEqual([
      {
        eventKind: 'comment',
        eventKey: 'comment:18000000000000001',
        skipReason: null,
        instagramUserId: INSTAGRAM_USER_ID,
      },
      {
        eventKind: 'echo',
        eventKey: 'echo:m_echo',
        skipReason: null,
        instagramUserId: INSTAGRAM_USER_ID,
      },
    ]);
    // The read receipt is dropped, never saved (WH9 step 3).
    expect(result).toMatchObject({
      entryCount: 1,
      storedEventCount: 2,
      duplicateEventCount: 0,
      droppedEventCount: 1,
    });
  });

  it('caps the store unit at 3 s before anything else in it (WH2, WHC2)', async () => {
    const { service, accountService, eventService } = setup();

    await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }]),
      requestId: REQUEST_ID,
    });

    expect(eventService.limitStoreStatementTime).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'verified' },
      milliseconds: 3_000,
    });
    expect(eventService.limitStoreStatementTime.mock.invocationCallOrder[0]).toBeLessThan(
      accountService.findWebhookAccountState.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('drops the echoes the own-message lookup knows as ours; a hand-typed one is saved (WH9 step 3, WH10)', async () => {
    const findOwnSentMessageIds = vi.fn(async () => new Set(['m_ours']));
    const { accountService, eventService } = setup();
    const service = new InstagramWebhookService(
      accountService as unknown as InstagramAccountService,
      eventService as unknown as InstagramWebhookEventService,
      undefined,
      findOwnSentMessageIds,
    );
    const echo = (mid: string) => ({
      sender: { id: INSTAGRAM_USER_ID },
      recipient: { id: CONTACT_ID },
      message: { mid, is_echo: true },
    });

    const result = await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, messaging: [echo('m_ours'), echo('m_by_hand')] }]),
      requestId: REQUEST_ID,
    });

    expect(findOwnSentMessageIds).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'verified' },
      channelAccount: { organizationId: 7, channelAccountId: 13 },
      messageIds: ['m_ours', 'm_by_hand'],
    });
    expect(storedEvents(eventService).map((event) => [event.eventKey, event.skipReason])).toEqual([
      ['echo:m_by_hand', null],
    ]);
    expect(result).toMatchObject({ storedEventCount: 1, droppedEventCount: 1 });
  });

  it('asks the own-message lookup nothing when the entry holds no echo', async () => {
    const findOwnSentMessageIds = vi.fn(async () => new Set<string>());
    const { accountService, eventService } = setup();
    const service = new InstagramWebhookService(
      accountService as unknown as InstagramAccountService,
      eventService as unknown as InstagramWebhookEventService,
      undefined,
      findOwnSentMessageIds,
    );

    await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }]),
      requestId: REQUEST_ID,
    });

    expect(findOwnSentMessageIds).not.toHaveBeenCalled();
  });

  it.each([
    ['a statement cancelled by the 3 s statement_timeout', '57014'],
    ['a lock wait cancelled by lock_timeout', '55P03'],
  ])('a store over its time (%s) answers 503 — Meta delivers again (WH2)', async (_label, code) => {
    const { service, eventService } = setup();
    eventService.recordReceivedEvents.mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to statement timeout'), { code }),
    );

    const failure = await service
      .receiveDelivery({
        body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }]),
        requestId: REQUEST_ID,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as ServiceUnavailableError).statusCode).toBe(503);
  });

  it.each([
    ['the automation switch off', { isAutomationEnabled: false }, 'automation_disabled'],
    // WH3: an `error` account's events are saved `received` — they wait in its stopped lanes.
    ['an error account', { connectionStatus: 'error' as const }, null],
    [
      'the switch off on an error account',
      { isAutomationEnabled: false, connectionStatus: 'error' as const },
      'automation_disabled',
    ],
  ])(
    'with %s, events to handle are born with skip reason %s; kind skips keep their own reason',
    async (_label, overrides, reason) => {
      const { service, eventService } = setup({ account: accountState(overrides) });

      await service.receiveDelivery({
        body: delivery([
          {
            id: INSTAGRAM_USER_ID,
            changes: [comment('1')],
            messaging: [{ sender: { id: CONTACT_ID }, message_edit: { mid: 'm', num_edit: 1 } }],
          },
        ]),
        requestId: REQUEST_ID,
      });

      expect(storedEvents(eventService).map((event) => event.skipReason)).toEqual([reason, 'edit']);
    },
  );

  it('a repeat delivery inserts nothing — counted as duplicates', async () => {
    const { service, eventService } = setup();
    eventService.recordReceivedEvents.mockResolvedValueOnce([]);

    const result = await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1'), comment('2')] }]),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ storedEventCount: 0, duplicateEventCount: 2 });
  });

  it('an item Meta repeats inside one entry is stored once (first wins)', async () => {
    const { service, eventService } = setup();

    await service.receiveDelivery({
      body: delivery([
        {
          id: INSTAGRAM_USER_ID,
          changes: [
            {
              field: 'messages',
              value: { sender: { id: CONTACT_ID }, message: { mid: 'm_same' } },
            },
          ],
          messaging: [{ sender: { id: CONTACT_ID }, message: { mid: 'm_same' } }],
        },
      ]),
      requestId: REQUEST_ID,
    });

    expect(storedEvents(eventService).map((event) => event.eventKey)).toEqual(['message:m_same']);
  });

  it('stores each entry in its own unit, in order; an unknown one does not stop the rest', async () => {
    const { service, accountService, eventService } = setup();
    accountService.resolveOrganizationPublicIdForInstagramUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ORGANIZATION_PUBLIC_ID);

    const result = await service.receiveDelivery({
      body: delivery([
        { id: '17841400000000999', changes: [comment('1')] },
        { id: INSTAGRAM_USER_ID, changes: [comment('2')] },
      ]),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({
      entryCount: 2,
      unknownAccountEntryCount: 1,
      storedEventCount: 1,
    });
    expect(eventService.recordReceivedEvents).toHaveBeenCalledTimes(1);
  });

  it('an entry with no items resolves and stores nothing', async () => {
    const { service, accountService, eventService } = setup();

    await service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [], messaging: [] }]),
      requestId: REQUEST_ID,
    });

    expect(accountService.resolveOrganizationPublicIdForInstagramUser).not.toHaveBeenCalled();
    expect(eventService.recordReceivedEvents).not.toHaveBeenCalled();
  });

  it('a store failure propagates — Meta must not get a 200 (WH10)', async () => {
    const { service, eventService } = setup();
    eventService.recordReceivedEvents.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      service.receiveDelivery({
        body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('1')] }]),
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow('connection terminated');
  });

  it('a failing entry never stops the others; the delivery still fails, so Meta delivers it again (D53)', async () => {
    const { service, eventService } = setup();
    eventService.recordReceivedEvents
      .mockRejectedValueOnce(new Error('unsupported Unicode escape sequence'))
      .mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      service.receiveDelivery({
        body: delivery([
          { id: INSTAGRAM_USER_ID, changes: [comment('1', 'a private text')] },
          { id: INSTAGRAM_USER_ID, changes: [comment('2', 'a private text')] },
          { id: INSTAGRAM_USER_ID, changes: [comment('3', 'a private text')] },
        ]),
        requestId: REQUEST_ID,
      }),
      // The first failure is the one Meta's answer is made from.
    ).rejects.toThrow('unsupported Unicode escape sequence');

    expect(
      eventService.recordReceivedEvents.mock.calls.map(([input]) =>
        input.events.map((event) => event.eventKey),
      ),
    ).toEqual([['comment:1'], ['comment:2'], ['comment:3']]);
    expect(logger.error.mock.calls).toEqual([
      [
        { requestId: REQUEST_ID, entryIndex: 0, errorName: 'Error' },
        'instagram.webhook.entry_store_failed',
      ],
      [
        { requestId: REQUEST_ID, entryIndex: 1, errorName: 'Error' },
        'instagram.webhook.entry_store_failed',
      ],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ entryCount: 3, failedEntryCount: 2, storedEventCount: 1 }),
      'instagram.webhook.delivery_received',
    );
    expect(JSON.stringify([logger.error.mock.calls, logger.info.mock.calls])).not.toContain(
      'a private text',
    );
  });

  it('a failing organization lookup is an entry failure too — the next entry is stored', async () => {
    const { service, accountService, eventService } = setup();
    accountService.resolveOrganizationPublicIdForInstagramUser.mockRejectedValueOnce(
      new Error('resolver down'),
    );

    await expect(
      service.receiveDelivery({
        body: delivery([
          { id: INSTAGRAM_USER_ID, changes: [comment('1')] },
          { id: INSTAGRAM_USER_ID, changes: [comment('2')] },
        ]),
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow('resolver down');
    expect(storedEvents(eventService).map((event) => event.eventKey)).toEqual(['comment:2']);
  });

  it('cleans the text Postgres refuses — the stored payload and the event key (D53)', async () => {
    const { service, eventService } = setup();

    const result = await service.receiveDelivery({
      body: delivery([
        {
          id: INSTAGRAM_USER_ID,
          changes: [
            {
              field: 'comments',
              value: {
                id: '1800\u0000001',
                from: { id: CONTACT_ID, 'user\u0000name': 'acme\ud83d_customer' },
                text: 'Price\u0000 please? \ud83d\ude00 \udead',
              },
            },
          ],
          messaging: [
            {
              sender: { id: CONTACT_ID },
              message: { mid: 'm_\u0000dm\ud83d', text: 'hello\u0000' },
            },
          ],
        },
      ]),
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ failedEntryCount: 0, storedEventCount: 2 });
    expect(
      storedEvents(eventService).map(({ eventKey, payload }) => ({ eventKey, payload })),
    ).toEqual([
      {
        eventKey: 'comment:1800001',
        payload: {
          field: 'comments',
          value: {
            id: '1800001',
            from: { id: CONTACT_ID, username: 'acme\ufffd_customer' },
            text: 'Price please? \ud83d\ude00 \ufffd',
          },
        },
      },
      {
        eventKey: 'message:m_dm\ufffd',
        payload: {
          sender: { id: CONTACT_ID },
          message: { mid: 'm_dm\ufffd', text: 'hello' },
        },
      },
    ]);
  });
});

describe("receiveDelivery — R14's processing enqueue hook (WH5, WH10)", () => {
  const body = delivery([
    {
      id: INSTAGRAM_USER_ID,
      changes: [comment('1')],
      messaging: [{ sender: { id: CONTACT_ID }, message_edit: { mid: 'm', num_edit: 1 } }],
    },
  ]);

  it('unwired (R13): nothing is enqueued and every stored event stays received', async () => {
    const { service, eventService } = setup();

    await service.receiveDelivery({ body, requestId: REQUEST_ID });

    expect(eventService.markEventsQueued).not.toHaveBeenCalled();
  });

  it('wired: adds the account job after the store, then turns only the received rows queued', async () => {
    const enqueue = vi.fn(async () => undefined);
    const { service, eventService } = setup({ enqueue });

    await service.receiveDelivery({ body, requestId: REQUEST_ID });

    expect(enqueue).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
      requestId: REQUEST_ID,
    });
    expect(eventService.markEventsQueued).toHaveBeenCalledWith({
      scope: { organizationPublicId: ORGANIZATION_PUBLIC_ID, source: 'verified' },
      channelAccount: { organizationId: 7, channelAccountId: 13 },
      eventIds: [100],
    });
  });

  it('wired, nothing received (all skipped or repeated): no job is added', async () => {
    const enqueue = vi.fn(async () => undefined);
    const { service } = setup({ enqueue, account: accountState({ isAutomationEnabled: false }) });

    await service.receiveDelivery({ body, requestId: REQUEST_ID });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failed add is logged and left to the stuck-event pick-up — it never fails the answer', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('redis down');
    });
    const { service, eventService } = setup({ enqueue });

    await expect(service.receiveDelivery({ body, requestId: REQUEST_ID })).resolves.toMatchObject({
      storedEventCount: 2,
    });
    expect(eventService.markEventsQueued).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        requestId: REQUEST_ID,
        channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
        errorName: 'Error',
      },
      'instagram.webhook.processing_enqueue_failed',
    );
  });
});

describe('receiveDelivery — logs never carry the payload (WH6, WHC5)', () => {
  it('no log line holds message or comment text, emails, phone numbers or the payload', async () => {
    const { service } = setup();
    const secretText = 'my email is person@example.com call +919876543210';

    await service.receiveDelivery({
      body: delivery([
        {
          id: INSTAGRAM_USER_ID,
          changes: [comment('1', secretText)],
          messaging: [{ sender: { id: CONTACT_ID }, message: { mid: 'm_text', text: secretText } }],
        },
        { changes: [comment('2', secretText)] },
      ]),
      requestId: REQUEST_ID,
    });
    // An unknown account's entry too.
    const unknown = setup({ organizationPublicId: null });
    await unknown.service.receiveDelivery({
      body: delivery([{ id: INSTAGRAM_USER_ID, changes: [comment('3', secretText)] }]),
      requestId: REQUEST_ID,
    });

    const logged = JSON.stringify(Object.values(logger).map((log) => log.mock.calls));
    expect(logged).toContain('instagram.webhook.entry_stored');
    for (const forbidden of [
      'person@example.com',
      '+919876543210',
      'my email is',
      '"text"',
      'payload',
    ]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
