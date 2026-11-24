import type { FastifyPluginAsync } from 'fastify';
import { channelConnectionRoutes } from './sub-domains/channel-connection/channel-connection.routes.js';
import { channelAccountRoutes } from './sub-domains/channel-account/channel-account.routes.js';
import { instagramAccountSettingsRoutes } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.routes.js';
import { instagramMediaRoutes } from './sub-domains/instagram-account/instagram-media/instagram-media.routes.js';
import { channelConnectionMetaCallbackRoutes } from './sub-domains/channel-connection/channel-connection-meta-callback.routes.js';
import { contactRoutes } from './sub-domains/contact/contact.routes.js';
import { instagramWebhookRoutes } from './sub-domains/instagram-webhook/instagram-webhook.routes.js';
import { automationRoutes } from './sub-domains/automation/automation.routes.js';
import { createAppPlanAccessPreHandler } from './app-plan-access.js';

/**
 * Top-level app domain plugin, mounted by `src/routes.ts` under `/api/v1/app`. It registers the
 * sub-domain route trees, each reading its services from `app.appDomain`: the channel connection
 * (`/social/channel-connections/…` — start, callback, reconnect, pick, list, one, disconnect
 * business) and Meta's two PUBLIC callbacks with it (`/social/channel-connections/{provider}/deauthorize`,
 * `…/data-deletion` — form-encoded, in their own encapsulated plugin so their body parser reaches no
 * other route), the channel account (`/social/channel-accounts/…` — list, one, disconnect, pause,
 * resume, choose active accounts), the Instagram account's settings
 * (`/social/instagram/accounts/{channel_account_id}/settings`), its post and story pickers
 * (`/social/instagram/accounts/{channel_account_id}/media`, `…/stories`), contacts (`/contacts`), the
 * Instagram webhook (Meta's `/social/instagram/webhook` and the team's
 * `/social/instagram/webhook-events`), and automations (`/automations`).
 *
 * @remarks
 * The read-only plan guard (`app-plan-access.ts`, AQ8) is built here from billing's subscription
 * service and attached to the automation writes only (D27).
 */
export const appRoutesPlugin: FastifyPluginAsync = async (app) => {
  const { appDomain } = app;
  await app.register(channelConnectionRoutes(appDomain.channelConnectionService));
  await app.register(
    channelConnectionMetaCallbackRoutes(appDomain.channelConnectionMetaCallbackService),
  );
  await app.register(channelAccountRoutes(appDomain.channelAccountService));
  await app.register(instagramAccountSettingsRoutes(appDomain.instagramAccountSettingsService));
  await app.register(instagramMediaRoutes(appDomain.instagramMediaService));
  await app.register(contactRoutes(appDomain.contactService));
  await app.register(
    automationRoutes({
      automationService: appDomain.automationService,
      planAccessPreHandler: createAppPlanAccessPreHandler(app.billingDomain.subscriptionService),
    }),
  );
  await app.register(
    instagramWebhookRoutes({
      instagramWebhookService: appDomain.instagramWebhookService,
      instagramWebhookEventService: appDomain.instagramWebhookEventService,
    }),
  );
};
