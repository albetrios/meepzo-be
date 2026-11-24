import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSendingPorts } from '@/domains/app/app.channel-ports.js';
import type { ChannelAccountPlanAccessService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import {
  AUTOMATION_DUPLICATE_NAME_SUFFIX,
  AUTOMATION_NAME_MAX_LENGTH,
} from '@/domains/app/sub-domains/automation/automation.constants.js';
import type { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import type { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import type {
  AutomationRepository,
  AutomationWithAccountRow,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import {
  type AutomationChannelAccountPort,
  AutomationService,
} from '@/domains/app/sub-domains/automation/automation.service.js';
import type { AutomationListQuery } from '@/domains/app/sub-domains/automation/automation.types.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';

const { runEnqueueAfterCommit } = vi.hoisted(() => ({
  runEnqueueAfterCommit: vi.fn(async (enqueue: () => Promise<void>) => enqueue()),
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

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runEnqueueAfterCommit };
});

// The automation object's shape has its own test (`automation.serializer.unit.test.ts`).
vi.mock('@/domains/app/sub-domains/automation/automation.serializer.js', () => ({
  serializeAutomation: vi.fn(({ automation }: { automation: AutomationWithAccountRow }) => ({
    id: automation.public_id,
    name: automation.name,
    status: automation.status,
    ref_code: automation.ref_code,
    target_starts_at: automation.target_starts_at,
  })),
  serializeAutomationListRow: vi.fn(({ automation }: { automation: AutomationWithAccountRow }) => ({
    id: automation.public_id,
  })),
}));

/**
 * The automation service's own decisions (routes-final § 4.A — routes 27, 29, 31, 33–35; AU3,
 * AU10, AU14–AU17) with its repository, the count, organization, plan and channel-account services
 * and the later rows' ports faked: the team checks, an unknown account's empty page and the default
 * order, the pause's transitions and no-ops, the delete's cancel steps and the channel's
 * waiting-message cancel, what a duplicate copies, and route 35's answer. Go-live and the saves are
 * in the integration test; the SQL in `automation.repository.db.unit.test.ts`.
 */

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const ORGANIZATION_ID = 7;
const CREATED_AT = new Date('2026-11-20T09:00:00.000Z');
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.VERIFIED({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});

function automationRow(
  overrides: Partial<AutomationWithAccountRow> = {},
): AutomationWithAccountRow {
  return {
    id: 11,
    public_id: 'aut_a1b2c3d4e5f6g7h8i9j0k',
    organization_id: ORGANIZATION_ID,
    channel_account_id: 5,
    channel_account_public_id: ACCOUNT_PUBLIC_ID,
    channel: 'instagram',
    name: 'Guide',
    status: 'live',
    trigger_type: 'comment',
    also_start_from: [],
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    target_starts_at: null,
    target_ends_at: null,
    next_post_status: null,
    next_post_linked_at: null,
    keywords: ['guide'],
    ref_code: null,
    starter_questions: [],
    ad_id: null,
    trigger_tag: null,
    default_reply_mode: null,
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_public_reply_mention_enabled: true,
    is_reply_like_person_enabled: false,
    public_reply_hour_limit: null,
    is_hide_comment_after_direct_message_enabled: false,
    steps: { messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }] },
    stopped_reason: null,
    stopped_at: null,
    cancelled_before_at: null,
    last_triggered_at: null,
    created_by_user_id: null,
    updated_by_user_id: null,
    deleted_at: null,
    delete_reason: null,
    delete_note: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  } as AutomationWithAccountRow;
}

function listQuery(overrides: Partial<AutomationListQuery> = {}): AutomationListQuery {
  return {
    limit: 20,
    after: undefined,
    q: undefined,
    sort: undefined,
    order: undefined,
    channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    statuses: [],
    triggerTypes: [],
    ...overrides,
  };
}

function setup({
  organizationType = 'TEAM',
  stored = automationRow() as AutomationWithAccountRow | null,
  liveOfAccount = [] as AutomationWithAccountRow[],
  cancelSteps = [] as Array<() => Promise<number>>,
  withSendingPort = false,
  withStarterSync = false,
}: {
  organizationType?: 'TEAM' | 'PERSONAL';
  stored?: AutomationWithAccountRow | null;
  liveOfAccount?: AutomationWithAccountRow[];
  cancelSteps?: Array<() => Promise<number>>;
  withSendingPort?: boolean;
  withStarterSync?: boolean;
} = {}) {
  const automationRepository = {
    countLiveOfAccount: vi.fn(async () => ({ channelAccountId: 5 as number | null, liveCount: 3 })),
    list: vi.fn(async (_input: { query: Record<string, unknown> }) => ({
      items: [automationRow()],
      limit: 20,
      has_more: false,
      next_cursor: null,
    })),
    findLiveByPublicId: vi.fn(async () => stored),
    lockLiveByPublicId: vi.fn(async () => stored),
    changeState: vi.fn(async () => (stored === null ? null : { ...stored, status: 'paused' })),
    softDelete: vi.fn(async () => stored),
    insert: vi.fn(async ({ fields }: { fields: Record<string, unknown> }) => ({
      ...automationRow({ id: 12, public_id: 'aut_copy0000000000000000', status: 'draft' }),
      ...fields,
    })),
    listLiveOfAccount: vi.fn(async () => liveOfAccount),
    findByPublicIdIncludingDeleted: vi.fn(async () => stored),
  };
  const countService = {
    readCounts: vi.fn(async () => new Map()),
    readAccountRunsStarted: vi.fn(async () => 42),
  };
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({
      id: ORGANIZATION_ID,
      public_id: ORGANIZATION_PUBLIC_ID,
      type: organizationType,
    })),
    resolveUserInternalIdByPublicId: vi.fn(async () => 41),
    resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map<number, string>()),
  };
  const planAccessService = { getPlanAccess: vi.fn(async () => ({ features: null })) };
  const channelAccountPort = { readAutomationAccount: vi.fn(async () => null) };
  const cancelWaitingMessages = vi.fn(async () => 0);
  const enqueueStarterQuestionSync = vi.fn(async () => undefined);
  const service = new AutomationService(
    automationRepository as unknown as AutomationRepository,
    countService as unknown as AutomationCountService,
    {} as AutomationReplyStateService,
    channelAccountPort as unknown as AutomationChannelAccountPort,
    planAccessService as unknown as ChannelAccountPlanAccessService,
    organizationService as unknown as OrganizationService,
    cancelSteps,
    {
      ...(withSendingPort
        ? {
            sendingPorts: {
              instagram: { cancelWaitingMessages },
            } as unknown as ChannelSendingPorts,
          }
        : {}),
      ...(withStarterSync ? { starterQuestionSync: { enqueueStarterQuestionSync } } : {}),
    },
  );
  return {
    service,
    automationRepository,
    countService,
    cancelWaitingMessages,
    enqueueStarterQuestionSync,
  };
}

const AUTOMATION_PUBLIC_ID = automationRow().public_id;

beforeEach(() => {
  runEnqueueAfterCommit.mockClear();
});

describe('AutomationService.listAutomations (route 27)', () => {
  it("answers an empty page with zero totals for an account that isn't the organization's", async () => {
    const { service, automationRepository } = setup();
    automationRepository.countLiveOfAccount.mockResolvedValueOnce({
      channelAccountId: null,
      liveCount: 0,
    });

    await expect(service.listAutomations({ scope, query: listQuery() })).resolves.toEqual({
      items: [],
      limit: 20,
      has_more: false,
      next_cursor: null,
      totals: { live_count: 0, runs_started: 0 },
    });
    expect(automationRepository.list).not.toHaveBeenCalled();
  });

  it('sorts newest first by default, and A→Z by name', async () => {
    const { service, automationRepository } = setup();

    await service.listAutomations({ scope, query: listQuery() });
    await service.listAutomations({ scope, query: listQuery({ sort: 'name' }) });

    expect(automationRepository.list.mock.calls.map(([input]) => input.query)).toEqual([
      expect.objectContaining({ sort: 'created_at', order: 'desc' }),
      expect.objectContaining({ sort: 'name', order: 'asc' }),
    ]);
  });

  it("totals the account's live count and all-time runs", async () => {
    const { service } = setup();

    const page = await service.listAutomations({ scope, query: listQuery() });

    expect(page.totals).toEqual({ live_count: 3, runs_started: 42 });
    expect(page.items).toEqual([{ id: AUTOMATION_PUBLIC_ID }]);
  });

  it('answers 404 team_organization_required to a personal organization', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    await expect(service.listAutomations({ scope, query: listQuery() })).rejects.toMatchObject({
      reason: 'team_organization_required',
    });
  });
});

describe('AutomationService.getAutomation (route 29)', () => {
  it('answers 404 automation_not_found for an absent or deleted automation', async () => {
    const { service } = setup({ stored: null });

    const failure = service.getAutomation({ scope, automationPublicId: AUTOMATION_PUBLIC_ID });

    await expect(failure).rejects.toBeInstanceOf(NotFoundError);
    await expect(failure).rejects.toMatchObject({ reason: 'automation_not_found' });
  });
});

describe('AutomationService.pauseAutomation (route 33)', () => {
  const pause = (mode: 'keep' | 'cancel') => ({
    scope,
    automationPublicId: AUTOMATION_PUBLIC_ID,
    mode,
    actingUserPublicId: USER_PUBLIC_ID,
  });

  it('answers 409 transition_not_allowed for a draft', async () => {
    const { service } = setup({ stored: automationRow({ status: 'draft' }) });

    const failure = service.pauseAutomation(pause('keep'));

    await expect(failure).rejects.toBeInstanceOf(ConflictError);
    await expect(failure).rejects.toMatchObject({ reason: 'transition_not_allowed' });
  });

  it.each(['keep', 'cancel'] as const)('pauses a live automation with mode %s', async (mode) => {
    const { service, automationRepository } = setup();

    const result = await service.pauseAutomation(pause(mode));

    expect(automationRepository.changeState).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      automationId: 11,
      change: { status: 'paused', isCancelledBeforeNow: mode === 'cancel' },
      updatedByUserId: 41,
    });
    expect(result.isChanged).toBe(true);
    expect(result.automation).toMatchObject({ status: 'paused' });
  });

  it('is a no-op for a paused automation with keep', async () => {
    const { service, automationRepository } = setup({
      stored: automationRow({ status: 'paused' }),
    });

    const result = await service.pauseAutomation(pause('keep'));

    expect(result.isChanged).toBe(false);
    expect(automationRepository.changeState).not.toHaveBeenCalled();
  });

  it('sets the cut-off when a kept pause is followed by cancel', async () => {
    const { service, automationRepository } = setup({
      stored: automationRow({ status: 'paused', cancelled_before_at: null }),
    });

    const result = await service.pauseAutomation(pause('cancel'));

    expect(result.isChanged).toBe(true);
    expect(automationRepository.changeState).toHaveBeenCalledWith(
      expect.objectContaining({ change: { status: 'paused', isCancelledBeforeNow: true } }),
    );
  });

  it('is a no-op for cancel when the waiting messages were already cancelled', async () => {
    const { service, automationRepository } = setup({
      stored: automationRow({ status: 'paused', cancelled_before_at: CREATED_AT }),
    });

    const result = await service.pauseAutomation(pause('cancel'));

    expect(result.isChanged).toBe(false);
    expect(automationRepository.changeState).not.toHaveBeenCalled();
  });

  it("enqueues the account's starter-question sync after commit when a live starter one pauses", async () => {
    const { service, enqueueStarterQuestionSync } = setup({
      stored: automationRow({ trigger_type: 'starter_question' }),
      withStarterSync: true,
    });

    await service.pauseAutomation(pause('keep'));

    expect(runEnqueueAfterCommit).toHaveBeenCalledTimes(1);
    expect(enqueueStarterQuestionSync).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    });
  });

  it('answers 422 to a personal organization', async () => {
    const { service } = setup({ organizationType: 'PERSONAL' });

    await expect(service.pauseAutomation(pause('keep'))).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
  });
});

describe('AutomationService.deleteAutomation (route 31)', () => {
  const deletion = {
    scope,
    automationPublicId: AUTOMATION_PUBLIC_ID,
    removal: { reason: null, note: null },
    deletedByUserPublicId: USER_PUBLIC_ID,
  };

  it('runs every open-run cancel step in order and sums the runs they cancelled', async () => {
    const order: string[] = [];
    const first = vi.fn(async () => {
      order.push('first');
      return 2;
    });
    const second = vi.fn(async () => {
      order.push('second');
      return 3;
    });
    const { service } = setup({ cancelSteps: [first, second] });

    const result = await service.deleteAutomation(deletion);

    expect(order).toEqual(['first', 'second']);
    expect(first).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID, automationId: 11 });
    expect(result).toEqual({ automationPublicId: AUTOMATION_PUBLIC_ID, cancelledRunCount: 5 });
  });

  it("cancels the channel's waiting messages when its sending port is wired", async () => {
    const { service, cancelWaitingMessages } = setup({ withSendingPort: true });

    await service.deleteAutomation(deletion);

    expect(cancelWaitingMessages).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      by: 'automation',
      id: 11,
      reason: 'automation_deleted',
    });
  });

  it('answers 404 and runs no step when a concurrent delete won', async () => {
    const step = vi.fn(async () => 1);
    const { service, automationRepository } = setup({ cancelSteps: [step] });
    automationRepository.softDelete.mockResolvedValueOnce(null);

    await expect(service.deleteAutomation(deletion)).rejects.toMatchObject({
      reason: 'automation_not_found',
    });
    expect(step).not.toHaveBeenCalled();
  });

  it('enqueues no starter-question sync for a deleted draft', async () => {
    const { service, enqueueStarterQuestionSync } = setup({
      stored: automationRow({ trigger_type: 'starter_question', status: 'draft' }),
      withStarterSync: true,
    });

    await service.deleteAutomation(deletion);

    expect(enqueueStarterQuestionSync).not.toHaveBeenCalled();
  });
});

describe('AutomationService.duplicateAutomation (route 34)', () => {
  const duplicate = {
    scope,
    automationPublicId: AUTOMATION_PUBLIC_ID,
    actingUserPublicId: USER_PUBLIC_ID,
  };

  it('copies onto the same account as "<name> (copy)", cutting a long name to fit', async () => {
    const longName = 'n'.repeat(AUTOMATION_NAME_MAX_LENGTH);
    const { service, automationRepository } = setup({ stored: automationRow({ name: longName }) });

    await service.duplicateAutomation(duplicate);

    const inserted = automationRepository.insert.mock.calls[0]?.[0] as unknown as {
      channelAccountId: number;
      createdByUserId: number;
      fields: { name: string; ref_code: string | null; keywords: string[] };
    };
    expect(inserted.channelAccountId).toBe(5);
    expect(inserted.createdByUserId).toBe(41);
    expect(inserted.fields.name).toHaveLength(AUTOMATION_NAME_MAX_LENGTH);
    expect(inserted.fields.name.endsWith(AUTOMATION_DUPLICATE_NAME_SUFFIX)).toBe(true);
    expect(inserted.fields.keywords).toEqual(['guide']);
    expect(inserted.fields.ref_code).toBeNull();
  });

  it('drops the next-post window and linked media of a "next post" automation', async () => {
    const { service, automationRepository } = setup({
      stored: automationRow({
        target_scope: 'next',
        target_starts_at: CREATED_AT,
        target_ends_at: CREATED_AT,
        target_instagram_media_id: '17900000000000001',
      }),
    });

    await service.duplicateAutomation(duplicate);

    expect(automationRepository.insert.mock.calls[0]?.[0]).toMatchObject({
      fields: {
        target_scope: 'next',
        target_starts_at: null,
        target_ends_at: null,
        target_instagram_media_id: null,
      },
    });
  });
});

describe('AutomationService.testAutomationKeyword (route 35)', () => {
  const keywordTest = (text: string) => ({
    scope,
    automationPublicId: AUTOMATION_PUBLIC_ID,
    text,
    source: undefined,
  });

  it('matches when this live automation answers first', async () => {
    const stored = automationRow();
    const { service } = setup({ stored, liveOfAccount: [stored] });

    await expect(service.testAutomationKeyword(keywordTest('send me the guide'))).resolves.toEqual({
      is_match: true,
      matched_keyword: 'guide',
      match_kind: 'exact',
      first_answering_automation: { id: AUTOMATION_PUBLIC_ID, name: 'Guide' },
      reason: null,
    });
  });

  it('names the older automation that would answer first', async () => {
    const stored = automationRow();
    const older = automationRow({ id: 3, public_id: 'aut_older000000000000000', name: 'Older' });
    const { service } = setup({ stored, liveOfAccount: [older, stored] });

    await expect(service.testAutomationKeyword(keywordTest('guide please'))).resolves.toMatchObject(
      {
        is_match: false,
        matched_keyword: 'guide',
        first_answering_automation: { id: 'aut_older000000000000000', name: 'Older' },
        reason: 'other_answers_first',
      },
    );
  });

  it('reports not_live for a paused automation whose keyword matches', async () => {
    const { service } = setup({ stored: automationRow({ status: 'paused' }) });

    await expect(service.testAutomationKeyword(keywordTest('guide'))).resolves.toMatchObject({
      is_match: false,
      matched_keyword: 'guide',
      first_answering_automation: null,
      reason: 'not_live',
    });
  });

  it('reports no_keyword when nothing matches', async () => {
    const stored = automationRow();
    const { service } = setup({ stored, liveOfAccount: [stored] });

    await expect(service.testAutomationKeyword(keywordTest('hello there'))).resolves.toMatchObject({
      is_match: false,
      matched_keyword: null,
      match_kind: null,
      reason: 'no_keyword',
    });
  });

  it('never matches a DM source against a comment automation', async () => {
    const stored = automationRow();
    const { service } = setup({ stored, liveOfAccount: [stored] });

    await expect(
      service.testAutomationKeyword({ ...keywordTest('guide'), source: 'dm' }),
    ).resolves.toMatchObject({ is_match: false, reason: 'no_keyword' });
  });
});

describe('AutomationService.findAutomationIdForFilter', () => {
  it("answers the automation's internal id, deleted ones included, or null", async () => {
    const found = setup({ stored: automationRow({ deleted_at: CREATED_AT }) });
    await expect(
      found.service.findAutomationIdForFilter({
        scope,
        organizationId: ORGANIZATION_ID,
        automationPublicId: AUTOMATION_PUBLIC_ID,
      }),
    ).resolves.toBe(11);

    const missing = setup({ stored: null });
    await expect(
      missing.service.findAutomationIdForFilter({
        scope,
        organizationId: ORGANIZATION_ID,
        automationPublicId: AUTOMATION_PUBLIC_ID,
      }),
    ).resolves.toBeNull();
  });
});
