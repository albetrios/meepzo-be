import type { FastifyInstance } from 'fastify';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { registerHealthSendingProbe } from '@/shared/utils/infrastructure/health-operational-metrics.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ChannelAccountRepository } from './sub-domains/channel-account/channel-account.repository.js';
import { ChannelAccountService } from './sub-domains/channel-account/channel-account.service.js';
import { ChannelAccountPlanStopService } from './sub-domains/channel-account/channel-account-plan-stop.service.js';
import type {
  ChannelConnectionLanePort,
  ChannelConnectionTrialPort,
} from './sub-domains/channel-connection/channel-connection.types.js';
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
import { ChannelConnectionMetaCallbackService } from './sub-domains/channel-connection/channel-connection-meta-callback.service.js';
import { InstagramWebhookEventRepository } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventService } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { InstagramWebhookService } from './sub-domains/instagram-webhook/instagram-webhook.service.js';
import { enqueueInstagramWebhookAccountProcessing } from './sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { ContactTagEventRepository } from './sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { ContactTagEventService } from './sub-domains/contact/contact-tag-event/contact-tag-event.service.js';
import { ContactRepository } from './sub-domains/contact/contact.repository.js';
import { ContactService } from './sub-domains/contact/contact.service.js';
import type { ContactErasureStep, ContactPauseStep } from './sub-domains/contact/contact.types.js';
import { AutomationRepository } from './sub-domains/automation/automation.repository.js';
import { AutomationCountRepository } from './sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from './sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from './sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from './sub-domains/automation/automation-reply-state.service.js';
import type { AutomationMessageFilePort } from './sub-domains/automation/automation.types.js';
import { AutomationService } from './sub-domains/automation/automation.service.js';
import { AutomationBackfillRepository } from './sub-domains/automation/automation-backfill/automation-backfill.repository.js';
import { AutomationBackfillService } from './sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type { AutomationOpenRunCancelStep } from './sub-domains/automation/automation.types.js';
import { AutomationRunService } from './sub-domains/automation/automation-run/automation-run.service.js';
import { AutomationRunMessageService } from './sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationPublicReplySafetyService } from './sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import { InstagramSendLaneRepository } from './sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from './sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from './sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { InstagramSendDayCountRepository } from './sub-domains/instagram-sending/instagram-send-day-count.repository.js';
import { MessageMonthCountRepository } from './sub-domains/instagram-sending/message-month-count.repository.js';
import { MessageMonthCountService } from './sub-domains/instagram-sending/message-month-count.service.js';
import { SendingStateService } from './sub-domains/instagram-sending/sending-state.service.js';
import { InstagramSendingService } from './sub-domains/instagram-sending/instagram-sending.service.js';
import type { InstagramAccountSettingsLanePort } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';

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
 * "next post" linking for event processing), the run engine (sub-domain 3.B — the entry points
 * event processing calls per comment, DM, story reply and button click), and the sending
 * sub-domain's root (feat-instagram-dm-sending § 6.A, ROUTE row R18) — the lane service (the lane
 * port of the connection, the channel account and route 12), the month count (the plan-stop port,
 * route 64's meter), the global sending state (`SENDING_ENABLED` and the environment id, the app-level
 * Meta usage) and the read service of routes 63–64.
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
  channelConnectionMetaCallbackService: ChannelConnectionMetaCallbackService;
  contactService: ContactService;
  /** The contact tag events (3.B): the tag-event recorder and the erase step; intake reads at R38. */
  contactTagEventService: ContactTagEventService;
  instagramWebhookEventService: InstagramWebhookEventService;
  instagramWebhookService: InstagramWebhookService;
  automationService: AutomationService;
  /** The past-comments reads (4.C, routes 38–39 — R15); the read job joins at R41. */
  automationBackfillService: AutomationBackfillService;
  /** The automations' all-time counts (AU19) — the run engine writes through it from R14. */
  automationCountService: AutomationCountService;
  /** The "Reply like a person" pacing (AU19) — sub-domain 6's reply lane reads and writes it. */
  automationReplyStateService: AutomationReplyStateService;
  automationRunService: AutomationRunService;
  instagramSendLaneService: InstagramSendLaneService;
  messageMonthCountService: MessageMonthCountService;
  sendingStateService: SendingStateService;
  instagramSendingService: InstagramSendingService;
};

/**
 * The channel connection service (routes 1–5, 40, 42): its accounts through the channel account
 * (P111 → R5), its lanes through sub-domain 6's lane service (R18) and a trial pick through billing's
 * trial port (R24).
 */
function createChannelConnectionService(options: {
  channelConnectionRepository: ChannelConnectionRepository;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelConnectionUsageService: ChannelConnectionUsageService;
  channelAccountService: ChannelAccountService;
  organizationService: OrganizationService;
  planAccessService: ChannelConnectionPlanAccessService;
  lanePort: ChannelConnectionLanePort;
  trialPort: ChannelConnectionTrialPort;
}): ChannelConnectionService {
  return new ChannelConnectionService(
    options.channelConnectionRepository,
    options.channelConnectionTokenService,
    options.channelConnectionUsageService,
    options.channelAccountService,
    options.organizationService,
    options.planAccessService,
    redisConnection,
    options.lanePort,
    options.trialPort,
  );
}

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
  settingsLanePort,
}: {
  organizationService: OrganizationService;
  channelConnectionTokenService: ChannelConnectionTokenService;
  /** Route 12's channel account steps (P42, CA11) — the channel account service, built after. */
  settingsChannelAccountPort: InstagramAccountSettingsChannelAccountPort;
  /** Route 12's lane wake after a limit change (IA14) — sub-domain 6's lane service (R18). */
  settingsLanePort: InstagramAccountSettingsLanePort;
}) {
  const instagramAccountRepository = new InstagramAccountRepository();
  const channelAccountRepository = new ChannelAccountRepository();
  const instagramAccountExtensionService = new InstagramAccountExtensionService(
    instagramAccountRepository,
  );
  // The lane wake after a limit change (IA14) is sub-domain 6's lane service (ROUTE row R18).
  const instagramAccountSettingsService = new InstagramAccountSettingsService(
    new InstagramAccountSettingsRepository(),
    settingsChannelAccountPort,
    organizationService,
    settingsLanePort,
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
 * The sending sub-domain's root services (routes-final § 6.A, ROUTE row R18): the lanes and their
 * stops, the global sending row (registered as the readiness body's sending check, SNC9), the
 * month count (the channel account's plan-stop port, route 64's meter) — and the connection's usage
 * service, whose app-level usage that row holds (S13, P107).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, plus the health
 * probe's registration.
 */
function createInstagramSendingServices(planAccessService: ChannelConnectionPlanAccessService) {
  const instagramSendLaneService = new InstagramSendLaneService(
    new InstagramSendLaneRepository(),
    new InstagramSendStopRepository(),
  );
  const sendingStateService = new SendingStateService();
  // The readiness body's sending part (SNC9): may this deployment send, and why not.
  registerHealthSendingProbe(async () => {
    const check = await sendingStateService.checkSending();
    return {
      may_send: check.maySend,
      reason: check.reason,
      settings_version: check.settingsVersion,
      minimum_compatible_settings_version: check.minimumCompatibleSettingsVersion,
      server_settings_version: check.serverSettingsVersion,
    };
  });
  const messageMonthCountService = new MessageMonthCountService(
    new MessageMonthCountRepository(),
    planAccessService,
  );
  // Meta's usage per connection (MC19, S13): the Postgres store; the app-level usage once, on the
  // global sending row (P107).
  const channelConnectionUsageService = createChannelConnectionUsageService({
    usageStore: createChannelConnectionUsagePostgresStore(new ChannelConnectionUsageRepository()),
    appUsageStore: sendingStateService,
  });
  return {
    instagramSendLaneService,
    sendingStateService,
    messageMonthCountService,
    channelConnectionUsageService,
  };
}

/**
 * The Instagram account's media and erasure services and Meta's callbacks (routes-final § 2, § 1):
 * the post and story pickers (routes 13–14, R8), the one erase of an account's data (which the
 * organization's delete and Meta's callbacks call, IAC5) and the connection's deauthorize /
 * data-deletion callbacks (routes 16–17, R9).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only. Meta's 190 on a media
 * read breaks the account's connection through the connection (MC11, R4's `markConnectionBroken`);
 * R53 adds the callbacks' team-alert port as the fifth argument of the callback service.
 */
function createInstagramMediaAndErasureServices(options: {
  instagramAccountService: InstagramAccountService;
  channelConnectionService: ChannelConnectionService;
  channelConnectionRepository: ChannelConnectionRepository;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelAccountService: ChannelAccountService;
}) {
  const instagramMediaService = new InstagramMediaService(
    new InstagramMediaRepository(),
    options.instagramAccountService,
    options.channelConnectionService,
  );
  const instagramAccountErasureService = new InstagramAccountErasureService(
    options.instagramAccountService,
    instagramMediaService,
  );
  const channelConnectionMetaCallbackService = new ChannelConnectionMetaCallbackService(
    options.channelConnectionRepository,
    options.channelConnectionTokenService,
    options.channelAccountService,
    instagramAccountErasureService,
  );
  return {
    instagramMediaService,
    instagramAccountErasureService,
    channelConnectionMetaCallbackService,
  };
}

/**
 * The Instagram webhook's services (routes-final § 5): the events service (route 62, the one write
 * path of the events table) and the receiver (Meta's routes 60–61).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only.
 */
function createInstagramWebhookServices({
  instagramAccountService,
  organizationService,
}: {
  instagramAccountService: InstagramAccountService;
  organizationService: OrganizationService;
}) {
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
  return { instagramWebhookEventService, instagramWebhookService };
}

/**
 * The contact sub-domain's services (routes-final § 3): the contact service and its tag events
 * (3.B, ROUTE row R11), with the erase and pause steps of § 3.10 — 3.B's tag-event delete first,
 * the run engine's erase pushed by the caller, 6's at its row; the bulk queue (R46) and intake's
 * queue (R38) join later. The automation filters resolve through the automation service, so
 * contacts never import it.
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 * `cancelContactOpenRuns` is a closure because the run engine is built after the contact service.
 */
function createContactServices({
  organizationService,
  automationService,
  cancelContactOpenRuns,
}: {
  organizationService: OrganizationService;
  automationService: AutomationService;
  cancelContactOpenRuns: ContactPauseStep;
}): {
  contactService: ContactService;
  contactTagEventService: ContactTagEventService;
  contactErasureSteps: ContactErasureStep[];
} {
  const contactTagEventService = new ContactTagEventService(new ContactTagEventRepository());
  const contactErasureSteps: ContactErasureStep[] = [
    (input) => contactTagEventService.deleteContactTagEvents(input),
  ];
  const contactService = new ContactService(
    new ContactRepository(),
    organizationService,
    contactErasureSteps,
    (input) => automationService.findAutomationIdForFilter(input),
    { pauseSteps: [cancelContactOpenRuns], tagEventRecorder: contactTagEventService },
  );
  return { contactService, contactTagEventService, contactErasureSteps };
}

/**
 * The automation, contact and run-engine services (feat-instagram-dm-sending routes-final § 3, § 4):
 * automations (routes 27–35, shared by every channel — R13) with their counts and reply pacing,
 * contacts (routes 18–23) and the run engine (4.B), with the two hooks that join them — the
 * automation delete's open-run cancel (AU16) and the contact erase's run copies (CT8).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only. The automations read
 * accounts and the one feature check through the channel account (AU34), the month limit through
 * 6's month count, files through the upload domain's usable-file read (R12); the starter-question
 * sync (R40) and the channels' sending ports (R19–R20) join later.
 */
function createAutomationServices({
  instagramAccountService,
  organizationService,
  channelAccountService,
  planAccessService,
  messageMonthCountService,
  messageFilePort,
}: {
  instagramAccountService: InstagramAccountService;
  organizationService: OrganizationService;
  channelAccountService: ChannelAccountService;
  planAccessService: ChannelConnectionPlanAccessService;
  messageMonthCountService: MessageMonthCountService;
  messageFilePort: AutomationMessageFilePort | undefined;
}) {
  // The automation delete's hook (AU16): every step registered here runs inside route 31's
  // transaction, after the soft delete, and answers how many open runs it cancelled. Sub-domain 4.B
  // registers `cancelAutomationOpenRuns` below, once the run engine is built.
  const automationOpenRunCancelSteps: AutomationOpenRunCancelStep[] = [];
  const automationCountService = new AutomationCountService(new AutomationCountRepository());
  const automationReplyStateService = new AutomationReplyStateService(
    new AutomationReplyStateRepository(),
  );
  const automationRepository = new AutomationRepository();
  // Past comments (4.C, R15): routes 38–39 and the automation object's open read; the read job
  // (WC-41) is enqueued once ROUTE row R41 passes its queue here.
  const automationBackfillService = new AutomationBackfillService(
    new AutomationBackfillRepository(),
    automationRepository,
    channelAccountService,
    organizationService,
  );
  const automationService = new AutomationService(
    automationRepository,
    automationCountService,
    automationReplyStateService,
    channelAccountService,
    planAccessService,
    organizationService,
    automationOpenRunCancelSteps,
    {
      monthLimit: messageMonthCountService,
      messageFiles: messageFilePort,
      openBackfills: automationBackfillService,
    },
  );
  const { contactService, contactTagEventService, contactErasureSteps } = createContactServices({
    organizationService,
    automationService,
    cancelContactOpenRuns: (input) => automationRunService.cancelContactOpenRuns(input),
  });
  // The run engine (sub-domain 4.B): sub-domain 5's event processing calls its entry points; it
  // sends through sub-domain 1 and writes contacts through sub-domain 3 (AU5).
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
    automationService,
    automationBackfillService,
    automationCountService,
    automationReplyStateService,
    contactService,
    contactTagEventService,
    automationRunService,
  };
}

/**
 * Builds the app domain container — the one place its sub-domains' repositories and services
 * are wired, with cross-domain services passed in as parameters (the organization service: the
 * team check, user id resolution; billing's plan read: the channel account limit; billing's trial
 * port: a pick during a trial).
 *
 * @remarks
 * The channel account (1B, R5) is also billing's accounts port (R24); its plan-stop port answers
 * `plan_ended` (R24), then the month count's `plan_limit` (R18). The connection reaches accounts
 * through the channel account (P111 → R5), records a trial pick through billing's trial port (R24),
 * and both reach lanes through sub-domain 6's lane service (R18).
 */
export function createAppContainer({
  organizationService,
  planAccessService,
  trialPort,
  messageFilePort,
}: {
  organizationService: OrganizationService;
  /** Billing's plan read — the channel account limit (feat-instagram-dm-sending MC7). */
  planAccessService: ChannelConnectionPlanAccessService;
  /** Billing's trial port — a pick during a trial (MC7, BL7, ROUTE row R24). */
  trialPort: ChannelConnectionTrialPort;
  /**
   * The upload domain's usable-file read (`UploadService.findUsableMessageFile`, R12) — the automation
   * go-live's file check (AU13 check 15); absent in a unit test, which then checks no file.
   */
  messageFilePort?: AutomationMessageFilePort | undefined;
}): AppContainer {
  const channelConnectionRepository = new ChannelConnectionRepository();
  const channelConnectionTokenService = new ChannelConnectionTokenService(
    new ChannelConnectionTokenRepository(),
    channelConnectionRepository,
  );
  // The sending sub-domain's root (§ 6.A, ROUTE row R18).
  const sending = createInstagramSendingServices(planAccessService);
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
    settingsLanePort: sending.instagramSendLaneService,
  });
  // The channel account (1B, R5): routes 6–11, the feature check, the connection's account port;
  // its lane port is 6's lane service (R18), its plan-stop port `plan_ended` (R24) then the month
  // count's `plan_limit` (R18).
  const channelAccountService = new ChannelAccountService(
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountService,
    instagramAccountSettingsService,
    channelConnectionRepository,
    channelConnectionTokenService,
    organizationService,
    planAccessService,
    sending.instagramSendLaneService,
    new ChannelAccountPlanStopService(planAccessService, sending.messageMonthCountService),
  );
  // The connection reaches accounts through the channel account (R5), lanes through 6 (R18) and a
  // trial pick through billing's trial port (R24).
  const channelConnectionService = createChannelConnectionService({
    channelConnectionRepository,
    channelConnectionTokenService,
    channelConnectionUsageService: sending.channelConnectionUsageService,
    channelAccountService,
    organizationService,
    planAccessService,
    lanePort: sending.instagramSendLaneService,
    trialPort,
  });
  // Routes 63–64 (§ 6.A); route 63's later parts (R19 on) join through its sources argument.
  const instagramSendingService = new InstagramSendingService({
    organizationService,
    channelAccountService,
    planAccessService,
    ...sending,
    dayCountRepository: new InstagramSendDayCountRepository(),
  });
  const {
    instagramMediaService,
    instagramAccountErasureService,
    channelConnectionMetaCallbackService,
  } = createInstagramMediaAndErasureServices({
    instagramAccountService,
    channelConnectionService,
    channelConnectionRepository,
    channelConnectionTokenService,
    channelAccountService,
  });
  const {
    automationService,
    automationBackfillService,
    automationCountService,
    automationReplyStateService,
    contactService,
    contactTagEventService,
    automationRunService,
  } = createAutomationServices({
    instagramAccountService,
    organizationService,
    channelAccountService,
    planAccessService,
    messageMonthCountService: sending.messageMonthCountService,
    messageFilePort,
  });
  const { instagramWebhookEventService, instagramWebhookService } = createInstagramWebhookServices({
    instagramAccountService,
    organizationService,
  });
  return {
    channelConnectionService,
    channelConnectionTokenService,
    channelConnectionUsageService: sending.channelConnectionUsageService,
    channelAccountService,
    instagramAccountService,
    instagramAccountSettingsService,
    instagramMediaService,
    instagramAccountErasureService,
    channelConnectionMetaCallbackService,
    contactService,
    contactTagEventService,
    instagramWebhookEventService,
    instagramWebhookService,
    automationService,
    automationBackfillService,
    automationCountService,
    automationReplyStateService,
    automationRunService,
    instagramSendLaneService: sending.instagramSendLaneService,
    messageMonthCountService: sending.messageMonthCountService,
    sendingStateService: sending.sendingStateService,
    instagramSendingService,
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
      trialPort: application.billingDomain.subscriptionTrialService,
      messageFilePort: application.uploadDomain.uploadService,
    }),
  );
}
