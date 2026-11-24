/**
 * Contact tag event nested sub-domain seed contribution — one finished `added` event per seeded
 * contact's tag. Composed up into the contact sub-domain's contribution after the contacts it
 * reads. No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedContactTagEventsBulk } from './contact-tag-event.bulk.seed.js';

/** Bulk-only contribution that seeds the contacts' tag events (no reference data). */
export const contactTagEventSeedContribution: SeedContribution = {
  seedBulk: seedContactTagEventsBulk,
};
