/**
 * Automation sub-domain seed contribution — demo automations for every seeded live Instagram
 * account, across every trigger and target scope, then the nested automation-run contribution (the
 * runs, run events and comment logs of those automations). Composed up into the app domain's seed
 * module after the Instagram account and contact contributions, whose accounts, stored posts and
 * contacts it reads. No reference data.
 */
import { composeContributions, type SeedContribution } from '@/scripts/seed/seed-contract.js';
import { automationRunSeedContribution } from '@/domains/app/sub-domains/automation/automation-run/seed/index.js';
import { seedAutomationsBulk } from './automation.bulk.seed.js';

/** Bulk-only contribution: each live account's automations, then their runs (no reference data). */
export const automationSeedContribution: SeedContribution = composeContributions(
  { seedBulk: seedAutomationsBulk },
  automationRunSeedContribution,
);
