import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  pgPolicy,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.instagram_attachments` — Meta's id for a message file uploaded once per Instagram account
 * (feat-instagram-dm-sending routes-final § 6.C.3, SN20): the channel account, the upload's public id
 * (`upl_…`, P25 — no key into `upload.uploads`, read through the upload service) and Meta's
 * `attachment_id`.
 *
 * @remarks
 * - One row per account and upload (`idx_instagram_attachments_account_upload`): the first send of a
 *   file, or the attachment task (WC-32, ROUTE row R46), uploads it and writes the row; every later
 *   send of that file from that account reuses the id (AC-15.4).
 * - Deleted when Meta says the file is gone (the `attachment_failed` group), and by the
 *   deleted-automation purge for files no live automation of the account uses (WC-47).
 * - RLS: the organization policy, plus the retention sweep arm in `USING` only (the purge).
 */
export const instagram_attachments = appSchema
  .table(
    'instagram_attachments',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      /** The upload's public id (`upl_…`) — a value, never a key (P25). */
      upload_public_id: varchar('upload_public_id', { length: 28 }).notNull(),
      /** Meta's reusable attachment id for this account. */
      attachment_id: varchar('attachment_id', { length: 128 }).notNull(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_attachments_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('cascade'),
      // One Meta id per account and file — the look-up before a send, and the composite key's index.
      uniqueIndex('idx_instagram_attachments_account_upload').on(
        table.organization_id,
        table.channel_account_id,
        table.upload_public_id,
      ),
      check(
        'chk_instagram_attachments_upload_public_id',
        sql`${table.upload_public_id} ~ '^upl_[a-z0-9]{21}$'`,
      ),
      check(
        'chk_instagram_attachments_attachment_id',
        sql`char_length(${table.attachment_id}) > 0`,
      ),
      check('chk_instagram_attachments_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('instagram_attachments_tenant_isolation', {
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
