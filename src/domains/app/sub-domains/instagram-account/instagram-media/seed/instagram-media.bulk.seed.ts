/**
 * Stored-posts bulk seeder — gives every connected Instagram account of a registry organization a
 * few stored posts (`app.instagram_media`), as event processing leaves them when comments arrive
 * (IA17): owned by the account, types lowered, the Instagram object kept as `graph_data`.
 *
 * Idempotency: the media ids are derived from the organization id and the post's place (digits
 * behind a `7`, never a real Instagram id), and every insert is `ON CONFLICT DO NOTHING` on
 * `(organization_id, instagram_media_id)`, so a re-run writes nothing new.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkInstagramMediaPost } from './instagram-media.faker.js';

/** How many posts each seeded account stores. */
const SEEDED_POSTS_PER_ACCOUNT = 3;

/** A seeded post's Instagram media id: `7`, the organization id in 15 digits, the post's place in 2. */
function seededInstagramMediaId({
  organizationId,
  position,
}: {
  organizationId: number;
  position: number;
}): string {
  return `7${String(organizationId).padStart(15, '0')}${String(position).padStart(2, '0')}`;
}

/**
 * Seeds a few stored posts for every connected Instagram account of the registry organizations.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, and the connected accounts the Instagram account
 * seeder wrote for them (this contribution is composed after it). Algorithm: list those
 * organizations' connected accounts, then insert {@link SEEDED_POSTS_PER_ACCOUNT} posts per account
 * (`ON CONFLICT DO NOTHING`). Side effects: inserts into `app.instagram_media`. Failure modes: warns
 * and returns early when the registry has no organizations, or they have no connected account;
 * otherwise propagates database errors.
 */
export async function seedInstagramMediaBulk(context: SeedContext): Promise<void> {
  const organizationIds = context.registry.organizations.map((organization) => organization.id);
  if (organizationIds.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-media: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  const accounts = await database
    .select({
      organizationId: instagram_accounts.organization_id,
      instagramAccountId: instagram_accounts.id,
    })
    .from(instagram_accounts)
    .where(
      and(
        inArray(instagram_accounts.organization_id, organizationIds),
        eq(instagram_accounts.connection_status, 'connected'),
      ),
    );
  if (accounts.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-media: no connected Instagram accounts; run the account seeder first',
    );
    return;
  }

  const now = Date.now();
  const rows = accounts.flatMap((account) =>
    Array.from({ length: SEEDED_POSTS_PER_ACCOUNT }, (_unused, position) => {
      const post = generateBulkInstagramMediaPost(context.faker);
      const instagramMediaId = seededInstagramMediaId({
        organizationId: account.organizationId,
        position,
      });
      const publishedAt = new Date(now - post.publishedDaysAgo * MILLISECONDS_PER_DAY);
      const permalink = `https://www.instagram.com/p/seed${instagramMediaId}/`;
      return {
        organization_id: account.organizationId,
        instagram_account_id: account.instagramAccountId,
        instagram_media_id: instagramMediaId,
        media_type: post.mediaType,
        media_product_type: post.mediaProductType,
        caption: post.caption,
        permalink,
        published_at: publishedAt,
        comments_count: post.commentsCount,
        like_count: post.likeCount,
        graph_data: {
          id: instagramMediaId,
          caption: post.caption,
          media_type: post.mediaType.toUpperCase(),
          media_product_type: post.mediaProductType.toUpperCase(),
          permalink,
          timestamp: publishedAt.toISOString(),
          comments_count: post.commentsCount,
          like_count: post.likeCount,
        },
      };
    }),
  );

  const inserted = await database
    .insert(instagram_media)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: instagram_media.id });
  context.logger.info(
    { accounts: accounts.length, created: inserted.length },
    'seed.bulk.instagram-media: stored posts seeded',
  );
}
