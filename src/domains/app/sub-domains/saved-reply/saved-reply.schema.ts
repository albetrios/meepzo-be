import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { sqlLiteral } from '@/infrastructure/database/utils/sql-literal.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { users } from '@/domains/user/user.schema.js';
import {
  SAVED_REPLY_TEXT_MAX_BYTES,
  SAVED_REPLY_TITLE_MAX_CHARACTERS,
} from './saved-reply.constants.js';

/**
 * `app.saved_replies` — the organization's reusable reply texts (feat-instagram-inbox routes-final § 3.3,
 * SR1–SR6), shared across channels (I-D2): the reply box inserts one, and a send that names one counts it.
 *
 * @remarks
 * - **Keys:** the organization (`CASCADE`); the creating and last updating users (`SET NULL`).
 * - **Title** unique among the organization's rows, any case (SR3); **hard delete** (SR5) — nothing
 *   points at a saved reply.
 * - **Use** (SR4): `use_count` and `last_used_at`, moved by the send in its own transaction.
 * - **RLS:** the organization policy only.
 */
export const saved_replies = appSchema
  .table(
    'saved_replies',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      /** `svr_…` (SR1). */
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      /** 1 to {@link SAVED_REPLY_TITLE_MAX_CHARACTERS} characters. */
      title: varchar('title', { length: SAVED_REPLY_TITLE_MAX_CHARACTERS }).notNull(),
      /** 1 to {@link SAVED_REPLY_TEXT_MAX_BYTES} UTF-8 bytes; may hold `{first_name}` and `{username}` (SR6). */
      text: text('text').notNull(),
      use_count: integer('use_count').notNull().default(0),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_saved_replies_public_id').on(table.public_id),
      // One title per organization, any case (SR3) — also the title-ordered list.
      uniqueIndex('idx_saved_replies_organization_title').on(
        table.organization_id,
        sql`lower(${table.title})`,
      ),
      // The most-used list (SR4).
      index('idx_saved_replies_organization_use_count').on(
        table.organization_id,
        table.use_count.desc(),
        table.id,
      ),
      index('idx_saved_replies_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      index('idx_saved_replies_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check(
        'chk_saved_replies_title',
        sql`char_length(${table.title}) BETWEEN 1 AND ${sqlLiteral(SAVED_REPLY_TITLE_MAX_CHARACTERS)}`,
      ),
      check(
        'chk_saved_replies_text',
        sql`octet_length(${table.text}) BETWEEN 1 AND ${sqlLiteral(SAVED_REPLY_TEXT_MAX_BYTES)}`,
      ),
      check('chk_saved_replies_use_count', sql`${table.use_count} >= 0`),
      check('chk_saved_replies_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('saved_replies_tenant_isolation', {
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
