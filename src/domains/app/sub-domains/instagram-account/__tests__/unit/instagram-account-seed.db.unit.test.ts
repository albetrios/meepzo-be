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
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_account_tokens } from '@/domains/app/sub-domains/instagram-account/instagram-account-token.schema.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import { INSTAGRAM_ACCOUNT_REQUIRED_SCOPES } from '@/domains/app/sub-domains/instagram-account/instagram-account.constants.js';
import { instagramAccountSeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';

/**
 * The Instagram account bulk seed (launch IAC10) against the real schema: each registry team
 * organization gets a connected account, a token that is `encryptFieldSecret` ciphertext whose
 * expiry the account copies (IA5), and the default settings — and a second run writes nothing new.
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
  const tokens = await database
    .select()
    .from(instagram_account_tokens)
    .where(eq(instagram_account_tokens.organization_id, organizationId));
  const settings = await database
    .select()
    .from(instagram_account_settings)
    .where(eq(instagram_account_settings.organization_id, organizationId));
  return { accounts, tokens, settings };
}

describe('Instagram account bulk seed (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('connects an account per organization with an encrypted token and the default settings', async () => {
    const organization = await seedOrganization();

    await instagramAccountSeedContribution.seedBulk?.(seedContext([organization]));

    const { accounts, tokens, settings } = await rowsOf(organization.id);
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(account).toMatchObject({
      connection_status: 'connected',
      connected_by_user_id: organization.ownerUserId,
      disconnected_at: null,
      scopes: [...INSTAGRAM_ACCOUNT_REQUIRED_SCOPES],
    });
    expect(account.instagram_user_id).toMatch(/^9[0-9]{15}$/);
    expect(account.webhook_subscribed_at).not.toBeNull();

    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(token.instagram_account_id).toBe(account.id);
    expect(token.expires_at).toEqual(account.token_expires_at);
    // Ciphertext, not a token: it decrypts to the placeholder only.
    expect(token.encrypted_access_token).not.toContain('placeholder');
    expect(decryptFieldSecret(token.encrypted_access_token)).toBe(
      'seed-placeholder-not-an-instagram-token',
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

    await instagramAccountSeedContribution.seedBulk?.(seedContext(organizations));
    const first = await Promise.all(organizations.map((organization) => rowsOf(organization.id)));
    await instagramAccountSeedContribution.seedBulk?.(seedContext(organizations));
    const second = await Promise.all(organizations.map((organization) => rowsOf(organization.id)));

    expect(second).toEqual(first);
    for (const rows of second) {
      expect([rows.accounts.length, rows.tokens.length, rows.settings.length]).toEqual([1, 1, 1]);
    }
  });

  it('leaves an organization that already holds another live account untouched', async () => {
    const organization = await seedOrganization();
    const [existing] = await database
      .insert(instagram_accounts)
      .values({
        public_id: generatePublicId('instagramAccount'),
        organization_id: organization.id,
        instagram_user_id: '17841400000000042',
        instagram_app_user_id: '917841400000000042',
        username: 'already_connected',
      })
      .returning({ id: instagram_accounts.id });

    await instagramAccountSeedContribution.seedBulk?.(seedContext([organization]));

    const { accounts, tokens, settings } = await rowsOf(organization.id);
    expect(accounts.map((account) => account.id)).toEqual([existing!.id]);
    expect(tokens).toEqual([]);
    // Every account has its settings, as a connect leaves it — the existing one included.
    expect(settings.map((row) => row.instagram_account_id)).toEqual([existing!.id]);
  });
});
