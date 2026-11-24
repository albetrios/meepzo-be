/**
 * Channel connection bulk seeder — gives every demo team organization in the registry one Meta
 * connection (`app.channel_connections`) with its token (`app.channel_connection_tokens`), as a
 * callback leaves them (routes-final § 1 MC5, MCC7): status `connected`, the three required
 * permissions granted, a `system_user` token that never ends.
 *
 * The token is a fixed placeholder encrypted with `encryptFieldSecret` — never a real-looking Meta
 * token, and never decrypted here. Meta refuses it on the first call, as it would any dead token.
 *
 * Idempotency: the business id is derived from the organization id (digits behind a `7`, never a
 * real business id), so a re-run finds the same connection; every insert is
 * `ON CONFLICT DO NOTHING`.
 */
import { and, eq } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { META_REQUIRED_PERMISSIONS } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/** The placeholder every seeded token encrypts — plainly not a Meta token. */
const SEEDED_ACCESS_TOKEN_PLACEHOLDER = 'seed-placeholder-not-a-meta-token';
/** The login configuration id every seeded connection names (not a real one). */
const SEEDED_CONFIG_ID = '1000000000000001';

/** A seeded connection's business id, derived from the organization id: digits behind a `7`. */
export function seededClientBusinessId(organizationId: number): string {
  return `7${String(organizationId).padStart(15, '0')}`;
}

/** Seeds one organization's connection and token; returns whether a new connection was written. */
async function seedChannelConnectionForOrganization(organization: SeededOrg): Promise<boolean> {
  const database = getRequestDatabase();
  const clientBusinessId = seededClientBusinessId(organization.id);
  const inserted = await database
    .insert(channel_connections)
    .values({
      public_id: generatePublicId('channelConnection'),
      organization_id: organization.id,
      provider: 'meta',
      client_business_id: clientBusinessId,
      config_id: SEEDED_CONFIG_ID,
      scopes: [...META_REQUIRED_PERMISSIONS],
      connected_by_user_id: organization.ownerUserId,
      last_checked_at: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: channel_connections.id });
  const [connection] = await database
    .select({ id: channel_connections.id })
    .from(channel_connections)
    .where(
      and(
        eq(channel_connections.organization_id, organization.id),
        eq(channel_connections.provider, 'meta'),
        eq(channel_connections.client_business_id, clientBusinessId),
      ),
    )
    .limit(1);
  if (connection === undefined) return false;
  await database
    .insert(channel_connection_tokens)
    .values({
      organization_id: organization.id,
      channel_connection_id: connection.id,
      encrypted_access_token: encryptFieldSecret(SEEDED_ACCESS_TOKEN_PLACEHOLDER),
    })
    .onConflictDoNothing();
  return inserted.length > 0;
}

/**
 * Seeds one connected Meta connection and its encrypted token for every registry organization.
 *
 * @remarks
 * Parents read: `context.registry.organizations` (the tenancy seeder's bulk team organizations);
 * `ownerUserId` is the connecting user. Side effects: inserts into `app.channel_connections` and
 * `app.channel_connection_tokens`. Failure modes: warns and returns early when the registry has no
 * organizations; otherwise propagates database errors.
 */
export async function seedChannelConnectionsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.channel-connection: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    if (await seedChannelConnectionForOrganization(organization)) created += 1;
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.channel-connection: connections seeded',
  );
}
