import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every override read and write runs in the target organization's context; a unit test has no
// database, so the wrapper runs the callback inline and records the scope it was handed.
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ scope: _scope, callback }: { scope: unknown; callback: () => Promise<unknown> }) =>
        callback(),
    ),
  };
});

import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { EntitlementOverrideRepository } from '@/domains/billing/sub-domains/entitlement/entitlement-override.repository.js';
import type { OrganizationEntitlementOverrideRow } from '@/domains/billing/sub-domains/entitlement/entitlement-override.schema.js';
import {
  type EntitlementOrganizationService,
  type EntitlementPlanAccessService,
  EntitlementService,
} from '@/domains/billing/sub-domains/entitlement/entitlement.service.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import type { PlanAccess } from '@/domains/billing/sub-domains/subscription/subscription.types.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ADMIN_USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';
const OVERRIDE_PUBLIC_ID = 'ovr_a1b2c3d4e5f6g7h8i9j0k';
const ORGANIZATION_ID = 3;
const ADMIN_USER_ID = 11;

function planAccess(values: Partial<PlanAccess> = {}): PlanAccess {
  return {
    state: 'active',
    graceEndsAt: null,
    trialEndsAt: null,
    plan: { publicId: 'pln_creator', name: 'Creator' },
    features: CREATOR_PLAN_FEATURES,
    seatLimit: null,
    defaultedKeys: [],
    overrides: [],
    isPlanChoiceRequired: false,
    ...values,
  };
}

/** Creator's features with `channel_accounts_max` overridden. */
function withChannelAccounts(channelAccountsMax: number): PlanAccess {
  return planAccess({
    features: { ...CREATOR_PLAN_FEATURES, channel_accounts_max: channelAccountsMax },
  });
}

function overrideRow(
  values: Partial<OrganizationEntitlementOverrideRow> = {},
): OrganizationEntitlementOverrideRow {
  return {
    id: 7,
    public_id: OVERRIDE_PUBLIC_ID,
    organization_id: ORGANIZATION_ID,
    key: 'channel_accounts_max',
    value: 5,
    expires_at: null,
    reason: 'Support deal',
    created_by_user_id: ADMIN_USER_ID,
    updated_by_user_id: ADMIN_USER_ID,
    deleted_at: null,
    created_at: new Date('2026-11-20T00:00:00.000Z'),
    updated_at: new Date('2026-11-21T00:00:00.000Z'),
    ...values,
  };
}

function setup() {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue({ id: ORGANIZATION_ID }),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(ADMIN_USER_ID),
  };
  const overrideRepository = {
    listLive: vi.fn().mockResolvedValue([]),
    findLiveByKeyForUpdate: vi.fn().mockResolvedValue(null),
    insert: vi.fn(),
    update: vi.fn(),
    softDeleteByPublicId: vi.fn(),
    resolveOrganizationPublicId: vi.fn().mockResolvedValue(ORGANIZATION_PUBLIC_ID),
  };
  const planAccessService = {
    getPlanAccess: vi.fn().mockResolvedValue(planAccess()),
    emitPlanStateChanged: vi.fn().mockResolvedValue(undefined),
  };
  const membershipSeatUsage = { countActiveMembers: vi.fn().mockResolvedValue(4) };
  const service = new EntitlementService({
    organizationService: organizationService as unknown as EntitlementOrganizationService,
    overrideRepository: overrideRepository as unknown as EntitlementOverrideRepository,
    planAccessService: planAccessService as unknown as EntitlementPlanAccessService,
    membershipSeatUsage,
  });
  return {
    service,
    organizationService,
    overrideRepository,
    planAccessService,
    membershipSeatUsage,
  };
}

const setInput = {
  organization_id: ORGANIZATION_PUBLIC_ID,
  key: 'channel_accounts_max' as const,
  value: 7,
  reason: 'Support deal',
};

describe('EntitlementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolve — one plan read, a source per key (change-plan-gates EN2)', () => {
    it('reads the plan access exactly once and names each value source', async () => {
      const { service, planAccessService } = setup();
      planAccessService.getPlanAccess.mockResolvedValue(
        planAccess({
          state: 'grace',
          graceEndsAt: new Date('2026-12-10T00:00:00.000Z'),
          trialEndsAt: null,
          seatLimit: 5,
          features: {
            ...CREATOR_PLAN_FEATURES,
            channel_accounts_max: 9,
            feature_switches: { ...CREATOR_PLAN_FEATURES.feature_switches, mark_seen: false },
          },
          defaultedKeys: ['mark_seen'],
          overrides: [{ key: 'channel_accounts_max', value: 9, expiresAt: null }],
        }),
      );

      const snapshot = await service.resolve({ organizationPublicId: ORGANIZATION_PUBLIC_ID });

      expect(planAccessService.getPlanAccess).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      });
      expect(snapshot).toMatchObject({
        state: 'grace',
        graceEndsAt: new Date('2026-12-10T00:00:00.000Z'),
        trialEndsAt: null,
        plan: { publicId: 'pln_creator', name: 'Creator' },
      });
      expect(snapshot.values.channel_accounts_max).toEqual({ value: 9, source: 'override' });
      expect(snapshot.values.mark_seen).toEqual({ value: false, source: 'default' });
      expect(snapshot.values.broadcasts).toEqual({ value: true, source: 'plan' });
      expect(snapshot.values.seats).toEqual({ value: 5, source: 'plan' });
    });
  });

  describe('getEntitlements — the plan read, the usage port and the seats (P271)', () => {
    const scope = {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
    } as unknown as OrganizationPrincipalDatabaseScope;

    it('composes the plan access, the wired usage and the member count', async () => {
      const { service, planAccessService, membershipSeatUsage } = setup();
      planAccessService.getPlanAccess.mockResolvedValue(
        planAccess({
          state: 'grace',
          graceEndsAt: new Date('2026-12-10T00:00:00.000Z'),
          seatLimit: 5,
          overrides: [{ key: 'broadcasts', value: true, expiresAt: null }],
        }),
      );
      const readPlanUsage = vi.fn().mockResolvedValue({
        directMessagesUsed: 120,
        directMessagesResetsOn: '2026-12-01',
        channelAccountsUsed: 2,
      });
      service.wirePlanUsage({ readPlanUsage });

      const entitlements = await service.getEntitlements({ scope });

      expect(planAccessService.getPlanAccess).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      });
      expect(readPlanUsage).toHaveBeenCalledExactlyOnceWith({ scope });
      expect(membershipSeatUsage.countActiveMembers).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
      });
      expect(entitlements).toMatchObject({
        state: 'grace',
        plan: { id: 'pln_creator', name: 'Creator' },
        limits: {
          direct_messages: {
            used: 120,
            limit: CREATOR_PLAN_FEATURES.message_month_limit,
            resets_on: '2026-12-01',
          },
          channel_accounts: { used: 2, limit: CREATOR_PLAN_FEATURES.channel_accounts_max },
          seats: { used: 4, limit: 5 },
        },
        grace_ends_at: '2026-12-10T00:00:00.000Z',
        overrides: [{ key: 'broadcasts', expires_at: null }],
        sources: { broadcasts: 'override', segments: 'plan', seats: 'plan' },
      });
    });

    it('reads nothing used while the usage port is unwired, and logs it', async () => {
      const { service } = setup();
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const entitlements = await service.getEntitlements({ scope });

      expect(warn).toHaveBeenCalledWith(
        { organizationPublicId: ORGANIZATION_PUBLIC_ID },
        'entitlement.plan_usage.port_unwired',
      );
      expect(entitlements.limits.direct_messages).toMatchObject({
        used: 0,
        resets_on: '1970-02-01',
      });
      expect(entitlements.limits.channel_accounts.used).toBe(0);
      warn.mockRestore();
    });

    it('counts zero seats without a membership port', async () => {
      const { overrideRepository, organizationService, planAccessService } = setup();
      const service = new EntitlementService({
        organizationService: organizationService as unknown as EntitlementOrganizationService,
        overrideRepository: overrideRepository as unknown as EntitlementOverrideRepository,
        planAccessService: planAccessService as unknown as EntitlementPlanAccessService,
      });
      service.wirePlanUsage({
        readPlanUsage: vi.fn().mockResolvedValue({
          directMessagesUsed: 0,
          directMessagesResetsOn: '2026-12-01',
          channelAccountsUsed: 0,
        }),
      });

      const entitlements = await service.getEntitlements({ scope });

      expect(entitlements.limits.seats).toEqual({ used: 0, limit: null });
    });
  });

  describe('listOverrides', () => {
    it("reads the organization's live overrides in its verified context and serializes them", async () => {
      const { service, overrideRepository, organizationService } = setup();
      overrideRepository.listLive.mockResolvedValue([
        overrideRow(),
        overrideRow({
          public_id: 'ovr_b1b2c3d4e5f6g7h8i9j0k',
          key: 'broadcasts',
          value: true,
          expires_at: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ]);

      const overrides = await service.listOverrides({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      expect(withAppDatabaseContext).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({
            organizationPublicId: ORGANIZATION_PUBLIC_ID,
            userPublicId: ADMIN_USER_PUBLIC_ID,
          }),
        }),
      );
      expect(organizationService.requireOrganizationByPublicId).toHaveBeenCalledWith(
        ORGANIZATION_PUBLIC_ID,
      );
      expect(overrideRepository.listLive).toHaveBeenCalledExactlyOnceWith(ORGANIZATION_ID);
      expect(overrides).toMatchObject([
        { id: OVERRIDE_PUBLIC_ID, organization_id: ORGANIZATION_PUBLIC_ID, is_active: true },
        { key: 'broadcasts', is_active: false, expires_at: '2020-01-01T00:00:00.000Z' },
      ]);
    });

    it('propagates the 404 of an unknown organization', async () => {
      const { service, organizationService, overrideRepository } = setup();
      organizationService.requireOrganizationByPublicId.mockRejectedValue(
        new NotFoundError('Organization'),
      );

      await expect(
        service.listOverrides({
          organizationPublicId: ORGANIZATION_PUBLIC_ID,
          actorUserPublicId: ADMIN_USER_PUBLIC_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(overrideRepository.listLive).not.toHaveBeenCalled();
    });
  });

  describe('setOverride', () => {
    it('inserts a new key with the actor and announces an upgrade when a limit went up', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      const before = planAccess();
      planAccessService.getPlanAccess
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(withChannelAccounts(7));
      overrideRepository.insert.mockResolvedValue(overrideRow({ value: 7 }));

      const change = await service.setOverride({
        input: { ...setInput, expires_at: '2027-01-01T00:00:00.000Z' },
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      expect(overrideRepository.findLiveByKeyForUpdate).toHaveBeenCalledExactlyOnceWith({
        organizationId: ORGANIZATION_ID,
        key: 'channel_accounts_max',
      });
      expect(overrideRepository.insert).toHaveBeenCalledExactlyOnceWith({
        organizationId: ORGANIZATION_ID,
        key: 'channel_accounts_max',
        values: {
          value: 7,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          reason: 'Support deal',
          actorUserId: ADMIN_USER_ID,
        },
      });
      expect(overrideRepository.update).not.toHaveBeenCalled();
      expect(planAccessService.emitPlanStateChanged).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        change: 'upgraded',
        previous: before,
      });
      expect(change.previous).toBeNull();
      expect(change.override).toMatchObject({
        id: OVERRIDE_PUBLIC_ID,
        organization_id: ORGANIZATION_PUBLIC_ID,
        value: 7,
      });
    });

    it('updates the live override in place, keeps what it replaced and announces a move down', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      const existing = overrideRow({ value: 9 });
      overrideRepository.findLiveByKeyForUpdate.mockResolvedValue(existing);
      overrideRepository.update.mockResolvedValue(overrideRow({ value: 2 }));
      planAccessService.getPlanAccess
        .mockResolvedValueOnce(withChannelAccounts(9))
        .mockResolvedValueOnce(withChannelAccounts(2));

      const change = await service.setOverride({
        input: { ...setInput, value: 2 },
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      expect(overrideRepository.update).toHaveBeenCalledExactlyOnceWith({
        id: existing.id,
        values: { value: 2, expiresAt: null, reason: 'Support deal', actorUserId: ADMIN_USER_ID },
      });
      expect(overrideRepository.insert).not.toHaveBeenCalled();
      expect(planAccessService.emitPlanStateChanged).toHaveBeenCalledWith(
        expect.objectContaining({ change: 'moved_down' }),
      );
      expect(change.override.value).toBe(2);
      expect(change.previous).toMatchObject({ id: OVERRIDE_PUBLIC_ID, value: 9 });
    });

    it('emits nothing when the features did not move', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      overrideRepository.insert.mockResolvedValue(overrideRow());

      await service.setOverride({ input: setInput, actorUserPublicId: ADMIN_USER_PUBLIC_ID });

      expect(planAccessService.getPlanAccess).toHaveBeenCalledTimes(2);
      expect(planAccessService.emitPlanStateChanged).not.toHaveBeenCalled();
    });

    it('is 409 entitlement_override_conflict when two sets of a new key race', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      overrideRepository.insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      const failure = service.setOverride({
        input: setInput,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      await expect(failure).rejects.toBeInstanceOf(ConflictError);
      await expect(failure).rejects.toMatchObject({ reason: 'entitlement_override_conflict' });
      expect(planAccessService.emitPlanStateChanged).not.toHaveBeenCalled();
    });

    it('propagates any other insert failure unchanged', async () => {
      const { service, overrideRepository } = setup();
      const failure = new Error('connection lost');
      overrideRepository.insert.mockRejectedValue(failure);

      await expect(
        service.setOverride({ input: setInput, actorUserPublicId: ADMIN_USER_PUBLIC_ID }),
      ).rejects.toBe(failure);
    });

    it('propagates the 404 of an unknown organization before any write', async () => {
      const { service, organizationService, overrideRepository } = setup();
      organizationService.requireOrganizationByPublicId.mockRejectedValue(
        new NotFoundError('Organization'),
      );

      await expect(
        service.setOverride({ input: setInput, actorUserPublicId: ADMIN_USER_PUBLIC_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(overrideRepository.insert).not.toHaveBeenCalled();
      expect(overrideRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('removeOverride', () => {
    it("soft-deletes in the override's organization and announces a move down", async () => {
      const { service, overrideRepository, planAccessService } = setup();
      const removedAt = new Date('2026-11-26T00:00:00.000Z');
      overrideRepository.softDeleteByPublicId.mockResolvedValue(
        overrideRow({ value: 9, deleted_at: removedAt }),
      );
      const before = withChannelAccounts(9);
      planAccessService.getPlanAccess
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(planAccess());

      const change = await service.removeOverride({
        entitlementOverridePublicId: OVERRIDE_PUBLIC_ID,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      expect(overrideRepository.resolveOrganizationPublicId).toHaveBeenCalledExactlyOnceWith(
        OVERRIDE_PUBLIC_ID,
      );
      expect(overrideRepository.softDeleteByPublicId).toHaveBeenCalledExactlyOnceWith({
        organizationId: ORGANIZATION_ID,
        publicId: OVERRIDE_PUBLIC_ID,
        actorUserId: ADMIN_USER_ID,
      });
      expect(planAccessService.emitPlanStateChanged).toHaveBeenCalledExactlyOnceWith({
        organizationPublicId: ORGANIZATION_PUBLIC_ID,
        change: 'moved_down',
        previous: before,
      });
      expect(change.override).toMatchObject({ id: OVERRIDE_PUBLIC_ID, value: 9, is_active: false });
      expect(change.previous).toEqual(change.override);
    });

    it('is 404 entitlement_override_not_found when the resolver knows no such override', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      overrideRepository.resolveOrganizationPublicId.mockResolvedValue(null);

      await expect(
        service.removeOverride({
          entitlementOverridePublicId: OVERRIDE_PUBLIC_ID,
          actorUserPublicId: ADMIN_USER_PUBLIC_ID,
        }),
      ).rejects.toMatchObject({ reason: 'entitlement_override_not_found' });
      expect(planAccessService.getPlanAccess).not.toHaveBeenCalled();
      expect(overrideRepository.softDeleteByPublicId).not.toHaveBeenCalled();
    });

    it('is 404 entitlement_override_not_found when it was already removed — nothing announced', async () => {
      const { service, overrideRepository, planAccessService } = setup();
      overrideRepository.softDeleteByPublicId.mockResolvedValue(null);

      const failure = service.removeOverride({
        entitlementOverridePublicId: OVERRIDE_PUBLIC_ID,
        actorUserPublicId: ADMIN_USER_PUBLIC_ID,
      });

      await expect(failure).rejects.toBeInstanceOf(NotFoundError);
      await expect(failure).rejects.toMatchObject({ reason: 'entitlement_override_not_found' });
      expect(planAccessService.getPlanAccess).toHaveBeenCalledTimes(1);
      expect(planAccessService.emitPlanStateChanged).not.toHaveBeenCalled();
    });
  });
});
