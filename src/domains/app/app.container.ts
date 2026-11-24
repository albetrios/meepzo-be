import type { FastifyInstance } from 'fastify';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ChannelAccountRepository } from './sub-domains/channel-account/channel-account.repository.js';
import { ChannelAccountService } from './sub-domains/channel-account/channel-account.service.js';
import { ChannelConnectionRepository } from './sub-domains/channel-connection/channel-connection.repository.js';
import {
  type ChannelConnectionPlanAccessService,
  ChannelConnectionService,
} from './sub-domains/channel-connection/channel-connection.service.js';
import { ChannelConnectionTokenRepository } from './sub-domains/channel-connection/channel-connection-token.repository.js';
import { ChannelConnectionTokenService } from './sub-domains/channel-connection/channel-connection-token.service.js';
import { ChannelConnectionUsageRepository } from './sub-domains/channel-connection/channel-connection-usage.repository.js';
import {
  type ChannelConnectionUsageService,
  createChannelConnectionUsagePostgresStore,
  createChannelConnectionUsageService,
} from './sub-domains/channel-connection/channel-connection-usage.service.js';
import { InstagramAccountRepository } from './sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from './sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountExtensionService } from './sub-domains/instagram-account/instagram-account-extension.service.js';
import { InstagramAccountSettingsRepository } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type { InstagramAccountSettingsChannelAccountPort } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { InstagramAccountErasureService } from './sub-domains/instagram-account/instagram-account-erasure.service.js';
import { InstagramMediaRepository } from './sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from './sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import { InstagramAccountMetaCallbackService } from './sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback.service.js';
import { InstagramWebhookEventRepository } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventService } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { InstagramWebhookService } from './sub-domains/instagram-webhook/instagram-webhook.service.js';
import { enqueueInstagramWebhookAccountProcessing } from './sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { ContactRepository } from './sub-domains/contact/contact.repository.js';
import { ContactService } from './sub-domains/contact/contact.service.js';
import type { ContactErasureStep } from './sub-domains/contact/contact.types.js';
import { AutomationRepository } from './sub-domains/automation/automation.repository.js';
import { AutomationService } from './sub-domains/automation/automation.service.js';
import type { AutomationOpenRunCancelStep } from './sub-domains/automation/automation.types.js';
import { AutomationRunService } from './sub-domains/automation/automation-run/automation-run.service.js';
import { AutomationRunMessageService } from './sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from './sub-domains/automation/automation-run/automation-public-reply-safety.service.js';

/**
 * Services exposed by the app domain container (mounted on `app.appDomain`): the channel connection
 * sub-domain — the connection service (routes 1–5, 40, 42 of feat-instagram-dm-sending § 1), the
 * token service (the one token path, MC9) and the usage service (Meta's usage per connection, MC19)
 * — the channel account sub-domain (routes 6–11, the one feature check, ROUTE row R5) — the
 * Instagram account sub-domain — the account service (the guarded status change, the webhook
 * subscription steps), the settings
 * service (route 3), the media service (the post and story pickers, routes 5–6, and the stored
 * posts sub-domains 3–4 write through it, IA17), the erasure service (the one erase of an account's
 * data, which tenancy's organization delete calls through its offboarding port, D54) and the Meta
 * callback service (Meta's deauthorize and data deletion, routes 7–8, IA19, IA20) — the contact service (routes 9–10 and the
 * operations event processing writes contacts through), the Instagram webhook events service
 * (route 18; the one write path for the events table the receiver and processing use), the
 * Instagram webhook receiver (Meta's routes 16–17), the automation service (routes 11–15 and
 * "next post" linking for event processing), and the run engine (sub-domain 3.B — the entry points
 * event processing calls per comment, DM, story reply and button click).
 *
 * @remarks
 * The connection's token service is exposed for the Instagram workers that call Meta with an
 * account's connection token; the daily check's processor reads it through the worker token
 * repository (MC9). The connection reaches accounts through its account port — the channel
 * account service (`ChannelAccountService`, ROUTE row R5), which also serves routes 6–11 and the one
 * feature check the go-live, settings, broadcasts and the engine call (CA11). The worker process builds
 * this container too (`createDomainContainers` → `appDomain`), for the daily check's guarded status
 * change (IA8, IA9) and for Instagram webhook event processing (WH12–WH14), which drives the
 * account, events, contact, media, automation and run-engine services from it.
 */
export type AppContainer = {
  channelConnectionService: ChannelConnectionService;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelConnectionUsageService: ChannelConnectionUsageService;
  channelAccountService: ChannelAccountService;
  instagramAccountService: InstagramAccountService;
  instagramAccountSettingsService: InstagramAccountSettingsService;
  instagramMediaService: InstagramMediaService;
  instagramAccountErasureService: InstagramAccountErasureService;
  instagramAccountMetaCallbackService: InstagramAccountMetaCallbackService;
  contactService: ContactService;
  instagramWebhookEventService: InstagramWebhookEventService;
  instagramWebhookService: InstagramWebhookService;
  automationService: AutomationService;
  automationRunService: AutomationRunService;
};

/**
 * The Instagram account sub-domain's services (routes-final § 2): the extension's one writer
 * (2.A.10, ROUTE row R6), the settings and the account service, over the channel account repository
 * that moves the account's status (CA4, CA8).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 */
function createInstagramAccountServices({
  organizationService,
  channelConnectionTokenService,
  settingsChannelAccountPort,
}: {
  organizationService: OrganizationService;
  channelConnectionTokenService: ChannelConnectionTokenService;
  /** Route 12's channel account steps (P42, CA11) — the channel account service, built after. */
  settingsChannelAccountPort: InstagramAccountSettingsChannelAccountPort;
}) {
  const instagramAccountRepository = new InstagramAccountRepository();
  const channelAccountRepository = new ChannelAccountRepository();
  const instagramAccountExtensionService = new InstagramAccountExtensionService(
    instagramAccountRepository,
  );
  // The lane wake after a limit change (IA14) is sub-domain 6's — not passed until ROUTE row R18.
  const instagramAccountSettingsService = new InstagramAccountSettingsService(
    new InstagramAccountSettingsRepository(),
    settingsChannelAccountPort,
    organizationService,
  );
  const instagramAccountService = new InstagramAccountService(
    instagramAccountRepository,
    instagramAccountExtensionService,
    channelAccountRepository,
    channelConnectionTokenService,
    instagramAccountSettingsService,
    organizationService,
  );
  return {
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountSettingsService,
    instagramAccountService,
  };
}

/**
 * Builds the app domain container — the one place its sub-domains' repositories and services
 * are wired, with cross-domain services passed in as parameters (the organization service: the
 * team check, user id resolution; billing's plan read: the channel account limit).
 */
export function createAppContainer({
  organizationService,
  planAccessService,
}: {
  organizationService: OrganizationService;
  /** Billing's plan read — the channel account limit (feat-instagram-dm-sending MC7). */
  planAccessService: ChannelConnectionPlanAccessService;
}): AppContainer {
  const channelConnectionRepository = new ChannelConnectionRepository();
  const channelConnectionTokenService = new ChannelConnectionTokenService(
    new ChannelConnectionTokenRepository(),
    channelConnectionRepository,
  );
  // Meta's usage per connection (MC19, S13): the Postgres store; the app-level store joins at R18.
  const channelConnectionUsageService = createChannelConnectionUsageService({
    usageStore: createChannelConnectionUsagePostgresStore(new ChannelConnectionUsageRepository()),
  });
  const {
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountSettingsService,
    instagramAccountService,
  } = createInstagramAccountServices({
    organizationService,
    channelConnectionTokenService,
    // The channel account service depends on the settings service, so route 12 reaches it through
    // this port; each call runs at request time, after both are built.
    settingsChannelAccountPort: {
      requireLiveInstagramAccount: (input) =>
        channelAccountService.requireLiveInstagramAccount(input),
      setAutomationEnabled: (input) => channelAccountService.setAutomationEnabled(input),
      canChannelAccountUseFeature: (input) =>
        channelAccountService.canChannelAccountUseFeature(input),
    },
  });
  // The channel account (1B, ROUTE row R5): routes 6–11, the one feature check, and the
  // connection's account port over `app.channel_accounts` with its Instagram extension. Its lane
  // port (R18) and plan-stop port (R18, R24) are not passed until their rows build them.
  const channelAccountService = new ChannelAccountService(
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountService,
    instagramAccountSettingsService,
    channelConnectionRepository,
    channelConnectionTokenService,
    organizationService,
    planAccessService,
  );
  // The connection reaches accounts through the channel account (P111 → R5). The lane port (R18)
  // and the trial port (R24) are not passed until their rows build them.
  const channelConnectionService = new ChannelConnectionService(
    channelConnectionRepository,
    channelConnectionTokenService,
    channelConnectionUsageService,
    channelAccountService,
    organizationService,
    planAccessService,
    redisConnection,
  );
  const instagramMediaService = new InstagramMediaService(
    new InstagramMediaRepository(),
    instagramAccountService,
  );
  // Meta's callbacks and the organization's delete (every account and connection, IAC5) erase here.
  const instagramAccountErasureService = new InstagramAccountErasureService(
    instagramAccountService,
    instagramMediaService,
  );
  const instagramAccountMetaCallbackService = new InstagramAccountMetaCallbackService(
    instagramAccountService,
    instagramAccountErasureService,
  );
  // The automation delete's hook (routes-final § 3.A AU12): every step registered here runs inside
  // route 15's transaction, after the soft delete, and answers how many open runs it cancelled.
  // Sub-domain 3.B registers `cancelAutomationOpenRuns` below, once the run engine is built.
  const automationOpenRunCancelSteps: AutomationOpenRunCancelStep[] = [];
  const automationService = new AutomationService(
    new AutomationRepository(),
    instagramAccountService,
    organizationService,
    automationOpenRunCancelSteps,
  );
  // The contact's erase and pause steps (§ 3.10) run in the route's transaction — the run engine's
  // below, 3.B's and 6's at their rows, as the tag-event port (R11) and the bulk queue (R46). The
  // automation filters resolve through the automation service, so contacts never import it.
  const contactErasureSteps: ContactErasureStep[] = [];
  const contactService = new ContactService(
    new ContactRepository(),
    organizationService,
    contactErasureSteps,
    (input) => automationService.findAutomationIdForFilter(input),
    { pauseSteps: [(input) => automationRunService.cancelContactOpenRuns(input)] },
  );
  const instagramWebhookEventService = new InstagramWebhookEventService(
    new InstagramWebhookEventRepository(),
    organizationService,
  );
  // The receiver stores through the events service (WH1), then adds the account's processing job
  // after each entry's commit and turns the stored `received` rows `queued` (WH5, WH10).
  const instagramWebhookService = new InstagramWebhookService(
    instagramAccountService,
    instagramWebhookEventService,
    enqueueInstagramWebhookAccountProcessing,
  );
  // The run engine (sub-domain 3.B): sub-domain 4's event processing calls its entry points; it
  // sends through sub-domain 1 and writes contacts through sub-domain 2 (AU5).
  const automationRunService = new AutomationRunService(
    instagramAccountService,
    contactService,
    new AutomationRunMessageService(),
    new AutomationPublicReplySafetyService(),
  );
  automationOpenRunCancelSteps.push((input) =>
    automationRunService.cancelAutomationOpenRuns(input),
  );
  contactErasureSteps.push((input) => automationRunService.eraseContactRunCopies(input));
  return {
    channelConnectionService,
    channelConnectionTokenService,
    channelConnectionUsageService,
    channelAccountService,
    instagramAccountService,
    instagramAccountSettingsService,
    instagramMediaService,
    instagramAccountErasureService,
    instagramAccountMetaCallbackService,
    contactService,
    instagramWebhookEventService,
    instagramWebhookService,
    automationService,
    automationRunService,
  };
}

/**
 * Fastify plugin step that decorates the application with the app domain container. Called by
 * `domainContainersPlugin` after the domains it reads (tenancy, and audit through the request).
 */
export function registerAppContainer(application: FastifyInstance): void {
  const { organizationService } = application.tenancyDomain;
  application.decorate(
    'appDomain',
    createAppContainer({
      organizationService,
      planAccessService: application.billingDomain.subscriptionService,
    }),
  );
}
