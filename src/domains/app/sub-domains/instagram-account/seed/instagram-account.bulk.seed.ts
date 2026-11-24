/**
 * Instagram account bulk seeder — gives every demo team organization's seeded channel account
 * (`channel-account/seed/`) its Instagram extension (`app.instagram_accounts`, 1:1), as a pick leaves
 * it (feat-instagram-dm-sending MC7): status
 * `connected`, the connection's scopes, the webhook subscribed. The token is the connection's.
 *
 * Idempotency: the Instagram id is derived from the organization id (digits behind a `9`, never a
 * real Instagram id), so a re-run finds the same account; the insert is `ON CONFLICT DO NOTHING`.
 * An organization without its seeded channel account is left untouched.
 */
import { and, eq } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { seededProviderAccountId } from '@/domains/app/sub-domains/channel-account/seed/channel-account.bulk.seed.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkInstagramAccountProfile } from './instagram-account.faker.js';

/** Seeds one organization's account; returns whether a new account was written. */
async function seedInstagramAccountForOrganization({
  context,
  organization,
}: {
  context: SeedContext;
  organization: SeededOrg;
}): Promise<boolean> {
  const database = getRequestDatabase();
  const instagramUserId = seededProviderAccountId(organization.id);
  const [account] = await database
    .select({ id: channel_accounts.id, scopes: channel_connections.scopes })
    .from(channel_accounts)
    .innerJoin(
      channel_connections,
      and(
        eq(channel_connections.organization_id, channel_accounts.organization_id),
        eq(channel_connections.id, channel_accounts.channel_connection_id),
      ),
    )
    .where(
      and(
        eq(channel_accounts.organization_id, organization.id),
        eq(channel_accounts.provider_account_id, instagramUserId),
      ),
    )
    .limit(1);
  if (account === undefined) return false;
  const profile = generateBulkInstagramAccountProfile(context.faker);
  const connectedAt = new Date();

  const inserted = await database
    .insert(instagram_accounts)
    .values({
      public_id: generatePublicId('instagramAccount'),
      organization_id: organization.id,
      channel_account_id: account.id,
      instagram_user_id: instagramUserId,
      instagram_app_user_id: instagramUserId,
      username: profile.username,
      name: profile.name,
      biography: profile.biography,
      website: profile.website,
      followers_count: profile.followersCount,
      follows_count: profile.followsCount,
      media_count: profile.mediaCount,
      scopes: account.scopes,
      connection_status: 'connected',
      connection_status_changed_at: connectedAt,
      webhook_subscribed_at: connectedAt,
      connected_by_user_id: organization.ownerUserId,
      connected_at: connectedAt,
      profile_synced_at: connectedAt,
    })
    .onConflictDoNothing()
    .returning({ id: instagram_accounts.id });

  return inserted.length > 0;
}

/**
 * Seeds the Instagram extension of the seeded channel account for every registry organization.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations
 * (personal organizations never enter the registry); `ownerUserId` is the connecting user.
 * Algorithm: per organization, find its seeded channel account, then insert the extension
 * (`ON CONFLICT DO NOTHING`). Side effects: inserts into `app.instagram_accounts`. Failure modes:
 * warns and returns early when the registry has no organizations; otherwise propagates database
 * errors.
 */
export async function seedInstagramAccountsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-account: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  let created = 0;
  for (const organization of organizations) {
    if (await seedInstagramAccountForOrganization({ context, organization })) created += 1;
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.instagram-account: connected accounts seeded',
  );
}
