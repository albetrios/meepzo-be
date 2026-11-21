import type { FastifyInstance } from 'fastify';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { InstagramAccountRepository } from './sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from './sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountTokenRepository } from './sub-domains/instagram-account/instagram-account-token.repository.js';
import { InstagramAccountTokenService } from './sub-domains/instagram-account/instagram-account-token.service.js';
import { InstagramAccountSettingsRepository } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';

/**
 * Services exposed by the app domain container (mounted on `app.appDomain`): the Instagram account
 * sub-domain today — the account service (routes 1, 2, 4 and the guarded status change) and the
 * settings service. Contact, automation and Instagram webhook services join as each one is built.
 *
 * @remarks
 * The token service is not exposed: only the account service (and, later, the daily check) uses
 * the token path (IA5).
 */
export type AppContainer = {
  instagramAccountService: InstagramAccountService;
  instagramAccountSettingsService: InstagramAccountSettingsService;
};

/**
 * Builds the app domain container — the one place its sub-domains' repositories and services
 * are wired, with cross-domain services passed in as parameters (the organization service: the
 * team check, user id resolution).
 */
export function createAppContainer({
  organizationService,
}: {
  organizationService: OrganizationService;
}): AppContainer {
  const instagramAccountRepository = new InstagramAccountRepository();
  const instagramAccountTokenService = new InstagramAccountTokenService(
    new InstagramAccountTokenRepository(),
  );
  const instagramAccountSettingsService = new InstagramAccountSettingsService(
    new InstagramAccountSettingsRepository(),
  );
  const instagramAccountService = new InstagramAccountService(
    instagramAccountRepository,
    instagramAccountTokenService,
    instagramAccountSettingsService,
    organizationService,
  );
  return { instagramAccountService, instagramAccountSettingsService };
}

/**
 * Fastify plugin step that decorates the application with the app domain container. Called by
 * `domainContainersPlugin` after the domains it reads (tenancy, and audit through the request).
 */
export function registerAppContainer(application: FastifyInstance): void {
  const { organizationService } = application.tenancyDomain;
  application.decorate('appDomain', createAppContainer({ organizationService }));
}
