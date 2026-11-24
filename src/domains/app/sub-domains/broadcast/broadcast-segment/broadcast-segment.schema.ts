import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral, sqlLiteralList } from '@/infrastructure/database/utils/sql-literal.util.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { CHANNEL_ACCOUNT_CHANNELS } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { SEGMENT_NAME_MAX_LENGTH } from './broadcast-segment.constants.js';
import type { SegmentConditions } from './broadcast-segment.dto.js';

/**
 * `app.segments` — a saved audience of one channel account (feat-instagram-dm-sending routes-final
 * § 7.B, BC1, BC12; shared by every channel, P48): its name and its condition tree, reused by many
 * broadcasts (routes 77–82).
 *
 * @remarks
 * - **Keys:** the account link is the composite `(organization_id, channel_account_id)` →
 *   `app.channel_accounts (organization_id, id)`, `ON DELETE CASCADE` (7.3) — set at create from
 *   the organization's account and never changed (BC5); `channel` is the account's, copied (P48).
 *   The unique `(organization_id, id)` index is the parent key broadcasts point at (R22).
 * - **Conditions:** `jsonb`, an object (`chk_segments_conditions`); the tree's shape — at most 2
 *   levels and 20 conditions (BC12) — is the validator's, so a caller gets a `400` naming the field.
 * - **Soft delete (BC4, P9):** `deleted_at`; a deleted segment leaves every list and read; the
 *   hourly purge (WC-62, ROUTE row R50) removes it for good 90 days later (P75) through
 *   `idx_segments_tombstoned`.
 * - **RLS:** the organization policy, plus the retention sweep arm in `USING` only — the purge reads
 *   across organizations (7.3).
 */
export const segments = appSchema
  .table(
    'segments',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** The account whose contacts the conditions read (BC5) — set at create, never changed. */
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** A copy of the account's channel (P48). */
      channel: varchar('channel', { length: 10 }).notNull().default('instagram'),
      name: varchar('name', { length: 255 }).notNull(),
      /** The condition tree of BC12, public ids inside. */
      conditions: jsonb('conditions').$type<SegmentConditions>().notNull(),
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
      foreignKey({
        name: 'segments_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      uniqueIndex('idx_segments_public_id').on(table.public_id),
      // The broadcasts' composite key (organization_id, segment_id) → (organization_id, id) (R22).
      uniqueIndex('idx_segments_organization_id_id').on(table.organization_id, table.id),
      // Route 77 by name (the default sort) over one account's live segments; both directions.
      index('idx_segments_account_name_id')
        .on(table.organization_id, table.channel_account_id, table.name, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      // Route 77 newest first.
      index('idx_segments_account_created_at_id')
        .on(
          table.organization_id,
          table.channel_account_id,
          table.created_at.desc(),
          table.id.desc(),
        )
        .where(sql`${table.deleted_at} IS NULL`),
      // The purge (BC4, WC-62): only the soft-deleted rows, so live writes never maintain it.
      index('idx_segments_tombstoned')
        .on(table.deleted_at)
        .where(sql`${table.deleted_at} IS NOT NULL`),
      index('idx_segments_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      index('idx_segments_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check(
        'chk_segments_channel',
        sql`${table.channel} IN (${sqlLiteralList(CHANNEL_ACCOUNT_CHANNELS)})`,
      ),
      check(
        'chk_segments_name',
        sql`char_length(btrim(${table.name})) BETWEEN 1 AND ${sqlLiteral(SEGMENT_NAME_MAX_LENGTH)}`,
      ),
      check('chk_segments_conditions', sql`jsonb_typeof(${table.conditions}) = 'object'`),
      check('chk_segments_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('segments_tenant_isolation', {
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
