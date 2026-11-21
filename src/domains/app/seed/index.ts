/**
 * App domain seed module — composes the sub-domains' seed contributions into the single
 * {@link DomainSeedModule} the bulk orchestrator registers: today the Instagram account
 * sub-domain (a connected account, its encrypted token and default settings per demo team
 * organization). It depends on `tenancy` (the organizations every app row belongs to) and has no
 * reference data of its own.
 */
import { instagramAccountSeedContribution } from '@/domains/app/sub-domains/instagram-account/seed/index.js';
import { composeContributions, type DomainSeedModule } from '@/scripts/seed/seed-contract.js';

const bulkContribution = composeContributions(instagramAccountSeedContribution);

/** The app domain's seed module (registered by the bulk orchestrator). */
export const appSeedModule: DomainSeedModule = {
  name: 'app',
  dependsOn: ['tenancy'],
  seedBulk: bulkContribution.seedBulk,
};
