import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';
import type {
  ContactListRow,
  ContactRepository,
  ContactRow,
} from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type {
  ContactAutomationFilterResolver,
  ContactBulkActionQueue,
  ContactErasureStep,
  ContactListQuery,
  ContactPauseStep,
  ContactTagEventRecorder,
} from '@/domains/app/sub-domains/contact/contact.types.js';

const { workerRepository, loggerWarn } = vi.hoisted(() => ({
  workerRepository: {
    upsertInteraction: vi.fn(),
    findLiveById: vi.fn(),
    updateProfile: vi.fn(),
    recordEmail: vi.fn(),
    recordPhone: vi.fn(),
    replaceTags: vi.fn(),
    recordMessageSent: vi.fn(),
    applyTagCountDeltas: vi.fn(),
    setOptedOut: vi.fn(),
  },
  loggerWarn: vi.fn(),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The unit lane has no Postgres: the unit of work runs the callback directly.
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({}),
    ),
  };
});

vi.mock('@/domains/app/sub-domains/contact/contact.repository.js', () => ({
  createWorkerContactRepository: vi.fn(() => workerRepository),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The contact service's own decisions (routes-final § 3.A, CT2, CT5–CT11) with the repository
 * mocked: the list's account and default sort, the team-only guards, the owner's change (tags, note,
 * pause steps, counts, events, `409`, `422`), the bulk count and its port, the tag list, the erase's
 * step order and its `404`, and how each worker operation normalises before it writes. The database behaviour is in
 * `contact.service.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const databaseHandle = {} as WorkerDatabaseHandle;
const now = new Date('2026-11-21T09:00:00.000Z');

function contactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 41,
    public_id: 'con_p3k8w2m9x4r7n1v5a1b2c',
    organization_id: 7,
    channel_account_id: 3,
    channel: 'instagram',
    instagram_user_id: '17841455500000001',
    username: 'jordan.lee',
    full_name: null,
    profile_picture_url: null,
    followers_count: null,
    is_following_account: null,
    follow_checked_at: null,
    email: null,
    email_collected_at: null,
    phone: null,
    phone_collected_at: null,
    tags: [],
    note: null,
    opted_out_at: null,
    automations_off_at: null,
    automations_off_by_user_id: null,
    first_automation_id: null,
    came_in_via: null,
    came_in_ref: null,
    first_seen_at: now,
    last_message_received_at: now,
    last_direct_message_received_at: null,
    last_message_sent_at: null,
    last_opening_message_at: null,
    first_message_at: null,
    last_comment_at: null,
    comment_count: 0,
    last_story_activity_at: null,
    last_broadcast_at: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const emptyListQuery: ContactListQuery = {
  limit: 25,
  after: undefined,
  q: undefined,
  sort: undefined,
  order: undefined,
  tags: [],
  hasEmail: undefined,
  hasPhone: undefined,
  isFollowingAccount: undefined,
  firstSeenFrom: undefined,
  firstSeenTo: undefined,
  channelAccountPublicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  automationPublicId: undefined,
  isOptedOut: undefined,
  isAutomationsPaused: undefined,
  cameInVia: [],
  firstAutomationPublicId: undefined,
};

describe('ContactService', () => {
  let organization: { id: number; type: string };
  let repository: {
    list: ReturnType<typeof vi.fn>;
    lockLiveByPublicId: ReturnType<typeof vi.fn>;
    erase: ReturnType<typeof vi.fn>;
    findChannelAccountId: ReturnType<typeof vi.fn>;
    findDetailByPublicId: ReturnType<typeof vi.fn>;
    updateOwnerFields: ReturnType<typeof vi.fn>;
    applyTagCountDeltas: ReturnType<typeof vi.fn>;
    countBulkSelection: ReturnType<typeof vi.fn>;
    listTagCounts: ReturnType<typeof vi.fn>;
  };
  let erasureSteps: ContactErasureStep[];
  let pauseSteps: ContactPauseStep[];
  let tagEventRecorder: { recordContactTagEvents: ReturnType<typeof vi.fn> };
  let bulkActionQueue: { enqueueContactBulkAction: ReturnType<typeof vi.fn> } | undefined;
  let organizationService: OrganizationService;
  let automationFilterResolver: ReturnType<typeof vi.fn> & ContactAutomationFilterResolver;
  let service: ContactService;

  beforeEach(() => {
    vi.clearAllMocks();
    organization = { id: 7, type: 'TEAM' };
    repository = {
      list: vi.fn(),
      lockLiveByPublicId: vi.fn(),
      erase: vi.fn(),
      findChannelAccountId: vi.fn(async () => 3),
      findDetailByPublicId: vi.fn(async () => ({
        ...contactRow(),
        channel_account_public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
        first_automation_public_id: null,
        first_automation_name: null,
        open_run_count: 0,
      })),
      updateOwnerFields: vi.fn(),
      applyTagCountDeltas: vi.fn(),
      countBulkSelection: vi.fn(async () => 12),
      listTagCounts: vi.fn(async () => [{ tag: 'vip', contact_count: 2 }]),
    };
    erasureSteps = [];
    pauseSteps = [];
    tagEventRecorder = { recordContactTagEvents: vi.fn() };
    bulkActionQueue = { enqueueContactBulkAction: vi.fn() };
    automationFilterResolver = vi.fn(async () => 52) as ReturnType<typeof vi.fn> &
      ContactAutomationFilterResolver;
    organizationService = {
      requireOrganizationByPublicId: vi.fn(async () => organization),
      resolveUserInternalIdByPublicId: vi.fn(async () => 12),
      resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map([[12, 'usr_owner']])),
    } as unknown as OrganizationService;
    service = buildService();
  });

  function buildService(): ContactService {
    return new ContactService(
      repository as unknown as ContactRepository,
      organizationService,
      erasureSteps,
      automationFilterResolver,
      {
        pauseSteps,
        tagEventRecorder: tagEventRecorder as unknown as ContactTagEventRecorder,
        ...(bulkActionQueue === undefined
          ? {}
          : { bulkActionQueue: bulkActionQueue as unknown as ContactBulkActionQueue }),
      },
    );
  }

  describe('listContacts (route 18)', () => {
    beforeEach(() => {
      repository.list.mockResolvedValue({
        items: [
          {
            ...contactRow(),
            channel_account_public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
            first_automation_public_id: null,
            cursor_created_at: '2026-11-21T09:00:00.000000Z',
          } satisfies ContactListRow,
        ],
        total: 1,
        limit: 25,
        has_more: false,
        next_cursor: null,
      });
    });

    it.each([
      [undefined, undefined, 'last_message_received_at', 'desc'],
      ['first_seen_at', undefined, 'first_seen_at', 'desc'],
      ['username', undefined, 'username', 'asc'],
      ['username', 'desc', 'username', 'desc'],
      ['last_message_received_at', 'asc', 'last_message_received_at', 'asc'],
    ] as const)(
      'sort %s order %s → %s %s (CT6)',
      async (sort, order, expectedSort, expectedOrder) => {
        await service.listContacts({ scope, query: { ...emptyListQuery, sort, order } });

        expect(repository.list).toHaveBeenCalledWith({
          organizationId: 7,
          query: expect.objectContaining({ sort: expectedSort, order: expectedOrder }),
        });
      },
    );

    it('serializes every row with its account public id', async () => {
      const page = await service.listContacts({ scope, query: emptyListQuery });

      expect(page.items).toEqual([
        expect.objectContaining({
          id: 'con_p3k8w2m9x4r7n1v5a1b2c',
          channel_account_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
        }),
      ]);
      expect(page.items[0]).not.toHaveProperty('cursor_created_at');
      expect(page.total).toBe(1);
    });

    it('passes no automation filter without automation_id, and never asks for one', async () => {
      await service.listContacts({ scope, query: emptyListQuery });

      expect(automationFilterResolver).not.toHaveBeenCalled();
      expect(repository.list).toHaveBeenCalledWith({
        organizationId: 7,
        query: expect.objectContaining({ automationId: undefined }),
      });
    });

    it('resolves automation_id inside the organization and filters by its internal id (CT5)', async () => {
      await service.listContacts({
        scope,
        query: { ...emptyListQuery, automationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c' },
      });

      expect(automationFilterResolver).toHaveBeenCalledWith({
        scope,
        organizationId: 7,
        automationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c',
      });
      expect(repository.list).toHaveBeenCalledWith({
        organizationId: 7,
        query: expect.objectContaining({ automationId: 52 }),
      });
    });

    it('passes null for an unknown automation, so the page is empty (CT5)', async () => {
      automationFilterResolver.mockResolvedValue(null);

      await service.listContacts({
        scope,
        query: { ...emptyListQuery, automationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c' },
      });

      expect(repository.list).toHaveBeenCalledWith({
        organizationId: 7,
        query: expect.objectContaining({ automationId: null }),
      });
    });

    it('answers an empty page for an account the organization does not have (CT2)', async () => {
      repository.findChannelAccountId.mockResolvedValue(null);

      const page = await service.listContacts({ scope, query: emptyListQuery });

      expect(page).toEqual({ items: [], limit: 25, has_more: false, next_cursor: null, total: 0 });
      expect(repository.list).not.toHaveBeenCalled();
    });

    it('lists the named account by its internal id', async () => {
      await service.listContacts({ scope, query: emptyListQuery });

      expect(repository.findChannelAccountId).toHaveBeenCalledWith({
        organizationId: 7,
        channelAccountPublicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
      });
      expect(repository.list).toHaveBeenCalledWith({
        organizationId: 7,
        query: expect.objectContaining({ channelAccountId: 3 }),
      });
    });

    it('answers 404 team_organization_required on a personal organization (CT3)', async () => {
      organization.type = 'PERSONAL';

      const error = await service
        .listContacts({ scope, query: emptyListQuery })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).reason).toBe('team_organization_required');
      expect(repository.list).not.toHaveBeenCalled();
    });
  });

  describe('updateContact (route 20)', () => {
    const caller = { scope, userPublicId: 'usr_owner' };
    const noChange = {
      note: undefined,
      addTags: [],
      removeTags: [],
      isAutomationsPaused: undefined,
      expectedUpdatedAt: undefined,
    };

    it('removes then adds tags, moves the counts and records one owner event per change (CT5)', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(contactRow({ tags: ['vip', 'lead'] }));

      const result = await service.updateContact({
        caller,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
        input: { ...noChange, addTags: ['vip', 'buyer'], removeTags: ['lead'] },
      });

      expect(repository.lockLiveByPublicId).toHaveBeenCalledWith(
        expect.objectContaining({ strength: 'no key update' }),
      );
      expect(repository.updateOwnerFields).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
        values: { tags: ['vip', 'buyer'] },
      });
      expect(repository.applyTagCountDeltas).toHaveBeenCalledWith({
        organizationId: 7,
        channelAccountId: 3,
        deltas: [
          { tag: 'buyer', delta: 1 },
          { tag: 'lead', delta: -1 },
        ],
      });
      const [[{ events }]] = tagEventRecorder.recordContactTagEvents.mock.calls as [
        [{ events: { tag: string; kind: string; source: string }[] }],
      ];
      expect(events.map((event) => [event.tag, event.kind, event.source])).toEqual([
        ['buyer', 'added', 'owner'],
        ['lead', 'removed', 'owner'],
      ]);
      expect(result.changedFields).toEqual(['tags']);
      expect(result.pauseChange).toBeNull();
    });

    it('refuses a change past 50 tags with 422 contact_tag_limit, writing nothing', async () => {
      const held = Array.from({ length: 50 }, (_, index) => `held${index}`);
      repository.lockLiveByPublicId.mockResolvedValue(contactRow({ tags: held }));

      const error = await service
        .updateContact({
          caller,
          contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
          input: { ...noChange, addTags: ['one-more'] },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnprocessableEntityError);
      expect((error as UnprocessableEntityError).reason).toBe('contact_tag_limit');
      expect(repository.updateOwnerFields).not.toHaveBeenCalled();
    });

    it('answers 409 record_changed for an older expected_updated_at', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(contactRow());

      const error = await service
        .updateContact({
          caller,
          contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
          input: { ...noChange, note: 'x', expectedUpdatedAt: new Date(now.getTime() - 1000) },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).reason).toBe('record_changed');
    });

    it('a pause sets who and when and runs every pause step with contact_excluded (D71)', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(contactRow());
      const step = vi.fn();
      pauseSteps.push(step);

      const result = await service.updateContact({
        caller,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
        input: { ...noChange, isAutomationsPaused: true },
      });

      expect(repository.updateOwnerFields).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
        values: { automations_off_at: expect.any(Date), automations_off_by_user_id: 12 },
      });
      expect(step).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
        reason: 'contact_excluded',
      });
      expect(result.pauseChange).toBe('pause');
    });

    it('switching the pause off clears it and runs no step (AC-5.9)', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(
        contactRow({ automations_off_at: now, automations_off_by_user_id: 12 }),
      );
      const step = vi.fn();
      pauseSteps.push(step);

      const result = await service.updateContact({
        caller,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
        input: { ...noChange, isAutomationsPaused: false },
      });

      expect(repository.updateOwnerFields).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
        values: { automations_off_at: null, automations_off_by_user_id: null },
      });
      expect(step).not.toHaveBeenCalled();
      expect(result.pauseChange).toBe('resume');
    });

    it('a body that changes nothing writes nothing', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(contactRow({ note: 'same', tags: ['vip'] }));

      const result = await service.updateContact({
        caller,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
        input: { ...noChange, note: 'same', addTags: ['vip'], isAutomationsPaused: false },
      });

      expect(repository.updateOwnerFields).not.toHaveBeenCalled();
      expect(repository.applyTagCountDeltas).not.toHaveBeenCalled();
      expect(result.changedFields).toEqual([]);
    });

    it('answers 404 contact_not_found for no live contact', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(null);

      await expect(
        service.updateContact({ caller, contactPublicId: 'con_x', input: noChange }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('startBulkAction (route 21)', () => {
    const caller = { scope, userPublicId: 'usr_owner' };
    const input = {
      channelAccountPublicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
      action: 'add_tag' as const,
      tag: 'vip',
      contactPublicIds: ['con_p3k8w2m9x4r7n1v5a1b2c'],
      filter: null,
    };

    it('counts the selection and queues one job (CT7)', async () => {
      const result = await service.startBulkAction({ caller, input });

      expect(result).toEqual({ action: 'add_tag', matched_count: 12, is_queued: true });
      expect(repository.countBulkSelection).toHaveBeenCalledWith(
        expect.objectContaining({ channelAccountId: 3, cap: 100_001 }),
      );
      expect(bulkActionQueue?.enqueueContactBulkAction).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
          channelAccountPublicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
          action: 'add_tag',
          tag: 'vip',
          actorUserPublicId: 'usr_owner',
        }),
      );
    });

    it('refuses more than 100,000 matches with 422 contact_bulk_too_many', async () => {
      repository.countBulkSelection.mockResolvedValue(100_001);

      const error = await service.startBulkAction({ caller, input }).catch((caught) => caught);

      expect((error as UnprocessableEntityError).reason).toBe('contact_bulk_too_many');
      expect(bulkActionQueue?.enqueueContactBulkAction).not.toHaveBeenCalled();
    });

    it('answers 503 contact_bulk_action_unavailable while no queue is wired (R46)', async () => {
      bulkActionQueue = undefined;
      service = buildService();

      const error = await service.startBulkAction({ caller, input }).catch((caught) => caught);

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as ServiceUnavailableError).reason).toBe('contact_bulk_action_unavailable');
    });

    it('answers 404 channel_account_not_found for an account of no one here', async () => {
      repository.findChannelAccountId.mockResolvedValue(null);

      const error = await service.startBulkAction({ caller, input }).catch((caught) => caught);

      expect((error as NotFoundError).reason).toBe('channel_account_not_found');
    });
  });

  describe('listContactTags (route 22)', () => {
    it('answers the counts of the named account', async () => {
      expect(
        await service.listContactTags({
          scope,
          channelAccountPublicId: 'cha_k7x9m2pqr4w8n1v3a1b2c',
          limit: 1000,
        }),
      ).toEqual([{ tag: 'vip', contact_count: 2 }]);
      expect(repository.listTagCounts).toHaveBeenCalledWith({
        organizationId: 7,
        channelAccountId: 3,
        limit: 1000,
      });
    });
  });

  describe('deleteContact (route 23)', () => {
    it('runs the steps in order with the contact, then erases it', async () => {
      const calls: string[] = [];
      repository.lockLiveByPublicId.mockImplementation(async () => {
        calls.push('lock');
        return contactRow();
      });
      erasureSteps.push(async (input) => {
        calls.push(`step:${input.organizationId}:${input.contactId}:${input.instagramUserId}`);
      });
      repository.erase.mockImplementation(async () => {
        calls.push('erase');
        return contactRow({ deleted_at: now, instagram_user_id: null });
      });

      const result = await service.deleteContact({
        scope,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
      });

      expect(result).toEqual({ contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c' });
      expect(calls).toEqual(['lock', 'step:7:41:17841455500000001', 'erase']);
      expect(repository.applyTagCountDeltas).toHaveBeenCalledWith({
        organizationId: 7,
        channelAccountId: 3,
        deltas: [],
      });
      expect(repository.lockLiveByPublicId).toHaveBeenCalledWith({
        organizationId: 7,
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
      });
    });

    it('answers 404 contact_not_found when there is no live contact, running no step', async () => {
      repository.lockLiveByPublicId.mockResolvedValue(null);
      const step = vi.fn();
      erasureSteps.push(step);

      const error = await service
        .deleteContact({ scope, contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).reason).toBe('contact_not_found');
      expect(step).not.toHaveBeenCalled();
      expect(repository.erase).not.toHaveBeenCalled();
    });

    it('answers 422 on a personal organization before any read (CT3)', async () => {
      organization.type = 'PERSONAL';

      await expect(
        service.deleteContact({ scope, contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityError);
      expect(repository.lockLiveByPublicId).not.toHaveBeenCalled();
    });
  });

  describe('the worker operations (3.A.10)', () => {
    const key = { databaseHandle, organizationId: 7, contactId: 41 };

    it('recordContactInteraction trims the username, drops an empty one and flags DMs', async () => {
      workerRepository.upsertInteraction.mockResolvedValue({
        contact: contactRow(),
        isInserted: true,
      });

      const result = await service.recordContactInteraction({
        databaseHandle,
        organizationId: 7,
        channelAccountId: 3,
        instagramUserId: '17841455500000001',
        username: '   ',
        occurredAt: now,
        interactionKind: 'story_reply',
      });

      expect(result.isNewContact).toBe(true);
      expect(workerRepository.upsertInteraction).toHaveBeenCalledWith({
        organizationId: 7,
        channelAccountId: 3,
        instagramUserId: '17841455500000001',
        username: null,
        occurredAt: now,
        isDirectMessage: true,
      });
    });

    it('recordContactProfile keeps a username out unless given and drops a non-https picture', async () => {
      workerRepository.updateProfile.mockResolvedValue(contactRow());

      await service.recordContactProfile({
        ...key,
        profile: {
          username: null,
          fullName: ' Jordan Lee ',
          profilePictureUrl: 'http://cdn.example.com/p.jpg',
          followersCount: -3,
          isFollowingAccount: true,
        },
        checkedAt: now,
      });

      expect(workerRepository.updateProfile).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
        values: {
          full_name: 'Jordan Lee',
          profile_picture_url: null,
          followers_count: null,
          is_following_account: true,
          follow_checked_at: now,
        },
      });
    });

    it('recordContactProfile with nothing given only reads the live contact', async () => {
      workerRepository.findLiveById.mockResolvedValue(contactRow());

      await service.recordContactProfile({ ...key, profile: {}, checkedAt: now });

      expect(workerRepository.updateProfile).not.toHaveBeenCalled();
      expect(workerRepository.findLiveById).toHaveBeenCalledWith({
        organizationId: 7,
        contactId: 41,
      });
    });

    it('recordContactEmail answers null for an erased contact before it validates', async () => {
      workerRepository.findLiveById.mockResolvedValue(null);

      expect(
        await service.recordContactEmail({ ...key, email: 'not an email', collectedAt: now }),
      ).toBeNull();
      expect(workerRepository.recordEmail).not.toHaveBeenCalled();
    });

    it('recordContactPhone answers invalid and writes nothing for a bad number', async () => {
      workerRepository.findLiveById.mockResolvedValue(contactRow());

      expect(await service.recordContactPhone({ ...key, phone: '123', collectedAt: now })).toEqual({
        outcome: 'invalid',
      });
      expect(workerRepository.recordPhone).not.toHaveBeenCalled();
    });

    it('addContactTags logs the dropped count only — never the tags — and writes nothing new', async () => {
      const heldTags = Array.from({ length: 50 }, (_, index) => `held${index}`);
      workerRepository.findLiveById.mockResolvedValue(contactRow({ tags: heldTags }));

      const result = await service.addContactTags({ ...key, tags: ['secret-campaign'] });

      expect(result?.tags).toEqual(heldTags);
      expect(workerRepository.replaceTags).not.toHaveBeenCalled();
      expect(workerRepository.applyTagCountDeltas).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        { contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c', droppedTagCount: 1 },
        'app.contact.tags_dropped_over_limit',
      );
    });
  });

  it('addContactTags moves the counts and records automation events for the added tags', async () => {
    workerRepository.findLiveById.mockResolvedValue(contactRow({ tags: ['vip'] }));
    workerRepository.replaceTags.mockResolvedValue(contactRow({ tags: ['vip', 'lead'] }));

    await service.addContactTags({
      databaseHandle,
      organizationId: 7,
      contactId: 41,
      tags: ['vip', 'lead'],
      sourceAutomationId: 17,
    });

    expect(workerRepository.applyTagCountDeltas).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: 3,
      deltas: [{ tag: 'lead', delta: 1 }],
    });
    expect(tagEventRecorder.recordContactTagEvents).toHaveBeenCalledWith({
      events: [
        expect.objectContaining({
          tag: 'lead',
          kind: 'added',
          source: 'automation',
          sourceAutomationId: 17,
        }),
      ],
      databaseHandle,
    });
  });

  it('recordContactOptOut sets it and runs every pause step with opted_out on the job handle (CT6)', async () => {
    workerRepository.setOptedOut.mockResolvedValue(contactRow({ opted_out_at: now }));
    const step = vi.fn();
    pauseSteps.push(step);

    await service.recordContactOptOut({
      databaseHandle,
      organizationId: 7,
      contactId: 41,
      optedOutAt: now,
    });

    expect(workerRepository.setOptedOut).toHaveBeenCalledWith({
      organizationId: 7,
      contactId: 41,
      at: now,
    });
    expect(step).toHaveBeenCalledWith({
      organizationId: 7,
      contactId: 41,
      reason: 'opted_out',
      databaseHandle,
    });
  });
});
