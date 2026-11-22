/**
 * Automation-run nested sub-domain seed contribution — demo runs of each organization's first
 * automation in every status, their status events and the comment logs of the comment runs.
 * Composed up into the automation sub-domain's contribution after the automations it reads. No
 * reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedAutomationRunsBulk } from './automation-run.bulk.seed.js';

/** Bulk-only contribution that seeds the runs, run events and comment logs (no reference data). */
export const automationRunSeedContribution: SeedContribution = {
  seedBulk: seedAutomationRunsBulk,
};
