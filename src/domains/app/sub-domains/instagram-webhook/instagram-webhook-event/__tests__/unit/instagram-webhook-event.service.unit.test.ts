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
import { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';

/**
 * The Instagram webhook events service without a database (routes-final § 4.B): route 18 checks
 * the team first and serializes (masks) the page; every write runs in the caller's scope and hands
 * the repository exactly what it was given.
 */

const scope = PRINCIPAL_SCOPE.JOB({
  organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
}) as OrganizationPrincipalDatabaseScope;
const instagramAccount = { organizationId: 7, instagramAccountId: 9 };
const claim = { ...instagramAccount, eventId: 42, claimedAttemptCount: 1 };

function eventRow() {
  return {
    id: 42,
    public_id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
    organization_id: 7,
    instagram_account_id: 9,
    instagram_user_id: '17841400000000001',
    contact_instagram_user_id: '17841400000000777',
    event_kind: 'comment',
    event_key: 'comment:18000000000000001',
    status: 'received',
    skip_reason: null,
    error_message: null,
    attempt_count: 0,
    last_attempted_at: null,
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
    markQueued: vi.fn(),
    claimOldestWaitingEvent: vi.fn(),
    markProcessed: vi.fn(),
    markSkipped: vi.fn(),
    markFailed: vi.fn(),
    releaseClaim: vi.fn(),
  };
  const organizationService = { requireOrganizationByPublicId: vi.fn() };
  const service = new InstagramWebhookEventService(
    repository as unknown as InstagramWebhookEventRepository,
    organizationService as unknown as OrganizationService,
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
    it('stores the events in the scope and returns the inserted rows', async () => {
      const inserted = [eventRow()];
      repository.insertEvents.mockResolvedValue(inserted);
      const events = [
        {
          instagramUserId: '17841400000000001',
          contactInstagramUserId: null,
          eventKind: 'comment' as const,
          eventKey: 'comment:1',
          skipReason: null,
          payload: {},
          occurredAt: null,
        },
      ];

      await expect(
        service.recordReceivedEvents({ scope, instagramAccount, requestId: 'req-1', events }),
      ).resolves.toBe(inserted);
      expect(repository.insertEvents).toHaveBeenCalledWith({
        ...instagramAccount,
        requestId: 'req-1',
        events,
      });
    });

    it('marks the stored rows queued', async () => {
      repository.markQueued.mockResolvedValue(2);

      await expect(
        service.markEventsQueued({ scope, instagramAccount, eventIds: [1, 2] }),
      ).resolves.toBe(2);
      expect(repository.markQueued).toHaveBeenCalledWith({ ...instagramAccount, eventIds: [1, 2] });
    });

    it('claims with the caller’s attempt cap and lease', async () => {
      repository.claimOldestWaitingEvent.mockResolvedValue(null);

      await expect(
        service.claimNextEvent({
          scope,
          instagramAccount,
          maxProcessingAttempts: 5,
          claimLeaseMinutes: 5,
        }),
      ).resolves.toBeNull();
      expect(repository.claimOldestWaitingEvent).toHaveBeenCalledWith({
        ...instagramAccount,
        maxProcessingAttempts: 5,
        claimLeaseMinutes: 5,
      });
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
        service.markEventFailed({ scope, claim, errorMessage: 'instagram_api:2/0' }),
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
