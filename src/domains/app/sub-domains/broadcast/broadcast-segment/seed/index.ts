/**
 * Segment sub-domain seed contribution — a few saved segments for every seeded live channel account.
 * Composed up into the app domain's seed module after the contacts, whose account it reads. No
 * reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedSegmentsBulk } from './broadcast-segment.bulk.seed.js';

/** Bulk-only contribution that seeds each live account's segments (no reference data). */
export const broadcastSegmentSeedContribution: SeedContribution = {
  seedBulk: seedSegmentsBulk,
};
