import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';

/**
 * `app.contact_tag_counts` — per channel account and tag, how many live contacts hold it (scale
 * review S7, P97; routes-final § 3 CT8): route 22 reads it instead of `unnest(tags)` over the
 * account's contacts.
 *
 * @remarks
 * - **Kept in the tag commit:** every tag change — route 20, the bulk job (route 21), the tag step
 *   (4.B, `addContactTags`) and the erase — moves the count in the same transaction; a row reaching
 *   0 is deleted, so the table holds only the tags in use.
 * - **Contention:** a popular tag is one row; each commit holds its lock briefly (one increment per
 *   tag change, one per bulk piece).
 * - **Keys:** unique on `(organization_id, channel_account_id, tag)` (the upsert target); the account
 *   `RESTRICT`. The `id` exists for the RLS matrix and is never returned.
 * - **RLS:** the organization arm only.
 */
export const contact_tag_counts = appSchema
  .table(
    'contact_tag_counts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_account_id: bigint('channel_account_id', { mode: 'number' }).notNull(),
      tag: varchar('tag', { length: 50 }).notNull(),
      contact_count: integer('contact_count').notNull(),
    },
    (table) => [
      // One row per account and tag: the upsert target.
      uniqueIndex('idx_contact_tag_counts_account_tag').on(
        table.organization_id,
        table.channel_account_id,
        table.tag,
      ),
      foreignKey({
        name: 'contact_tag_counts_channel_account_fk',
        columns: [table.organization_id, table.channel_account_id],
        foreignColumns: [channel_accounts.organization_id, channel_accounts.id],
      }).onDelete('restrict'),
      // Route 22's order: most contacts first, then the tag A→Z.
      index('idx_contact_tag_counts_account_count').on(
        table.organization_id,
        table.channel_account_id,
        table.contact_count.desc(),
        table.tag,
      ),
      check('chk_contact_tag_counts_contact_count', sql`${table.contact_count} >= 0`),
      check('chk_contact_tag_counts_tag', sql`char_length(${table.tag}) BETWEEN 1 AND 50`),
      pgPolicy('contact_tag_counts_tenant_isolation', {
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
