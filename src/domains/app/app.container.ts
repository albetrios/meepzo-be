import type { FastifyInstance } from 'fastify';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { InstagramAccountRepository } from './sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from './sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountTokenRepository } from './sub-domains/instagram-account/instagram-account-token.repository.js';
import { InstagramAccountTokenService } from './sub-domains/instagram-account/instagram-account-token.service.js';
import { InstagramAccountSettingsRepository } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
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
 * Services exposed by the app domain container (mounted on `app.appDomain`): the Instagram account
 * sub-domain — the account service (routes 1, 2, 4 and the guarded status change), the settings
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
 * The token service is not exposed: only the account service uses it, and the daily check's
 * processor reads the token through the worker token repository (IA5). The worker process builds
 * this container too (`createDomainContainers` → `appDomain`), for the daily check's guarded status
 * change (IA8, IA9) and for Instagram webhook event processing (WH12–WH14), which drives the
 * account, events, contact, media, automation and run-engine services from it.
 */
export type AppContainer = {
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
 * Builds the app domain container — the one place its sub-domains' repositories and services
 * are wired, with cross-domain services passed in as parameters (the organization service: the
 * team check, user id resolution — for the account and the settings services).
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
    instagramAccountRepository,
    organizationService,
  );
  const instagramAccountService = new InstagramAccountService(
    instagramAccountRepository,
    instagramAccountTokenService,
    instagramAccountSettingsService,
    organizationService,
  );
  const instagramMediaService = new InstagramMediaService(
    new InstagramMediaRepository(),
    instagramAccountService,
  );
  // Meta's callbacks and the organization's delete erase through one service (D54).
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
  // The contact erase's hook (routes-final § 2.10, CT8): every step registered here runs inside
  // route 10's transaction, before the contact is anonymised. Sub-domain 3 registers its step below
  // — the run cancel, the trigger texts and the comment-log copies (AU26); sub-domain 4 adds none
  // (CQ1). The list's automation filter (CT5) resolves its `aut_…` id through the automation
  // service, so contacts never import sub-domain 3.
  const contactErasureSteps: ContactErasureStep[] = [];
  const contactService = new ContactService(
    new ContactRepository(),
    organizationService,
    contactErasureSteps,
    (input) => automationService.findAutomationIdForFilter(input),
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
  application.decorate('appDomain', createAppContainer({ organizationService }));
}
