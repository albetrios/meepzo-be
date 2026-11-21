/**
 * Instagram account bulk seeder — gives every demo team organization in the registry a connected
 * Instagram professional account (`app.instagram_accounts`) and its token
 * (`app.instagram_account_tokens`), as a connect leaves them (IA12): status `connected`, the three
 * scopes, the webhook subscribed, the token's expiry copied onto the account (IA5).
 *
 * The token is a fixed placeholder encrypted with `encryptFieldSecret` — never a real-looking
 * Instagram token, and never decrypted here. The daily check (IA8) refuses it on its first
 * Instagram call, as it would any dead token.
 *
 * Idempotency: the Instagram ids are derived from the organization id (digits behind a `9`, never a
 * real Instagram id), so a re-run finds the same account; every insert is
 * `ON CONFLICT DO NOTHING`, and the token's expiry is read back from the account, so the two
 * always agree. An organization that already holds another live account keeps it untouched.
 */
import { and, eq } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_account_tokens } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.schema.js';
import { INSTAGRAM_ACCOUNT_REQUIRED_SCOPES } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkInstagramAccountProfile } from './instagram-account.faker.js';

/** The placeholder every seeded token encrypts — plainly not an Instagram token. */
const SEEDED_ACCESS_TOKEN_PLACEHOLDER = 'seed-placeholder-not-an-instagram-token';
/** A long-lived token's lifetime, as Instagram grants it (about 60 days, IA12). */
const SEEDED_TOKEN_LIFETIME_DAYS = 60;

/**
 * A seeded account's Instagram ids, derived from the organization id: digits behind a leading `9`
 * (`8` for the app-scoped id), 16 in all. Unique per organization, so the cross-organization live
 * index never clashes.
 */
function seededInstagramIds(organizationId: number): {
  instagramUserId: string;
  instagramAppUserId: string;
} {
  const digits = String(organizationId).padStart(15, '0');
  return { instagramUserId: `9${digits}`, instagramAppUserId: `8${digits}` };
}

/** Seeds one organization's account and token; returns whether a new account was written. */
async function seedInstagramAccountForOrganization({
  context,
  organization,
}: {
  context: SeedContext;
  organization: SeededOrg;
}): Promise<boolean> {
  const database = getRequestDatabase();
  const { instagramUserId, instagramAppUserId } = seededInstagramIds(organization.id);
  const profile = generateBulkInstagramAccountProfile(context.faker);
  const connectedAt = new Date();

  const inserted = await database
    .insert(instagram_accounts)
    .values({
      public_id: generatePublicId('instagramAccount'),
      organization_id: organization.id,
      instagram_user_id: instagramUserId,
      instagram_app_user_id: instagramAppUserId,
      username: profile.username,
      name: profile.name,
      biography: profile.biography,
      website: profile.website,
      followers_count: profile.followersCount,
      follows_count: profile.followsCount,
      media_count: profile.mediaCount,
      scopes: [...INSTAGRAM_ACCOUNT_REQUIRED_SCOPES],
      connection_status: 'connected',
      connection_status_changed_at: connectedAt,
      token_expires_at: new Date(
        connectedAt.getTime() + SEEDED_TOKEN_LIFETIME_DAYS * MILLISECONDS_PER_DAY,
      ),
      webhook_subscribed_at: connectedAt,
      connected_by_user_id: organization.ownerUserId,
      connected_at: connectedAt,
      profile_synced_at: connectedAt,
    })
    .onConflictDoNothing()
    .returning({ id: instagram_accounts.id });

  const [account] = await database
    .select({ id: instagram_accounts.id, tokenExpiresAt: instagram_accounts.token_expires_at })
    .from(instagram_accounts)
    .where(
      and(
        eq(instagram_accounts.organization_id, organization.id),
        eq(instagram_accounts.instagram_user_id, instagramUserId),
        eq(instagram_accounts.connection_status, 'connected'),
      ),
    )
    .limit(1);
  // Another live account holds the organization, or the seeded one was disconnected: leave both.
  if (!account?.tokenExpiresAt) return false;

  await database
    .insert(instagram_account_tokens)
    .values({
      organization_id: organization.id,
      instagram_account_id: account.id,
      encrypted_access_token: encryptFieldSecret(SEEDED_ACCESS_TOKEN_PLACEHOLDER),
      expires_at: account.tokenExpiresAt,
    })
    .onConflictDoNothing();
  return inserted.length > 0;
}

/**
 * Seeds a connected Instagram account and its encrypted token for every registry organization.
 *
 * @remarks
 * Parents read: `context.registry.organizations` — the tenancy seeder's bulk team organizations
 * (personal organizations never enter the registry); `ownerUserId` is the connecting user.
 * Algorithm: per organization, insert the account (`ON CONFLICT DO NOTHING`), read it back, then
 * insert its token with the account's `token_expires_at` (`ON CONFLICT DO NOTHING`). Side effects:
 * inserts into `app.instagram_accounts` and `app.instagram_account_tokens`. Failure modes: warns
 * and returns early when the registry has no organizations; otherwise propagates database errors.
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
