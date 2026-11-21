/**
 * Instagram account sub-domain seed contribution — a connected account with its encrypted token
 * for every demo team organization, then the nested settings contribution, so the default settings
 * seed strictly after the accounts they belong to. Composed up into the app domain's seed module.
 * No reference data: the nine app permission codes and the Member role are tenancy's.
 */
import { instagramAccountSettingsSeedContribution } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/seed/index.js';
import { composeContributions, type SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedInstagramAccountsBulk } from './instagram-account.bulk.seed.js';

/** The accounts and their tokens first, then their settings (ordered by {@link composeContributions}). */
const instagramAccountOwnContribution: SeedContribution = {
  seedBulk: seedInstagramAccountsBulk,
};

/** Bulk contribution: connected accounts and tokens, followed by their default settings. */
export const instagramAccountSeedContribution: SeedContribution = composeContributions(
  instagramAccountOwnContribution,
  instagramAccountSettingsSeedContribution,
);
