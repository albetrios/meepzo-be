import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramMediaGraphItem } from '@/infrastructure/social/instagram.client.js';
import {
  InstagramAccountRepository,
  type InstagramAccountKey,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';

/** A carousel post as `readInstagramMediaItem` hands it over (the contract fixture's shape). */
const CAROUSEL_POST: InstagramMediaGraphItem = {
  id: '18030000000000004',
  caption: 'Three colours, one price — comment SHOP',
  media_type: 'CAROUSEL_ALBUM',
  media_product_type: 'FEED',
  media_url: 'https://cdn.example.com/carousel-cover.jpg',
  permalink: 'https://www.instagram.com/p/AcmeCarousel/',
  timestamp: '2026-11-18T12:00:00+0000',
  comments_count: 31,
  like_count: 512,
  children: {
    data: [
      {
        id: '18030000000000005',
        media_type: 'IMAGE',
        media_url: 'https://cdn.example.com/red.jpg',
      },
    ],
  },
};

/**
 * `InstagramMediaService.upsertFromInstagram` and `deleteForAccount` (routes-final § 1.C.3, IA17,
 * IA20) against the real table: the Instagram object mapped onto the stored row, a refresh, the
 * account's posts erased — and a scope of another organization never writing this one's posts.
 */
describe('InstagramMediaService stored posts (database)', () => {
  const service = new InstagramMediaService(
    new InstagramMediaRepository(),
    {} as InstagramAccountService,
  );
  let scope: OrganizationPrincipalDatabaseScope;
  let otherScope: OrganizationPrincipalDatabaseScope;
  let instagramAccount: InstagramAccountKey;
  let otherOrganizationId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    otherOrganizationId = otherOrganization.id;
    scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });
    otherScope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: otherOrganization.public_id });
    const { account } = await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramAccountRepository().upsertConnected({
          organizationId: organization.id,
          instagramUserId: '17841400000000001',
          instagramAppUserId: '917841400000000001',
          username: 'acme_shop',
          name: null,
          biography: null,
          website: null,
          profilePictureUrl: null,
          followersCount: 0,
          followsCount: 0,
          mediaCount: 0,
          scopes: [],
          tokenExpiresAt: new Date(),
          connectedByUserId: null,
        }),
    });
    instagramAccount = { organizationId: organization.id, instagramAccountId: account.id };
  });

  it('stores a post from the Instagram object: types lowered, timestamp, counts, the object as graph_data', async () => {
    const stored = await service.upsertFromInstagram({
      scope,
      instagramAccount,
      mediaItem: CAROUSEL_POST,
    });

    expect(stored).toMatchObject({
      organization_id: instagramAccount.organizationId,
      instagram_account_id: instagramAccount.instagramAccountId,
      instagram_media_id: '18030000000000004',
      shortcode: null,
      media_type: 'carousel_album',
      media_product_type: 'feed',
      caption: 'Three colours, one price — comment SHOP',
      media_url: 'https://cdn.example.com/carousel-cover.jpg',
      thumbnail_url: null,
      permalink: 'https://www.instagram.com/p/AcmeCarousel/',
      comments_count: 31,
      like_count: 512,
      is_comment_enabled: true,
    });
    expect(stored?.published_at.toISOString()).toBe('2026-11-18T12:00:00.000Z');
    expect(stored?.graph_data).toEqual(CAROUSEL_POST);
  });

  it('refreshes the same post, with missing counts as 0 and Instagram’s comment switch when it says one', async () => {
    const first = await service.upsertFromInstagram({
      scope,
      instagramAccount,
      mediaItem: CAROUSEL_POST,
    });

    const refreshed = await service.upsertFromInstagram({
      scope,
      instagramAccount,
      mediaItem: {
        id: CAROUSEL_POST.id,
        media_type: 'CAROUSEL_ALBUM',
        timestamp: '2026-11-18T12:00:00+0000',
        is_comment_enabled: false,
      } as InstagramMediaGraphItem,
    });

    expect(refreshed).toMatchObject({
      id: first?.id,
      comments_count: 0,
      like_count: 0,
      caption: null,
      is_comment_enabled: false,
    });
  });

  it("never writes another organization's posts from its own scope", async () => {
    await service.upsertFromInstagram({ scope, instagramAccount, mediaItem: CAROUSEL_POST });

    // The other organization's scope with this account's key: the composite key refuses it.
    await expect(
      service.upsertFromInstagram({
        scope: otherScope,
        instagramAccount: {
          organizationId: otherOrganizationId,
          instagramAccountId: instagramAccount.instagramAccountId,
        },
        mediaItem: CAROUSEL_POST,
      }),
    ).rejects.toThrow();
    // And deleting from it erases nothing of this organization's.
    await expect(
      service.deleteForAccount({
        scope: otherScope,
        instagramAccount: {
          organizationId: otherOrganizationId,
          instagramAccountId: instagramAccount.instagramAccountId,
        },
      }),
    ).resolves.toBe(0);

    const rows = await operatorQuery<Array<{ instagram_media_id: string }>>`
      SELECT instagram_media_id FROM app.instagram_media`;
    expect(rows).toEqual([{ instagram_media_id: '18030000000000004' }]);
  });

  it("erases the account's stored posts (Meta's data deletion, IA20)", async () => {
    await service.upsertFromInstagram({ scope, instagramAccount, mediaItem: CAROUSEL_POST });
    await service.upsertFromInstagram({
      scope,
      instagramAccount,
      mediaItem: { ...CAROUSEL_POST, id: '18030000000000009' },
    });

    await expect(service.deleteForAccount({ scope, instagramAccount })).resolves.toBe(2);
    await expect(service.deleteForAccount({ scope, instagramAccount })).resolves.toBe(0);
  });
});
