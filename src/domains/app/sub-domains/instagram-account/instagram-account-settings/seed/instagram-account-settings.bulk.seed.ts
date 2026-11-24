/**
 * Instagram account settings bulk seeder — gives every Instagram account of a registry organization
 * that has no settings row the empty one, as the pick does (feat-instagram-dm-sending MC7, IA12):
 * every limit empty (the settings file's values), replies under comments and once per person per
 * post on, mark as seen off, no stop words, no extra delay — the column defaults, keyed by the
 * channel account (P47).
 *
 * Idempotency: one row per account (`idx_instagram_account_settings_organization_account`), every
 * insert `ON CONFLICT DO NOTHING`; a re-run, or an account whose settings a user changed, keeps the
 * row as it is.
 */
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_account_settings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';

/**
 * Seeds the default settings row of every Instagram account of the registry organizations.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, and the accounts the parent Instagram account
 * seeder wrote for them (this contribution is composed after it). Algorithm: list those
 * organizations' accounts, then insert one default row per account (`ON CONFLICT DO NOTHING`).
 * Side effects: inserts into `app.instagram_account_settings`. Failure modes: warns and returns
 * early when the registry has no organizations; otherwise propagates database errors.
 */
export async function seedInstagramAccountSettingsBulk(context: SeedContext): Promise<void> {
  const organizationIds = context.registry.organizations.map((organization) => organization.id);
  if (organizationIds.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-account-settings: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  const accounts = await database
    .select({
      organizationId: instagram_accounts.organization_id,
      channelAccountId: instagram_accounts.channel_account_id,
    })
    .from(instagram_accounts)
    .where(inArray(instagram_accounts.organization_id, organizationIds));
  if (accounts.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-account-settings: no Instagram accounts; run the account seeder first',
    );
    return;
  }

  const inserted = await database
    .insert(instagram_account_settings)
    .values(
      accounts.map((account) => ({
        organization_id: account.organizationId,
        channel_account_id: account.channelAccountId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: instagram_account_settings.id });
  context.logger.info(
    { accounts: accounts.length, created: inserted.length },
    'seed.bulk.instagram-account-settings: default settings seeded',
  );
}
