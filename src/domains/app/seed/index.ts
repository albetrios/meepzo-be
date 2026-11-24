/**
 * App domain seed module — composes the sub-domains' seed contributions into the single
 * {@link DomainSeedModule} the bulk orchestrator registers: the channel connection (one Meta
 * connection with its encrypted token per demo team organization), the channel account (a connected
 * Instagram account through it), the Instagram account sub-domain (its Instagram extension, default settings and a few stored posts), its sending lanes, a stop and the minute and month counts (§ 6.A SNC12), then the contact sub-domain (contacts of each live account), then the automations
 * (every trigger and scope per live account), then the segments (three per live account), then the Instagram webhook events (every kind and
 * status per seeded account — after the accounts they name). It depends on `tenancy` (the
 * organizations every app row belongs to) and has no reference data of its own.
 */
import { channelConnectionSeedContribution } from '@/domains/app/sub-domains/channel-connection/seed/index.js';
import { channelAccountSeedContribution } from '@/domains/app/sub-domains/channel-account/seed/index.js';
import { automationSeedContribution } from '@/domains/app/sub-domains/automation/seed/index.js';
import { contactSeedContribution } from '@/domains/app/sub-domains/contact/seed/index.js';
import { broadcastSegmentSeedContribution } from '@/domains/app/sub-domains/broadcast/broadcast-segment/seed/index.js';
import { instagramAccountSeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';
import { instagramWebhookEventSeedContribution } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/seed/index.js';
import { instagramSendingSeedContribution } from '@/domains/app/sub-domains/instagram-sending/seed/index.js';
import { composeContributions, type DomainSeedModule } from '@/scripts/seed/seed-contract.js';

/**
 * The connections first, then the accounts, then the contacts, the automations and the webhook events that belong to
 * them (CT13, AU27).
 */
const bulkContribution = composeContributions(
  channelConnectionSeedContribution,
  channelAccountSeedContribution,
  instagramAccountSeedContribution,
  instagramSendingSeedContribution,
  contactSeedContribution,
  automationSeedContribution,
  broadcastSegmentSeedContribution,
  instagramWebhookEventSeedContribution,
);

/** The app domain's seed module (registered by the bulk orchestrator). */
export const appSeedModule: DomainSeedModule = {
  name: 'app',
  dependsOn: ['tenancy'],
  seedBulk: bulkContribution.seedBulk,
};
