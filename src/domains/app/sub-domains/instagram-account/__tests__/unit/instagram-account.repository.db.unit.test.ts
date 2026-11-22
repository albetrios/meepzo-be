import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import {
  InstagramAccountRepository,
  type InstagramAccountConnectValues,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountTokenRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.repository.js';
import { INSTAGRAM_ACCOUNT_UNIQUE_INDEXES } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';

/**
 * `app.instagram_accounts` through its repository (routes-final § 1.A.3, IA9, IA11, IA14, IA20),
 * every statement inside the organization's own database context — the way the services run it,
 * so the suite also holds under `pnpm test:rls-role`.
 */

const INSTAGRAM_USER_ID = '17841400000000001';
const OTHER_INSTAGRAM_USER_ID = '17841400000000002';

type TestOrganization = { id: number; public_id: string };

function connectValues(
  organization: TestOrganization,
  overrides: Partial<InstagramAccountConnectValues> = {},
): InstagramAccountConnectValues {
  return {
    organizationId: organization.id,
    instagramUserId: INSTAGRAM_USER_ID,
    instagramAppUserId: `9${INSTAGRAM_USER_ID}`,
    username: 'meepzo_shop',
    name: 'Acme Shop',
    biography: 'Handmade things',
    website: 'https://example.com',
    profilePictureUrl: 'https://cdn.example.com/picture.jpg',
    followersCount: 120,
    followsCount: 15,
    mediaCount: 42,
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    connectedByUserId: null,
    ...overrides,
  };
}

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
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let userId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const user = await createTestUser();
    userId = user.id;
    organization = await createTestOrganization({ ownerUserId: user.id });
    otherOrganization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
  });

  it('inserts a first connect as a new connection with an iga_ public id', async () => {
    const result = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization, { connectedByUserId: userId })),
    );

    expect(result.isNewConnection).toBe(true);
    expect(result.account.public_id).toMatch(publicIdPatternFor('instagramAccount'));
    expect(result.account).toMatchObject({
      organization_id: organization.id,
      instagram_user_id: INSTAGRAM_USER_ID,
      connection_status: 'connected',
      connected_by_user_id: userId,
      disconnected_at: null,
      webhook_subscribed_at: null,
      scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    });
    expect(result.account.profile_synced_at).toBeInstanceOf(Date);
    await expect(
      inOrganization(organization, () => repository.findLiveByOrganizationId(organization.id)),
    ).resolves.toMatchObject({ id: result.account.id });
  });

  it('reuses the row when the same Instagram account reconnects after a disconnect (IA11)', async () => {
    const first = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const key = { organizationId: organization.id, instagramAccountId: first.account.id };
    await inOrganization(organization, () => repository.recordWebhookSubscribed(key));
    const revoked = await inOrganization(organization, () => repository.revoke(key));
    expect(revoked).toMatchObject({
      connection_status: 'revoked',
      token_expires_at: null,
      webhook_subscribed_at: null,
      username: 'meepzo_shop',
    });
    expect(revoked?.disconnected_at).toBeInstanceOf(Date);
    await expect(
      inOrganization(organization, () => repository.findLiveByOrganizationId(organization.id)),
    ).resolves.toBeNull();

    const second = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization, { username: 'meepzo_shop_new' })),
    );

    expect(second.isNewConnection).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.public_id).toBe(first.account.public_id);
    expect(second.account).toMatchObject({
      connection_status: 'connected',
      username: 'meepzo_shop_new',
      disconnected_at: null,
      profile_erased_at: null,
      webhook_subscribed_at: null,
    });
    expect(second.account.connection_status_changed_at.getTime()).toBeGreaterThanOrEqual(
      revoked!.connection_status_changed_at.getTime(),
    );
  });

  it('keeps the status timestamp when a connected account connects again', async () => {
    const first = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const again = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    expect(again.isNewConnection).toBe(false);
    expect(again.account.connection_status_changed_at).toEqual(
      first.account.connection_status_changed_at,
    );
  });

  it('refuses a second not-revoked account in one organization (D5)', async () => {
    await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const error = await captureError(() =>
      inOrganization(organization, () =>
        repository.upsertConnected(
          connectValues(organization, {
            instagramUserId: OTHER_INSTAGRAM_USER_ID,
            instagramAppUserId: `9${OTHER_INSTAGRAM_USER_ID}`,
          }),
        ),
      ),
    );
    expect(getPostgresErrorCode(error)).toBe('23505');
    expect(getPostgresConstraintName(error)).toBe(
      INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.organizationLive,
    );
  });

  it('refuses an Instagram account that is not revoked in another organization', async () => {
    await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const error = await captureError(() =>
      inOrganization(otherOrganization, () =>
        repository.upsertConnected(connectValues(otherOrganization)),
      ),
    );
    expect(getPostgresErrorCode(error)).toBe('23505');
    expect(getPostgresConstraintName(error)).toBe(
      INSTAGRAM_ACCOUNT_UNIQUE_INDEXES.instagramUserLive,
    );
  });

  it('moves a connected account to expired once — the second caller gets null (IA9)', async () => {
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const key = { organizationId: organization.id, instagramAccountId: account.id };

    const broken = await inOrganization(organization, () =>
      repository.markConnectionBroken({ ...key, connectionStatus: 'expired' }),
    );
    expect(broken?.connection_status).toBe('expired');
    expect(broken!.connection_status_changed_at.getTime()).toBeGreaterThanOrEqual(
      account.connection_status_changed_at.getTime(),
    );
    await expect(
      inOrganization(organization, () =>
        repository.markConnectionBroken({ ...key, connectionStatus: 'error' }),
      ),
    ).resolves.toBeNull();
    // An expired account is still the organization's live account (the reconnect card).
    await expect(
      inOrganization(organization, () => repository.findLiveByOrganizationId(organization.id)),
    ).resolves.toMatchObject({ connection_status: 'expired' });
  });

  it('revokes once and erases the profile of a revoked account only (IA14, IA20)', async () => {
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const key = { organizationId: organization.id, instagramAccountId: account.id };

    await expect(
      inOrganization(organization, () => repository.eraseProfile(key)),
    ).resolves.toBeNull();
    await inOrganization(organization, () => repository.revoke(key));
    await expect(inOrganization(organization, () => repository.revoke(key))).resolves.toBeNull();

    const erased = await inOrganization(organization, () => repository.eraseProfile(key));
    expect(erased).toMatchObject({
      username: null,
      name: null,
      biography: null,
      website: null,
      profile_picture_url: null,
      followers_count: 0,
      follows_count: 0,
      media_count: 0,
      scopes: [],
      connection_status: 'revoked',
    });
    expect(erased?.profile_erased_at).toBeInstanceOf(Date);
    await expect(
      inOrganization(organization, () => repository.recordWebhookSubscribed(key)),
    ).resolves.toBe(false);
    // Meta repeating its data deletion finds the profile already erased (R6): nothing changes.
    await expect(
      inOrganization(organization, () => repository.eraseProfile(key)),
    ).resolves.toBeNull();
  });

  it('erases the profile again after a reconnect cleared profile_erased_at (IA20)', async () => {
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const key = { organizationId: organization.id, instagramAccountId: account.id };
    await inOrganization(organization, () => repository.revoke(key));
    await inOrganization(organization, () => repository.eraseProfile(key));
    await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    await inOrganization(organization, () => repository.revoke(key));

    const erasedAgain = await inOrganization(organization, () => repository.eraseProfile(key));

    expect(erasedAgain).toMatchObject({ username: null, connection_status: 'revoked' });
  });

  it('lists the organization’s accounts of one app-scoped id, any status, never another organization’s (IA19)', async () => {
    // A revoked row and a live row of the same app-scoped id in one organization (one live row at a
    // time, D5): both are listed.
    const { account: revoked } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    await inOrganization(organization, () =>
      repository.revoke({ organizationId: organization.id, instagramAccountId: revoked.id }),
    );
    const { account: live } = await inOrganization(organization, () =>
      repository.upsertConnected(
        connectValues(organization, {
          instagramUserId: OTHER_INSTAGRAM_USER_ID,
          instagramAppUserId: `9${INSTAGRAM_USER_ID}`,
        }),
      ),
    );
    await inOrganization(otherOrganization, () =>
      repository.upsertConnected(
        connectValues(otherOrganization, { instagramUserId: '17841400000000003' }),
      ),
    );

    const rows = await inOrganization(organization, () =>
      repository.lockByInstagramAppUserInOrganization({
        organizationPublicId: organization.public_id,
        instagramAppUserId: `9${INSTAGRAM_USER_ID}`,
      }),
    );

    expect(rows.map((row) => [row.id, row.connection_status])).toEqual([
      [revoked.id, 'revoked'],
      [live.id, 'connected'],
    ]);
    expect(rows.every((row) => row.organization_id === organization.id)).toBe(true);
    // The organization's delete takes every account of the organization (D54).
    const everyRow = await inOrganization(organization, () =>
      repository.lockByOrganizationId(organization.id),
    );
    expect(everyRow.map((row) => row.id)).toEqual([revoked.id, live.id]);
    await expect(
      inOrganization(organization, () =>
        repository.lockByInstagramAppUserInOrganization({
          organizationPublicId: organization.public_id,
          instagramAppUserId: '91111111111111111',
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('holds the account rows it read until the unit ends, so a reconnect waits and connects on top (D53)', async () => {
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const order: string[] = [];
    let releaseMetaUnit: () => void = () => undefined;
    const metaUnitMayEnd = new Promise<void>((resolve) => {
      releaseMetaUnit = resolve;
    });
    let metaUnitHoldsTheRow: () => void = () => undefined;
    const metaUnitStarted = new Promise<void>((resolve) => {
      metaUnitHoldsTheRow = resolve;
    });

    const metaUnit = inOrganization(organization, async () => {
      await repository.lockByInstagramAppUserInOrganization({
        organizationPublicId: organization.public_id,
        instagramAppUserId: `9${INSTAGRAM_USER_ID}`,
      });
      metaUnitHoldsTheRow();
      await metaUnitMayEnd;
      await repository.revoke({ organizationId: organization.id, instagramAccountId: account.id });
      order.push('revoked');
    });
    await metaUnitStarted;
    const reconnect = inOrganization(organization, async () => {
      await repository.upsertConnected(connectValues(organization));
      order.push('reconnected');
    });
    releaseMetaUnit();
    await Promise.all([metaUnit, reconnect]);

    expect(order).toEqual(['revoked', 'reconnected']);
    const row = await inOrganization(organization, () =>
      repository.findById({ organizationId: organization.id, instagramAccountId: account.id }),
    );
    expect(row?.connection_status).toBe('connected');
  });

  it('names the organization in every statement: another organization’s key finds nothing', async () => {
    // The repository's own organization filter, independent of RLS (which this lane's role
    // bypasses; the app-role isolation is instagram-account-resolvers.security.test.ts and the
    // RLS matrix).
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const mismatchedKey = { organizationId: otherOrganization.id, instagramAccountId: account.id };

    await expect(
      inOrganization(otherOrganization, () => repository.findById(mismatchedKey)),
    ).resolves.toBeNull();
    await expect(
      inOrganization(otherOrganization, () => repository.revoke(mismatchedKey)),
    ).resolves.toBeNull();
    await expect(
      inOrganization(otherOrganization, () =>
        repository.markConnectionBroken({ ...mismatchedKey, connectionStatus: 'error' }),
      ),
    ).resolves.toBeNull();
    await expect(
      inOrganization(otherOrganization, () =>
        repository.findLiveByOrganizationId(otherOrganization.id),
      ),
    ).resolves.toBeNull();
    await expect(
      inOrganization(organization, () =>
        repository.findById({ organizationId: organization.id, instagramAccountId: account.id }),
      ),
    ).resolves.toMatchObject({ connection_status: 'connected' });
  });

  it('refuses a token that names another organization’s account (composite key)', async () => {
    const { account } = await inOrganization(organization, () =>
      repository.upsertConnected(connectValues(organization)),
    );
    const tokenRepository = new InstagramAccountTokenRepository();
    const error = await captureError(() =>
      inOrganization(otherOrganization, () =>
        tokenRepository.upsert({
          organizationId: otherOrganization.id,
          instagramAccountId: account.id,
          encryptedAccessToken: 'v1:composite-key-placeholder',
          expiresAt: new Date(),
        }),
      ),
    );
    expect(getPostgresErrorCode(error)).toBe('23503');
    expect(getPostgresConstraintName(error)).toBe('instagram_account_tokens_instagram_account_fk');
  });
});
