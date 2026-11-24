/**
 * Channel account sub-domain seed contribution — one connected Instagram channel account through
 * the seeded connection of every demo team organization, before its Instagram extension and the
 * product rows. Composed up into the app domain's seed module. No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedChannelAccountsBulk } from './channel-account.bulk.seed.js';

/** Bulk contribution: the channel accounts. */
export const channelAccountSeedContribution: SeedContribution = {
  seedBulk: seedChannelAccountsBulk,
};
