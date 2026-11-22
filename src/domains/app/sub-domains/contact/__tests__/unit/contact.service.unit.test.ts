import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import type {
  ContactListRow,
  ContactRepository,
  ContactRow,
} from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type {
  ContactAutomationFilterResolver,
  ContactErasureStep,
  ContactListQuery,
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
 * The contact service's own decisions (routes-final § 2.10, CT3, CT6–CT10) with the repository
 * mocked: the list's default sort and order, the team-only guards, the erase's step order and its
 * `404`, and how each worker operation normalises before it writes. The database behaviour is in
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
    instagram_account_id: 3,
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
    first_seen_at: now,
    last_message_received_at: now,
    last_direct_message_received_at: null,
    last_message_sent_at: null,
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
  instagramAccountPublicId: undefined,
  automationPublicId: undefined,
};

describe('ContactService', () => {
  let organization: { id: number; type: string };
  let repository: {
    list: ReturnType<typeof vi.fn>;
    lockLiveByPublicId: ReturnType<typeof vi.fn>;
    erase: ReturnType<typeof vi.fn>;
  };
  let erasureSteps: ContactErasureStep[];
  let automationFilterResolver: ReturnType<typeof vi.fn> & ContactAutomationFilterResolver;
  let service: ContactService;

  beforeEach(() => {
    vi.clearAllMocks();
    organization = { id: 7, type: 'TEAM' };
    repository = { list: vi.fn(), lockLiveByPublicId: vi.fn(), erase: vi.fn() };
    erasureSteps = [];
    automationFilterResolver = vi.fn(async () => 52) as ReturnType<typeof vi.fn> &
      ContactAutomationFilterResolver;
    const organizationService = {
      requireOrganizationByPublicId: vi.fn(async () => organization),
    } as unknown as OrganizationService;
    service = new ContactService(
      repository as unknown as ContactRepository,
      organizationService,
      erasureSteps,
      automationFilterResolver,
    );
  });

  describe('listContacts (route 9)', () => {
    beforeEach(() => {
      repository.list.mockResolvedValue({
        items: [
          {
            ...contactRow(),
            instagram_account_public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
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
          instagram_account_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
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

  describe('deleteContact (route 10)', () => {
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

  describe('the worker operations (2.10)', () => {
    const key = { databaseHandle, organizationId: 7, contactId: 41 };

    it('recordContactInteraction trims the username, drops an empty one and flags DMs', async () => {
      workerRepository.upsertInteraction.mockResolvedValue({
        contact: contactRow(),
        isInserted: true,
      });

      const result = await service.recordContactInteraction({
        databaseHandle,
        organizationId: 7,
        instagramAccountId: 3,
        instagramUserId: '17841455500000001',
        username: '   ',
        occurredAt: now,
        interactionKind: 'story_reply',
      });

      expect(result.isNewContact).toBe(true);
      expect(workerRepository.upsertInteraction).toHaveBeenCalledWith({
        organizationId: 7,
        instagramAccountId: 3,
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
      expect(loggerWarn).toHaveBeenCalledWith(
        { contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c', droppedTagCount: 1 },
        'app.contact.tags_dropped_over_limit',
      );
    });
  });
});
