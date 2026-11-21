import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { instagram_accounts } from './instagram-account.schema.js';

/**
 * `app.instagram_account_tokens` — the connected account's long-lived Instagram token, stored only
 * as `encryptFieldSecret` ciphertext (routes-final § 1.A.3, IA5): one per account, a persistence
 * part of the account (no public id, no routes). Only the token repository reads it, and only the
 * token service and the daily check use that repository; the plain token exists only inside the
 * Instagram client. Erased on every disconnect (IA14). RLS: the organization arm only, in `USING`
 * and `WITH CHECK` — deliberately no retention sweep arm, so no maintenance process reads a token.
 */
export const instagram_account_tokens = appSchema
  .table(
    'instagram_account_tokens',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      instagram_account_id: bigint('instagram_account_id', { mode: 'number' }).notNull(),
      /** `encryptFieldSecret` output — never the plain token (IA5). */
      encrypted_access_token: text('encrypted_access_token').notNull(),
      token_type: varchar('token_type', { length: 20 }).notNull().default('long_lived'),
      /** About 60 days after issue or renewal; copied onto the account's `token_expires_at`. */
      expires_at: timestamp('expires_at', { withTimezone: true }),
      last_refreshed_at: timestamp('last_refreshed_at', { withTimezone: true }),
      /** Instagram's code and message from the last failed renewal — never the token. */
      last_refresh_error: varchar('last_refresh_error', { length: 500 }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'instagram_account_tokens_instagram_account_fk',
        columns: [table.organization_id, table.instagram_account_id],
        foreignColumns: [instagram_accounts.organization_id, instagram_accounts.id],
      }).onDelete('cascade'),
      // One token per account, and the composite key's index.
      uniqueIndex('idx_instagram_account_tokens_organization_account').on(
        table.organization_id,
        table.instagram_account_id,
      ),
      check('chk_instagram_account_tokens_token_type', sql`${table.token_type} IN ('long_lived')`),
      check(
        'chk_instagram_account_tokens_encrypted_access_token_not_empty',
        sql`length(${table.encrypted_access_token}) > 0`,
      ),
      check(
        'chk_instagram_account_tokens_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('instagram_account_tokens_tenant_isolation', {
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
