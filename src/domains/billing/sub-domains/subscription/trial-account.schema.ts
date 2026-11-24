import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { billingSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';

/**
 * `billing.trial_accounts` — every Instagram account that had the 7-day trial, in any organization
 * (feat-instagram-dm-sending routes-final § 8.B.3, BL7, BL18): one row per `instagram_user_id`, ever.
 *
 * @remarks
 * - Written by the trial start (route 102, the organization's not-revoked accounts) and by the pick of an
 *   account during a trial (sub-domain 1, through billing's trial port). Append-only: no `updated_*`,
 *   no soft delete.
 * - The row outlives its organization: `organization_id` and `subscription_id` are nullable with
 *   `ON DELETE SET NULL`, so an account that trialled in a deleted organization still cannot trial again.
 *   A row with no organization matches no request's policy; the cross-organization check is the
 *   `SECURITY DEFINER` resolver `billing.resolve_trialled_instagram_user_ids(text[])` (BL18).
 * - RLS: the organization arm in `USING` and `WITH CHECK`, enabled and forced.
 */
export const trial_accounts = billingSchema
  .table(
    'trial_accounts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
        { onDelete: 'set null' },
      ),
      instagram_user_id: varchar('instagram_user_id', { length: 30 }).notNull(),
      plan_id: bigint('plan_id', { mode: 'number' })
        .notNull()
        .references(() => plans.id, { onDelete: 'restrict' }),
      subscription_id: bigint('subscription_id', { mode: 'number' }).references(
        () => subscriptions.id,
        { onDelete: 'set null' },
      ),
      started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_trial_accounts_public_id').on(table.public_id),
      uniqueIndex('idx_trial_accounts_instagram_user_id').on(table.instagram_user_id),
      index('idx_trial_accounts_organization_started').on(
        table.organization_id,
        table.started_at.desc(),
      ),
      index('idx_trial_accounts_subscription').on(table.subscription_id),
      index('idx_trial_accounts_plan').on(table.plan_id),
      check(
        'chk_trial_accounts_instagram_user_id',
        sql`${table.instagram_user_id} ~ '^[0-9]{1,30}$'`,
      ),
      pgPolicy('trial_accounts_tenant_isolation', {
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
