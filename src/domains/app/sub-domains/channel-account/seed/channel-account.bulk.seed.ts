/**
 * Channel account bulk seeder — gives every demo team organization in the registry one connected
 * Instagram channel account (`app.channel_accounts`) through its seeded channel connection
 * (`channel-connection/seed/`), as a pick leaves it (feat-instagram-dm-sending MC7, CAC5): status
 * `connected`, in the plan, not paused. Its Instagram extension is the Instagram account seeder's.
 *
 * Idempotency: the provider id is derived from the organization id (digits behind a `9`, never a
 * real Instagram id), so a re-run finds the same account; the insert is `ON CONFLICT DO NOTHING`.
 * An organization without its seeded connection is left untouched.
 */
import { and, eq } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { seededClientBusinessId } from '@/domains/app/sub-domains/channel-connection/seed/channel-connection.bulk.seed.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';

/**
 * A seeded account's provider id (its Instagram user id), derived from the organization id: digits
 * behind a leading `9`, 16 in all. Unique per organization, so the cross-organization live index
 * never clashes.
 */
export function seededProviderAccountId(organizationId: number): string {
  return `9${String(organizationId).padStart(15, '0')}`;
}

/** Seeds one organization's channel account; returns whether a new account was written. */
async function seedChannelAccountForOrganization(organization: SeededOrg): Promise<boolean> {
  const database = getRequestDatabase();
  const [connection] = await database
    .select({ id: channel_connections.id })
    .from(channel_connections)
    .where(
      and(
        eq(channel_connections.organization_id, organization.id),
        eq(channel_connections.client_business_id, seededClientBusinessId(organization.id)),
      ),
    )
    .limit(1);
  if (connection === undefined) return false;
  const inserted = await database
    .insert(channel_accounts)
    .values({
      public_id: generatePublicId('channelAccount'),
      organization_id: organization.id,
      channel: 'instagram',
      channel_connection_id: connection.id,
      provider_account_id: seededProviderAccountId(organization.id),
      display_name: `@demo_${organization.id}`,
      connected_by_user_id: organization.ownerUserId,
    })
    .onConflictDoNothing()
    .returning({ id: channel_accounts.id });
  return inserted.length > 0;
}

/**
 * Seeds a connected Instagram channel account through its seeded channel connection for every
 * registry organization.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations;
 * `ownerUserId` is the connecting user. Algorithm: per organization, find its seeded connection,
 * then insert the account (`ON CONFLICT DO NOTHING`). Side effects: inserts into
 * `app.channel_accounts`. Failure modes: warns and returns early when the registry has no
 * organizations; otherwise propagates database errors.
 */
export async function seedChannelAccountsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.channel-account: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  let created = 0;
  for (const organization of organizations) {
    if (await seedChannelAccountForOrganization(organization)) created += 1;
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.channel-account: connected accounts seeded',
  );
}
