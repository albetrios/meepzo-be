/**
 * Instagram webhook event nested seed contribution — the demo events of every seeded Instagram
 * account, every kind and every status of route 18 (routes-final § 4.B, WHC16). The parent
 * `instagram-webhook/` owns no table and has no `seed/`, so the app domain composes this
 * contribution directly, after the Instagram account's (the accounts it reads). No reference data.
 */
import type { SeedContribution } from '@/scripts/seed/seed-contract.js';
import { seedInstagramWebhookEventsBulk } from './instagram-webhook-event.bulk.seed.js';

/** Bulk-only contribution that seeds each account's demo events. */
export const instagramWebhookEventSeedContribution: SeedContribution = {
  seedBulk: seedInstagramWebhookEventsBulk,
};
