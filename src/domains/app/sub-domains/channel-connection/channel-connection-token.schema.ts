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
import { channel_connections } from './channel-connection.schema.js';

/**
 * `app.channel_connection_tokens` — the connection's token, stored only as `encryptFieldSecret`
 * ciphertext (routes-final § 1.3, MC9, MC18): one per connection, a persistence part of the
 * connection (no public id, no routes). Meta's Unified Login writes a `system_user` token that never
 * ends (`expires_at` empty) and no refresh token; a later provider whose user tokens expire writes
 * `oauth_user` with its encrypted refresh token (P49). Only the token repository reads it, and only
 * the token service and the token check use that repository; the plain token exists only inside the
 * provider client. Deleted when the connection is `revoked`. RLS: the organization arm only, in
 * `USING` and `WITH CHECK` — deliberately no retention sweep arm, so no maintenance process reads a
 * token.
 */
export const channel_connection_tokens = appSchema
  .table(
    'channel_connection_tokens',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      channel_connection_id: bigint('channel_connection_id', { mode: 'number' }).notNull(),
      /** `encryptFieldSecret` output — never the plain token (MC9). */
      encrypted_access_token: text('encrypted_access_token').notNull(),
      /** `system_user` (Meta) · `oauth_user` (a later provider, P49). */
      token_type: varchar('token_type', { length: 20 }).notNull().default('system_user'),
      /** `encryptFieldSecret` output; empty for Meta (MC18). */
      encrypted_refresh_token: text('encrypted_refresh_token'),
      /** Empty = never ends (D24). */
      expires_at: timestamp('expires_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: 'channel_connection_tokens_channel_connection_fk',
        columns: [table.organization_id, table.channel_connection_id],
        foreignColumns: [channel_connections.organization_id, channel_connections.id],
      }).onDelete('cascade'),
      // One token per connection, and the composite key's index.
      uniqueIndex('idx_channel_connection_tokens_organization_connection').on(
        table.organization_id,
        table.channel_connection_id,
      ),
      check(
        'chk_channel_connection_tokens_token_type',
        sql`${table.token_type} IN ('system_user', 'oauth_user')`,
      ),
      check(
        'chk_channel_connection_tokens_encrypted_access_token_not_empty',
        sql`length(${table.encrypted_access_token}) > 0`,
      ),
      check(
        'chk_channel_connection_tokens_encrypted_refresh_token_not_empty',
        sql`${table.encrypted_refresh_token} IS NULL OR length(${table.encrypted_refresh_token}) > 0`,
      ),
      check(
        'chk_channel_connection_tokens_updated',
        sql`${table.updated_at} >= ${table.created_at}`,
      ),
      pgPolicy('channel_connection_tokens_tenant_isolation', {
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
