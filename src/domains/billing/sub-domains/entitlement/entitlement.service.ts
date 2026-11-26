import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type {
  MembershipSeatUsagePort,
  SubscriptionService,
} from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { EntitlementOverrideRepository } from './entitlement-override.repository.js';
import type { OrganizationEntitlementOverrideRow } from './entitlement-override.schema.js';
import { entitlementOverridePlanChange } from './entitlement-override.util.js';
import { buildEntitlementSnapshot } from './entitlement-snapshot.util.js';
import type { SetEntitlementOverrideInput } from './entitlement.dto.js';
import { serializeEntitlementOverride, serializeEntitlements } from './entitlement.serializer.js';
import type {
  EntitlementOverrideOutput,
  EntitlementPlanUsage,
  EntitlementSnapshot,
  EntitlementsOutput,
} from './entitlement.types.js';

/**
 * The tenancy reads the entitlement service needs — structural, so a test can stub them.
 *
 * @remarks
 * Satisfied by `OrganizationService`; both reads run in the caller's organization context.
 */
export type EntitlementOrganizationService = Pick<
  OrganizationService,
  'requireOrganizationByPublicId' | 'resolveUserInternalIdByPublicId'
>;

/**
 * The billing reads and the plan-change event the entitlement service reuses (BL2, BL8, SE1).
 *
 * @remarks
 * Satisfied by `SubscriptionService` — the one plan read, its after-commit event and the locked
 * seat-ceiling read.
 */
export type EntitlementPlanAccessService = Pick<
  SubscriptionService,
  'getPlanAccess' | 'emitPlanStateChanged' | 'reserveSeatCeilingForMemberAdd'
>;

/**
 * What a set or a remove changed — the override now and, for the audit row, what it replaced.
 *
 * @remarks
 * Answered by {@link EntitlementService.setOverride} and {@link EntitlementService.removeOverride};
 * the controller audits from it.
 */
export interface EntitlementOverrideChange {
  override: EntitlementOverrideOutput;
  /** The live override the set replaced (`null` for a new key); on a remove, the removed one. */
  previous: EntitlementOverrideOutput | null;
}

/**
 * The app's report of an organization's plan usage (P271) — billing never reads app tables (8.10):
 * the app's sending service implements it and the composition root wires it
 * ({@link EntitlementService.wirePlanUsage}).
 *
 * @remarks
 * Read in the caller's organization scope (the signed `org` claim); a personal organization answers
 * zeros.
 */
export interface EntitlementPlanUsagePort {
  readPlanUsage(options: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<EntitlementPlanUsage>;
}

/** The usage read while no port is wired (a minimal harness): nothing used. */
const NO_PLAN_USAGE: EntitlementPlanUsage = {
  directMessagesUsed: 0,
  directMessagesResetsOn: '1970-02-01',
  channelAccountsUsed: 0,
};

/** `404 entitlement_override_not_found` — no live override with this id (absent or removed). */
function entitlementOverrideNotFoundError(): NotFoundError {
  return new NotFoundError('Entitlement override').withReason('entitlement_override_not_found');
}

/**
 * The entitlement module's service (change-plan-gates EN1–EN6): resolves an organization's
 * entitlement snapshot from the one plan read ({@link EntitlementService.resolve}), answers
 * `GET /billing/entitlements` from it, and keeps the per-organization plan overrides (plan-gating
 * close, P270) — the global admin lists, sets and removes an organization's exceptions to its plan;
 * the plan entitlement merges them in its one read (`resolvePlanAccess`, BL2).
 *
 * @remarks
 * - **Algorithm:** the admin names the target organization (or the override); every read and write
 *   runs in `withAppDatabaseContext` under `PRINCIPAL_SCOPE.VERIFIED` for that organization and the
 *   admin — the route's `requireRole(SUPER_ADMIN)` is the proof, and the remove finds the
 *   organization through the `SECURITY DEFINER` resolver. A set locks the key's live row and updates
 *   it in place, or inserts one. After the commit the entitlement is read again: when the features
 *   moved, `subscription.plan_state_changed` is emitted (BL8) with `upgraded` or `moved_down`
 *   ({@link entitlementOverridePlanChange}), so the app stops or frees accounts and steps as for a
 *   plan change.
 * - **Failure modes:** `404` (`errors:resources.Organization`) for an unknown organization; `404
 *   entitlement_override_not_found` on a remove of an absent or removed override; `409
 *   entitlement_override_conflict` when two sets of a new key race; a query failure propagates.
 * - **Side effects:** override rows; one plan-change event when the features moved. The audit row
 *   is the controller's (after the service returns, K9).
 */
export class EntitlementService {
  private readonly organizationService: EntitlementOrganizationService;
  private readonly overrideRepository: EntitlementOverrideRepository;
  private readonly planAccessService: EntitlementPlanAccessService;
  private readonly membershipSeatUsage: MembershipSeatUsagePort | undefined;
  private planUsage: EntitlementPlanUsagePort | undefined;

  constructor(dependencies: {
    organizationService: EntitlementOrganizationService;
    overrideRepository: EntitlementOverrideRepository;
    planAccessService: EntitlementPlanAccessService;
    /** Tenancy's member count (active + invited) — the seats used. */
    membershipSeatUsage?: MembershipSeatUsagePort | undefined;
  }) {
    this.organizationService = dependencies.organizationService;
    this.overrideRepository = dependencies.overrideRepository;
    this.planAccessService = dependencies.planAccessService;
    this.membershipSeatUsage = dependencies.membershipSeatUsage;
  }

  /** Wires the app's usage port (built after billing, so late — no container cycle, 8.10). */
  wirePlanUsage(port: EntitlementPlanUsagePort): void {
    this.planUsage = port;
  }

  /**
   * Reads an organization's seat ceiling under the subscription row lock for a member add
   * (change-plan-gates SE1) — the ceiling method of tenancy's seat port.
   *
   * @remarks
   * - **Algorithm:** delegates, unchanged, to {@link SubscriptionService.reserveSeatCeilingForMemberAdd}
   *   (the subscription row `FOR UPDATE`, then the plan's included seats, else Free's). A snapshot
   *   read would sit outside that lock, so a plan change could slip between the read and the insert;
   *   the delegation keeps the same lock, the same transaction and the same result.
   * - **Failure modes:** the subscription read's failures propagate; the caller MUST already hold an
   *   organization database context and transaction (membership's add, after its `MEMBERSHIP_SEAT`
   *   advisory lock).
   * - **Side effects:** the subscription row lock, released at the caller's COMMIT.
   * - **Notes:** `null` means no ceiling (every plan today, P26). Tenancy reaches billing's seat
   *   ceiling only through this module (K3); the port's Stripe seat sync stays with subscription.
   */
  async reserveSeatCeilingForMemberAdd(organizationId: number): Promise<number | null> {
    return this.planAccessService.reserveSeatCeilingForMemberAdd(organizationId);
  }

  /**
   * Resolves an organization's entitlement (change-plan-gates EN2, P19, P24): the plan state, its
   * dates, the plan and every registry key's `{ value, source }` — the snapshot `can`, `limit` and
   * the refusal builder read.
   *
   * @remarks
   * - **Algorithm:** exactly one plan read ({@link SubscriptionService.getPlanAccess}, BL2 — one SQL
   *   statement; the active overrides laid over the plan inside it), then the pure
   *   `buildEntitlementSnapshot`: each key's source is `override` (an active override set it) →
   *   `plan` (the plan row carried it) → `default` (the registry default filled a switch the row
   *   lacked); seats come from the same read's `seatLimit`.
   * - **Failure modes:** the plan read's failures propagate (a query failure; a plan row whose
   *   features the strict parse refuses, BL12).
   * - **Side effects:** none — read-only, no cache and no memo (BL2): a caller with several gates
   *   resolves once and passes the snapshot on (K2).
   * - **Notes:** `organizationPublicId` is one the caller has already proved (the signed `org` claim,
   *   or a verified target), as for `getPlanAccess`.
   */
  async resolve({
    organizationPublicId,
  }: {
    organizationPublicId: string;
  }): Promise<EntitlementSnapshot> {
    const planAccess = await this.planAccessService.getPlanAccess({ organizationPublicId });
    return buildEntitlementSnapshot({ planAccess });
  }

  /**
   * `GET /api/v1/billing/entitlements` (P271): the organization's plan state, plan, features after
   * overrides, each limit with its usage, the dates, the overrides in force and each value's source
   * (change-plan-gates EN6).
   *
   * @remarks
   * - **Algorithm:** one {@link EntitlementService.resolve} (billing's one plan read, BL2 — the
   *   overrides merged inside it), the app's usage port (this month's DMs, the accounts in the plan)
   *   and tenancy's member count, issued concurrently — none depends on another; the route
   *   serializes the same snapshot the gates read.
   * - **Failure modes:** a read failure propagates. An unwired port reads as nothing used (logged).
   * - **Side effects:** none (the app may populate its month-count cache).
   */
  async getEntitlements({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<EntitlementsOutput> {
    const organizationPublicId = scope.organizationPublicId;
    const [snapshot, usage, seatsUsed] = await Promise.all([
      this.resolve({ organizationPublicId }),
      this.readPlanUsage(scope),
      this.membershipSeatUsage?.countActiveMembers({ organizationPublicId }) ?? Promise.resolve(0),
    ]);
    return serializeEntitlements({ snapshot, usage, seats_used: seatsUsed });
  }

  private async readPlanUsage(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<EntitlementPlanUsage> {
    if (!this.planUsage) {
      logger.warn(
        { organizationPublicId: scope.organizationPublicId },
        'entitlement.plan_usage.port_unwired',
      );
      return NO_PLAN_USAGE;
    }
    return this.planUsage.readPlanUsage({ scope });
  }

  /**
   * The organization's live overrides, expired ones included with `is_active: false` (admin list).
   *
   * @remarks
   * Algorithm: one organization read and one override read in the organization's context.
   * Failure modes: `404` for an unknown organization. Side effects: none.
   */
  async listOverrides({
    organizationPublicId,
    actorUserPublicId,
  }: {
    organizationPublicId: string;
    actorUserPublicId: string;
  }): Promise<EntitlementOverrideOutput[]> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId, userPublicId: actorUserPublicId }),
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organizationPublicId);
        const rows = await this.overrideRepository.listLive(organization.id);
        const now = new Date(Date.now());
        return rows.map((row) =>
          serializeEntitlementOverride({ row, organization_public_id: organizationPublicId, now }),
        );
      },
    });
  }

  /**
   * Sets one key's override for the organization (admin set): replaces the live one in place, or
   * inserts it; then announces a features change (BL8).
   *
   * @remarks
   * Algorithm: as the class says. Failure modes: `404` for an unknown organization; `409
   * entitlement_override_conflict` on a lost race for a new key. Side effects: one override row; a
   * plan-change event when the features moved.
   */
  async setOverride({
    input,
    actorUserPublicId,
  }: {
    input: SetEntitlementOverrideInput;
    actorUserPublicId: string;
  }): Promise<EntitlementOverrideChange> {
    const organizationPublicId = input.organization_id;
    const previousAccess = await this.planAccessService.getPlanAccess({ organizationPublicId });
    const { row, replaced } = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId, userPublicId: actorUserPublicId }),
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organizationPublicId);
        const actorUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(actorUserPublicId);
        const values = {
          value: input.value,
          expiresAt: input.expires_at ? new Date(input.expires_at) : null,
          reason: input.reason,
          actorUserId,
        };
        const existing = await this.overrideRepository.findLiveByKeyForUpdate({
          organizationId: organization.id,
          key: input.key,
        });
        if (existing !== null) {
          return {
            row: await this.overrideRepository.update({ id: existing.id, values }),
            replaced: existing,
          };
        }
        try {
          return {
            row: await this.overrideRepository.insert({
              organizationId: organization.id,
              key: input.key,
              values,
            }),
            replaced: null,
          };
        } catch (error) {
          if (isPostgresUniqueViolation(error)) {
            throw new ConflictError('errors:entitlementOverrideConflict').withReason(
              'entitlement_override_conflict',
            );
          }
          throw error;
        }
      },
    });
    await this.announceFeaturesChange({ organizationPublicId, previousAccess });
    return this.toChange({ organizationPublicId, row, previous: replaced });
  }

  /**
   * Removes one override (admin remove): soft-deleted, then a features change announced (BL8).
   *
   * @remarks
   * Algorithm: the resolver names the override's organization; the soft delete runs in its
   * context. Failure modes: `404 entitlement_override_not_found`. Side effects: `deleted_at` on
   * the row; a plan-change event when the features moved.
   */
  async removeOverride({
    entitlementOverridePublicId,
    actorUserPublicId,
  }: {
    entitlementOverridePublicId: string;
    actorUserPublicId: string;
  }): Promise<EntitlementOverrideChange> {
    const organizationPublicId = await this.overrideRepository.resolveOrganizationPublicId(
      entitlementOverridePublicId,
    );
    if (organizationPublicId === null) throw entitlementOverrideNotFoundError();
    const previousAccess = await this.planAccessService.getPlanAccess({ organizationPublicId });
    const removed = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId, userPublicId: actorUserPublicId }),
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organizationPublicId);
        const actorUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(actorUserPublicId);
        return this.overrideRepository.softDeleteByPublicId({
          organizationId: organization.id,
          publicId: entitlementOverridePublicId,
          actorUserId,
        });
      },
    });
    if (removed === null) throw entitlementOverrideNotFoundError();
    await this.announceFeaturesChange({ organizationPublicId, previousAccess });
    const override = serializeEntitlementOverride({
      row: removed,
      organization_public_id: organizationPublicId,
      now: new Date(Date.now()),
    });
    return { override, previous: override };
  }

  /** After the commit: emits the plan-change event when the override moved the features (BL8). */
  private async announceFeaturesChange({
    organizationPublicId,
    previousAccess,
  }: {
    organizationPublicId: string;
    previousAccess: Awaited<ReturnType<EntitlementPlanAccessService['getPlanAccess']>>;
  }): Promise<void> {
    const currentAccess = await this.planAccessService.getPlanAccess({ organizationPublicId });
    const change = entitlementOverridePlanChange({
      previous: previousAccess.features,
      current: currentAccess.features,
    });
    if (change === null) return;
    await this.planAccessService.emitPlanStateChanged({
      organizationPublicId,
      change,
      previous: previousAccess,
    });
  }

  private toChange({
    organizationPublicId,
    row,
    previous,
  }: {
    organizationPublicId: string;
    row: OrganizationEntitlementOverrideRow;
    previous: OrganizationEntitlementOverrideRow | null;
  }): EntitlementOverrideChange {
    const now = new Date(Date.now());
    return {
      override: serializeEntitlementOverride({
        row,
        organization_public_id: organizationPublicId,
        now,
      }),
      previous:
        previous === null
          ? null
          : serializeEntitlementOverride({
              row: previous,
              organization_public_id: organizationPublicId,
              now,
            }),
    };
  }
}
