import type { AppContainer } from '@/domains/app/app.container.js';
import { createAppContainer } from '@/domains/app/app.container.js';
import type { AuditContainer } from '@/domains/audit/audit.container.js';
import { createAuditContainer } from '@/domains/audit/audit.container.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';
import { createAuthContainer } from '@/domains/auth/auth.container.js';
import type { BillingContainer } from '@/domains/billing/billing.container.js';
import { createBillingContainer } from '@/domains/billing/billing.container.js';
import type { NotifyContainer } from '@/domains/notify/notify.container.js';
import { createNotifyContainer } from '@/domains/notify/notify.container.js';
import type { TenancyContainer } from '@/domains/tenancy/tenancy.container.js';
import { createTenancyContainer } from '@/domains/tenancy/tenancy.container.js';
import type { UploadContainer } from '@/domains/upload/upload.container.js';
import { createUploadContainer } from '@/domains/upload/upload.container.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import { getDefaultS3ObjectStorageAdapter } from '@/infrastructure/storage/s3-adapter.js';
import type { UserContainer } from '@/domains/user/user.container.js';
import { completeUserContainer, createUserContainerBase } from '@/domains/user/user.container.js';
import { UserDataExportService } from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { UserDataExportRepository } from '@/domains/user/sub-domains/user-data-export/user-data-export.repository.js';
import { UserBugReportRepository } from '@/domains/user/sub-domains/user-bug-report/user-bug-report.repository.js';

/**
 * Aggregate of every domain container the API and worker processes need.
 * Built once at startup by {@link createDomainContainers} so cross-domain
 * service references are wired consistently.
 */
export type DomainContainers = {
  userDomain: UserContainer;
  tenancyDomain: TenancyContainer;
  auditDomain: AuditContainer;
  authDomain: AuthContainer;
  billingDomain: BillingContainer;
  notifyDomain: NotifyContainer;
  uploadDomain: UploadContainer;
  /**
   * The Instagram automation (launch): its workers — the channel connection's token check, the
   * 7-day wait check — use its services.
   */
  appDomain: AppContainer;
};

/**
 * Builds all domain containers without Fastify (API and worker processes share this wiring).
 */
export function createDomainContainers(
  objectStorage: ObjectStoragePort = getDefaultS3ObjectStorageAdapter(),
): DomainContainers {
  const userBase = createUserContainerBase(objectStorage);
  const tenancyDomain = createTenancyContainer({
    userService: userBase.userService,
    objectStorage,
  });
  const authDomain = createAuthContainer({
    userService: userBase.userService,
    organizationSettingsService: tenancyDomain.organizationSettingsService,
    organizationService: tenancyDomain.organizationService,
    authorizationService: tenancyDomain.authorizationService,
  });
  const auditDomain = createAuditContainer({
    organizationService: tenancyDomain.organizationService,
    userService: userBase.userService,
  });
  const billingDomain = createBillingContainer({
    organizationService: tenancyDomain.organizationService,
    membershipSeatUsage: tenancyDomain.membershipService,
  });
  const notifyDomain = createNotifyContainer({
    organizationService: tenancyDomain.organizationService,
    membershipService: tenancyDomain.membershipService,
    userService: userBase.userService,
  });
  const uploadDomain = createUploadContainer({
    userService: userBase.userService,
    organizationService: tenancyDomain.organizationService,
    objectStorage,
  });
  // Built after the domains it reads, as `domainContainersPlugin` does for the API.
  const appDomain = createAppContainer({
    organizationService: tenancyDomain.organizationService,
    planAccessService: billingDomain.subscriptionService,
    trialPort: billingDomain.subscriptionTrialService,
    messageFilePort: uploadDomain.uploadService,
  });
  // Billing's accounts port (feat-instagram-dm-sending § 8.10) is the app's — late-wired, as the API.
  billingDomain.subscriptionService.wireChannelAccounts(appDomain.channelAccountService);
  // The account set-up's failure email (WC-30, R40) reads tenancy's and notify's services — only the
  // worker process runs the account tasks.
  appDomain.instagramAccountTaskSlots.noticeServices = {
    membershipService: tenancyDomain.membershipService,
    organizationSettingsService: tenancyDomain.organizationSettingsService,
    notificationService: notifyDomain.notificationService,
  };

  const userDataExportRepository = new UserDataExportRepository();
  const userDataExportService = new UserDataExportService(
    userBase.userService,
    userDataExportRepository,
    objectStorage,
    new UserBugReportRepository(),
  );
  const userDomainWithRepository = completeUserContainer({ base: userBase, userDataExportService });
  const userDomain: UserContainer = {
    userService: userDomainWithRepository.userService,
    userSettingsService: userDomainWithRepository.userSettingsService,
    userNotificationPreferencesService: userDomainWithRepository.userNotificationPreferencesService,
    userDataExportService: userDomainWithRepository.userDataExportService,
    userBugReportService: userDomainWithRepository.userBugReportService,
  };

  userDomain.userService.wireOffboardingServices({
    authSessionService: authDomain.authSessionService,
    authMethodService: authDomain.authMethodService,
    uploadService: uploadDomain.uploadService,
    userDataExportService: userDomain.userDataExportService,
    // route-audit-#2 follow-up: block deleting a user who still owns organizations.
    organizationOwnership: tenancyDomain.organizationService,
    // Account deletion leaves every organization and erases the user from webhook payloads.
    tenancyDeparture: {
      removeAllForDepartingUser: (userInternalId) =>
        tenancyDomain.membershipService.removeAllForDepartingUser(userInternalId),
      offboardPersonalOrganization: (options) =>
        tenancyDomain.organizationService.offboardPersonalOrganization(options),
    },
    webhookPayloadErasure: notifyDomain.webhookService,
  });

  // feat-instagram-dm-sending UN1: the organization chooser's counts are the app's — a port, wired
  // here because the app is built after tenancy (no container cycle).
  tenancyDomain.organizationService.wireOrganizationCounts(appDomain.channelAccountService);

  tenancyDomain.organizationService.wireOffboardingUploadService({
    uploadService: uploadDomain.uploadService,
    subscriptionService: billingDomain.subscriptionService,
    instagramErasureService: appDomain.instagramAccountErasureService,
  });

  // REQ-4: late-wire billing's subscription service into the membership service so seat enforcement
  // + Stripe seat reconciliation work in the worker process too (membership↔subscription cycle).
  tenancyDomain.membershipService.wireSeatEnforcement(billingDomain.subscriptionService);

  userDomain.userDataExportService.wireCrossDomainServices({
    authSessionService: authDomain.authSessionService,
    membershipService: tenancyDomain.membershipService,
    notificationService: notifyDomain.notificationService,
    auditService: auditDomain.auditService,
  });

  return {
    userDomain,
    tenancyDomain,
    auditDomain,
    authDomain,
    billingDomain,
    notifyDomain,
    uploadDomain,
    appDomain,
  };
}

/** Worker process entry: same container graph as HTTP, without Fastify decorators. */
export function createWorkerContainers(): DomainContainers {
  return createDomainContainers();
}
