import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ForbiddenError, ServiceUnavailableError, ValidationError } from '@/shared/errors/index.js';
import type { BroadcastSegmentRepository } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import { BroadcastSegmentService } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.service.js';
import type {
  SegmentBackgroundCountPort,
  SegmentFeatureCheck,
} from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.types.js';
import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';

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

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ACCOUNT_PUBLIC_ID = 'cha_a1b2c3d4e5f6g7h8i9j0k';
const AUTOMATION_PUBLIC_ID = 'aut_a1b2c3d4e5f6g7h8i9j0k';
const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
const caller = { scope, userPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k' };
const conditions: SegmentConditions = { op: 'and', items: [{ field: 'details', has: 'email' }] };

/** A Postgres statement timeout as the driver throws it (57014), wrapped as Drizzle does. */
function statementTimeout(): Error {
  return Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    }),
  });
}

/**
 * The segment service's own decisions (routes-final § 7.B, BC12, BC14, BC19) with the repository
 * mocked: the `segments` switch before any write, an automation of another account, and the
 * count's timeout path — the background answer, or `503` until the background count is wired (R46).
 */
describe('BroadcastSegmentService', () => {
  let repository: {
    findChannelAccount: ReturnType<typeof vi.fn>;
    findAccountAutomationIds: ReturnType<typeof vi.fn>;
    countAudience: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let featureCheck: ReturnType<typeof vi.fn>;
  const organizationService = {
    requireOrganizationByPublicId: vi.fn(async () => ({ id: 7, type: 'TEAM' })),
    resolveUserInternalIdByPublicId: vi.fn(async () => 11),
    resolveUserPublicIdsByInternalIds: vi.fn(async () => new Map([[11, caller.userPublicId]])),
  } as unknown as OrganizationService;

  beforeEach(() => {
    repository = {
      findChannelAccount: vi.fn(async () => ({
        id: 3,
        public_id: ACCOUNT_PUBLIC_ID,
        channel: 'instagram',
      })),
      findAccountAutomationIds: vi.fn(async () => new Map()),
      countAudience: vi.fn(async () => ({
        matched: 5,
        canReceiveNow: 2,
        countedAt: new Date('2026-11-24T10:00:00.000Z'),
      })),
      insert: vi.fn(),
    };
    featureCheck = vi.fn(async () => ({ isAllowed: true }));
  });

  function service(backgroundCount?: SegmentBackgroundCountPort): BroadcastSegmentService {
    return new BroadcastSegmentService(
      repository as unknown as BroadcastSegmentRepository,
      organizationService,
      featureCheck as unknown as SegmentFeatureCheck,
      backgroundCount === undefined ? {} : { backgroundCount },
    );
  }

  it('refuses a save on a plan without segments before writing (BC19, AC-9.1)', async () => {
    featureCheck.mockResolvedValueOnce({ isAllowed: false, reason: 'plan_lacks_feature' });
    const refused = service().createSegment({
      caller,
      input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, name: 'VIPs', conditions },
    });
    await expect(refused).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused).rejects.toMatchObject({ reason: 'plan_lacks_feature' });
    expect(featureCheck).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 7, channelAccountId: 3, feature: 'segments' }),
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it("refuses an automation that is not the account's with 400 on conditions (BC12)", async () => {
    const refused = service().createSegment({
      caller,
      input: {
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        name: 'Ran it',
        conditions: {
          op: 'and',
          items: [{ field: 'automation', automation_id: AUTOMATION_PUBLIC_ID, state: 'started' }],
        },
      },
    });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('counts inline and answers the numbers (BC14)', async () => {
    const answer = await service().countAudience({
      caller,
      input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, conditions },
    });
    expect(answer).toEqual({
      matched: 5,
      can_receive_now: 2,
      is_counting: false,
      counted_at: '2026-11-24T10:00:00.000Z',
    });
  });

  it('a timed-out count answers 503 segment_count_unavailable while no background count is wired', async () => {
    repository.countAudience.mockRejectedValueOnce(statementTimeout());
    const refused = service().countAudience({
      caller,
      input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, conditions },
    });
    await expect(refused).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(refused).rejects.toMatchObject({ reason: 'segment_count_unavailable' });
  });

  it('a timed-out count asks the background count and answers is_counting (BC14, AC-9.3)', async () => {
    repository.countAudience.mockRejectedValueOnce(statementTimeout());
    const backgroundCount = { readCount: vi.fn(async () => null), requestCount: vi.fn() };
    const answer = await service(backgroundCount).countAudience({
      caller,
      input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, conditions },
    });
    expect(answer).toEqual({
      matched: null,
      can_receive_now: null,
      is_counting: true,
      counted_at: null,
    });
    expect(backgroundCount.requestCount).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        channelAccountPublicId: ACCOUNT_PUBLIC_ID,
        conditions,
      }),
    );
  });

  it("answers the background count's copy without counting again", async () => {
    const backgroundCount = {
      readCount: vi.fn(async () => ({
        matched: 9,
        canReceiveNow: 1,
        countedAt: new Date('2026-11-24T09:59:00.000Z'),
      })),
      requestCount: vi.fn(),
    };
    const answer = await service(backgroundCount).countAudience({
      caller,
      input: { channelAccountPublicId: ACCOUNT_PUBLIC_ID, conditions },
    });
    expect(answer.matched).toBe(9);
    expect(repository.countAudience).not.toHaveBeenCalled();
  });
});
