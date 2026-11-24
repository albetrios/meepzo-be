import { faker } from '@faker-js/faker';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { PROFILES } from '@/scripts/seed/bulk-config.js';
import {
  type SeedContext,
  type SeededOrg,
  composeContributions,
} from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { instagramAccountSeedContribution as accountOnlySeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';
import { channelConnectionSeedContribution } from '@/domains/app/sub-domains/channel-connection/seed/index.js';
import { channelAccountSeedContribution } from '@/domains/app/sub-domains/channel-account/seed/index.js';

/** The connection seed first — every account comes in through one (feat-instagram-dm-sending R3). */
const instagramAccountSeedContribution = composeContributions(
  channelConnectionSeedContribution,
  channelAccountSeedContribution,
  accountOnlySeedContribution,
);

/**
 * The stored-posts bulk seed (launch IAC10, R5) against the real schema: every seeded connected
 * account gets a few stored posts that belong to it and pass the table's checks — and a second run
 * writes nothing new.
 */

async function seedOrganization(): Promise<SeededOrg> {
  const owner = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: owner.id });
  return { id: organization.id, public_id: organization.public_id, ownerUserId: owner.id };
}

function seedContext(organizations: SeededOrg[]): SeedContext {
  const registry = createSeedRegistry();
  for (const organization of organizations) registry.addOrganization(organization);
  return {
    counts: PROFILES.demo,
    faker,
    registry,
    logger: { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
  };
}

async function mediaOf(organizationId: number) {
  return database
    .select()
    .from(instagram_media)
    .where(eq(instagram_media.organization_id, organizationId))
    .orderBy(instagram_media.instagram_media_id);
}

describe('Instagram media bulk seed (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("stores three posts for the organization's connected account", async () => {
    const organization = await seedOrganization();

    await instagramAccountSeedContribution.seedBulk?.(seedContext([organization]));

    const [account] = await database
      .select({ channelAccountId: instagram_accounts.channel_account_id })
      .from(instagram_accounts)
      .where(eq(instagram_accounts.organization_id, organization.id));
    const posts = await mediaOf(organization.id);
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(post.channel_account_id).toBe(account!.channelAccountId);
      expect(post.instagram_media_id).toMatch(/^7[0-9]{17}$/);
      expect(['image', 'video', 'carousel_album']).toContain(post.media_type);
      expect(post.media_product_type).toBe(post.media_type === 'video' ? 'reels' : 'feed');
      expect(post.published_at.getTime()).toBeLessThan(Date.now());
      expect(post.graph_data).toMatchObject({ id: post.instagram_media_id });
    }
  });

  it('is idempotent: a second run adds nothing', async () => {
    const organizations = [await seedOrganization(), await seedOrganization()];

    await instagramAccountSeedContribution.seedBulk?.(seedContext(organizations));
    const first = await Promise.all(organizations.map((organization) => mediaOf(organization.id)));
    await instagramAccountSeedContribution.seedBulk?.(seedContext(organizations));
    const second = await Promise.all(organizations.map((organization) => mediaOf(organization.id)));

    expect(second.map((posts) => posts.map((post) => post.id))).toEqual(
      first.map((posts) => posts.map((post) => post.id)),
    );
    expect(second.map((posts) => posts.length)).toEqual([3, 3]);
  });
});
