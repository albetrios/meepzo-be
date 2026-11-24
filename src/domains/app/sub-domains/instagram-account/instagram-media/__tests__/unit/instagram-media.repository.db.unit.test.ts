import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { ChannelAccountKey } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  InstagramMediaRepository,
  type InstagramMediaValues,
} from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';

/**
 * `app.instagram_media` through its repository (routes-final § 2.C.3, IA17, IA20, P47), every statement
 * inside the organization's own database context — the way the media service runs it, so the suite
 * also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string };

/** Runs `callback` inside the organization's own context, as the services do. */
function inOrganization<T>(organization: TestOrganization, callback: () => Promise<T>): Promise<T> {
  return withAppDatabaseContext({
    scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
    callback,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** Connects an Instagram account in the organization and returns its key. */
async function connectAccount({
  organization,
  instagramUserId,
}: {
  organization: TestOrganization;
  instagramUserId: string;
}): Promise<ChannelAccountKey> {
  const channelConnection = await insertChannelConnection({ organizationId: organization.id });
  const channelAccount = await insertChannelAccount({
    organizationId: organization.id,
    providerAccountId: instagramUserId,
    channelConnectionId: channelConnection.id,
  });
  await inOrganization(organization, () =>
    new InstagramAccountRepository().upsertAtPick(
      buildInstagramPickValues({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
        instagramUserId: instagramUserId,
        username: `acme_shop_${instagramUserId.slice(-4)}`,
      }),
    ),
  );
  return { organizationId: organization.id, channelAccountId: channelAccount.id };
}

function mediaValues(
  channelAccount: ChannelAccountKey,
  overrides: Partial<InstagramMediaValues> = {},
): InstagramMediaValues {
  return {
    ...channelAccount,
    instagramMediaId: '18030000000000001',
    shortcode: null,
    mediaType: 'image',
    mediaProductType: 'feed',
    caption: 'New drop this Friday — comment SHOP',
    mediaUrl: 'https://cdn.example.com/post.jpg',
    thumbnailUrl: null,
    permalink: 'https://www.instagram.com/p/AcmePost/',
    publishedAt: new Date('2026-11-20T10:00:00.000Z'),
    commentsCount: 12,
    likeCount: 340,
    isCommentEnabled: undefined,
    graphData: { id: '18030000000000001', media_type: 'IMAGE' },
    ...overrides,
  };
}

describe('InstagramMediaRepository (database)', () => {
  const repository = new InstagramMediaRepository();
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let channelAccount: ChannelAccountKey;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    channelAccount = await connectAccount({
      organization,
      instagramUserId: '17841400000000001',
    });
  });

  it('inserts a post with the defaults the table gives it', async () => {
    const row = await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(channelAccount)),
    );

    expect(row).toMatchObject({
      organization_id: organization.id,
      channel_account_id: channelAccount.channelAccountId,
      instagram_media_id: '18030000000000001',
      media_type: 'image',
      media_product_type: 'feed',
      comments_count: 12,
      like_count: 340,
      is_comment_enabled: true,
      graph_data: { id: '18030000000000001', media_type: 'IMAGE' },
    });
    expect(row?.published_at.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(row?.synced_at).toBeInstanceOf(Date);
  });

  it('refreshes the stored row of the same account, keeping is_comment_enabled when Instagram is silent', async () => {
    const first = await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(channelAccount, { isCommentEnabled: false })),
    );

    const refreshed = await inOrganization(organization, () =>
      repository.upsertForAccount(
        mediaValues(channelAccount, { caption: 'Edited caption', commentsCount: 13 }),
      ),
    );

    expect(refreshed).toMatchObject({
      id: first?.id,
      caption: 'Edited caption',
      comments_count: 13,
      is_comment_enabled: false,
    });
    expect(refreshed!.synced_at.getTime()).toBeGreaterThanOrEqual(first!.synced_at.getTime());
    const counted = await operatorQuery<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM app.instagram_media WHERE organization_id = ${organization.id}`;
    expect(counted[0]?.count).toBe('1');
  });

  it("finds the account's stored post by its media id — event processing reads Instagram only without one (WH13)", async () => {
    const stored = await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(channelAccount)),
    );

    const found = await inOrganization(organization, () =>
      repository.findByInstagramMediaId({
        ...channelAccount,
        instagramMediaId: '18030000000000001',
      }),
    );
    const missing = await inOrganization(organization, () =>
      repository.findByInstagramMediaId({
        ...channelAccount,
        instagramMediaId: '18030000000000009',
      }),
    );
    const otherAccountsPost = await inOrganization(organization, () =>
      repository.findByInstagramMediaId({
        organizationId: organization.id,
        channelAccountId: channelAccount.channelAccountId + 1_000_000,
        instagramMediaId: '18030000000000001',
      }),
    );

    expect(found?.id).toBe(stored?.id);
    expect(found?.published_at.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(missing).toBeNull();
    expect(otherAccountsPost).toBeNull();
  });

  it("never mixes accounts: a media id stored under the organization's other account is left untouched (IA17, AC-3.8)", async () => {
    await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(channelAccount)),
    );
    await operatorQuery`
      UPDATE app.channel_accounts SET connection_status = 'revoked', disconnected_at = now()
      WHERE id = ${channelAccount.channelAccountId}`;
    const secondAccount = await connectAccount({
      organization,
      instagramUserId: '17841400000000002',
    });

    const result = await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(secondAccount, { caption: 'Hijacked' })),
    );

    expect(result).toBeNull();
    const rows = await operatorQuery<Array<{ channel_account_id: string; caption: string }>>`
      SELECT channel_account_id, caption FROM app.instagram_media
      WHERE organization_id = ${organization.id}`;
    expect(rows).toEqual([
      {
        channel_account_id: String(channelAccount.channelAccountId),
        caption: 'New drop this Friday — comment SHOP',
      },
    ]);
  });

  it("deletes only the account's posts, and names the organization in the statement (IA20)", async () => {
    await inOrganization(organization, () =>
      repository.upsertForAccount(mediaValues(channelAccount)),
    );
    await inOrganization(organization, () =>
      repository.upsertForAccount(
        mediaValues(channelAccount, { instagramMediaId: '18030000000000002' }),
      ),
    );
    const otherAccount = await connectAccount({
      organization: otherOrganization,
      instagramUserId: '17841400000000003',
    });
    await inOrganization(otherOrganization, () =>
      repository.upsertForAccount(mediaValues(otherAccount)),
    );

    // Another organization's id with this account's internal id deletes nothing.
    await expect(
      inOrganization(otherOrganization, () =>
        repository.deleteForAccount({
          organizationId: otherOrganization.id,
          channelAccountId: channelAccount.channelAccountId,
        }),
      ),
    ).resolves.toBe(0);
    await expect(
      inOrganization(organization, () => repository.deleteForAccount(channelAccount)),
    ).resolves.toBe(2);

    const remaining = await operatorQuery<Array<{ organization_id: string }>>`
      SELECT organization_id FROM app.instagram_media`;
    expect(remaining).toEqual([{ organization_id: String(otherOrganization.id) }]);
  });

  it("refuses a post that names another organization's account (composite key)", async () => {
    const error = await captureError(() =>
      inOrganization(otherOrganization, () =>
        repository.upsertForAccount(
          mediaValues({
            organizationId: otherOrganization.id,
            channelAccountId: channelAccount.channelAccountId,
          }),
        ),
      ),
    );

    expect(getPostgresErrorCode(error)).toBe('23503');
    expect(getPostgresConstraintName(error)).toBe('instagram_media_channel_account_fk');
  });

  it.each([
    [
      'a media id that is not digits',
      { instagramMediaId: 'abc123' },
      'chk_instagram_media_instagram_media_id',
    ],
    ['a negative count', { likeCount: -1 }, 'chk_instagram_media_counts'],
    [
      'a product type Meta does not send',
      { mediaProductType: 'igtv' as never },
      'chk_instagram_media_media_product_type',
    ],
    [
      'graph data that is not an object',
      { graphData: [] as never },
      'chk_instagram_media_graph_data_object',
    ],
  ])('refuses %s (CHECK)', async (_case, overrides, constraint) => {
    const error = await captureError(() =>
      inOrganization(organization, () =>
        repository.upsertForAccount(mediaValues(channelAccount, overrides)),
      ),
    );

    expect(getPostgresErrorCode(error)).toBe('23514');
    expect(getPostgresConstraintName(error)).toBe(constraint);
  });

  it('reads the due watch through its partial index — empty = not watched (2.C.3)', async () => {
    const rows = await operatorQuery<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'app' AND indexname = 'idx_instagram_media_comments_next_check'`;

    expect(rows[0]?.indexdef).toContain('(comments_next_check_at)');
    expect(rows[0]?.indexdef).toContain('WHERE (comments_next_check_at IS NOT NULL)');
  });
});
