/**
 * Automation-backfill nested sub-domain seed contribution — demo past-comments reads of each
 * organization's live comment automations in every status. Composed up into the automation
 * sub-domain's contribution after the automations it reads. No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedAutomationBackfillsBulk } from './automation-backfill.bulk.seed.js';

/** Bulk-only contribution that seeds the past-comments reads (no reference data). */
export const automationBackfillSeedContribution: SeedContribution = {
  seedBulk: seedAutomationBackfillsBulk,
};
