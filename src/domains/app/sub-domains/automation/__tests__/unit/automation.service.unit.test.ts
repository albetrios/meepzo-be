import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import type {
  AutomationRepository,
  AutomationRow,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import type {
  AutomationListQuery,
  AutomationOpenRunCancelStep,
} from '@/domains/app/sub-domains/automation/automation.types.js';

const { acquireLock } = vi.hoisted(() => ({ acquireLock: vi.fn() }));

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

vi.mock('@/infrastructure/database/resource-quota-lock.util.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, acquireResourceQuotaLock: acquireLock };
});

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The automation service's own decisions (routes-final § 3.A — AU3, AU8–AU12, AU15, AU27) with the
 * repository, the account service and the organization service mocked: the team-only guards, the
 * account at create and its `409`, the overlap `409` and its lock, the linked-window `409`, the
 * stale-save `409`, the delete's cancel steps, the list's default order and linking under the lock.
 * The SQL is in `automation.repository.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const TEAM = { id: 7, public_id: ORGANIZATION_PUBLIC_ID, type: 'TEAM' };
const PERSONAL = { ...TEAM, type: 'PERSONAL' };
const ACCOUNT = { id: 3, public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c' };
const DAY = 24 * 60 * 60 * 1000;
const FINAL_MESSAGE = { text: 'Here you go', links: [] };

function automationRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 17,
    public_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
    organization_id: TEAM.id,
    instagram_account_id: ACCOUNT.id,
    name: 'Comment for the link',
    status: 'inactive',
    trigger_type: 'comment',
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    next_post_starts_at: null,
    next_post_ends_at: null,
    next_post_status: null,
    next_post_linked_at: null,
    is_dm_keyword_trigger_enabled: true,
    keywords: ['link'],
    tags: [],
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_opening_message_enabled: true,
    opening_message: { text: 'Thanks!', button_title: 'Send it' },
    is_follow_required: false,
    follow_request_message: null,
    is_email_collection_enabled: false,
    email_request_message: null,
    is_phone_collection_enabled: false,
    phone_request_message: null,
    final_message: FINAL_MESSAGE,
    completed_run_count: 0,
    last_triggered_at: null,
    created_by_user_id: 5,
    updated_by_user_id: 5,
    deleted_at: null,
    delete_reason: null,
    delete_note: null,
    created_at: new Date('2026-11-21T08:00:00.000Z'),
    updated_at: new Date('2026-11-21T08:30:00.000Z'),
    ...overrides,
  };
}

function setup({
  organization = TEAM,
  account = ACCOUNT as { id: number; public_id: string } | null,
  cancelSteps = [] as AutomationOpenRunCancelStep[],
} = {}) {
  const repository = {
    list: vi.fn(async (_input: { query: { sort: string; order: string } }) => ({
      items: [],
      total: 0,
      limit: 25,
      has_more: false,
      next_cursor: null,
    })),
    findLiveByPublicId: vi.fn(),
    lockLiveByPublicId: vi.fn(),
    insert: vi.fn(async () => automationRow()),
    update: vi.fn(async () => automationRow()),
    softDelete: vi.fn(async () => automationRow({ deleted_at: new Date() })),
    findNextPostOverlap: vi.fn(async () => null),
    linkNextPost: vi.fn(async () => ['aut_m4q8x2k7p9r3t1v5a1b2c']),
  };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => organization),
    resolveUserInternalIdByPublicId: vi.fn(async () => 5),
    resolveUserPublicIdByInternalId: vi.fn(async () => 'usr_a1b2c3d4e5f6g7h8i9j0k'),
    resolveUserPublicIdsByInternalIds: vi.fn(
      async () => new Map([[5, 'usr_a1b2c3d4e5f6g7h8i9j0k']]),
    ),
  };
  const instagramAccountService = { findLiveAccount: vi.fn(async () => account) };
  const service = new AutomationService(
    repository as unknown as AutomationRepository,
    instagramAccountService as unknown as InstagramAccountService,
    organizationService as unknown as OrganizationService,
    cancelSteps,
  );
  return { service, repository, organizationService, instagramAccountService };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  acquireLock.mockReset();
});

describe('AutomationService.createAutomation (route 12)', () => {
  const changes = {
    name: 'Comment for the link',
    trigger_type: 'comment' as const,
    opening_message: { text: 'Thanks!', button_title: 'Send it' },
    final_message: FINAL_MESSAGE,
  };

  it('creates on the connected account, with the caller as creator (AU27)', async () => {
    const { service, repository } = setup();
    const automation = await service.createAutomation({
      scope,
      changes,
      createdByUserPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k',
    });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: TEAM.id,
        instagramAccountId: ACCOUNT.id,
        createdByUserId: 5,
        fields: expect.objectContaining({ status: 'inactive', next_post_status: null }),
      }),
    );
    expect(automation.instagram_account_id).toBe(ACCOUNT.public_id);
    expect(automation.created_by_user_id).toBe('usr_a1b2c3d4e5f6g7h8i9j0k');
    // Not live and waiting: no overlap check, no lock.
    expect(repository.findNextPostOverlap).not.toHaveBeenCalled();
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('answers 409 instagram_not_connected without a not-revoked account, after the body 400s', async () => {
    const { service, repository } = setup({ account: null });
    const error = await rejection(
      service.createAutomation({ scope, changes, createdByUserPublicId: undefined }),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).reason).toBe('instagram_not_connected');
    expect(repository.insert).not.toHaveBeenCalled();
    // A broken flow is a 400 before the account is even read.
    const invalid = setup({ account: null });
    expect(
      await rejection(
        invalid.service.createAutomation({
          scope,
          changes: { ...changes, opening_message: null },
          createdByUserPublicId: undefined,
        }),
      ),
    ).toBeInstanceOf(ValidationError);
    expect(invalid.instagramAccountService.findLiveAccount).not.toHaveBeenCalled();
  });

  it('refuses a personal organization with 422 (AU3)', async () => {
    const { service } = setup({ organization: PERSONAL });
    expect(
      await rejection(
        service.createAutomation({ scope, changes, createdByUserPublicId: undefined }),
      ),
    ).toBeInstanceOf(UnprocessableEntityError);
  });

  it('checks a live, waiting window under the lock and answers 409 next_post_window_overlap', async () => {
    const { service, repository } = setup();
    repository.findNextPostOverlap.mockResolvedValueOnce({
      public_id: 'aut_other0000000000000000',
      name: 'Giveaway',
      keywords: ['shop', 'link'],
      next_post_starts_at: new Date('2026-11-22T00:00:00.000Z'),
      next_post_ends_at: new Date('2026-11-25T00:00:00.000Z'),
    } as never);
    const startsAt = new Date(Date.now() + DAY).toISOString();
    const endsAt = new Date(Date.now() + 3 * DAY).toISOString();
    const error = await rejection(
      service.createAutomation({
        scope,
        changes: {
          ...changes,
          status: 'live',
          target_scope: 'next',
          keywords: ['link', 'shop'],
          next_post_starts_at: new Date(startsAt),
          next_post_ends_at: new Date(endsAt),
        },
        createdByUserPublicId: undefined,
      }),
    );
    expect(error).toBeInstanceOf(ConflictError);
    const conflict = error as ConflictError;
    expect(conflict.reason).toBe('next_post_window_overlap');
    expect(conflict.messageKey).toBe('errors:nextPostWindowOverlap');
    // The first shared keyword A→Z, the other automation's name and window in ISO 8601 UTC.
    expect(conflict.messageParams).toEqual({
      name: 'Giveaway',
      keyword: 'link',
      startsAt: '2026-11-22T00:00:00.000Z',
      endsAt: '2026-11-25T00:00:00.000Z',
    });
    expect(acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ key: TEAM.id, namespace: 0x41_4e_58_50 }),
    );
    expect(repository.findNextPostOverlap).toHaveBeenCalledWith(
      expect.objectContaining({ instagramAccountId: ACCOUNT.id, excludedAutomationId: null }),
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('uses the "any comment" wording when a side has no keywords', async () => {
    const { service, repository } = setup();
    repository.findNextPostOverlap.mockResolvedValueOnce({
      public_id: 'aut_other0000000000000000',
      name: 'Any comment',
      keywords: [],
      next_post_starts_at: new Date('2026-11-22T00:00:00.000Z'),
      next_post_ends_at: new Date('2026-11-25T00:00:00.000Z'),
    } as never);
    const error = (await rejection(
      service.createAutomation({
        scope,
        changes: {
          ...changes,
          status: 'live',
          target_scope: 'next',
          keywords: ['link'],
          next_post_starts_at: new Date(Date.now() + DAY),
          next_post_ends_at: new Date(Date.now() + 2 * DAY),
        },
        createdByUserPublicId: undefined,
      }),
    )) as ConflictError;
    expect(error.messageKey).toBe('errors:nextPostWindowOverlapAnyComment');
    expect(error.messageParams).not.toHaveProperty('keyword');
  });
});

describe('AutomationService.updateAutomation (route 14)', () => {
  const stored = () => ({ ...automationRow(), instagram_account_public_id: ACCOUNT.public_id });

  it('takes the lock, then the row, and writes the merged automation (AU8, AU27)', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce(stored());
    await service.updateAutomation({
      scope,
      automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      changes: { status: 'live' },
      expectedUpdatedAt: undefined,
      updatedByUserPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k',
    });
    expect(acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      repository.lockLiveByPublicId.mock.invocationCallOrder[0] as number,
    );
    expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: 17,
        updatedByUserId: 5,
        fields: expect.objectContaining({ status: 'live', keywords: ['link'] }),
      }),
    );
  });

  it('answers 404 automation_not_found for a missing, deleted or foreign automation', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce(null);
    const error = await rejection(
      service.updateAutomation({
        scope,
        automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
        changes: { name: 'X' },
        expectedUpdatedAt: undefined,
        updatedByUserPublicId: undefined,
      }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).reason).toBe('automation_not_found');
  });

  it('refuses a stale save with 409 record_changed (AU11)', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce(stored());
    const error = await rejection(
      service.updateAutomation({
        scope,
        automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
        changes: { name: 'X' },
        expectedUpdatedAt: '2026-11-21T08:00:00.000Z',
        updatedByUserPublicId: undefined,
      }),
    );
    expect((error as ConflictError).reason).toBe('record_changed');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses a changed window on a linked automation with 409 next_post_already_linked', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce({
      ...stored(),
      target_scope: 'next',
      target_instagram_media_id: '1801',
      next_post_starts_at: new Date('2026-11-18T00:00:00.000Z'),
      next_post_ends_at: new Date('2026-11-20T00:00:00.000Z'),
      next_post_status: 'linked',
      next_post_linked_at: new Date('2026-11-19T00:00:00.000Z'),
    });
    const error = await rejection(
      service.updateAutomation({
        scope,
        automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
        changes: { next_post_ends_at: new Date(Date.now() + DAY) },
        expectedUpdatedAt: undefined,
        updatedByUserPublicId: undefined,
      }),
    );
    expect((error as ConflictError).reason).toBe('next_post_already_linked');
  });

  it('runs the overlap check without the automation itself when it stays live and waiting', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce({
      ...stored(),
      status: 'live',
      target_scope: 'next',
      next_post_starts_at: new Date(Date.now() + DAY),
      next_post_ends_at: new Date(Date.now() + 3 * DAY),
      next_post_status: 'waiting',
    });
    await service.updateAutomation({
      scope,
      automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      changes: { keywords: ['shop'] },
      expectedUpdatedAt: undefined,
      updatedByUserPublicId: undefined,
    });
    expect(repository.findNextPostOverlap).toHaveBeenCalledWith(
      expect.objectContaining({ excludedAutomationId: 17, keywords: ['shop'] }),
    );
  });
});

describe('AutomationService.deleteAutomation (route 15, AU12)', () => {
  it('soft-deletes, runs every cancel step in the same unit of work and sums their counts', async () => {
    const first = vi.fn(async () => 2);
    const second = vi.fn(async () => 1);
    const { service, repository } = setup({ cancelSteps: [first, second] });
    repository.lockLiveByPublicId.mockResolvedValueOnce({
      ...automationRow(),
      instagram_account_public_id: ACCOUNT.public_id,
    });
    const result = await service.deleteAutomation({
      scope,
      automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      removal: { reason: 'other', note: 'Season over' },
      deletedByUserPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k',
    });
    expect(repository.softDelete).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'other', note: 'Season over', updatedByUserId: 5 }),
    );
    expect(first).toHaveBeenCalledWith({ organizationId: TEAM.id, automationId: 17 });
    expect(second).toHaveBeenCalledWith({ organizationId: TEAM.id, automationId: 17 });
    expect(result).toEqual({
      automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      cancelledRunCount: 3,
    });
  });

  it('answers 404 for a repeat and 422 on a personal organization', async () => {
    const { service, repository } = setup();
    repository.lockLiveByPublicId.mockResolvedValueOnce(null);
    expect(
      await rejection(
        service.deleteAutomation({
          scope,
          automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
          removal: { reason: 'mistake', note: null },
          deletedByUserPublicId: undefined,
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
    const personal = setup({ organization: PERSONAL });
    expect(
      await rejection(
        personal.service.deleteAutomation({
          scope,
          automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
          removal: { reason: 'mistake', note: null },
          deletedByUserPublicId: undefined,
        }),
      ),
    ).toBeInstanceOf(UnprocessableEntityError);
  });
});

describe('AutomationService reads (routes 11, 13)', () => {
  const query: AutomationListQuery = {
    limit: 25,
    after: undefined,
    q: undefined,
    sort: undefined,
    order: undefined,
    status: undefined,
    triggerType: undefined,
    targetScope: undefined,
    nextPostStatus: undefined,
    instagramAccountPublicId: undefined,
  };

  it('defaults to created_at newest first, name A→Z, the counters most first (AU13)', async () => {
    const { service, repository } = setup();
    await service.listAutomations({ scope, query });
    await service.listAutomations({ scope, query: { ...query, sort: 'name' } });
    await service.listAutomations({ scope, query: { ...query, sort: 'completed_run_count' } });
    await service.listAutomations({
      scope,
      query: { ...query, sort: 'last_triggered_at', order: 'asc' },
    });
    expect(repository.list.mock.calls.map(([call]) => [call.query.sort, call.query.order])).toEqual(
      [
        ['created_at', 'desc'],
        ['name', 'asc'],
        ['completed_run_count', 'desc'],
        ['last_triggered_at', 'asc'],
      ],
    );
  });

  it('answers 404 team_organization_required on a personal organization — never 422 (AU3)', async () => {
    const { service } = setup({ organization: PERSONAL });
    const error = await rejection(service.listAutomations({ scope, query }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).reason).toBe('team_organization_required');
  });

  it('reads one automation, or 404 automation_not_found', async () => {
    const { service, repository } = setup();
    repository.findLiveByPublicId.mockResolvedValueOnce({
      ...automationRow(),
      instagram_account_public_id: ACCOUNT.public_id,
    });
    const automation = await service.getAutomation({
      scope,
      automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c',
    });
    expect(automation.id).toBe('aut_m4q8x2k7p9r3t1v5a1b2c');
    repository.findLiveByPublicId.mockResolvedValueOnce(null);
    expect(
      await rejection(
        service.getAutomation({ scope, automationPublicId: 'aut_m4q8x2k7p9r3t1v5a1b2c' }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe('AutomationService.linkNextPostAutomations (AU15)', () => {
  it('takes the organization lock, then links in one statement', async () => {
    const { service, repository } = setup();
    const publishedAt = new Date('2026-11-21T10:00:00.000Z');
    const linked = await service.linkNextPostAutomations({
      scope,
      instagramAccountPublicId: ACCOUNT.public_id,
      instagramMediaId: '1801',
      publishedAt,
    });
    expect(linked).toEqual(['aut_m4q8x2k7p9r3t1v5a1b2c']);
    expect(acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      repository.linkNextPost.mock.invocationCallOrder[0] as number,
    );
    expect(repository.linkNextPost).toHaveBeenCalledWith({
      organizationId: TEAM.id,
      instagramAccountPublicId: ACCOUNT.public_id,
      instagramMediaId: '1801',
      publishedAt,
    });
  });
});
