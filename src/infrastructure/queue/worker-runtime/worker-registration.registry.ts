import { createMailWorker } from '@/infrastructure/mail/workers/mail.worker.js';
import { createMailOutboxSweeperWorker } from '@/infrastructure/mail/workers/mail-outbox-sweeper.worker.js';
import { MAIL_OUTBOX_SWEEPER_QUEUE_NAME } from '@/infrastructure/mail/workers/mail-outbox-sweeper.constants.js';
import { createCommitDispatchRecoveryWorker } from '@/infrastructure/queue/commit-dispatch/commit-dispatch-recovery.worker.js';
import { COMMIT_DISPATCH_RECOVERY_QUEUE_NAME } from '@/infrastructure/queue/commit-dispatch/commit-dispatch-recovery.constants.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { isMailConfigured } from '@/infrastructure/mail/mail.service.js';
import { createWebhookDeliveryWorker } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import { WEBHOOK_DELIVERY_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { createWebhookDeliveryReclaimWorker } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery-reclaim.worker.js';
import { WEBHOOK_DELIVERY_RECLAIM_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery-reclaim.constants.js';
import { createNotificationWorker } from '@/domains/notify/sub-domains/notification/workers/notification.worker.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { createAuditRetentionWorker } from '@/domains/audit/workers/audit-retention.worker.js';
import { AUDIT_OUTBOX_DRAIN_QUEUE_NAME } from '@/domains/audit/workers/audit-outbox-drain.constants.js';
import { createAuditOutboxDrainWorker } from '@/domains/audit/workers/audit-outbox-drain.worker.js';
import { AUDIT_RETENTION_QUEUE_NAME } from '@/domains/audit/workers/audit-retention.constants.js';
import { createAuditExportWorker } from '@/domains/audit/workers/audit-export.worker.js';
import { AUDIT_EXPORT_QUEUE_NAME } from '@/domains/audit/workers/audit-export.constants.js';
import { createSessionCleanupWorker } from '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.worker.js';
import { SESSION_CLEANUP_QUEUE_NAME } from '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.constants.js';
import { createWebhookTombstoneRetentionWorker } from '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js';
import { WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.constants.js';
import { createWebhookDeliveryAttemptRetentionWorker } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.worker.js';
import { WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.constants.js';
import { createOrganizationNotificationPolicyTombstoneRetentionWorker } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.worker.js';
import { ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.constants.js';
import { createUserTombstoneRetentionWorker } from '@/domains/user/workers/user-tombstone-retention.worker.js';
import { USER_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/user/workers/user-tombstone-retention.constants.js';
import { createUserOffboardingReconcileWorker } from '@/domains/user/workers/user-offboarding-reconcile.worker.js';
import { USER_OFFBOARDING_RECONCILE_QUEUE_NAME } from '@/domains/user/workers/user-offboarding-reconcile.constants.js';
import { createOrganizationOffboardingReconcileWorker } from '@/domains/tenancy/sub-domains/organization/workers/organization-offboarding-reconcile.worker.js';
import { ORGANIZATION_OFFBOARDING_RECONCILE_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/workers/organization-offboarding-reconcile.constants.js';
import { createOrganizationTombstoneRetentionWorker } from '@/domains/tenancy/sub-domains/organization/workers/organization-tombstone-retention.worker.js';
import { ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/workers/organization-tombstone-retention.constants.js';
import { createMembershipTombstoneRetentionWorker } from '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js';
import { MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.constants.js';
import { MEMBERSHIP_INVITATION_EXPIRY_QUEUE_NAME } from '@/domains/tenancy/sub-domains/membership/membership-invitation/workers/membership-invitation-expiry.constants.js';
import { createMembershipInvitationExpiryWorker } from '@/domains/tenancy/sub-domains/membership/membership-invitation/workers/membership-invitation-expiry.worker.js';
import { createMemberRoleTombstoneRetentionWorker } from '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js';
import { MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.constants.js';
import { createOrganizationApiKeyTombstoneRetentionWorker } from '@/domains/tenancy/sub-domains/organization/organization-api-key/workers/organization-api-key-tombstone-retention.worker.js';
import { ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/organization-api-key/workers/organization-api-key-tombstone-retention.constants.js';
import { createUploadTombstoneRetentionWorker } from '@/domains/upload/workers/upload-tombstone-retention.worker.js';
import { UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/upload/workers/upload-tombstone-retention.constants.js';
import { createUploadPendingSweepWorker } from '@/domains/upload/workers/upload-pending-sweep.worker.js';
import { UPLOAD_PENDING_SWEEP_QUEUE_NAME } from '@/domains/upload/workers/upload-pending-sweep.constants.js';
import { createUserDataExportWorker } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export.worker.js';
import { USER_DATA_EXPORT_QUEUE_NAME } from '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js';
import { createUserDataExportRetentionWorker } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.worker.js';
import { USER_DATA_EXPORT_RETENTION_QUEUE_NAME } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.constants.js';
import { createIdempotencyCardinalityWorker } from '@/infrastructure/observability/idempotency-cardinality/idempotency-cardinality.worker.js';
import { IDEMPOTENCY_CARDINALITY_QUEUE_NAME } from '@/infrastructure/observability/idempotency-cardinality/idempotency-cardinality.constants.js';
import { createDlqDepthWorker } from '@/infrastructure/observability/dlq-depth/dlq-depth.worker.js';
import { DLQ_DEPTH_QUEUE_NAME } from '@/infrastructure/observability/dlq-depth/dlq-depth.constants.js';
import { createDlqAutoRetryWorker } from '@/infrastructure/queue/dlq/dlq-auto-retry.worker.js';
import { DLQ_AUTO_RETRY_QUEUE_NAME } from '@/infrastructure/queue/dlq/dlq-auto-retry.constants.js';
import {
  createStripeWebhookWorkerIfConfigured,
  type StripeWebhookWorkerBillingContainer,
} from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook.worker.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { createStripeWebhookEventRetentionWorker } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.worker.js';
import { STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.constants.js';
import { createStripeWebhookEventReclaimWorker } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-reclaim.worker.js';
import { STRIPE_WEBHOOK_EVENT_RECLAIM_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-reclaim.constants.js';
import { createStripeWebhookEventCatchupWorker } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-catchup.worker.js';
import { STRIPE_WEBHOOK_EVENT_CATCHUP_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-catchup.constants.js';
import {
  createSubscriptionSeatSyncWorker,
  type SubscriptionSeatSyncWorkerBillingContainer,
} from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.worker.js';
import { SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { createInstagramWebhookWorker } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.worker.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { createInstagramWebhookEventRetentionWorker } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.worker.js';
import { INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/workers/instagram-webhook-event-retention.constants.js';
import { createNotificationRetentionWorker } from '@/domains/notify/sub-domains/notification/workers/notification-retention.worker.js';
import { NOTIFICATION_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-retention.constants.js';
import { createInstagramAccountDailyCheckWorker } from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-daily-check.worker.js';
import { INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-account-daily-check.queue.js';
import { createInstagramReconnectNoticeWorker } from '@/domains/app/sub-domains/instagram-account/workers/instagram-reconnect-notice.worker.js';
import { INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { createInstagramSendSlowWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-slow.worker.js';
import { INSTAGRAM_SEND_SLOW_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import { createInstagramSendFastWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-fast.worker.js';
import { INSTAGRAM_SEND_FAST_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { createInstagramTasksWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.worker.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { INSTAGRAM_DATABASE_SLOT_LIMITER_NAME } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { isMetaConfigured } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { createAutomationRunWaitExpiryWorker } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.worker.js';
import { AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.constants.js';
import { createAutomationTombstoneRetentionWorker } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.worker.js';
import { AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.constants.js';
import {
  isStripeConfigured,
  isStripeWebhookIngressConfigured,
} from '@/infrastructure/payment/stripe.client.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { RETENTION_WORKER_CONCURRENCY } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import type { WorkerQueueFamily } from '@/infrastructure/queue/worker-runtime/worker-queue-family.constants.js';
import { env } from '@/shared/config/env.config.js';
import {
  getWorkerConcurrencyInstagram,
  getWorkerInstagramDatabaseSlots,
  getWorkerConcurrencyMail,
  getWorkerConcurrencyNotify,
  getWorkerConcurrencyStripe,
  getWorkerConcurrencyWebhook,
} from '@/shared/config/worker-concurrency.util.js';
import type { DomainContainers } from '@/worker-containers.js';

/**
 * Operational profile for a registered worker. Used by alerting (`throughput` vs
 * `maintenance` vs `observability`) and replica-mode guidance in docs.
 */
export type WorkerCriticality = 'throughput' | 'maintenance' | 'observability';

/**
 * Single row in the worker registry — declarative metadata plus a `create` factory used
 * by {@link registerDomainWorkers} to instantiate the BullMQ worker. Drives pool
 * budgeting, family-based split worker selection, `auditSchedulerRegistryConsistency`
 * drift detection, and `isEnabled` gating for workers that depend on optional secrets
 * (Resend, Stripe).
 */
export type WorkerQueueRegistrationDefinition = {
  readonly queueName: string;
  readonly family: WorkerQueueFamily;
  readonly logLabel: string;
  readonly usesPostgres: boolean;
  /**
   * `true` when this worker is driven by a repeatable cron in `scheduler.ts`.
   * `false` for event-driven workers (`mail`, `webhook-delivery`, `notification`,
   * `user-data-export`, `stripe-webhook`, `subscription-seat-sync`) and worker-without-cron orphans.
   *
   * Cross-checked against `scheduler.ts` at startup
   * (`auditSchedulerRegistryConsistency()`); mismatches are logged.
   */
  readonly scheduled: boolean;
  readonly criticality: WorkerCriticality;
  /**
   * `true` when the worker holds a Postgres pool checkout while making outbound
   * HTTP / S3 / Resend / Stripe calls (e.g. webhook delivery wraps its tenant
   * transaction around the outbound HTTP request; S3-bound retention workers
   * delete inside a DB context).
   *
   * Surfaced in `worker.queue_families.selected` and pool-pressure alerts so
   * operators can correlate slow externals with pool starvation.
   */
  readonly holdsConnectionDuringExternalIo?: boolean;
  readonly resolvePostgresConcurrency?: (workerContainers: DomainContainers | undefined) => number;
  /**
   * The in-process database limiter this worker's units of work take their slots from (SN24, P91).
   * Its `resolvePostgresConcurrency` reports the limiter's size, and the connection budget counts
   * each named limiter **once per process**, whatever number of queues share it — slots, not job
   * places.
   */
  readonly databaseSlotLimiterName?: string;
  readonly isEnabled?: (workerContainers: DomainContainers) => boolean;
  readonly create: (workerContainers: DomainContainers) => WorkerHandle;
};

/**
 * Default retention/cron worker: Postgres-bound, single concurrency, maintenance criticality,
 * scheduled via cron. Caller may override `scheduled` or `criticality` for the rare worker
 * that lacks a cron yet (orphans) or has a different criticality.
 */
function retentionDefinition(
  parameters: Omit<
    WorkerQueueRegistrationDefinition,
    'usesPostgres' | 'resolvePostgresConcurrency' | 'criticality' | 'scheduled'
  > & {
    readonly scheduled?: boolean;
    readonly criticality?: WorkerCriticality;
  },
): WorkerQueueRegistrationDefinition {
  return {
    ...parameters,
    usesPostgres: true,
    resolvePostgresConcurrency: () => RETENTION_WORKER_CONCURRENCY,
    scheduled: parameters.scheduled ?? true,
    criticality: parameters.criticality ?? 'maintenance',
  };
}

const WORKER_QUEUE_REGISTRATION_DEFINITIONS: WorkerQueueRegistrationDefinition[] = [
  {
    queueName: COMMIT_DISPATCH_RECOVERY_QUEUE_NAME,
    family: 'mail',
    logLabel: 'commit dispatch recovery worker',
    usesPostgres: false,
    scheduled: true,
    criticality: 'maintenance',
    create: () => createCommitDispatchRecoveryWorker(),
  },
  retentionDefinition({
    queueName: MAIL_OUTBOX_SWEEPER_QUEUE_NAME,
    family: 'mail',
    logLabel: 'mail outbox sweeper worker',
    create: () => createMailOutboxSweeperWorker(),
  }),
  {
    queueName: MAIL_QUEUE_NAME,
    family: 'mail',
    logLabel: 'mail worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyMail(),
    isEnabled: () => isMailConfigured(),
    create: () => createMailWorker(),
  },
  {
    queueName: WEBHOOK_DELIVERY_QUEUE_NAME,
    family: 'webhook',
    logLabel: 'webhook delivery worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    // Claim + record run in separate short transactions; the outbound POST happens with no
    // open Postgres checkout, so delivery no longer pins a connection during external IO.
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyWebhook(),
    create: () => createWebhookDeliveryWorker(),
  },
  // Same family as the delivery worker, so the safety net runs wherever deliveries run: it
  // re-enqueues attempts whose job was lost (Redis refused the enqueue, or the process died
  // between commit and enqueue). One short read, then the adds outside any database context.
  retentionDefinition({
    queueName: WEBHOOK_DELIVERY_RECLAIM_QUEUE_NAME,
    family: 'webhook',
    logLabel: 'webhook delivery reclaim worker',
    holdsConnectionDuringExternalIo: false,
    create: () => createWebhookDeliveryReclaimWorker(),
  }),
  {
    queueName: NOTIFICATION_QUEUE_NAME,
    family: 'notify',
    logLabel: 'notification worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyNotify(),
    create: () => createNotificationWorker(),
  },
  {
    // Launch IA9: tells the organization's `instagram-account:manage` holders, in the app and by
    // email, that its Instagram account must be connected again — one job per account and break,
    // enqueued after the guarded status change commits (API and worker processes alike).
    queueName: INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME,
    family: 'notify',
    logLabel: 'Instagram reconnect notice worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyNotify(),
    create: (workerContainers) =>
      createInstagramReconnectNoticeWorker({
        membershipService: workerContainers.tenancyDomain.membershipService,
        organizationSettingsService: workerContainers.tenancyDomain.organizationSettingsService,
        notificationService: workerContainers.notifyDomain.notificationService,
      }),
  },
  {
    queueName: USER_DATA_EXPORT_QUEUE_NAME,
    family: 'notify',
    logLabel: 'user data export worker',
    usesPostgres: true,
    // Also runs the `reclaim-pending-user-data-exports` sweep, every five minutes.
    scheduled: true,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyNotify(),
    create: (workerContainers) =>
      createUserDataExportWorker(workerContainers.userDomain.userDataExportService),
  },
  {
    queueName: STRIPE_WEBHOOK_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'stripe webhook worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyStripe(),
    isEnabled: () => isStripeConfigured() && isStripeWebhookIngressConfigured(),
    create: (workerContainers) => {
      const handle = createStripeWebhookWorkerIfConfigured(
        workerContainers.billingDomain as StripeWebhookWorkerBillingContainer,
      );
      if (handle === null) {
        throw new Error('stripe webhook worker create called when Stripe is not configured');
      }
      return handle;
    },
  },
  retentionDefinition({
    queueName: AUDIT_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'audit retention worker',
    create: () => createAuditRetentionWorker(),
  }),
  retentionDefinition({
    queueName: AUDIT_OUTBOX_DRAIN_QUEUE_NAME,
    family: 'retention',
    logLabel: 'audit outbox drain worker',
    create: () => createAuditOutboxDrainWorker(),
  }),
  retentionDefinition({
    queueName: AUDIT_EXPORT_QUEUE_NAME,
    family: 'retention',
    logLabel: 'audit export worker',
    create: () => createAuditExportWorker(),
  }),
  retentionDefinition({
    queueName: SESSION_CLEANUP_QUEUE_NAME,
    family: 'retention',
    logLabel: 'session cleanup worker',
    create: () => createSessionCleanupWorker(),
  }),
  retentionDefinition({
    queueName: NOTIFICATION_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'notification retention worker',
    create: () => createNotificationRetentionWorker(),
  }),
  retentionDefinition({
    queueName: USER_OFFBOARDING_RECONCILE_QUEUE_NAME,
    family: 'retention',
    logLabel: 'user offboarding reconcile worker',
    create: (workerContainers) =>
      createUserOffboardingReconcileWorker(workerContainers.userDomain.userService),
  }),
  retentionDefinition({
    queueName: ORGANIZATION_OFFBOARDING_RECONCILE_QUEUE_NAME,
    family: 'retention',
    logLabel: 'organization offboarding reconcile worker',
    create: (workerContainers) =>
      createOrganizationOffboardingReconcileWorker(
        workerContainers.tenancyDomain.organizationService,
      ),
  }),
  {
    // REQ-4: reconciles the Stripe subscription quantity to the organization member count, out-of-band so a
    // Stripe outage never fails member management. Event-driven (enqueued on member add/remove +
    // change-plan), plus the hourly `reconcile-subscription-seats` job (lost enqueues, lapsed dunning
    // entitlements). Stripe-gated like the rest of the family; the service phases the Stripe call
    // outside its DB context so no checkout is held during external IO.
    queueName: SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'subscription seat sync worker',
    usesPostgres: true,
    scheduled: true,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyStripe(),
    isEnabled: () => isStripeConfigured(),
    create: (workerContainers) =>
      createSubscriptionSeatSyncWorker(
        workerContainers.billingDomain as SubscriptionSeatSyncWorkerBillingContainer,
      ),
  },
  retentionDefinition({
    queueName: STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'stripe webhook event retention worker',
    create: () => createStripeWebhookEventRetentionWorker(),
  }),
  retentionDefinition({
    queueName: STRIPE_WEBHOOK_EVENT_RECLAIM_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'stripe webhook event reclaim worker',
    create: () => createStripeWebhookEventReclaimWorker(),
  }),
  retentionDefinition({
    queueName: STRIPE_WEBHOOK_EVENT_CATCHUP_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'stripe webhook event catch-up worker',
    create: () => createStripeWebhookEventCatchupWorker(),
  }),
  {
    // launch-2026-11-20-ujai WH5, WH12–WH15: Instagram webhook event processing — one job per
    // account works through its waiting events in order (deduplicated per account), plus the
    // every-minute stuck-event pick-up on the same queue. Provider-pausable on the `instagram`
    // circuit; every Instagram call runs between short organization contexts, never inside one.
    // Off until the Instagram app is configured (no account can be connected before).
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram webhook event processing worker',
    usesPostgres: true,
    scheduled: true,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyInstagram(),
    isEnabled: () => isMetaConfigured(),
    create: (workerContainers) =>
      createInstagramWebhookWorker({
        instagramAccountService: workerContainers.appDomain.instagramAccountService,
        instagramWebhookEventService: workerContainers.appDomain.instagramWebhookEventService,
        contactService: workerContainers.appDomain.contactService,
        instagramMediaService: workerContainers.appDomain.instagramMediaService,
        automationService: workerContainers.appDomain.automationService,
        automationRunService: workerContainers.appDomain.automationRunService,
      }),
  },
  // launch-2026-11-20-ujai WH19: the daily 30-day clean-up of the Instagram webhook events. Family
  // `instagram` (beside event processing and its stuck-event pick-up, WH5); no `isEnabled` — the
  // delete is harmless without Instagram settings, and rows stored before they were removed still go.
  retentionDefinition({
    queueName: INSTAGRAM_WEBHOOK_EVENT_RETENTION_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'instagram webhook event retention worker',
    create: () => createInstagramWebhookEventRetentionWorker(),
  }),
  // feat-instagram-dm-sending SN2, SN24 (P91, ROUTE row R37): the send and task queues. Their job
  // places wait on Meta, not Postgres: every unit of work takes a slot of the process's Instagram
  // database limiter, which the budget counts once (`WORKER_INSTAGRAM_DATABASE_SLOTS`). Not
  // provider-pausable — the lanes' stops decide. Off unless this deployment may send
  // (`SENDING_ENABLED`); each ticket also asks `mayTakeTickets` (SN7). All three are family
  // `instagram` and run in the existing `worker` service beside every other queue (P140, which
  // supersedes P91's send service): one limiter for the process.
  {
    queueName: INSTAGRAM_SEND_SLOW_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram send worker (slow, reply and broadcast lane turns)',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    isEnabled: () => env.SENDING_ENABLED,
    create: (workerContainers) =>
      createInstagramSendSlowWorker({
        sendingGate: workerContainers.appDomain.sendingStateService,
        laneTurn: workerContainers.appDomain.instagramSendWork.laneTurn,
      }),
  },
  {
    queueName: INSTAGRAM_SEND_FAST_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram send worker (fast messages)',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    isEnabled: () => env.SENDING_ENABLED,
    create: (workerContainers) =>
      createInstagramSendFastWorker({
        sendingGate: workerContainers.appDomain.sendingStateService,
        fastMessage: workerContainers.appDomain.instagramSendWork.fastMessage,
      }),
  },
  {
    queueName: INSTAGRAM_TASKS_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram task worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    isEnabled: () => env.SENDING_ENABLED,
    create: (workerContainers) =>
      createInstagramTasksWorker({
        sendingGate: workerContainers.appDomain.sendingStateService,
        taskHandlers: workerContainers.appDomain.instagramSendWork.taskHandlers,
      }),
  },
  retentionDefinition({
    queueName: WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'webhook tombstone retention worker',
    create: () => createWebhookTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'webhook delivery attempt retention worker',
    create: () => createWebhookDeliveryAttemptRetentionWorker(),
  }),
  retentionDefinition({
    queueName: ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'organization notification policy tombstone retention worker',
    create: () => createOrganizationNotificationPolicyTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: USER_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'user tombstone retention worker',
    create: () => createUserTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'organization tombstone retention worker',
    create: () => createOrganizationTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'membership tombstone retention worker',
    create: () => createMembershipTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: MEMBERSHIP_INVITATION_EXPIRY_QUEUE_NAME,
    family: 'retention',
    logLabel: 'membership invitation expiry worker',
    create: (workerContainers) =>
      createMembershipInvitationExpiryWorker(workerContainers.tenancyDomain.membershipService),
  }),
  retentionDefinition({
    queueName: MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'member role tombstone retention worker',
    create: () => createMemberRoleTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'organization API key tombstone retention worker',
    create: () => createOrganizationApiKeyTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'upload tombstone retention worker',
    holdsConnectionDuringExternalIo: false,
    create: () => createUploadTombstoneRetentionWorker(),
  }),
  retentionDefinition({
    queueName: UPLOAD_PENDING_SWEEP_QUEUE_NAME,
    family: 'retention',
    logLabel: 'upload pending sweep worker',
    holdsConnectionDuringExternalIo: false,
    create: () => createUploadPendingSweepWorker(),
  }),
  retentionDefinition({
    queueName: USER_DATA_EXPORT_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'user data export retention worker',
    holdsConnectionDuringExternalIo: false,
    create: () => createUserDataExportRetentionWorker(),
  }),
  // Launch IA8: the daily Instagram account check — the 04:00 UTC sweep and one check per
  // connected account ride one queue. Provider-pausable on the `instagram` circuit; every
  // Instagram call runs between two short organization contexts, never inside one. Off until the
  // Instagram app is configured (no account can be connected before).
  retentionDefinition({
    queueName: INSTAGRAM_ACCOUNT_DAILY_CHECK_QUEUE_NAME,
    family: 'retention',
    logLabel: 'Instagram account daily check worker',
    holdsConnectionDuringExternalIo: false,
    isEnabled: () => isMetaConfigured(),
    create: (workerContainers) =>
      createInstagramAccountDailyCheckWorker({
        accountService: workerContainers.appDomain.instagramAccountService,
      }),
  }),
  // Launch D8 (routes-final § 3.B AU25, AQ7): the run and automation clean-ups — every hour the
  // runs waiting more than 7 days are cancelled with their open keys (a cross-organization scan, then
  // each organization's cancel in its own context, through the run service — WC-45); daily at 03:40
  // UTC the automations deleted more than 180 days ago are removed. Runs and comment logs go by
  // month-part drops (the shared upkeep, R49). Pure database sweeps: no channel call, no gate.
  retentionDefinition({
    queueName: AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME,
    family: 'retention',
    logLabel: 'automation run wait expiry worker',
    create: (workerContainers) =>
      createAutomationRunWaitExpiryWorker({
        runService: workerContainers.appDomain.automationRunService,
      }),
  }),
  retentionDefinition({
    queueName: AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME,
    family: 'retention',
    logLabel: 'automation tombstone retention worker',
    create: () => createAutomationTombstoneRetentionWorker(),
  }),
  {
    queueName: IDEMPOTENCY_CARDINALITY_QUEUE_NAME,
    family: 'observability',
    logLabel: 'idempotency cardinality worker',
    usesPostgres: false,
    scheduled: true,
    criticality: 'observability',
    create: () => createIdempotencyCardinalityWorker(),
  },
  {
    queueName: DLQ_DEPTH_QUEUE_NAME,
    family: 'observability',
    logLabel: 'DLQ depth monitoring worker',
    usesPostgres: false,
    scheduled: true,
    criticality: 'observability',
    create: () => createDlqDepthWorker(),
  },
  retentionDefinition({
    queueName: DLQ_AUTO_RETRY_QUEUE_NAME,
    family: 'observability',
    logLabel: 'DLQ auto-retry worker',
    create: () => createDlqAutoRetryWorker(),
  }),
];

/** Returns the full registry (every queue family) — used by the scheduler audit and pool-budget calculations. */
export function getWorkerQueueRegistrationDefinitions(): readonly WorkerQueueRegistrationDefinition[] {
  return WORKER_QUEUE_REGISTRATION_DEFINITIONS;
}

/** Serializable operational manifest row (no factory functions). */
export type WorkerQueueOperationalManifestEntry = Pick<
  WorkerQueueRegistrationDefinition,
  | 'queueName'
  | 'family'
  | 'logLabel'
  | 'usesPostgres'
  | 'scheduled'
  | 'criticality'
  | 'holdsConnectionDuringExternalIo'
>;

/**
 * Returns the declarative worker/queue manifest for ops dashboards and `/readyz`.
 */
export function getWorkerQueueOperationalManifest(): readonly WorkerQueueOperationalManifestEntry[] {
  return WORKER_QUEUE_REGISTRATION_DEFINITIONS.map(
    ({
      queueName,
      family,
      logLabel,
      usesPostgres,
      scheduled,
      criticality,
      holdsConnectionDuringExternalIo,
    }) => ({
      queueName,
      family,
      logLabel,
      usesPostgres,
      scheduled,
      criticality,
      ...(holdsConnectionDuringExternalIo === undefined ? {} : { holdsConnectionDuringExternalIo }),
    }),
  );
}

/**
 * Filters the registry down to definitions whose `family` is in the selected set — used
 * by split worker services so `pnpm dev:worker` only starts the queues the local process
 * is responsible for.
 */
export function getWorkerRegistrationsForFamilies(
  families: readonly WorkerQueueFamily[],
): WorkerQueueRegistrationDefinition[] {
  const familySet = new Set(families);
  return WORKER_QUEUE_REGISTRATION_DEFINITIONS.filter((definition) =>
    familySet.has(definition.family),
  );
}
