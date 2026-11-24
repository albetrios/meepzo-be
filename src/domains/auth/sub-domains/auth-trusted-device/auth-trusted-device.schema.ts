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
import { authSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';

/**
 * Drizzle table for `auth.trusted_devices` — a browser a person ticked "trust this device for 30
 * days" on after a right 2FA code (feat-instagram-dm-sending AT17, D56).
 *
 * @remarks
 * - **Notes:** user-owned (no organization), no soft delete: `revoked_at` ends a row. Only the
 *   SHA-256 of the cookie is stored (`token_hash`). FORCE RLS keyed on `app.current_user_public_id`
 *   (`USING` and `WITH CHECK`), plus — in `USING` only — the session clean-up's maintenance arm
 *   (`app.session_retention_cleanup`) for the hourly delete of ROUTE R50. Migration
 *   `20261124110000_auth_trusted_devices.sql`.
 */
export const trusted_devices = authSchema
  .table(
    'trusted_devices',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      token_hash: varchar('token_hash', { length: 64 }).notNull(),
      user_agent: varchar('user_agent', { length: 512 }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      revoked_at: timestamp('revoked_at', { withTimezone: true }),
    },
    (table) => [
      uniqueIndex('trusted_devices_public_id_unique').on(table.public_id),
      uniqueIndex('trusted_devices_token_hash_unique').on(table.token_hash),
      // The live count and "revoke the oldest" (TRUSTED_DEVICES_MAX).
      index('idx_trusted_devices_user_id_created_at_live')
        .on(table.user_id, table.created_at)
        .where(sql`${table.revoked_at} IS NULL`),
      // Backs the user_id foreign key (the user-delete cascade reaches revoked rows too).
      index('idx_trusted_devices_user_id').on(table.user_id),
      // The clean-up's "expired or revoked over 30 days ago" scan (R50).
      index('idx_trusted_devices_expires_at').on(table.expires_at),
      check('chk_trusted_devices_expires', sql`${table.expires_at} > ${table.created_at}`),
      pgPolicy('trusted_devices_user_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
          ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )
          OR ${maintenanceBypassArm('app.session_retention_cleanup')}
        )`,
        // No bypass arm in WITH CHECK: the clean-up only deletes (USING), it never writes a row.
        withCheck: sql`${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
      }),
    ],
  )
  .enableRLS();
