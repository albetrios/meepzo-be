import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  primaryKey,
  smallint,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_webhook_events` — one saved event of a Meta webhook delivery (a `changes[]` or
 * `messaging[]` item), of the missed-comment check or of a past-comments read, with what intake did
 * with it (feat-instagram-dm-sending routes-final § 5.B.3, WH18–WH22). Born `received` — or
 * already `skipped`, without a body — by the store function, then `queued` → `processed` ·
 * `skipped` · `failed` by intake (WH12). No soft delete, no `*_by_user_id` (WH6); `created_at` is
 * the received time (the API's `received_at`).
 *
 * @remarks
 * - **Split by day** (`PARTITION BY RANGE (created_at)`, one part per UTC day, kept 8 days — P33,
 *   P96, WH19): Drizzle declares the parent only; the parts are made by
 *   `app.fn_create_daily_partitions` (the migration's first parts, then the shared upkeep). Every
 *   key carries the partition key — primary key `(id, created_at)`, unique `(public_id, created_at)`.
 * - The repeat guard lives in `app.instagram_webhook_event_keys` (WH20), not here.
 * - The body (`payload`) is set exactly while the event waits or failed (WH22,
 *   `chk_instagram_webhook_events_body`); `intake_group` is generated from the kind (WH11).
 * - RLS on the parent: the organization policy, plus the retention sweep arm in `USING` only (the
 *   stuck-event pick-up's cross-organization read).
 */
export const instagram_webhook_events = appSchema
  .table(
    'instagram_webhook_events',
    {
      id: bigserial('id', { mode: 'number' }).notNull(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** `app.channel_accounts.id` the events were saved for (composite key with the organization). */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** The delivery entry's `id` as received — the account's webhook user id; digits only. */
      instagram_user_id: varchar('instagram_user_id', { length: 64 }).notNull(),
      /** The person on the other side — the sender, or for an echo the recipient; digits only. */
      contact_instagram_user_id: varchar('contact_instagram_user_id', { length: 64 }),
      event_kind: varchar('event_kind', { length: 20 }).notNull(),
      /** `comments` · `live` · `messages`, generated from `event_kind` (WH11) — each intake job claims its own. */
      intake_group: varchar('intake_group', { length: 8 }).generatedAlwaysAs(
        sql`CASE event_kind WHEN 'comment' THEN 'comments' WHEN 'live_comment' THEN 'live' ELSE 'messages' END`,
      ),
      /** The event's key (WH9); its repeat guard is `app.instagram_webhook_event_keys`. */
      event_key: varchar('event_key', { length: 512 }).notNull(),
      status: varchar('status', { length: 10 }).notNull().default('received'),
      skip_reason: varchar('skip_reason', { length: 30 }),
      /** A code and a short reason, never payload text; set exactly when `failed`. */
      error_message: varchar('error_message', { length: 2000 }),
      /** One per claim (WH12). */
      attempt_count: smallint('attempt_count').notNull().default(0),
      /** The claim; held for 5 minutes. */
      last_attempted_at: timestamp('last_attempted_at', { withTimezone: true }),
      /** A failed event's next try (WH21); set only while `failed`. */
      next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
      /**
       * The event item as received, kept only while the event waits or failed and cleared when it is
       * done (WH22) — the masking runs in the serializer only (5.B.10).
       */
      payload: jsonb('payload'),
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
      primaryKey({ name: 'instagram_webhook_events_pkey', columns: [table.id, table.created_at] }),
      foreignKey({
        name: 'instagram_webhook_events_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // A partitioned table's unique index carries the partition key.
      uniqueIndex('idx_instagram_webhook_events_public_id').on(table.public_id, table.created_at),
      // Route 62, every account: newest first; also serves the organization cascade.
      index('idx_instagram_webhook_events_organization_id_created_at_id').on(
        table.organization_id,
        table.created_at.desc(),
        table.id.desc(),
      ),
      // Route 62, one account (WH23); leads with the composite key, so it serves the account cascade.
      index('idx_instagram_webhook_events_organization_account_created_at').on(
        table.organization_id,
        table.channel_account_id,
        table.created_at.desc(),
        table.id.desc(),
      ),
      // Route 62 filtered by status.
      index('idx_instagram_webhook_events_organization_status_created_at_id').on(
        table.organization_id,
        table.status,
        table.created_at.desc(),
        table.id.desc(),
      ),
      // The claim and the stuck-event pick-up per intake group: only waiting rows, oldest first.
      index('idx_instagram_webhook_events_pending')
        .on(table.channel_account_id, table.intake_group, table.created_at, table.id)
        .where(sql`${table.status} IN ('received', 'queued')`),
      // The hourly retry of a failed event (WH21).
      index('idx_instagram_webhook_events_next_attempt_at')
        .on(table.next_attempt_at)
        .where(sql`${table.status} = 'failed' AND ${table.next_attempt_at} IS NOT NULL`),
      // The inbound flood count (WH16): her message events of the last minute.
      index('idx_instagram_webhook_events_flood')
        .on(table.channel_account_id, table.contact_instagram_user_id, table.created_at)
        .where(sql`${table.intake_group} = 'messages'`),
      check(
        'chk_instagram_webhook_events_kind',
        sql`${table.event_kind} IN ('comment', 'live_comment', 'message', 'story_reply', 'story_mention', 'shared_post', 'postback', 'ice_breaker', 'referral', 'reaction', 'echo', 'edit', 'unknown')`,
      ),
      check(
        'chk_instagram_webhook_events_status',
        sql`${table.status} IN ('received', 'queued', 'processed', 'skipped', 'failed')`,
      ),
      check(
        'chk_instagram_webhook_events_skip_reason',
        sql`${table.skip_reason} IS NULL OR ${table.skip_reason} IN ('automation_disabled', 'account_disconnected', 'own_comment', 'edit', 'unsupported', 'flood')`,
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
      check(
        'chk_instagram_webhook_events_payload',
        sql`${table.payload} IS NULL OR jsonb_typeof(${table.payload}) = 'object'`,
      ),
      check(
        'chk_instagram_webhook_events_body',
        sql`(${table.status} IN ('received', 'queued', 'failed')) = (${table.payload} IS NOT NULL)`,
      ),
      check(
        'chk_instagram_webhook_events_next_attempt',
        sql`${table.next_attempt_at} IS NULL OR ${table.status} = 'failed'`,
      ),
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
