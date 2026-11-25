import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import {
  DATABASE_APP_ROLE,
  DATABASE_MAINTENANCE_ROLE,
} from '@/shared/constants/project-identity.constants.js';
import { ConfigurationError } from '@/shared/errors/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  FIELD_SECRET_ROTATION_COLUMNS,
  assertConnectedRoleBypassesRowLevelSecurity,
  rotateFieldSecrets,
} from '@/scripts/ops/secrets-key-rotate.js';

const KEY_V1 = '11'.repeat(32);
const KEY_V2 = '22'.repeat(32);
const INSTAGRAM_TOKEN_COLUMN = 'app.channel_connection_tokens.encrypted_access_token';
const REFRESH_TOKEN_COLUMN = 'app.channel_connection_tokens.encrypted_refresh_token';
const OLD_TOKEN = 'EAAG-rotation-test-token-on-v1';
const CURRENT_TOKEN = 'EAAG-rotation-test-token-on-v2';

/**
 * The secrets-key rotation (`pnpm ops:secrets:rotate`): every `encryptFieldSecret` column moves
 * onto the current `SECRETS_ENCRYPTION` key version — the channel connection's tokens included
 * (launch D37, feat-instagram-dm-sending MC9, MC18), so a stored token still decrypts once the old key leaves the keyring. This lane's role
 * bypasses RLS, as the script's connection must.
 */
describe('rotateFieldSecrets', () => {
  const originalSecretsKeys = process.env.SECRETS_ENCRYPTION_KEYS;
  const originalCurrentVersion = process.env.SECRETS_ENCRYPTION_CURRENT_VERSION;

  function useKeyVersion(version: 'v1' | 'v2'): void {
    process.env.SECRETS_ENCRYPTION_KEYS = JSON.stringify({ v1: KEY_V1, v2: KEY_V2 });
    process.env.SECRETS_ENCRYPTION_CURRENT_VERSION = version;
    resetEnvCacheForTests();
  }

  function restoreEnvVar(name: string, original: string | undefined): void {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }

  /** A channel connection with its token stored as `ciphertext`; returns the token row id. */
  async function storeInstagramToken({
    instagramUserId,
    ciphertext,
  }: {
    instagramUserId: string;
    ciphertext: string;
  }): Promise<number> {
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const [connection] = await database
      .insert(channel_connections)
      .values({
        public_id: generatePublicId('channelConnection'),
        organization_id: organization.id,
        client_business_id: instagramUserId,
        config_id: '1234567890',
      })
      .returning({ id: channel_connections.id });
    const [token] = await database
      .insert(channel_connection_tokens)
      .values({
        organization_id: organization.id,
        channel_connection_id: connection!.id,
        encrypted_access_token: ciphertext,
      })
      .returning({ id: channel_connection_tokens.id });
    return token!.id;
  }

  async function readCiphertext(tokenId: number): Promise<string | undefined> {
    const [row] = await database
      .select({ stored: channel_connection_tokens.encrypted_access_token })
      .from(channel_connection_tokens)
      .where(eq(channel_connection_tokens.id, tokenId));
    return row?.stored;
  }

  beforeEach(async () => {
    await cleanupDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnvVar('SECRETS_ENCRYPTION_KEYS', originalSecretsKeys);
    restoreEnvVar('SECRETS_ENCRYPTION_CURRENT_VERSION', originalCurrentVersion);
    resetEnvCacheForTests();
  });

  it('walks the channel connection tokens with the other encrypted fields (D37)', () => {
    expect(FIELD_SECRET_ROTATION_COLUMNS.map(({ column }) => column)).toEqual([
      'auth.mfa_methods.encrypted_secret',
      'notify.webhooks.encrypted_secret',
      INSTAGRAM_TOKEN_COLUMN,
      REFRESH_TOKEN_COLUMN,
    ]);
  });

  it('re-encrypts an Instagram token onto the current version, leaving one already there alone', async () => {
    useKeyVersion('v1');
    const oldCiphertext = encryptFieldSecret(OLD_TOKEN);
    expect(oldCiphertext).toMatch(/^v1:/);
    const oldTokenId = await storeInstagramToken({
      instagramUserId: '17841400000000101',
      ciphertext: oldCiphertext,
    });
    useKeyVersion('v2');
    const currentCiphertext = encryptFieldSecret(CURRENT_TOKEN);
    const currentTokenId = await storeInstagramToken({
      instagramUserId: '17841400000000102',
      ciphertext: currentCiphertext,
    });

    // Dry run: reports the one old row and writes nothing.
    const dryRun = await rotateFieldSecrets({ apply: false });
    expect(dryRun).toEqual({
      apply: false,
      currentVersion: 'v2',
      updatedByColumn: {
        'auth.mfa_methods.encrypted_secret': 0,
        'notify.webhooks.encrypted_secret': 0,
        [INSTAGRAM_TOKEN_COLUMN]: 1,
        [REFRESH_TOKEN_COLUMN]: 0,
      },
    });
    expect(await readCiphertext(oldTokenId)).toBe(oldCiphertext);

    // Apply: the old row moves to v2 and still holds the same token.
    const applied = await rotateFieldSecrets({ apply: true });
    expect(applied.updatedByColumn[INSTAGRAM_TOKEN_COLUMN]).toBe(1);
    const rotatedCiphertext = await readCiphertext(oldTokenId);
    expect(rotatedCiphertext).toMatch(/^v2:/);
    expect(decryptFieldSecret(rotatedCiphertext as string)).toBe(OLD_TOKEN);
    expect(await readCiphertext(currentTokenId)).toBe(currentCiphertext);

    // The old key can now leave the keyring: the rotated token decrypts with v2 alone.
    process.env.SECRETS_ENCRYPTION_KEYS = JSON.stringify({ v2: KEY_V2 });
    resetEnvCacheForTests();
    expect(decryptFieldSecret(rotatedCiphertext as string)).toBe(OLD_TOKEN);

    // A second pass finds nothing left to rotate.
    useKeyVersion('v2');
    const rerun = await rotateFieldSecrets({ apply: true });
    expect(rerun.updatedByColumn[INSTAGRAM_TOKEN_COLUMN]).toBe(0);
  });

  describe('the connected role (D56)', () => {
    it('accepts the role this lane connects with, which bypasses row-level security', async () => {
      await expect(assertConnectedRoleBypassesRowLevelSecurity()).resolves.toBeUndefined();
    });

    it.each([[DATABASE_APP_ROLE], [DATABASE_MAINTENANCE_ROLE]])(
      'refuses %s, which is subject to row-level security',
      async (role) => {
        await database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);

          const failure = await assertConnectedRoleBypassesRowLevelSecurity(transaction).then(
            () => null,
            (error: unknown) => error,
          );

          expect(failure).toBeInstanceOf(ConfigurationError);
          expect((failure as ConfigurationError).message).toContain(role);
        });
      },
    );

    it.each([[true], [false]])(
      'stops before it reads a value when the role cannot bypass it (apply: %s)',
      async (apply) => {
        useKeyVersion('v1');
        const oldCiphertext = encryptFieldSecret(OLD_TOKEN);
        const tokenId = await storeInstagramToken({
          instagramUserId: '17841400000000103',
          ciphertext: oldCiphertext,
        });
        useKeyVersion('v2');
        vi.spyOn(database, 'execute').mockResolvedValueOnce({
          rows: [{ role_name: DATABASE_APP_ROLE, bypasses_row_level_security: false }],
        } as never);
        const readStoredValues = vi.spyOn(FIELD_SECRET_ROTATION_COLUMNS[0]!, 'readStoredValues');

        await expect(rotateFieldSecrets({ apply })).rejects.toBeInstanceOf(ConfigurationError);

        expect(readStoredValues).not.toHaveBeenCalled();
        expect(await readCiphertext(tokenId)).toBe(oldCiphertext);
      },
    );
  });
});
