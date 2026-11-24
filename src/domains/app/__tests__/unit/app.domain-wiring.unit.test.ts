import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { createAppContainer, registerAppContainer } from '@/domains/app/app.container.js';
import { appRoutesPlugin } from '@/domains/app/app.routes.js';
import { appSeedModule } from '@/domains/app/seed/index.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { InstagramAccountErasureService } from '@/domains/app/sub-domains/instagram-account/instagram-account-erasure.service.js';
import { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { InstagramMediaService } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { ChannelConnectionMetaCallbackService } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta-callback.service.js';
import { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { InstagramWebhookService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { createSeedRegistry } from '@/scripts/seed/seed-registry.js';
import {
  buildPublicApiPrefix,
  PUBLIC_API_VERSION_SEGMENT_V1,
} from '@/shared/utils/http/api-versioning.util.js';

const APP_PREFIX = `${buildPublicApiPrefix(PUBLIC_API_VERSION_SEGMENT_V1)}/app`;

/**
 * The `app` domain wiring (launch-2026-11-20-ujai, ROUTE R1 IAC1, R3, R4, R5, R6, R8, R9, R12,
 * R13): the container holds the Instagram account sub-domain's services, the contact service, the
 * automation service, the Instagram webhook events service and the webhook receiver, the routes
 * plugin registers routes 1–18 under `/api/v1/app`, and the seed module is wired; the run engine
 * joins later.
 */
describe('app domain wiring', () => {
  const organizationService = {} as OrganizationService;
  const planAccessService = { getPlanAccess: vi.fn() };
  const trialPort = { assertAccountsMayTrial: vi.fn(), recordTrialAccounts: vi.fn() };

  it('registerAppContainer decorates appDomain with the Instagram account, contact, automation, run engine and webhook services', async () => {
    const application = Fastify();
    application.decorate('tenancyDomain', { organizationService } as never);
    application.decorate('billingDomain', {
      subscriptionService: planAccessService,
      subscriptionTrialService: trialPort,
    } as never);
    registerAppContainer(application);

    expect(Object.keys(application.appDomain).sort()).toEqual([
      'automationRunService',
      'automationService',
      'broadcastSegmentService',
      'channelAccountService',
      'channelConnectionMetaCallbackService',
      'channelConnectionService',
      'channelConnectionTokenService',
      'channelConnectionUsageService',
      'contactService',
      'instagramAccountErasureService',
      'instagramAccountService',
      'instagramAccountSettingsService',
      'instagramMediaService',
      'instagramSendLaneService',
      'instagramSendingService',
      'instagramWebhookEventService',
      'instagramWebhookService',
      'messageMonthCountService',
      'sendingStateService',
    ]);
    expect(application.appDomain.instagramAccountService).toBeInstanceOf(InstagramAccountService);
    expect(application.appDomain.contactService).toBeInstanceOf(ContactService);
    expect(application.appDomain.automationService).toBeInstanceOf(AutomationService);
    expect(application.appDomain.automationRunService).toBeInstanceOf(AutomationRunService);
    expect(application.appDomain.instagramWebhookEventService).toBeInstanceOf(
      InstagramWebhookEventService,
    );
    expect(application.appDomain.instagramWebhookService).toBeInstanceOf(InstagramWebhookService);
    expect(
      createAppContainer({ organizationService, planAccessService, trialPort })
        .instagramAccountSettingsService,
    ).toBeInstanceOf(InstagramAccountSettingsService);
    expect(application.appDomain.instagramMediaService).toBeInstanceOf(InstagramMediaService);
    // Tenancy's organization delete calls it through its offboarding port (D54).
    expect(application.appDomain.instagramAccountErasureService).toBeInstanceOf(
      InstagramAccountErasureService,
    );
    expect(application.appDomain.channelConnectionMetaCallbackService).toBeInstanceOf(
      ChannelConnectionMetaCallbackService,
    );
    await application.close();
  });

  it('the routes plugin mounts the Instagram account, contact, automation and webhook routes under /api/v1/app', async () => {
    const application = Fastify();
    application.setValidatorCompiler(validatorCompiler);
    application.setSerializerCompiler(serializerCompiler);
    application.decorate('authenticate', async () => undefined);
    application.decorate(
      'appDomain',
      createAppContainer({ organizationService, planAccessService, trialPort }),
    );
    // The automation writes' read-only guard reads billing's subscription service (AQ8).
    application.decorate('billingDomain', {
      subscriptionService: { assertOrganizationWritable: vi.fn() },
    } as never);
    const registeredRoutes: string[] = [];
    application.addHook('onRoute', (route) => {
      if (route.method !== 'HEAD') registeredRoutes.push(`${String(route.method)} ${route.url}`);
    });

    await application.register(appRoutesPlugin, { prefix: APP_PREFIX });
    await application.ready();

    expect(registeredRoutes.sort()).toEqual([
      `DELETE ${APP_PREFIX}/automations/:automation_id`,
      `DELETE ${APP_PREFIX}/contacts/:contact_id`,
      `DELETE ${APP_PREFIX}/segments/:segment_id`,
      `DELETE ${APP_PREFIX}/social/channel-accounts/:channel_account_id`,
      `DELETE ${APP_PREFIX}/social/channel-connections/:channel_connection_id`,
      `GET ${APP_PREFIX}/automations`,
      `GET ${APP_PREFIX}/automations/:automation_id`,
      `GET ${APP_PREFIX}/contact-tags`,
      `GET ${APP_PREFIX}/contacts`,
      `GET ${APP_PREFIX}/contacts/:contact_id`,
      `GET ${APP_PREFIX}/segments`,
      `GET ${APP_PREFIX}/segments/:segment_id`,
      `GET ${APP_PREFIX}/social/channel-accounts`,
      `GET ${APP_PREFIX}/social/channel-accounts/:channel_account_id`,
      `GET ${APP_PREFIX}/social/channel-connections`,
      `GET ${APP_PREFIX}/social/channel-connections/:channel_connection_id`,
      `GET ${APP_PREFIX}/social/channel-connections/:channel_connection_id/ad-accounts`,
      `GET ${APP_PREFIX}/social/channel-connections/:channel_connection_id/ads`,
      `GET ${APP_PREFIX}/social/channel-connections/meta/webhooks/instagram`,
      `GET ${APP_PREFIX}/social/instagram/accounts/:channel_account_id/media`,
      `GET ${APP_PREFIX}/social/instagram/accounts/:channel_account_id/sending-status`,
      `GET ${APP_PREFIX}/social/instagram/accounts/:channel_account_id/stories`,
      `GET ${APP_PREFIX}/social/instagram/webhook-events`,
      `GET ${APP_PREFIX}/usage`,
      `PATCH ${APP_PREFIX}/automations/:automation_id`,
      `PATCH ${APP_PREFIX}/contacts/:contact_id`,
      `PATCH ${APP_PREFIX}/segments/:segment_id`,
      `PATCH ${APP_PREFIX}/social/instagram/accounts/:channel_account_id/settings`,
      `POST ${APP_PREFIX}/automations`,
      `POST ${APP_PREFIX}/contacts/bulk-actions`,
      `POST ${APP_PREFIX}/segments`,
      `POST ${APP_PREFIX}/segments/audience-count`,
      `POST ${APP_PREFIX}/social/channel-accounts/:channel_account_id/activate`,
      `POST ${APP_PREFIX}/social/channel-accounts/:channel_account_id/pause`,
      `POST ${APP_PREFIX}/social/channel-accounts/:channel_account_id/resume`,
      `POST ${APP_PREFIX}/social/channel-connections/:channel_connection_id/accounts`,
      `POST ${APP_PREFIX}/social/channel-connections/:channel_connection_id/reconnect`,
      `POST ${APP_PREFIX}/social/channel-connections/:provider/callback`,
      `POST ${APP_PREFIX}/social/channel-connections/:provider/data-deletion`,
      `POST ${APP_PREFIX}/social/channel-connections/:provider/deauthorize`,
      `POST ${APP_PREFIX}/social/channel-connections/:provider/start`,
      `POST ${APP_PREFIX}/social/channel-connections/meta/webhooks/instagram`,
    ]);
    // Runs have no route (D13).
    const response = await application.inject({
      method: 'GET',
      url: `${APP_PREFIX}/automation-runs`,
    });
    expect(response.statusCode).toBe(404);
    await application.close();
  });

  it('the seed module depends on tenancy, has no reference data, and needs organizations', async () => {
    expect(appSeedModule.name).toBe('app');
    expect(appSeedModule.dependsOn).toEqual(['tenancy']);
    expect(appSeedModule.seedReference).toBeUndefined();
    // Without organizations the channel connection, channel account, Instagram account, settings, stored-posts,
    // sending, contact, automation, automation-run, segment and webhook event seeders warn and write nothing.
    const warn = vi.fn();
    const context = {
      registry: createSeedRegistry(),
      logger: { warn, info: vi.fn() },
    } as unknown as SeedContext;
    await expect(appSeedModule.seedBulk(context)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(11);
  });
});
