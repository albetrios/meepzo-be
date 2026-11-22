/**
 * App domain seed module — composes the sub-domains' seed contributions into the single
 * {@link DomainSeedModule} the bulk orchestrator registers: the Instagram account sub-domain (a
 * connected account, its encrypted token, default settings and a few stored posts per demo team
 * organization), then the contact sub-domain (contacts of each live account), then the automations
 * (every trigger and scope per live account), then the Instagram webhook events (every kind and
 * status per seeded account — after the accounts they name). It depends on `tenancy` (the
 * organizations every app row belongs to) and has no reference data of its own.
 */
import { automationSeedContribution } from '@/domains/app/sub-domains/automation/seed/index.js';
import { contactSeedContribution } from '@/domains/app/sub-domains/contact/seed/index.js';
import { instagramAccountSeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';
import { instagramWebhookEventSeedContribution } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/seed/index.js';
import { composeContributions, type DomainSeedModule } from '@/scripts/seed/seed-contract.js';

/**
 * The accounts first, then the contacts, the automations and the webhook events that belong to
 * them (CT13, AU27).
 */
const bulkContribution = composeContributions(
  instagramAccountSeedContribution,
  contactSeedContribution,
  automationSeedContribution,
  instagramWebhookEventSeedContribution,
);

/** The app domain's seed module (registered by the bulk orchestrator). */
export const appSeedModule: DomainSeedModule = {
  name: 'app',
  dependsOn: ['tenancy'],
  seedBulk: bulkContribution.seedBulk,
};
