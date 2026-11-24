import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
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
import type { InstagramMediaGraphItem } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
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
 * `InstagramMediaService.upsertFromInstagram`, the watch, the Live end and `deleteForAccount`
 * (routes-final § 2.C.3, IA17, D40, IA20) against the real table: the Instagram object mapped onto
 * the stored row under its channel account (P47), a refresh, the missed-comment watch and a Live's
 * end, the account's posts erased — and a scope of another organization never writing this one's
 * posts.
 */
describe('InstagramMediaService stored posts (database)', () => {
  const service = new InstagramMediaService(
    new InstagramMediaRepository(),
    {} as InstagramAccountService,
    { markConnectionBroken: async () => false },
  );
  let scope: OrganizationPrincipalDatabaseScope;
  let otherScope: OrganizationPrincipalDatabaseScope;
  let channelAccount: ChannelAccountKey;
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
    const channelConnection = await insertChannelConnection({ organizationId: organization.id });
    const channelAccountRow = await insertChannelAccount({
      organizationId: organization.id,
      providerAccountId: '17841400000000001',
      channelConnectionId: channelConnection.id,
    });
    await withAppDatabaseContext({
      scope,
      callback: () =>
        new InstagramAccountRepository().upsertAtPick(
          buildInstagramPickValues({
            organizationId: organization.id,
            channelAccountId: channelAccountRow.id,
            instagramUserId: '17841400000000001',
            username: 'acme_shop',
          }),
        ),
    });
    channelAccount = { organizationId: organization.id, channelAccountId: channelAccountRow.id };
  });

  it('stores a post from the Instagram object: types lowered, timestamp, counts, the object as graph_data', async () => {
    const stored = await service.upsertFromInstagram({
      scope,
      channelAccount,
      mediaItem: CAROUSEL_POST,
    });

    expect(stored).toMatchObject({
      organization_id: channelAccount.organizationId,
      channel_account_id: channelAccount.channelAccountId,
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
      channelAccount,
      mediaItem: CAROUSEL_POST,
    });

    const refreshed = await service.upsertFromInstagram({
      scope,
      channelAccount,
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
    await service.upsertFromInstagram({ scope, channelAccount, mediaItem: CAROUSEL_POST });

    // The other organization's scope with this account's key: the composite key refuses it.
    await expect(
      service.upsertFromInstagram({
        scope: otherScope,
        channelAccount: {
          organizationId: otherOrganizationId,
          channelAccountId: channelAccount.channelAccountId,
        },
        mediaItem: CAROUSEL_POST,
      }),
    ).rejects.toThrow();
    // And deleting from it erases nothing of this organization's.
    await expect(
      service.deleteForAccount({
        scope: otherScope,
        channelAccount: {
          organizationId: otherOrganizationId,
          channelAccountId: channelAccount.channelAccountId,
        },
      }),
    ).resolves.toBe(0);

    const rows = await operatorQuery<Array<{ instagram_media_id: string }>>`
      SELECT instagram_media_id FROM app.instagram_media`;
    expect(rows).toEqual([{ instagram_media_id: '18030000000000004' }]);
  });

  it("erases the account's stored posts (Meta's data deletion, IA20)", async () => {
    await service.upsertFromInstagram({ scope, channelAccount, mediaItem: CAROUSEL_POST });
    await service.upsertFromInstagram({
      scope,
      channelAccount,
      mediaItem: { ...CAROUSEL_POST, id: '18030000000000009' },
    });

    await expect(service.deleteForAccount({ scope, channelAccount })).resolves.toBe(2);
    await expect(service.deleteForAccount({ scope, channelAccount })).resolves.toBe(0);
  });

  it('stores a Live with the `live` product type, and records its end once (D40)', async () => {
    await service.upsertFromInstagram({
      scope,
      channelAccount,
      mediaItem: { ...CAROUSEL_POST, id: '18030000000000010', media_product_type: 'LIVE' },
    });
    const target = { scope, channelAccount, instagramMediaId: '18030000000000010' };

    const ended = await service.recordLiveEnded({
      ...target,
      endedAt: new Date('2026-11-24T10:00:00.000Z'),
    });
    const again = await service.recordLiveEnded({
      ...target,
      endedAt: new Date('2026-11-24T11:00:00.000Z'),
    });

    expect(ended).toMatchObject({ media_product_type: 'live' });
    expect(ended?.live_ended_at?.toISOString()).toBe('2026-11-24T10:00:00.000Z');
    expect(again?.live_ended_at?.toISOString()).toBe('2026-11-24T10:00:00.000Z');
    await expect(
      service.recordLiveEnded({
        ...target,
        instagramMediaId: '18030000000000099',
        endedAt: new Date(),
      }),
    ).resolves.toBeNull();
  });

  it('writes the missed-comment watch: start, a check, a newer comment only, then stop (D40)', async () => {
    await service.upsertFromInstagram({ scope, channelAccount, mediaItem: CAROUSEL_POST });
    const target = { scope, channelAccount, instagramMediaId: CAROUSEL_POST.id };
    const nextCheckAt = new Date('2026-11-24T10:10:00.000Z');

    const watched = await service.updateCommentWatch({
      ...target,
      watch: { commentsNextCheckAt: nextCheckAt },
    });
    expect(watched).toMatchObject({ comments_checked_at: null, last_comment_at: null });
    expect(watched?.comments_next_check_at?.toISOString()).toBe(nextCheckAt.toISOString());

    const checked = await service.updateCommentWatch({
      ...target,
      watch: {
        commentsCheckedAt: new Date('2026-11-24T10:10:05.000Z'),
        lastCommentAt: new Date('2026-11-24T10:09:00.000Z'),
      },
    });
    expect(checked?.comments_checked_at?.toISOString()).toBe('2026-11-24T10:10:05.000Z');
    expect(checked?.comments_next_check_at?.toISOString()).toBe(nextCheckAt.toISOString());

    // An older comment never moves the newest one back.
    const older = await service.updateCommentWatch({
      ...target,
      watch: { lastCommentAt: new Date('2026-11-24T09:00:00.000Z') },
    });
    expect(older?.last_comment_at?.toISOString()).toBe('2026-11-24T10:09:00.000Z');

    const stopped = await service.updateCommentWatch({
      ...target,
      watch: { commentsNextCheckAt: null },
    });
    expect(stopped?.comments_next_check_at).toBeNull();

    // Another organization's scope never reaches this post.
    await expect(
      service.updateCommentWatch({
        scope: otherScope,
        channelAccount: {
          organizationId: otherOrganizationId,
          channelAccountId: channelAccount.channelAccountId,
        },
        instagramMediaId: CAROUSEL_POST.id,
        watch: { commentsNextCheckAt: nextCheckAt },
      }),
    ).resolves.toBeNull();
  });
});
