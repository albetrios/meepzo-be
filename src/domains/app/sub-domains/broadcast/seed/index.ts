/**
 * Broadcast seed contribution — a draft, a done and a cancelled broadcast for every seeded live
 * channel account. Composed up into the app domain's seed module after the segments, one of which
 * the draft uses. No reference data; the recipients are ROUTE row R23's.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedBroadcastsBulk } from './broadcast.bulk.seed.js';

/** Bulk-only contribution that seeds each live account's broadcasts (no reference data). */
export const broadcastSeedContribution: SeedContribution = {
  seedBulk: seedBroadcastsBulk,
};
