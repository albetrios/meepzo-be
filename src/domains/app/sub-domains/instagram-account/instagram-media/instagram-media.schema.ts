import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema, maintenanceBypassArm } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';

/**
 * `app.instagram_media` — a post or reel an automation ran on (routes-final § 1.C.3, IA17): one row
 * per organization and Instagram media id, owned by one Instagram account through the composite key
 * `(organization_id, instagram_account_id)`, so Meta's data deletion erases that account's posts
 * (IQ4) and a second account's posts never mix with the first's. No public id — a post is addressed
 * by its Instagram media id.
 *
 * @remarks
 * Written only through `InstagramMediaService.upsertFromInstagram` (event processing, "next post"
 * linking); routes 5–6 read Instagram live and never write here (1.C.10). RLS: the organization
 * policy, plus the retention sweep arm in `USING` only (1.3).
 */
export const instagram_media = appSchema
  .table(
    'instagram_media',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
      /** Instagram's media id — digits. */
      instagram_media_id: varchar('instagram_media_id', { length: 64 }).notNull(),
      shortcode: varchar('shortcode', { length: 64 }),
      /** `image` · `video` · `carousel_album` (Instagram's upper case, lowered). */
      media_type: varchar('media_type', { length: 20 }),
      /** `feed` · `reels` · `story` · `ad`. */
      media_product_type: varchar('media_product_type', { length: 20 }),
      caption: text('caption'),
      media_url: text('media_url'),
      thumbnail_url: text('thumbnail_url'),
      permalink: text('permalink'),
      /** Instagram's `timestamp`. */
      published_at: timestamp('published_at', { withTimezone: true }).notNull(),
      comments_count: integer('comments_count').notNull().default(0),
      like_count: integer('like_count').notNull().default(0),
      is_comment_enabled: boolean('is_comment_enabled').notNull().default(true),
      /** The Instagram object as read — always a JSON object. */
      graph_data: jsonb('graph_data').$type<Record<string, unknown>>().notNull().default({}),
      /** When the row was last written from Instagram. */
      synced_at: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_media_instagram_account_fk',
        columns: [table.organization_id, table.instagram_account_id],
        foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
      }).onDelete('cascade'),
      // One row per Instagram media id per organization — the upsert's key.
      uniqueIndex('idx_instagram_media_organization_media').on(
        table.organization_id,
        table.instagram_media_id,
      ),
      // The composite key's index, and the account's posts by date.
      index('idx_instagram_media_organization_account_published').on(
        table.organization_id,
        table.instagram_account_id,
        table.published_at.desc(),
      ),
      check(
        'chk_instagram_media_instagram_media_id',
        sql`${table.instagram_media_id} ~ '^[0-9]{1,64}$'`,
      ),
      check(
        'chk_instagram_media_media_type',
        sql`${table.media_type} IN ('image', 'video', 'carousel_album')`,
      ),
      check(
        'chk_instagram_media_media_product_type',
        sql`${table.media_product_type} IN ('feed', 'reels', 'story', 'ad')`,
      ),
      check(
        'chk_instagram_media_counts',
        sql`${table.comments_count} >= 0 AND ${table.like_count} >= 0`,
      ),
      check(
        'chk_instagram_media_graph_data_object',
        sql`jsonb_typeof(${table.graph_data}) = 'object'`,
      ),
      check('chk_instagram_media_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('instagram_media_tenant_isolation', {
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
