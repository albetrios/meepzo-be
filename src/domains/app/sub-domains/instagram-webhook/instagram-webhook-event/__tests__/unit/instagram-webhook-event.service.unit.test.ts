import { beforeEach, describe, expect, it, vi } from 'vitest';

// The unit lane has no Postgres: the context wrapper runs its callback directly.
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { scope: unknown; callback: () => Promise<unknown> }) => callback(),
    ),
  };
});

import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { NotFoundError } from '@/shared/errors/index.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramWebhookEventRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import type { InstagramWebhookEventKeyRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event-key.repository.js';
import {
  InstagramWebhookEventService,
  instagramWebhookEventDay,
  isInstagramWebhookEventReplay,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';

/**
 * The Instagram webhook events service without a database (feat-instagram-dm-sending § 5.B): route
 * 62 checks the team first and serializes (masks) the page; the store function drops replays, files
 * each key under its Meta day and inserts only the events whose key was new (WH9, WH20); every other
 * write runs in the caller's scope and hands the repository exactly what it was given.
 */

const scope = PRINCIPAL_SCOPE.JOB({
  organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
}) as OrganizationPrincipalDatabaseScope;
const channelAccount = { organizationId: 7, channelAccountId: 9 };
const claim = { ...channelAccount, eventId: 42, claimedAttemptCount: 1 };

function eventRow() {
  return {
    id: 42,
    public_id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
    organization_id: 7,
    channel_account_id: 9,
    channel_account_public_id: 'cha_a1b2c3d4e5f6g7h8i9j0k',
    instagram_user_id: '17841400000000001',
    contact_instagram_user_id: '17841400000000777',
    event_kind: 'comment',
    intake_group: 'comments',
    event_key: 'comment:18000000000000001',
    status: 'received',
    skip_reason: null,
    error_message: null,
    attempt_count: 0,
    last_attempted_at: null,
    next_attempt_at: null,
    payload: { field: 'comments', value: { text: 'email me at rimeet@gmail.com' } },
    occurred_at: null,
    processed_at: null,
    request_id: 'req-1',
    created_at: new Date('2026-11-21T09:00:00.000Z'),
    updated_at: new Date('2026-11-21T09:00:00.000Z'),
    cursor_created_at: '2026-11-21T09:00:00.000000Z',
  };
}

describe('InstagramWebhookEventService', () => {
  const repository = {
    listByOrganization: vi.fn(),
    insertEvents: vi.fn(),
    countContactMessageEventsSince: vi.fn(),
    listEchoMessageIdsSince: vi.fn(),
    countWaitingEvents: vi.fn(),
    claimOldestWaitingEvent: vi.fn(),
    markProcessed: vi.fn(),
    markSkipped: vi.fn(),
    markFailed: vi.fn(),
    releaseClaim: vi.fn(),
  };
  const keyRepository = { insertNewKeys: vi.fn() };
  const organizationService = { requireOrganizationByPublicId: vi.fn() };
  const service = new InstagramWebhookEventService(
    repository as unknown as InstagramWebhookEventRepository,
    organizationService as unknown as OrganizationService,
    keyRepository as unknown as InstagramWebhookEventKeyRepository,
  );
  const filters = { limit: 25, includeTotal: false };

  beforeEach(() => {
    vi.clearAllMocks();
    organizationService.requireOrganizationByPublicId.mockResolvedValue({ id: 7, type: 'TEAM' });
    repository.listByOrganization.mockResolvedValue({
      items: [eventRow()],
      total: null,
      limit: 25,
      has_more: false,
      next_cursor: null,
    });
  });

  describe('listEvents (route 18)', () => {
    it("lists the scope's organization's events with the payload masked", async () => {
      const page = await service.listEvents({ scope, filters });

      expect(organizationService.requireOrganizationByPublicId).toHaveBeenCalledWith(
        scope.organizationPublicId,
      );
      expect(repository.listByOrganization).toHaveBeenCalledWith({ organizationId: 7, filters });
      expect(page).toMatchObject({ total: null, limit: 25, has_more: false, next_cursor: null });
      expect(page.items[0]).toMatchObject({
        id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
        payload: { field: 'comments', value: { text: 'email me at r***@g***.com' } },
      });
      expect(vi.mocked(withAppDatabaseContext)).toHaveBeenCalledWith(
        expect.objectContaining({ scope }),
      );
    });

    it('answers 404 team_organization_required on a personal organization, reading no event', async () => {
      organizationService.requireOrganizationByPublicId.mockResolvedValue({
        id: 7,
        type: 'PERSONAL',
      });

      const failure = await service.listEvents({ scope, filters }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundError);
      expect((failure as NotFoundError & { reason?: string }).reason).toBe(
        'team_organization_required',
      );
      expect(repository.listByOrganization).not.toHaveBeenCalled();
    });
  });

  describe('the write path (4.A calls it)', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    function newEvent(eventKey: string, occurredAt: Date | null) {
      return {
        instagramUserId: '17841400000000001',
        contactInstagramUserId: null,
        eventKind: 'comment' as const,
        eventKey,
        skipReason: null,
        payload: {},
        occurredAt,
      };
    }

    it('claims the keys on their Meta day, then stores only the events whose key was new', async () => {
      const inserted = [eventRow()];
      repository.insertEvents.mockResolvedValue(inserted);
      const fresh = newEvent('comment:1', new Date('2026-11-23T23:59:00.000Z'));
      const repeat = newEvent('comment:2', new Date('2026-11-24T00:01:00.000Z'));
      const timeless = newEvent('comment:3', null);
      keyRepository.insertNewKeys.mockResolvedValue([
        { eventKey: 'comment:1', eventDay: '2026-11-23' },
        { eventKey: 'comment:3', eventDay: '2026-11-24' },
      ]);

      await expect(
        service.recordReceivedEvents({
          scope,
          channelAccount,
          requestId: 'req-1',
          events: [fresh, repeat, timeless],
          now,
        }),
      ).resolves.toBe(inserted);
      expect(keyRepository.insertNewKeys).toHaveBeenCalledWith({
        ...channelAccount,
        keys: [
          { eventKey: 'comment:1', eventDay: '2026-11-23' },
          { eventKey: 'comment:2', eventDay: '2026-11-24' },
          { eventKey: 'comment:3', eventDay: '2026-11-24' },
        ],
      });
      expect(repository.insertEvents).toHaveBeenCalledWith({
        ...channelAccount,
        requestId: 'req-1',
        events: [fresh, timeless],
      });
    });

    it('drops an event whose Meta time is over 8 days old before any write (WH9 step 5)', async () => {
      const replay = newEvent('comment:old', new Date('2026-11-15T11:59:00.000Z'));

      await expect(
        service.recordReceivedEvents({
          scope,
          channelAccount,
          requestId: null,
          events: [replay],
          now,
        }),
      ).resolves.toEqual([]);
      expect(keyRepository.insertNewKeys).not.toHaveBeenCalled();
      expect(repository.insertEvents).not.toHaveBeenCalled();
    });

    it('files a key under the UTC day of Meta’s time, else the received day', () => {
      expect(
        instagramWebhookEventDay({
          occurredAt: new Date('2026-11-23T23:30:00.000-05:00'),
          receivedAt: now,
        }),
      ).toBe('2026-11-24');
      expect(instagramWebhookEventDay({ occurredAt: null, receivedAt: now })).toBe('2026-11-24');
      expect(
        isInstagramWebhookEventReplay({ occurredAt: new Date('2026-11-16T12:00:00.000Z'), now }),
      ).toBe(false);
      expect(
        isInstagramWebhookEventReplay({ occurredAt: new Date('2026-11-16T11:59:59.000Z'), now }),
      ).toBe(true);
      expect(isInstagramWebhookEventReplay({ occurredAt: null, now })).toBe(false);
    });

    it('claims with the caller’s attempt cap and lease', async () => {
      repository.claimOldestWaitingEvent.mockResolvedValue(null);

      await expect(
        service.claimNextEvent({
          scope,
          channelAccount,
          intakeGroup: 'comments',
          maxProcessingAttempts: 5,
          claimLeaseMinutes: 5,
          retryAfterMinutes: 60,
        }),
      ).resolves.toBeNull();
      // Comments claim SKIP LOCKED (S11); the other groups keep strict order.
      expect(repository.claimOldestWaitingEvent).toHaveBeenCalledWith({
        ...channelAccount,
        intakeGroup: 'comments',
        isSkipLocked: true,
        maxProcessingAttempts: 5,
        claimLeaseMinutes: 5,
        retryAfterMinutes: 60,
      });
      await service.claimNextEvent({
        scope,
        channelAccount,
        intakeGroup: 'messages',
        maxProcessingAttempts: 5,
        claimLeaseMinutes: 5,
        retryAfterMinutes: 60,
      });
      expect(repository.claimOldestWaitingEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ intakeGroup: 'messages', isSkipLocked: false }),
      );
    });

    it('passes each mark and the release the claim', async () => {
      for (const method of [
        'markProcessed',
        'markSkipped',
        'markFailed',
        'releaseClaim',
      ] as const) {
        repository[method].mockResolvedValue(true);
      }

      await expect(service.markEventProcessed({ scope, claim })).resolves.toBe(true);
      await expect(
        service.markEventSkipped({ scope, claim, skipReason: 'automation_disabled' }),
      ).resolves.toBe(true);
      await expect(
        service.markEventFailed({
          scope,
          claim,
          errorMessage: 'instagram_api:2/0',
          retryAfterMinutes: 60,
        }),
      ).resolves.toBe(true);
      await expect(service.releaseEventClaim({ scope, claim })).resolves.toBe(true);
      await expect(service.releaseEventClaim({ scope, claim, isAttemptSpent: true })).resolves.toBe(
        true,
      );

      expect(repository.markProcessed).toHaveBeenCalledWith(claim);
      expect(repository.markSkipped).toHaveBeenCalledWith({
        ...claim,
        skipReason: 'automation_disabled',
      });
      expect(repository.markFailed).toHaveBeenCalledWith({
        ...claim,
        errorMessage: 'instagram_api:2/0',
        retryAfterMinutes: 60,
      });
      // An outage gives the attempt back; a temporary failure keeps it and only ends the lease.
      expect(repository.releaseClaim).toHaveBeenNthCalledWith(1, {
        ...claim,
        isAttemptSpent: false,
      });
      expect(repository.releaseClaim).toHaveBeenNthCalledWith(2, {
        ...claim,
        isAttemptSpent: true,
      });
    });
  });
});
