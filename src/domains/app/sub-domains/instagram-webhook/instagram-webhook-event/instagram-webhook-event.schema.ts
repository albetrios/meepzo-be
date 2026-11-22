import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';

/**
 * `app.instagram_webhook_events` — one event of a Meta webhook delivery (a `changes[]` or
 * `messaging[]` item), stored once per Instagram account and event key, with what happened to it
 * (routes-final § 4.B.3, WH16). Born `received` — or already `skipped` — by the receiver (4.A),
 * then `queued` → `processed` · `skipped` · `failed` by event processing (WH12); deleted 30 days
 * after it was received, whatever its status (WH19). No soft delete, no `*_by_user_id` (WH6);
 * `created_at` is the received time (the API's `received_at`). `organization_id` is required —
 * events of an account no team holds are never stored (WH4). RLS: the organization policy, plus the
 * retention sweep arm in `USING` only (the stuck-event pick-up and the clean-up).
 */
export const instagram_webhook_events = appSchema
  .table(
    'instagram_webhook_events',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
      /** The delivery entry's `id` as received — the account's webhook user id; digits only. */
      instagram_user_id: varchar('instagram_user_id', { length: 64 }).notNull(),
      /** The person on the other side — the sender, or for an echo the recipient; digits only. */
      contact_instagram_user_id: varchar('contact_instagram_user_id', { length: 64 }),
      event_kind: varchar('event_kind', { length: 20 }).notNull(),
      /** The event's key (WH9), unique per account. */
      event_key: varchar('event_key', { length: 512 }).notNull(),
      status: varchar('status', { length: 10 }).notNull().default('received'),
      skip_reason: varchar('skip_reason', { length: 30 }),
      /** A code and a short reason, never payload text; set exactly when `failed`. */
      error_message: varchar('error_message', { length: 2000 }),
      /** One per claim (WH12). */
      attempt_count: smallint('attempt_count').notNull().default(0),
      /** The claim; held for 5 minutes. */
      last_attempted_at: timestamp('last_attempted_at', { withTimezone: true }),
      /** The event item as received — the masking runs in the serializer only (4.B.10). */
      payload: jsonb('payload').notNull(),
      /** Meta's own time: the item's `timestamp`, else the entry's `time`. */
      occurred_at: timestamp('occurred_at', { withTimezone: true }),
      /** Set exactly when the status is final (`processed`, `skipped`, `failed`). */
      processed_at: timestamp('processed_at', { withTimezone: true }),
      /** The delivery's request id — ties the row to its log line. */
      request_id: varchar('request_id', { length: 128 }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_webhook_events_instagram_account_fk',
        columns: [table.organization_id, table.instagram_account_id],
        foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
      }).onDelete('cascade'),
      uniqueIndex('idx_instagram_webhook_events_public_id').on(table.public_id),
      // The repeat-delivery guard (WH9, WH10); leads with the composite key's columns, so it also
      // serves the account and organization cascades.
      uniqueIndex('idx_instagram_webhook_events_organization_account_event_key').on(
        table.organization_id,
        table.instagram_account_id,
        table.event_key,
      ),
      // Route 18: newest first.
      index('idx_instagram_webhook_events_organization_id_created_at_id').on(
        table.organization_id,
        table.created_at.desc(),
        table.id.desc(),
      ),
      // Route 18 filtered by status.
      index('idx_instagram_webhook_events_organization_status_created_at_id').on(
        table.organization_id,
        table.status,
        table.created_at.desc(),
        table.id.desc(),
      ),
      // The claim and the stuck-event pick-up: only waiting rows, oldest first per account.
      index('idx_instagram_webhook_events_pending')
        .on(table.instagram_account_id, table.created_at, table.id)
        .where(sql`${table.status} IN ('received', 'queued')`),
      // The 30-day clean-up.
      index('idx_instagram_webhook_events_created_at').on(table.created_at),
      check(
        'chk_instagram_webhook_events_kind',
        sql`${table.event_kind} IN ('comment', 'message', 'postback', 'story_reply', 'echo', 'read', 'reaction', 'edit', 'unknown')`,
      ),
      check(
        'chk_instagram_webhook_events_status',
        sql`${table.status} IN ('received', 'queued', 'processed', 'skipped', 'failed')`,
      ),
      check(
        'chk_instagram_webhook_events_skip_reason',
        sql`${table.skip_reason} IS NULL OR ${table.skip_reason} IN ('automation_disabled', 'account_disconnected', 'echo', 'read_receipt', 'reaction', 'edit', 'unsupported')`,
      ),
      check(
        'chk_instagram_webhook_events_skipped',
        sql`(${table.status} = 'skipped') = (${table.skip_reason} IS NOT NULL)`,
      ),
      check(
        'chk_instagram_webhook_events_failed',
        sql`(${table.status} = 'failed') = (${table.error_message} IS NOT NULL)`,
      ),
      check(
        'chk_instagram_webhook_events_final',
        sql`(${table.status} IN ('received', 'queued')) = (${table.processed_at} IS NULL)`,
      ),
      check('chk_instagram_webhook_events_payload', sql`jsonb_typeof(${table.payload}) = 'object'`),
      check('chk_instagram_webhook_events_attempt_count', sql`${table.attempt_count} >= 0`),
      check(
        'chk_instagram_webhook_events_instagram_ids',
        sql`${table.instagram_user_id} ~ '^[0-9]{1,64}$' AND (${table.contact_instagram_user_id} IS NULL OR ${table.contact_instagram_user_id} ~ '^[0-9]{1,64}$')`,
      ),
      check(
        'chk_instagram_webhook_events_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('instagram_webhook_events_tenant_isolation', {
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
