import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  pgPolicy,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_webhook_event_keys` — every event key seen per organization, channel account and
 * Meta event day, so a repeat delivery saves nothing (feat-instagram-dm-sending routes-final § 5.B.3,
 * WH20, P96). Inserted `ON CONFLICT DO NOTHING` before the events; only the keys it inserted get an
 * event row (the store function, WH9 step 6). Never changed; no public id, no `updated_at`.
 *
 * @remarks
 * - **Split by Meta's event day** (`PARTITION BY RANGE (event_day)`, one part per UTC day): the day
 *   is the UTC day of Meta's own time for the item, so a redelivery — and the missed-comment check
 *   and a past-comments read of the same comment — lands on the same day. Drizzle declares the
 *   parent only; the parts come from `app.fn_create_daily_partitions` and go with the shared upkeep
 *   after 8 days (WH24, ROUTE R49) — no batch delete.
 * - Primary key `(organization_id, channel_account_id, event_key, event_day)` — organization first,
 *   so it also serves both cascades.
 * - RLS: the organization policy (`USING` + `WITH CHECK`), plus the retention sweep arm in `USING`
 *   only (the upkeep's oldest-part check).
 */
export const instagram_webhook_event_keys = appSchema
  .table(
    'instagram_webhook_event_keys',
    {
      organization_id: bigint('organization_id', { mode: 'number' }).notNull(),
      /** `app.channel_accounts.id` (composite key with the organization). */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** The same key as the event's (WH9, at most 512 characters). */
      event_key: varchar('event_key', { length: 512 }).notNull(),
      /** The partition key: the UTC day of Meta's own time for the item (WH20). */
      event_day: date('event_day', { mode: 'string' }).notNull(),
      received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'instagram_webhook_event_keys_pkey',
        columns: [
          table.organization_id,
          table.channel_account_id,
          table.event_key,
          table.event_day,
        ],
      }),
      foreignKey({
        name: 'instagram_webhook_event_keys_organization_fk',
        columns: [table.organization_id],
        foreignColumns: [organizations.id],
      }).onDelete('cascade'),
      foreignKey({
        name: 'instagram_webhook_event_keys_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      check('chk_instagram_webhook_event_keys_event_key', sql`length(${table.event_key}) > 0`),
      pgPolicy('instagram_webhook_event_keys_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR ${maintenanceBypassArm('app.global_retention_cleanup')}`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();
