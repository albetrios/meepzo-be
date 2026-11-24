import { faker } from '@faker-js/faker';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { PROFILES } from '@/scripts/seed/bulk-config.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { composeContributions } from '@/scripts/seed/seed-contract.js';
import { channel_connections } from '@/domains/app/sub-domains/channel-connection/channel-connection.schema.js';
import { channel_connection_tokens } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.schema.js';
import { META_REQUIRED_PERMISSIONS } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import { channelConnectionSeedContribution } from '@/domains/app/sub-domains/channel-connection/seed/index.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { instagramAccountSeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';

/** The connection seed, then the account seed — the app domain's order. */
const connectionAndAccountSeed = composeContributions(
  channelConnectionSeedContribution,
  instagramAccountSeedContribution,
);

/**
 * The channel connection and Instagram account bulk seeds (launch IAC10, feat-instagram-dm-sending
 * MCC7) against the real schema: each registry team organization gets one connection with a token
 * that is `encryptFieldSecret` ciphertext, a connected account through it and the default settings —
 * and a second run writes nothing new.
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

async function rowsOf(organizationId: number) {
  const accounts = await database
    .select()
    .from(instagram_accounts)
    .where(eq(instagram_accounts.organization_id, organizationId));
  const connections = await database
    .select()
    .from(channel_connections)
    .where(eq(channel_connections.organization_id, organizationId));
  const tokens = await database
    .select()
    .from(channel_connection_tokens)
    .where(eq(channel_connection_tokens.organization_id, organizationId));
  const settings = await database
    .select()
    .from(instagram_account_settings)
    .where(eq(instagram_account_settings.organization_id, organizationId));
  return { connections, accounts, tokens, settings };
}

describe('Instagram account bulk seed (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('connects a connection and an account through it per organization, with an encrypted token and the default settings', async () => {
    const organization = await seedOrganization();

    await connectionAndAccountSeed.seedBulk?.(seedContext([organization]));

    const { connections, accounts, tokens, settings } = await rowsOf(organization.id);
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      provider: 'meta',
      status: 'connected',
      connected_by_user_id: organization.ownerUserId,
      scopes: [...META_REQUIRED_PERMISSIONS],
    });
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account).toMatchObject({
      channel_connection_id: connection.id,
      connection_status: 'connected',
      connected_by_user_id: organization.ownerUserId,
      disconnected_at: null,
      token_expires_at: null,
      scopes: [...META_REQUIRED_PERMISSIONS],
    });
    expect(account.instagram_user_id).toMatch(/^9[0-9]{15}$/);
    expect(account.webhook_subscribed_at).not.toBeNull();

    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(token.channel_connection_id).toBe(connection.id);
    expect(token.token_type).toBe('system_user');
    expect(token.expires_at).toBeNull();
    // Ciphertext, not a token: it decrypts to the placeholder only.
    expect(token.encrypted_access_token).not.toContain('placeholder');
    expect(decryptFieldSecret(token.encrypted_access_token)).toBe(
      'seed-placeholder-not-a-meta-token',
    );

    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      instagram_account_id: account.id,
      is_automation_enabled: true,
      is_public_reply_safety_enabled: false,
      public_reply_chance_percent: 80,
      public_reply_hour_limit: 60,
      public_reply_gap_min_seconds: 20,
      public_reply_gap_max_seconds: 60,
      updated_by_user_id: null,
    });
  });

  it('is idempotent: a second run adds nothing and changes nothing', async () => {
    const organizations = [await seedOrganization(), await seedOrganization()];

    await connectionAndAccountSeed.seedBulk?.(seedContext(organizations));
    const first = await Promise.all(organizations.map((organization) => rowsOf(organization.id)));
    await connectionAndAccountSeed.seedBulk?.(seedContext(organizations));
    const second = await Promise.all(organizations.map((organization) => rowsOf(organization.id)));

    expect(second).toEqual(first);
    for (const rows of second) {
      expect([
        rows.connections.length,
        rows.accounts.length,
        rows.tokens.length,
        rows.settings.length,
      ]).toEqual([1, 1, 1, 1]);
    }
  });

  it('seeds no account for an organization without its seeded connection', async () => {
    const organization = await seedOrganization();

    await instagramAccountSeedContribution.seedBulk?.(seedContext([organization]));

    const { accounts } = await rowsOf(organization.id);
    expect(accounts).toEqual([]);
  });
});
