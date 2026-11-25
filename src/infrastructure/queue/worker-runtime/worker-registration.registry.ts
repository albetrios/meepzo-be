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
  getSubscriptionSeatSyncConcurrency,
  type SubscriptionSeatSyncWorkerBillingContainer,
} from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.worker.js';
import { SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { BILLING_SEAT_SYNC_ENABLED } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import { createSubscriptionPlanStateCheckWorker } from '@/domains/billing/sub-domains/subscription/workers/subscription-plan-state-check.worker.js';
import { SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.queue.js';
import { createInstagramSendingRepairWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.worker.js';
import { INSTAGRAM_SENDING_REPAIR_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.constants.js';
import { rebuildInstagramGateOneFromPostgres } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js';
import { registerWorkerRedisRebuildStep } from '@/infrastructure/queue/worker-runtime/worker-redis-watch.js';
import { INSTAGRAM_REPAIR_DATABASE_SLOT_WAIT_MILLISECONDS } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.constants.js';
import { getInstagramDatabaseSlotLimiter } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-ticket.processor.js';
import { createInstagramWebhookWorker } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.worker.js';
import { enqueueInstagramContactProfileRead } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-contact-profile-read.processor.js';
import { createInstagramLateCommentTimeReader } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-missed-comment-check.processor.js';
import {
  enqueueInstagramTagEventIntake,
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { broadcastSendQueue } from '@/domains/app/app.tasks.js';
import { createAppPartitionUpkeepWorker } from '@/domains/app/workers/app-partition-upkeep.worker.js';
import { APP_PARTITION_UPKEEP_QUEUE_NAME } from '@/domains/app/workers/app-partition-upkeep.constants.js';
import { createNotificationRetentionWorker } from '@/domains/notify/sub-domains/notification/workers/notification-retention.worker.js';
import { NOTIFICATION_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-retention.constants.js';
import { runInstagramWebhookSubscriptionCheckSweep } from '@/domains/app/sub-domains/instagram-account/workers/instagram-account-tasks.processor.js';
import { createChannelConnectionTokenCheckWorker } from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.worker.js';
import { CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME } from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js';
import { createInstagramReconnectNoticeWorker } from '@/domains/app/sub-domains/instagram-account/workers/instagram-reconnect-notice.worker.js';
import { INSTAGRAM_RECONNECT_NOTICE_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-account/queues/instagram-reconnect-notice.queue.js';
import { createInstagramSendSlowWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-slow.worker.js';
import { INSTAGRAM_SEND_SLOW_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-slow.queue.js';
import { createInstagramSendFastWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-fast.worker.js';
import { INSTAGRAM_SEND_FAST_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { createInstagramTasksWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-tasks.worker.js';
import { createInstagramSendRepairDutyServices } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-repair-duties.processor.js';
import { INSTAGRAM_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { createInstagramDatabaseTasksWorker } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-database-tasks.worker.js';
import { INSTAGRAM_DATABASE_TASKS_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
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
    // Also runs the weekly summary's hourly sweep and its jobs, and the grouped contact-details
    // notes (feat-instagram-dm-sending UN12, UN13, R53) — the app's reads through its ports (UN1).
    scheduled: true,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getWorkerConcurrencyNotify(),
    create: (workerContainers) =>
      createNotificationWorker({
        weeklySummary: workerContainers.appDomain.channelAccountService,
        contactDetails: workerContainers.appDomain.contactService,
      }),
  },
  {
    // Launch IA9 (WC-46): tells the organization's `channel-account:manage` holders (CA4), in the app
    // and by email, that its Instagram account must be connected again — one job per account and break,
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
    // outside its DB context so no checkout is held during external IO. Switched off by
    // `BILLING_SEAT_SYNC_ENABLED` (BL9, WC-65): nothing is enqueued and the reconcile is not
    // scheduled; the worker stays to drain jobs an older release left, one at a time (R48: so it
    // holds 1 of the worker's Postgres budget, not the family's 4).
    queueName: SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
    family: 'stripe',
    logLabel: 'subscription seat sync worker',
    usesPostgres: true,
    scheduled: BILLING_SEAT_SYNC_ENABLED,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    resolvePostgresConcurrency: () => getSubscriptionSeatSyncConcurrency(),
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
    // feat-instagram-dm-sending § 5 WH5, WH11–WH16, WH25 (ROUTE row R38): Instagram intake — the
    // three kind groups' jobs of each account (messages and Live first, comments behind them), the
    // tag-intake jobs and the every-minute stuck-event pick-up, on one queue. A plain worker, never
    // paused by an Instagram outage (P47 F3); every unit of work takes a slot of the process's
    // Instagram database limiter, which the budget counts once (SN24, P408). Off until the Meta app
    // is configured (no account can be connected before).
    queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram intake worker',
    usesPostgres: true,
    scheduled: true,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    isEnabled: () => isMetaConfigured(),
    create: (workerContainers) => {
      const { appDomain, tenancyDomain } = workerContainers;
      return createInstagramWebhookWorker({
        services: {
          intake: {
            instagramAccountService: appDomain.instagramAccountService,
            channelAccountService: appDomain.channelAccountService,
            broadcastRecipientService: appDomain.broadcastRecipientService,
            instagramAccountSettingsService: appDomain.instagramAccountSettingsService,
            instagramWebhookEventService: appDomain.instagramWebhookEventService,
            contactService: appDomain.contactService,
            instagramMediaService: appDomain.instagramMediaService,
            automationService: appDomain.automationService,
            automationRunService: appDomain.automationRunService,
            instagramMessageService: appDomain.instagramMessageService,
          },
          tagIntake: {
            organizationService: tenancyDomain.organizationService,
            contactTagEventService: appDomain.contactTagEventService,
            contactService: appDomain.contactService,
            automationRunService: appDomain.automationRunService,
          },
          enqueueProfileRead: enqueueInstagramContactProfileRead,
          readLateCommentTime: createInstagramLateCommentTimeReader({
            instagramSendAccessService: appDomain.instagramSendAccessService,
          }),
          // The month notices' backup check (WC-56, R53) rides this queue.
          monthNotice: appDomain.messageMonthNoticeService,
        },
      });
    },
  },
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
  {
    queueName: INSTAGRAM_DATABASE_TASKS_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram database task worker',
    usesPostgres: true,
    scheduled: false,
    criticality: 'throughput',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    // No `isEnabled`: the bulk changes, counts, audiences and retries call no Meta, so they run
    // with sending off too (S19, P217) — a bulk tag change or a segment count is not sending.
    create: (workerContainers) =>
      createInstagramDatabaseTasksWorker({
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
  // feat-instagram-dm-sending MC10 (WC-34): the channel connection's daily token check — the hourly
  // sweep, the 10-minute webhook subscription sweep (WC-25, R40; the launch daily check is retired)
  // and one check per due connection ride one queue. Never paused (F3): a check that meets Meta
  // down returns `deferred` and the next sweep adds it again. Every Meta call runs between two short
  // organization contexts, never inside one. Off until the Meta app is configured.
  retentionDefinition({
    queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
    family: 'retention',
    logLabel: 'channel connection token check worker',
    holdsConnectionDuringExternalIo: false,
    isEnabled: () => isMetaConfigured(),
    create: (workerContainers) =>
      createChannelConnectionTokenCheckWorker({
        connectionService: workerContainers.appDomain.channelConnectionService,
        accountPort: workerContainers.appDomain.channelAccountService,
        usageService: workerContainers.appDomain.channelConnectionUsageService,
        // WC-25 (R40): the 10-minute webhook subscription sweep rides this queue since the launch
        // daily check was retired (R40 × R51 merge).
        webhookSubscriptionSweep: () => runInstagramWebhookSubscriptionCheckSweep(),
      }),
  }),
  // feat-instagram-dm-sending BL17 (WC-59): the 15-minute plan-state check — a sweep across
  // organizations under the retention context, then one check per due subscription inside its
  // organization (a grace that ended, the trial notices, a switched-off plan row). No Stripe call.
  retentionDefinition({
    queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
    family: 'retention',
    logLabel: 'subscription plan-state check worker',
    create: (workerContainers) =>
      createSubscriptionPlanStateCheckWorker({
        subscriptionService: workerContainers.billingDomain.subscriptionService,
        notificationService: workerContainers.notifyDomain.notificationService,
        membershipService: workerContainers.tenancyDomain.membershipService,
        organizationSettingsService: workerContainers.tenancyDomain.organizationSettingsService,
      }),
  }),
  // feat-instagram-dm-sending SN6 (P94): the sending repair duties, one repeat job each — at R52 the
  // month wake's check (WC-37) and the plan-stop backup (WC-38); at R48 the watches (the outage
  // watch every 10 s, the Live check, the waiting estimate); at R47 the eleven every-minute repairs
  // (lost turns … open-run keys, WC-13–WC-20, WC-27–WC-29, WC-67). Several at once (P94: in
  // parallel), each database unit in a slot of the process's `instagram-database` limiter — counted
  // once (SN24), so the duties add no Postgres demand. Not gated on sending as a queue: the duties
  // that work send tickets and the Live check ask `mayTakeTickets` first.
  {
    queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
    family: 'instagram',
    logLabel: 'Instagram sending repair worker',
    usesPostgres: true,
    scheduled: true,
    criticality: 'maintenance',
    holdsConnectionDuringExternalIo: false,
    databaseSlotLimiterName: INSTAGRAM_DATABASE_SLOT_LIMITER_NAME,
    resolvePostgresConcurrency: () => getWorkerInstagramDatabaseSlots(),
    create: (workerContainers) => {
      const limiter = getInstagramDatabaseSlotLimiter();
      const runInDatabaseSlot = <T>(callback: () => Promise<T>): Promise<T> =>
        limiter.runInSlot({
          callback,
          waitMilliseconds: INSTAGRAM_REPAIR_DATABASE_SLOT_WAIT_MILLISECONDS,
        });
      // WC-21: after Redis was lost, gate 1's counts come back from Postgres (the watch's step).
      registerWorkerRedisRebuildStep({
        name: 'instagram-send-gate-one',
        run: async () => {
          await rebuildInstagramGateOneFromPostgres({
            gateService: workerContainers.appDomain.instagramSendGateService,
            runInDatabaseSlot,
          });
        },
      });
      const { appDomain } = workerContainers;
      return createInstagramSendingRepairWorker({
        runInDatabaseSlot,
        sendRepairDuties: createInstagramSendRepairDutyServices({
          sendingGate: appDomain.sendingStateService,
          messageService: appDomain.instagramMessageService,
          gateService: appDomain.instagramSendGateService,
          recipientService: appDomain.broadcastRecipientService,
          sendingPorts: appDomain.channelSendingPorts,
          // R46's `BroadcastSendQueuePort` (`app.tasks.ts`) — the start duty's audience task.
          broadcastSendQueue,
          tagIntakeQueue: { enqueueContactTagEventIntake: enqueueInstagramTagEventIntake },
          openKeyRunService: appDomain.automationRunService,
          runInDatabaseSlot,
        }),
        watch: {
          watchService: workerContainers.appDomain.instagramSendingWatchService,
          runInDatabaseSlot,
        },
      });
    },
  },
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
  // feat-instagram-dm-sending WC-55 (WHC13, P96, P410 — ROUTE row R49): the shared upkeep of the
  // seven time-split app tables — parts made 14 days ahead daily and at worker start, expired parts
  // dropped hourly (webhook events and keys, send attempts, messages, comment logs, run events,
  // runs: WC-48–WC-52). Replaces the launch's daily webhook-event batch delete (WHC15). A pure
  // database pass under its own maintenance scope; no `isEnabled` — the parts must keep coming
  // whatever is configured.
  retentionDefinition({
    queueName: APP_PARTITION_UPKEEP_QUEUE_NAME,
    family: 'retention',
    logLabel: 'app partition upkeep worker',
    create: () => createAppPartitionUpkeepWorker(),
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
