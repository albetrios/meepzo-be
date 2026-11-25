import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { BroadcastSegmentRepository } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import type { BroadcastRepository } from '@/domains/app/sub-domains/broadcast/broadcast.repository.js';
import type { BroadcastCaller } from '@/domains/app/sub-domains/broadcast/broadcast.types.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '@/shared/errors/index.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({}),
    ),
  };
});
// The serializer has its own unit test: here it hands back the row's public id and status.
vi.mock('@/domains/app/sub-domains/broadcast/broadcast.serializer.js', () => ({
  serializeBroadcast: vi.fn(
    ({ broadcast }: { broadcast: { public_id: string; status: string } }) => ({
      id: broadcast.public_id,
      status: broadcast.status,
      channel_account_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
    }),
  ),
}));

import { BroadcastService } from '@/domains/app/sub-domains/broadcast/broadcast.service.js';

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const BROADCAST_PUBLIC_ID = 'brc_aaaaaaaaaaaaaaaaaaaaa';
const caller: BroadcastCaller = {
  scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID }),
  userPublicId: 'usr_aaaaaaaaaaaaaaaaaaaaa',
};
const CONDITIONS = { op: 'and', items: [{ field: 'tags', match: 'any', values: ['vip'] }] };
const ACCOUNT = {
  id: 11,
  public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  channel: 'instagram',
  connection_status: 'connected',
  channel_connection_status: 'connected',
};

/** A draft broadcast view row, ready to send unless overridden. */
function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    public_id: BROADCAST_PUBLIC_ID,
    organization_id: 7,
    channel_account_id: 11,
    status: 'draft',
    messages: [{ kind: 'text', wait_minutes: 0, text: 'Hello' }],
    conditions: CONDITIONS,
    segment_id: null,
    segment_public_id: null,
    created_by_user_id: null,
    updated_at: new Date('2026-11-25T08:00:00.000Z'),
    updated_by_user_id: null,
    ...overrides,
  };
}

/**
 * The broadcasts' service with the repositories, the organization, the account read, the feature
 * check and the ports faked (routes-final § 7.A — BC1–BC11; AC-9.4, AC-9.7–AC-9.9): a personal
 * organization and a missing broadcast are refused, an account not yet connected lists nothing, the
 * send runs the `broadcasts` switch, the draft check, the connection and the month limit in that
 * order and queues the audience for `now` and the matched count for `when_chat_opens`, and the
 * delete, edit and cancel answer 409 off their status. Routes and the database side are
 * `broadcast.integration.test.ts`.
 */
describe('BroadcastService', () => {
  let broadcastRepository: Record<string, ReturnType<typeof vi.fn>>;
  let segmentRepository: Record<string, ReturnType<typeof vi.fn>>;
  let organization: { id: number; type: string };
  let account: typeof ACCOUNT | null;
  let featureCheck: ReturnType<typeof vi.fn>;
  let monthStop: string | null;
  let sendQueue: {
    enqueueBroadcastAudience: ReturnType<typeof vi.fn>;
    enqueueBroadcastMatchedCount: ReturnType<typeof vi.fn>;
  };
  let service: BroadcastService;

  beforeEach(() => {
    vi.clearAllMocks();
    organization = { id: 7, type: 'TEAM' };
    account = { ...ACCOUNT };
    monthStop = null;
    broadcastRepository = {
      list: vi.fn(),
      findLiveByPublicId: vi.fn(async () => draftRow()),
      findLiveView: vi.fn(async () => draftRow({ status: 'sending' })),
      markSent: vi.fn(async () => true),
      softDelete: vi.fn(async () => true),
      cancelByOwner: vi.fn(async () => true),
      updateDraft: vi.fn(async () => true),
      clearDraftSegment: vi.fn(async () => {}),
    };
    segmentRepository = { findLiveByPublicId: vi.fn(), findAccountAutomationIds: vi.fn() };
    featureCheck = vi.fn(async () => ({ isAllowed: true }));
    sendQueue = {
      enqueueBroadcastAudience: vi.fn(async () => {}),
      enqueueBroadcastMatchedCount: vi.fn(async () => {}),
    };
    service = new BroadcastService(
      broadcastRepository as unknown as BroadcastRepository,
      segmentRepository as unknown as BroadcastSegmentRepository,
      {
        requireOrganizationByPublicId: vi.fn(async () => organization),
        resolveUserInternalIdByPublicId: vi.fn(async () => 99),
        resolveUserPublicIdByInternalId: vi.fn(async () => null),
        resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map()),
      } as unknown as OrganizationService,
      vi.fn(async () => account) as never,
      featureCheck as never,
      {
        monthLimit: { readOrganizationPlanStop: vi.fn(async () => monthStop) },
        sendQueue,
      } as never,
    );
  });

  it('lists nothing for an account that is not connected, and a personal organization is refused', async () => {
    account = null;
    const query = { channelAccountPublicId: ACCOUNT.public_id, limit: 20 } as never;
    expect(await service.listBroadcasts({ scope: caller.scope, query })).toEqual({
      items: [],
      limit: 20,
      has_more: false,
      next_cursor: null,
      total: 0,
    });
    expect(broadcastRepository.list).not.toHaveBeenCalled();
    organization = { id: 7, type: 'PERSONAL' };
    await expect(service.listBroadcasts({ scope: caller.scope, query })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('a missing broadcast is 404 broadcast_not_found', async () => {
    broadcastRepository.findLiveByPublicId?.mockResolvedValueOnce(null);
    await expect(
      service.getBroadcast({ scope: caller.scope, broadcastPublicId: BROADCAST_PUBLIC_ID }),
    ).rejects.toMatchObject({ reason: 'broadcast_not_found' });
  });

  it('sends a complete draft now: marks it sending, then queues its audience', async () => {
    const sent = await service.sendBroadcast({
      caller,
      broadcastPublicId: BROADCAST_PUBLIC_ID,
      input: { mode: 'now' },
    });
    expect(sent).toMatchObject({ id: BROADCAST_PUBLIC_ID, status: 'sending' });
    expect(featureCheck).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccountId: 11, feature: 'broadcasts' }),
    );
    expect(broadcastRepository.markSent).toHaveBeenCalledWith(
      expect.objectContaining({
        broadcastId: 21,
        values: expect.objectContaining({ status: 'sending', mode: 'now', isStarted: true }),
        updatedByUserId: 99,
      }),
    );
    expect(sendQueue.enqueueBroadcastAudience).toHaveBeenCalledWith({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      broadcastPublicId: BROADCAST_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT.public_id,
    });
    expect(sendQueue.enqueueBroadcastMatchedCount).not.toHaveBeenCalled();
  });

  it('a when-chat-opens send ends after its wait days and queues the matched count', async () => {
    await service.sendBroadcast({
      caller,
      broadcastPublicId: BROADCAST_PUBLIC_ID,
      input: { mode: 'when_chat_opens', openWaitDays: 3 },
    });
    const [{ values }] = (broadcastRepository.markSent as ReturnType<typeof vi.fn>).mock
      .calls[0] as [{ values: { status: string; endsAt: Date } }];
    expect(values.status).toBe('waiting_for_chats');
    expect(values.endsAt.getTime() - Date.now()).toBeGreaterThan(3 * 24 * 60 * 60_000 - 60_000);
    expect(sendQueue.enqueueBroadcastMatchedCount).toHaveBeenCalledTimes(1);
    expect(sendQueue.enqueueBroadcastAudience).not.toHaveBeenCalled();
  });

  it("refuses a send the plan's switch, the status, the connection or the month refuses", async () => {
    const send = () =>
      service.sendBroadcast({
        caller,
        broadcastPublicId: BROADCAST_PUBLIC_ID,
        input: { mode: 'now' },
      });
    featureCheck.mockResolvedValueOnce({ isAllowed: false, reason: 'plan_lacks_feature' });
    await expect(send()).rejects.toBeInstanceOf(ForbiddenError);

    broadcastRepository.findLiveByPublicId?.mockResolvedValue(draftRow({ status: 'sending' }));
    await expect(send()).rejects.toMatchObject({ reason: 'transition_not_allowed' });
    broadcastRepository.findLiveByPublicId?.mockResolvedValue(draftRow());

    account = { ...ACCOUNT, channel_connection_status: 'error' };
    await expect(send()).rejects.toMatchObject({ reason: 'instagram_not_connected' });
    account = { ...ACCOUNT };

    monthStop = 'plan_limit';
    await expect(send()).rejects.toMatchObject({ reason: 'message_month_limit_reached' });
    expect(broadcastRepository.markSent).not.toHaveBeenCalled();
    expect(sendQueue.enqueueBroadcastAudience).not.toHaveBeenCalled();
  });

  it('a draft with no messages and no audience is 422 broadcast_incomplete with both problems', async () => {
    broadcastRepository.findLiveByPublicId?.mockResolvedValue(
      draftRow({ messages: [], conditions: null }),
    );
    const error = await service
      .sendBroadcast({ caller, broadcastPublicId: BROADCAST_PUBLIC_ID, input: { mode: 'now' } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableEntityError);
    expect(error).toMatchObject({ reason: 'broadcast_incomplete' });
  });

  it('only a draft is edited; a delete or cancel its status forbids is 409', async () => {
    broadcastRepository.findLiveByPublicId?.mockResolvedValue(draftRow({ status: 'sending' }));
    await expect(
      service.updateBroadcast({
        caller,
        broadcastPublicId: BROADCAST_PUBLIC_ID,
        input: { name: 'New' } as never,
      }),
    ).rejects.toMatchObject({ reason: 'broadcast_not_draft' });

    broadcastRepository.softDelete?.mockResolvedValueOnce(false);
    await expect(
      service.deleteBroadcast({ caller, broadcastPublicId: BROADCAST_PUBLIC_ID }),
    ).rejects.toBeInstanceOf(ConflictError);

    broadcastRepository.cancelByOwner?.mockResolvedValueOnce(false);
    await expect(
      service.cancelBroadcast({ caller, broadcastPublicId: BROADCAST_PUBLIC_ID }),
    ).rejects.toMatchObject({ reason: 'transition_not_allowed' });
  });

  it('an edit that changes nothing writes nothing; a change names its fields', async () => {
    const unchanged = await service.updateBroadcast({
      caller,
      broadcastPublicId: BROADCAST_PUBLIC_ID,
      input: { messages: draftRow().messages } as never,
    });
    expect(unchanged.changedFields).toEqual([]);
    expect(broadcastRepository.updateDraft).not.toHaveBeenCalled();

    const changed = await service.updateBroadcast({
      caller,
      broadcastPublicId: BROADCAST_PUBLIC_ID,
      input: { name: 'Spring drop' } as never,
    });
    expect(changed.changedFields).toEqual(['name']);
    expect(broadcastRepository.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ values: { name: 'Spring drop' }, updatedByUserId: 99 }),
    );
  });

  it("a segment delete clears it from the drafts that use it (BC17's draft step)", async () => {
    await service.clearDraftSegment({ organizationId: 7, segmentId: 4 });
    expect(broadcastRepository.clearDraftSegment).toHaveBeenCalledWith({
      organizationId: 7,
      segmentId: 4,
    });
  });
});
