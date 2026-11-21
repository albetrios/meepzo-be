/**
 * Instagram account settings nested seed contribution — the default settings row of every seeded
 * Instagram account. Composed up into the Instagram account sub-domain's contribution, after the
 * accounts it reads.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedInstagramAccountSettingsBulk } from './instagram-account-settings.bulk.seed.js';

/** Bulk-only contribution that seeds each account's default settings (no reference data). */
export const instagramAccountSettingsSeedContribution: SeedContribution = {
  seedBulk: seedInstagramAccountSettingsBulk,
};
