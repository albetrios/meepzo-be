/**
 * Instagram account settings bulk seeder — gives every account of a registry organization that has
 * no settings row the default one, as the first connect does (IA12 step 4): the automation switch
 * on, public reply safety off, 80 %, 60 an hour, 20–60 seconds — the column defaults.
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
      instagramAccountId: instagram_accounts.id,
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
        instagram_account_id: account.instagramAccountId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: instagram_account_settings.id });
  context.logger.info(
    { accounts: accounts.length, created: inserted.length },
    'seed.bulk.instagram-account-settings: default settings seeded',
  );
}
