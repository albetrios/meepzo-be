import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { EntitlementOverrideRepository } from './entitlement-override.repository.js';
import type { OrganizationEntitlementOverrideRow } from './entitlement-override.schema.js';
import { entitlementOverridePlanChange } from './entitlement-override.util.js';
import type { SetEntitlementOverrideInput } from './entitlement.dto.js';
import { serializeEntitlementOverride } from './entitlement.serializer.js';
import type { EntitlementOverrideOutput } from './entitlement.types.js';

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
 * The billing reads and the plan-change event the entitlement service reuses (BL2, BL8).
 *
 * @remarks
 * Satisfied by `SubscriptionService` — the one plan read and its after-commit event.
 */
export type EntitlementPlanAccessService = Pick<
  SubscriptionService,
  'getPlanAccess' | 'emitPlanStateChanged'
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

/** `404 entitlement_override_not_found` — no live override with this id (absent or removed). */
function entitlementOverrideNotFoundError(): NotFoundError {
  return new NotFoundError('Entitlement override').withReason('entitlement_override_not_found');
}

/**
 * Per-organization plan overrides (plan-gating close, P270): the global admin lists, sets and
 * removes an organization's exceptions to its plan; the plan entitlement merges them in its one
 * read (`resolvePlanAccess`, BL2).
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

  constructor(dependencies: {
    organizationService: EntitlementOrganizationService;
    overrideRepository: EntitlementOverrideRepository;
    planAccessService: EntitlementPlanAccessService;
  }) {
    this.organizationService = dependencies.organizationService;
    this.overrideRepository = dependencies.overrideRepository;
    this.planAccessService = dependencies.planAccessService;
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
