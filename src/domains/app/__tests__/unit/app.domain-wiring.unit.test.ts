import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { createAppContainer, registerAppContainer } from '@/domains/app/app.container.js';
import { appRoutesPlugin } from '@/domains/app/app.routes.js';
import { appSeedModule } from '@/domains/app/seed/index.js';
import { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import {
  buildPublicApiPrefix,
  PUBLIC_API_VERSION_SEGMENT_V1,
} from '@/shared/utils/http/api-versioning.util.js';

const APP_PREFIX = `${buildPublicApiPrefix(PUBLIC_API_VERSION_SEGMENT_V1)}/app`;

/**
 * The `app` domain wiring (launch-2026-11-20-ujai, ROUTE R1 IAC1, R3): the container holds the
 * Instagram account sub-domain's services, the routes plugin registers routes 1, 2 and 4 under
 * `/api/v1/app`, and the seed module is wired; contacts, automations and the Instagram webhook
 * join later.
 */
describe('app domain wiring', () => {
  const organizationService = {} as OrganizationService;

  it('registerAppContainer decorates appDomain with the Instagram account services', async () => {
    const application = Fastify();
    application.decorate('tenancyDomain', { organizationService } as never);
    registerAppContainer(application);

    expect(Object.keys(application.appDomain).sort()).toEqual([
      'instagramAccountService',
      'instagramAccountSettingsService',
    ]);
    expect(application.appDomain.instagramAccountService).toBeInstanceOf(InstagramAccountService);
    expect(
      createAppContainer({ organizationService }).instagramAccountSettingsService,
    ).toBeInstanceOf(InstagramAccountSettingsService);
    await application.close();
  });

  it('the routes plugin mounts the three Instagram account routes under /api/v1/app', async () => {
    const application = Fastify();
    application.setValidatorCompiler(validatorCompiler);
    application.setSerializerCompiler(serializerCompiler);
    application.decorate('authenticate', async () => undefined);
    application.decorate('appDomain', createAppContainer({ organizationService }));
    const registeredRoutes: string[] = [];
    application.addHook('onRoute', (route) => {
      if (route.method !== 'HEAD') registeredRoutes.push(`${String(route.method)} ${route.url}`);
    });

    await application.register(appRoutesPlugin, { prefix: APP_PREFIX });
    await application.ready();

    expect(registeredRoutes.sort()).toEqual([
      `DELETE ${APP_PREFIX}/social/instagram/account`,
      `GET ${APP_PREFIX}/social/instagram/account`,
      `POST ${APP_PREFIX}/social/instagram/connect`,
    ]);
    const response = await application.inject({ method: 'GET', url: `${APP_PREFIX}/contacts` });
    expect(response.statusCode).toBe(404);
    await application.close();
  });

  it('the seed module depends on tenancy, has no reference data, and needs organizations', async () => {
    expect(appSeedModule.name).toBe('app');
    expect(appSeedModule.dependsOn).toEqual(['tenancy']);
    expect(appSeedModule.seedReference).toBeUndefined();
    // Without organizations the Instagram account and settings seeders warn and write nothing.
    const warn = vi.fn();
    const context = {
      registry: createSeedRegistry(),
      logger: { warn, info: vi.fn() },
    } as unknown as SeedContext;
    await expect(appSeedModule.seedBulk(context)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
