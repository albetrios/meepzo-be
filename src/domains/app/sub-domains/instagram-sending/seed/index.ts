/**
 * Instagram sending sub-domain seed contribution (feat-instagram-dm-sending § 6.A SNC12) — the four
 * lanes of every seeded Instagram channel account, one ended stop of its history, this minute's
 * count and this month's count for the DM meter. Composed up into the app domain's seed module,
 * after the channel accounts. No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedInstagramSendingBulk } from './instagram-sending.bulk.seed.js';

/** Bulk contribution: the lanes, a stop, the minute and month counts. */
export const instagramSendingSeedContribution: SeedContribution = {
  seedBulk: seedInstagramSendingBulk,
};
