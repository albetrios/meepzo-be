/**
 * Instagram media nested seed contribution — a few stored posts for every seeded connected
 * Instagram account. Composed up into the Instagram account sub-domain's contribution, after the
 * accounts it reads.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedInstagramMediaBulk } from './instagram-media.bulk.seed.js';

/** Bulk-only contribution that seeds each connected account's stored posts (no reference data). */
export const instagramMediaSeedContribution: SeedContribution = {
  seedBulk: seedInstagramMediaBulk,
};
