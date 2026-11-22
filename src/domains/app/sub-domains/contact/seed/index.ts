/**
 * Contact sub-domain seed contribution — demo contacts for every seeded live Instagram account.
 * Composed up into the app domain's seed module after the Instagram account contribution, whose
 * accounts it reads. No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedContactsBulk } from './contact.bulk.seed.js';

/** Bulk-only contribution that seeds each live account's contacts (no reference data). */
export const contactSeedContribution: SeedContribution = {
  seedBulk: seedContactsBulk,
};
