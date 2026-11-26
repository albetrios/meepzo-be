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
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import { ChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';

/**
 * `app.instagram_accounts`, the 1:1 Instagram extension of a channel account, through its repository
 * (feat-instagram-dm-sending routes-final § 2.A.3, IA8, IAC6 — ROUTE row R6): every read carries the
 * channel account's public id, status and connection; the extension holds none of them. Every
 * statement runs inside the organization's own database context — the way the services run it, so
 * the suite also holds under `pnpm test:rls-role`.
 */

const INSTAGRAM_USER_ID = '17841400000000001';
const OTHER_INSTAGRAM_USER_ID = '17841400000000002';

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

describe('InstagramAccountRepository (database)', () => {
  const repository = new InstagramAccountRepository();
  const channelAccountRepository = new ChannelAccountRepository();
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
  });

  /** A channel account (as the pick leaves it) and its Instagram extension written by the pick. */
  async function pickAccount({
    owner = organization,
    instagramUserId = INSTAGRAM_USER_ID,
    connectionStatus = 'connected',
  }: {
    owner?: TestOrganization;
    instagramUserId?: string;
    connectionStatus?: 'connected' | 'error' | 'revoked';
  } = {}) {
    const channelAccount = await insertChannelAccount({
      organizationId: owner.id,
      providerAccountId: instagramUserId,
      connectionStatus,
    });
    const account = await inOrganization(owner, () =>
      repository.upsertAtPick(
        buildInstagramPickValues({
          organizationId: owner.id,
          channelAccountId: channelAccount.id,
          instagramUserId,
          username: 'meepzo_shop',
          biography: 'Handmade things',
          followersCount: 120,
          accountType: 'business',
          isPrivate: true,
        }),
      ),
    );
    return {
      channelAccount,
      account,
      key: { organizationId: owner.id, instagramAccountId: account.id },
    };
  }

  it('writes the extension at the pick and reads it with its channel account (IA8)', async () => {
    const { channelAccount, account } = await pickAccount();

    expect(account).toMatchObject({
      channel_account_id: channelAccount.id,
      instagram_user_id: INSTAGRAM_USER_ID,
      username: 'meepzo_shop',
      account_type: 'business',
      is_private: true,
      followers_count: 120,
      starter_questions_set_at: null,
      webhook_subscribed_at: null,
      profile_erased_at: null,
      // The channel account's columns (the extension holds none, R6).
      public_id: channelAccount.public_id,
      connection_status: 'connected',
      channel_connection_id: channelAccount.channel_connection_id,
    });
    expect(account.public_id).toMatch(publicIdPatternFor('channelAccount'));
    expect(account.profile_synced_at).toBeInstanceOf(Date);
    const [columns] = await operatorQuery<Array<{ names: string[] }>>`
      SELECT array_agg(column_name::text) AS names FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'instagram_accounts'`;
    for (const moved of [
      'public_id',
      'connection_status',
      'connection_status_changed_at',
      'connected_by_user_id',
      'connected_at',
      'disconnected_at',
      'name',
      'instagram_app_user_id',
      'scopes',
      'token_expires_at',
    ]) {
      expect(columns?.names).not.toContain(moved);
    }
  });

  it('brings the same row back on a later pick: profile updated, erase mark cleared, stamps kept', async () => {
    const { channelAccount, account, key } = await pickAccount();
    await inOrganization(organization, () => repository.recordWebhookSubscribed(key));
    await inOrganization(organization, () =>
      channelAccountRepository.revoke({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
      }),
    );
    await inOrganization(organization, () => repository.eraseProfile(key));

    const again = await inOrganization(organization, () =>
      repository.upsertAtPick(
        buildInstagramPickValues({
          organizationId: organization.id,
          channelAccountId: channelAccount.id,
          instagramUserId: INSTAGRAM_USER_ID,
          username: 'meepzo_shop_renamed',
          followersCount: 300,
        }),
      ),
    );

    expect(again.id).toBe(account.id);
    expect(again).toMatchObject({
      username: 'meepzo_shop_renamed',
      followers_count: 300,
      profile_erased_at: null,
    });
    expect(again.webhook_subscribed_at).toBeInstanceOf(Date);
  });

  it('holds one extension per channel account (1:1, idx_instagram_accounts_channel_account)', async () => {
    const { channelAccount } = await pickAccount();
    const error = await captureError(() =>
      inOrganization(organization, () =>
        repository.upsertAtPick(
          buildInstagramPickValues({
            organizationId: organization.id,
            channelAccountId: channelAccount.id,
            instagramUserId: OTHER_INSTAGRAM_USER_ID,
          }),
        ),
      ),
    );
    expect(getPostgresErrorCode(error)).toBe('23505');
    expect(getPostgresConstraintName(error)).toBe('idx_instagram_accounts_channel_account');
  });

  it('refuses an account type Meta does not have and a username emptied without the erasure', async () => {
    const { key } = await pickAccount();
    const typeError = await captureError(
      () =>
        operatorQuery`UPDATE app.instagram_accounts SET account_type = 'personal'
        WHERE id = ${key.instagramAccountId}`,
    );
    expect(getPostgresConstraintName(typeError)).toBe('chk_instagram_accounts_account_type');
    const usernameError = await captureError(
      () =>
        operatorQuery`UPDATE app.instagram_accounts SET username = NULL
        WHERE id = ${key.instagramAccountId}`,
    );
    expect(getPostgresConstraintName(usernameError)).toBe(
      'chk_instagram_accounts_username_unless_erased',
    );
  });

  it("reads the organization's live accounts, oldest connected first; a revoked one is not live", async () => {
    const first = await pickAccount();
    const second = await pickAccount({ instagramUserId: OTHER_INSTAGRAM_USER_ID });
    await pickAccount({ instagramUserId: '17841400000000003', connectionStatus: 'revoked' });

    const live = await inOrganization(organization, () =>
      repository.listLiveByOrganizationId(organization.id),
    );
    expect(live.map((row) => row.id)).toEqual([first.account.id, second.account.id]);
    await expect(
      inOrganization(organization, () => repository.findLiveByOrganizationId(organization.id)),
    ).resolves.toMatchObject({ id: first.account.id });
    await expect(
      inOrganization(otherOrganization, () =>
        repository.findLiveByOrganizationId(otherOrganization.id),
      ),
    ).resolves.toBeNull();
  });

  it('clears the webhook stamp on a revoke and stamps only while the channel account is live', async () => {
    const { channelAccount, key } = await pickAccount();
    await expect(
      inOrganization(organization, () => repository.recordWebhookSubscribed(key)),
    ).resolves.toBe(true);
    await expect(
      inOrganization(organization, () => repository.clearWebhookSubscription(key)),
    ).resolves.toBe(true);
    await expect(
      inOrganization(organization, () => repository.clearWebhookSubscription(key)),
    ).resolves.toBe(false);

    await inOrganization(organization, () =>
      channelAccountRepository.revoke({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
      }),
    );
    await expect(
      inOrganization(organization, () => repository.recordWebhookSubscribed(key)),
    ).resolves.toBe(false);
  });

  it('flags missing messaging webhooks once, only while subscribed and live, and clears the flag with a messaging item or the stamp (P358)', async () => {
    const { channelAccount, key } = await pickAccount();
    const readMarks = () => inOrganization(organization, () => repository.findById(key));

    // Not subscribed yet: nothing to flag.
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookMissing(key)),
    ).resolves.toBe(false);

    await inOrganization(organization, () => repository.recordWebhookSubscribed(key));
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookMissing(key)),
    ).resolves.toBe(true);
    // Once: a second check in between does not flag again (the one notice).
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookMissing(key)),
    ).resolves.toBe(false);
    expect((await readMarks())?.messages_webhook_missing_at).toBeInstanceOf(Date);

    // A messaging item: seen now, flag emptied.
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookSeen(key)),
    ).resolves.toBe(true);
    const seen = await readMarks();
    expect(seen?.messages_webhook_missing_at).toBeNull();
    expect(seen?.messages_webhook_seen_at).toBeInstanceOf(Date);

    // The stamp cleared (a lost field, a revoke) empties a new flag too.
    await inOrganization(organization, () => repository.recordMessagesWebhookMissing(key));
    await inOrganization(organization, () => repository.clearWebhookSubscription(key));
    expect((await readMarks())?.messages_webhook_missing_at).toBeNull();

    // A revoked account is never flagged nor marked.
    await inOrganization(organization, () => repository.recordWebhookSubscribed(key));
    await inOrganization(organization, () =>
      channelAccountRepository.revoke({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
      }),
    );
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookMissing(key)),
    ).resolves.toBe(false);
    await expect(
      inOrganization(organization, () => repository.recordMessagesWebhookSeen(key)),
    ).resolves.toBe(false);
  });

  it('erases the profile of a revoked account only, once (IA20, D54)', async () => {
    const { channelAccount, key } = await pickAccount();
    await expect(
      inOrganization(organization, () => repository.eraseProfile(key)),
    ).resolves.toBeNull();
    await inOrganization(organization, () =>
      channelAccountRepository.revoke({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
      }),
    );

    const erased = await inOrganization(organization, () => repository.eraseProfile(key));
    expect(erased).toMatchObject({
      username: null,
      biography: null,
      website: null,
      profile_picture_url: null,
      account_type: null,
      is_private: false,
      followers_count: 0,
      follows_count: 0,
      media_count: 0,
      connection_status: 'revoked',
    });
    expect(erased?.profile_erased_at).toBeInstanceOf(Date);
    await expect(
      inOrganization(organization, () => repository.eraseProfile(key)),
    ).resolves.toBeNull();
  });

  it('refreshes the profile while live and of the same Instagram account only', async () => {
    const { channelAccount, key } = await pickAccount();
    const profile = {
      username: null,
      biography: 'New bio',
      website: null,
      profilePictureUrl: null,
      followersCount: 999,
      followsCount: null,
      mediaCount: null,
    };
    await expect(
      inOrganization(organization, () =>
        repository.recordProfileRefresh({
          ...key,
          instagramUserId: OTHER_INSTAGRAM_USER_ID,
          profile,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      inOrganization(organization, () =>
        repository.recordProfileRefresh({ ...key, instagramUserId: INSTAGRAM_USER_ID, profile }),
      ),
    ).resolves.toBe(true);
    await expect(
      inOrganization(organization, () => repository.findById(key)),
    ).resolves.toMatchObject({
      username: 'meepzo_shop',
      biography: 'New bio',
      followers_count: 999,
    });

    await inOrganization(organization, () =>
      channelAccountRepository.revoke({
        organizationId: organization.id,
        channelAccountId: channelAccount.id,
      }),
    );
    await expect(
      inOrganization(organization, () =>
        repository.recordProfileRefresh({ ...key, instagramUserId: INSTAGRAM_USER_ID, profile }),
      ),
    ).resolves.toBe(false);
  });

  it("locks the organization's rows of one provider account id, any status (Meta's callbacks, MC15)", async () => {
    const own = await pickAccount({ connectionStatus: 'revoked' });
    await pickAccount({ instagramUserId: OTHER_INSTAGRAM_USER_ID });
    await pickAccount({ owner: otherOrganization });

    const locked = await inOrganization(organization, () =>
      repository.lockByProviderAccountInOrganization({
        organizationPublicId: organization.public_id,
        providerAccountId: INSTAGRAM_USER_ID,
      }),
    );
    expect(locked.map((row) => row.id)).toEqual([own.account.id]);
    expect(locked[0]?.connection_status).toBe('revoked');
  });

  it("locks the not-revoked rows of the organization's named connections (Meta's business match, MC15)", async () => {
    const live = await pickAccount();
    await pickAccount({ instagramUserId: OTHER_INSTAGRAM_USER_ID, connectionStatus: 'revoked' });
    await pickAccount({ owner: otherOrganization, connectionStatus: 'revoked' });

    const locked = await inOrganization(organization, () =>
      repository.lockLiveByConnections({
        organizationId: organization.id,
        channelConnectionIds: [live.channelAccount.channel_connection_id],
      }),
    );
    expect(locked.map((row) => row.id)).toEqual([live.account.id]);
    await expect(
      inOrganization(organization, () =>
        repository.lockLiveByConnections({
          organizationId: organization.id,
          channelConnectionIds: [],
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('locks every row of the organization for its delete (D54, IAC5)', async () => {
    const first = await pickAccount();
    const second = await pickAccount({
      instagramUserId: OTHER_INSTAGRAM_USER_ID,
      connectionStatus: 'revoked',
    });
    await pickAccount({ owner: otherOrganization, instagramUserId: '17841400000000003' });

    const locked = await inOrganization(organization, () =>
      repository.lockByOrganizationId(organization.id),
    );
    expect(locked.map((row) => row.id)).toEqual([first.account.id, second.account.id]);
  });

  it("finds an account by its channel account's public id, only in its own organization", async () => {
    const { account } = await pickAccount();
    await expect(
      inOrganization(organization, () =>
        repository.findByPublicIdInOrganization({
          organizationPublicId: organization.public_id,
          instagramAccountPublicId: account.public_id,
        }),
      ),
    ).resolves.toMatchObject({ id: account.id });
    await expect(
      inOrganization(otherOrganization, () =>
        repository.findByPublicIdInOrganization({
          organizationPublicId: otherOrganization.public_id,
          instagramAccountPublicId: account.public_id,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('names the organization in every statement: another organization’s key finds nothing', async () => {
    // The repository's own organization filter, independent of RLS (which this lane's role
    // bypasses; the app-role isolation is instagram-account-resolvers.security.test.ts and the
    // RLS matrix).
    const { account } = await pickAccount();
    const mismatchedKey = { organizationId: otherOrganization.id, instagramAccountId: account.id };

    await expect(
      inOrganization(otherOrganization, () => repository.findById(mismatchedKey)),
    ).resolves.toBeNull();
    await expect(
      inOrganization(otherOrganization, () => repository.clearWebhookSubscription(mismatchedKey)),
    ).resolves.toBe(false);
    await expect(
      inOrganization(otherOrganization, () => repository.eraseProfile(mismatchedKey)),
    ).resolves.toBeNull();
  });

  it('resolves the organization of a live Instagram account through the channel account (IA6)', async () => {
    await pickAccount();
    await pickAccount({
      owner: otherOrganization,
      instagramUserId: OTHER_INSTAGRAM_USER_ID,
      connectionStatus: 'revoked',
    });

    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(INSTAGRAM_USER_ID),
    ).resolves.toBe(organization.public_id);
    await expect(
      repository.resolveOrganizationPublicIdForInstagramUser(OTHER_INSTAGRAM_USER_ID),
    ).resolves.toBeNull();
    await expect(
      new ChannelConnectionRepository().resolveOrganizationPublicIdsForProviderAccount({
        provider: 'meta',
        providerAccountId: OTHER_INSTAGRAM_USER_ID,
      }),
    ).resolves.toEqual([otherOrganization.public_id]);
  });

  it('refuses a token that names another organization’s connection (composite key)', async () => {
    const connection = await insertChannelConnection({ organizationId: organization.id });
    const tokenRepository = new ChannelConnectionTokenRepository();
    const error = await captureError(() =>
      inOrganization(otherOrganization, () =>
        tokenRepository.upsert({
          organizationId: otherOrganization.id,
          channelConnectionId: connection.id,
          encryptedAccessToken: 'v1:composite-key-placeholder',
          encryptedRefreshToken: null,
          tokenType: 'system_user',
          expiresAt: null,
        }),
      ),
    );
    expect(getPostgresErrorCode(error)).toBe('23503');
    expect(getPostgresConstraintName(error)).toBe(
      'channel_connection_tokens_channel_connection_fk',
    );
  });
});
