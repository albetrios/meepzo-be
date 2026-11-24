/**
 * Channel connection sub-domain seed contribution — one Meta connection with its encrypted token
 * for every demo team organization, before the Instagram accounts that come in through it.
 * Composed up into the app domain's seed module. No reference data: the `channel-account:*`
 * permission codes are tenancy's.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedChannelConnectionsBulk } from './channel-connection.bulk.seed.js';

/** Bulk contribution: the connections and their tokens. */
export const channelConnectionSeedContribution: SeedContribution = {
  seedBulk: seedChannelConnectionsBulk,
};
