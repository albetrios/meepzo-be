/**
 * Contact sub-domain seed contribution — demo contacts for every seeded live Instagram account,
 * then their tag events (the nested `contact-tag-event/` contribution). Composed up into the app
 * domain's seed module after the Instagram account contribution, whose accounts it reads. No
 * reference data.
 */
import { type SeedContribution, composeContributions } from '@/scripts/seed/seed-contract.js';
import { contactTagEventSeedContribution } from '@/domains/app/sub-domains/contact/contact-tag-event/seed/index.js';
import { seedContactsBulk } from './contact.bulk.seed.js';

/** Bulk-only contribution: each live account's contacts, then their tag events. */
export const contactSeedContribution: SeedContribution = composeContributions(
  { seedBulk: seedContactsBulk },
  contactTagEventSeedContribution,
);
