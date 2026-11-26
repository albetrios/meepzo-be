import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  getContextFreeDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  databaseNowTimestamp,
  databaseUpdatedAtTimestamp,
} from '@/shared/utils/infrastructure/database-timestamp.util.js';
import {
  type OrganizationEntitlementOverrideRow,
  organization_entitlement_overrides,
} from './entitlement-override.schema.js';
import type { EntitlementOverrideKey } from './entitlement.constants.js';

/** What a set writes (P270): the key's new value, its end and why. */
export interface EntitlementOverrideWriteValues {
  value: boolean | number;
  expiresAt: Date | null;
  reason: string;
  /** The acting global admin's internal id; `null` when not resolvable. */
  actorUserId: number | null;
}

/**
 * Drizzle access to `billing.organization_entitlement_overrides` (plan-gating close, P270) for the
 * global admin's list, set and remove; the plan entitlement's merge read is
 * `SubscriptionRepository.findPlanAccessSubject` (one query, BL2).
 *
 * @remarks
 * - **Algorithm:** every query but the resolver runs in the caller's unit of work under the target
 *   organization's context (its RLS `USING` and `WITH CHECK`); the set locks the live row of the key
 *   (`FOR UPDATE`) and updates it in place, or inserts one — the partial unique index on
 *   `(organization_id, key) WHERE deleted_at IS NULL` is the final guard against two sets racing.
 * - **Failure modes:** a query failure propagates (a lost insert race surfaces as a unique
 *   violation the service maps to a conflict).
 * - **Side effects:** inserts and updates override rows; never hard-deletes (a remove sets
 *   `deleted_at`).
 */
export class EntitlementOverrideRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The organization's live (not deleted) overrides, expired ones included, by key. */
  async listLive(organizationId: number): Promise<OrganizationEntitlementOverrideRow[]> {
    return this.db()
      .select()
      .from(organization_entitlement_overrides)
      .where(
        and(
          eq(organization_entitlement_overrides.organization_id, organizationId),
          isNull(organization_entitlement_overrides.deleted_at),
        ),
      )
      .orderBy(asc(organization_entitlement_overrides.key));
  }

  /** The live override of one key, locked for the set (`FOR UPDATE`); `null` when there is none. */
  async findLiveByKeyForUpdate({
    organizationId,
    key,
  }: {
    organizationId: number;
    key: EntitlementOverrideKey;
  }): Promise<OrganizationEntitlementOverrideRow | null> {
    const rows = await this.db()
      .select()
      .from(organization_entitlement_overrides)
      .where(
        and(
          eq(organization_entitlement_overrides.organization_id, organizationId),
          eq(organization_entitlement_overrides.key, key),
          isNull(organization_entitlement_overrides.deleted_at),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Inserts a new live override (a fresh `ovr_…` id, retried on a public-id collision). */
  async insert({
    organizationId,
    key,
    values,
  }: {
    organizationId: number;
    key: EntitlementOverrideKey;
    values: EntitlementOverrideWriteValues;
  }): Promise<OrganizationEntitlementOverrideRow> {
    return runInsertWithPublicIdentifierRetry({
      insert: async () => {
        const [row] = await this.db()
          .insert(organization_entitlement_overrides)
          .values({
            public_id: generatePublicId('organizationEntitlementOverride'),
            organization_id: organizationId,
            key,
            value: values.value,
            expires_at: values.expiresAt,
            reason: values.reason,
            created_by_user_id: values.actorUserId,
            updated_by_user_id: values.actorUserId,
          })
          .returning();
        return row!;
      },
    });
  }

  /** Replaces a live override's value, end and reason in place. */
  async update({
    id,
    values,
  }: {
    id: number;
    values: EntitlementOverrideWriteValues;
  }): Promise<OrganizationEntitlementOverrideRow> {
    const [row] = await this.db()
      .update(organization_entitlement_overrides)
      .set({
        value: values.value,
        expires_at: values.expiresAt,
        reason: values.reason,
        updated_by_user_id: values.actorUserId,
        updated_at: databaseUpdatedAtTimestamp(organization_entitlement_overrides.created_at),
      })
      .where(eq(organization_entitlement_overrides.id, id))
      .returning();
    return row!;
  }

  /** Soft-deletes the organization's live override with this public id; `null` when there is none. */
  async softDeleteByPublicId({
    organizationId,
    publicId,
    actorUserId,
  }: {
    organizationId: number;
    publicId: string;
    actorUserId: number | null;
  }): Promise<OrganizationEntitlementOverrideRow | null> {
    const [row] = await this.db()
      .update(organization_entitlement_overrides)
      .set({
        deleted_at: databaseNowTimestamp,
        updated_at: databaseUpdatedAtTimestamp(organization_entitlement_overrides.created_at),
        updated_by_user_id: actorUserId,
      })
      .where(
        and(
          eq(organization_entitlement_overrides.organization_id, organizationId),
          eq(organization_entitlement_overrides.public_id, publicId),
          isNull(organization_entitlement_overrides.deleted_at),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * The organization public id of a live override, through the `SECURITY DEFINER` resolver
   * `billing.resolve_organization_public_id_for_entitlement_override` (no context needed);
   * `null` when the override does not exist or was removed.
   */
  async resolveOrganizationPublicId(overridePublicId: string): Promise<string | null> {
    const result = await getContextFreeDatabase().execute(
      sql`SELECT billing.resolve_organization_public_id_for_entitlement_override(${overridePublicId}) AS organization_public_id`,
    );
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
      organization_public_id: string | null;
    }>;
    return rows[0]?.organization_public_id ?? null;
  }
}
