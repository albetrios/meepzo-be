import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { billingSchema } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import {
  ENTITLEMENT_OVERRIDE_KEYS,
  ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH,
} from './entitlement.constants.js';

/**
 * `billing.organization_entitlement_overrides` — one organization's exception to its plan (plan-gating
 * close, P270): a feature switch turned on or off, or a limit raised or lowered, optionally until
 * `expires_at`, set by a global admin with a `reason`.
 *
 * @remarks
 * - **Keys:** `key` ∈ `ENTITLEMENT_OVERRIDE_KEYS` (`chk_…_key`); `value` a JSON boolean (a feature
 *   switch) or a JSON number (a limit) — the exact type per key is the validator's and the merge's
 *   (`entitlement-override.util.ts`). At most one live (not deleted) row per organization and key
 *   (`idx_…_organization_key_live`); a set replaces it in place.
 * - **Merge:** read in the plan entitlement's one query (`SubscriptionRepository.findPlanAccessSubject`,
 *   BL2) and laid over the plan's features while `expires_at` is null or in the future.
 * - **Soft delete:** `deleted_at` (a remove); a deleted or expired row is never merged. Rows go with
 *   their organization (`ON DELETE CASCADE`).
 * - **RLS:** the organization policy in `USING` and `WITH CHECK`, enabled and forced — no bypass
 *   arm. The admin remove names only the override, so its organization is found by the
 *   `SECURITY DEFINER` resolver `billing.resolve_organization_public_id_for_entitlement_override(text)`
 *   (the organization's public id only), and the write runs under that organization's context.
 */
export const organization_entitlement_overrides = billingSchema
  .table(
    'organization_entitlement_overrides',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      key: varchar('key', { length: 64 }).notNull(),
      value: jsonb('value').$type<boolean | number>().notNull(),
      expires_at: timestamp('expires_at', { withTimezone: true }),
      reason: varchar('reason', { length: ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH }).notNull(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_organization_entitlement_overrides_public_id').on(table.public_id),
      // The organization key's ON DELETE CASCADE needs a full index (the live-key one is partial).
      index('idx_organization_entitlement_overrides_organization_id').on(table.organization_id),
      // One live override per organization and key; also the plan entitlement's merge read.
      uniqueIndex('idx_organization_entitlement_overrides_organization_key_live')
        .on(table.organization_id, table.key)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_organization_entitlement_overrides_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      index('idx_organization_entitlement_overrides_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check(
        'chk_organization_entitlement_overrides_key',
        sql`${table.key} IN (${sqlLiteralList(ENTITLEMENT_OVERRIDE_KEYS)})`,
      ),
      check(
        'chk_organization_entitlement_overrides_value',
        sql`jsonb_typeof(${table.value}) IN ('boolean', 'number')`,
      ),
      check(
        'chk_organization_entitlement_overrides_reason',
        sql`char_length(btrim(${table.reason})) BETWEEN 1 AND ${sqlLiteral(ENTITLEMENT_OVERRIDE_REASON_MAX_LENGTH)}`,
      ),
      check(
        'chk_organization_entitlement_overrides_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('organization_entitlement_overrides_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();

/** A stored override row. */
export type OrganizationEntitlementOverrideRow =
  typeof organization_entitlement_overrides.$inferSelect;
