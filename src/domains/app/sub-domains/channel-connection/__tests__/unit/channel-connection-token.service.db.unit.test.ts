import { beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import { ChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import { insertChannelConnection } from '@/domains/app/sub-domains/channel-connection/__tests__/factories/channel-connection.factory.js';

/**
 * The connection's token service against the database (routes-final § 1 MC9, MC18, MCC11): a
 * token stored, read, replaced; a refresh token stored as ciphertext (empty for Meta); another
 * organization's scope sees none; a revoke deletes the token with the connection. Every call runs in
 * the organization's own scope, so the suite also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string };

describe('ChannelConnectionTokenService (database)', () => {
  const service = new ChannelConnectionTokenService(
    new ChannelConnectionTokenRepository(),
    new ChannelConnectionRepository(),
  );
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let channelConnection: { organizationId: number; channelConnectionId: number };

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const connection = await insertChannelConnection({
      organizationId: organization.id,
      plainToken: null,
    });
    channelConnection = { organizationId: organization.id, channelConnectionId: connection.id };
  });

  const scopeOf = (target: TestOrganization) =>
    PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: target.public_id });

  it('stores a system-user token and no refresh token for Meta, replaces it, and reads it back', async () => {
    await service.storeAccessToken({
      scope: scopeOf(organization),
      channelConnection,
      token: {
        encryptedAccessToken: encryptFieldSecret('EAAG-first'),
        encryptedRefreshToken: null,
        tokenType: 'system_user',
        expiresAt: null,
      },
    });
    await service.storeAccessToken({
      scope: scopeOf(organization),
      channelConnection,
      token: {
        encryptedAccessToken: encryptFieldSecret('EAAG-second'),
        encryptedRefreshToken: null,
        tokenType: 'system_user',
        expiresAt: null,
      },
    });

    const token = await service.findAccessToken({
      scope: scopeOf(organization),
      channelConnection,
    });
    expect(token).toMatchObject({
      encryptedRefreshToken: null,
      tokenType: 'system_user',
      expiresAt: null,
    });
    expect(decryptFieldSecret(token?.encryptedAccessToken ?? '')).toBe('EAAG-second');
    // Another organization's key names no token (RLS adds the same wall under `pnpm test:rls-role`).
    await expect(
      service.findAccessToken({
        scope: scopeOf(otherOrganization),
        channelConnection: { ...channelConnection, organizationId: otherOrganization.id },
      }),
    ).resolves.toBeNull();
  });

  it('stores an OAuth user token with its refresh token as ciphertext only (MC18)', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await service.storeAccessToken({
      scope: scopeOf(organization),
      channelConnection,
      token: {
        encryptedAccessToken: encryptFieldSecret('oauth-access'),
        encryptedRefreshToken: encryptFieldSecret('oauth-refresh'),
        tokenType: 'oauth_user',
        expiresAt,
      },
    });

    const [row] = await operatorQuery<
      Array<{ encrypted_refresh_token: string; token_type: string }>
    >`
      SELECT encrypted_refresh_token, token_type FROM app.channel_connection_tokens
      WHERE channel_connection_id = ${channelConnection.channelConnectionId}`;
    expect(row?.token_type).toBe('oauth_user');
    expect(row?.encrypted_refresh_token).not.toContain('oauth-refresh');
    expect(decryptFieldSecret(row?.encrypted_refresh_token ?? '')).toBe('oauth-refresh');
  });

  it('refuses an empty refresh token (chk_channel_connection_tokens_encrypted_refresh_token_not_empty)', async () => {
    await expect(
      service.storeAccessToken({
        scope: scopeOf(organization),
        channelConnection,
        token: {
          encryptedAccessToken: encryptFieldSecret('oauth-access'),
          encryptedRefreshToken: '',
          tokenType: 'oauth_user',
          expiresAt: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('revokes the connection and deletes its token; a second revoke reports it was not live', async () => {
    await service.storeAccessToken({
      scope: scopeOf(organization),
      channelConnection,
      token: {
        encryptedAccessToken: encryptFieldSecret('EAAG-token'),
        encryptedRefreshToken: null,
        tokenType: 'system_user',
        expiresAt: null,
      },
    });

    await expect(
      service.revokeConnection({ scope: scopeOf(organization), channelConnection }),
    ).resolves.toBe(true);
    await expect(
      service.revokeConnection({ scope: scopeOf(organization), channelConnection }),
    ).resolves.toBe(false);

    const [connection] = await operatorQuery<
      Array<{ status: string; disconnected_at: Date | null }>
    >`
      SELECT status, disconnected_at FROM app.channel_connections
      WHERE id = ${channelConnection.channelConnectionId}`;
    expect(connection?.status).toBe('revoked');
    expect(connection?.disconnected_at).not.toBeNull();
    await expect(
      service.findAccessToken({ scope: scopeOf(organization), channelConnection }),
    ).resolves.toBeNull();
  });
});
