/**
 * Central registry for BullMQ repeatable jobs (cleanup / retention).
 * Worker processors live in domains; this module only calls upsertJobScheduler.
 */

import { Queue } from 'bullmq';
import { SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { AUDIT_RETENTION_QUEUE_NAME } from '@/domains/audit/workers/audit-retention.constants.js';
import {
  AUDIT_OUTBOX_DRAIN_QUEUE_NAME,
  DEFAULT_AUDIT_OUTBOX_DRAIN_CRON,
} from '@/domains/audit/workers/audit-outbox-drain.constants.js';
import { NOTIFICATION_WEEKLY_SUMMARY_SWEEP_JOB_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-weekly-summary.constants.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-owner-problem-email.constants.js';
import { MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/message-month-notice-check.constants.js';
import { NOTIFICATION_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-retention.constants.js';
import { SESSION_CLEANUP_QUEUE_NAME } from '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.constants.js';
import { WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.constants.js';
import { WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.constants.js';
import { ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.constants.js';
import { USER_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/user/workers/user-tombstone-retention.constants.js';
import { USER_OFFBOARDING_RECONCILE_QUEUE_NAME } from '@/domains/user/workers/user-offboarding-reconcile.constants.js';
import { ORGANIZATION_OFFBOARDING_RECONCILE_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/workers/organization-offboarding-reconcile.constants.js';
import { ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/workers/organization-tombstone-retention.constants.js';
import { MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.constants.js';
import { MEMBERSHIP_INVITATION_EXPIRY_QUEUE_NAME } from '@/domains/tenancy/sub-domains/membership/membership-invitation/workers/membership-invitation-expiry.constants.js';
import { MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.constants.js';
import { ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/tenancy/sub-domains/organization/organization-api-key/workers/organization-api-key-tombstone-retention.constants.js';
import { UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/upload/workers/upload-tombstone-retention.constants.js';
import { UPLOAD_PENDING_SWEEP_QUEUE_NAME } from '@/domains/upload/workers/upload-pending-sweep.constants.js';
import { USER_DATA_EXPORT_RETENTION_QUEUE_NAME } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.constants.js';
import { IDEMPOTENCY_CARDINALITY_QUEUE_NAME } from '@/infrastructure/observability/idempotency-cardinality/idempotency-cardinality.constants.js';
import { DLQ_DEPTH_QUEUE_NAME } from '@/infrastructure/observability/dlq-depth/dlq-depth.constants.js';
import { MAIL_OUTBOX_SWEEPER_QUEUE_NAME } from '@/infrastructure/mail/workers/mail-outbox-sweeper.constants.js';
import { COMMIT_DISPATCH_RECOVERY_QUEUE_NAME } from '@/infrastructure/queue/commit-dispatch/commit-dispatch-recovery.constants.js';
import {
  DLQ_AUTO_RETRY_QUEUE_NAME,
  DEFAULT_DLQ_AUTO_RETRY_CRON,
} from '@/infrastructure/queue/dlq/dlq-auto-retry.constants.js';
import { STRIPE_WEBHOOK_EVENT_RECLAIM_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-reclaim.constants.js';
import { SUBSCRIPTION_SEAT_RECONCILE_JOB_NAME } from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-reconcile.constants.js';
import { SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { BILLING_SEAT_SYNC_ENABLED } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import { SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME } from '@/domains/billing/sub-domains/subscription/queues/subscription-plan-state-check.queue.js';
import {
  SUBSCRIPTION_PLAN_STATE_CHECK_CRON,
  SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME,
} from '@/domains/billing/sub-domains/subscription/workers/subscription-plan-state-check.constants.js';
import {
  INSTAGRAM_REPAIR_MONTH_WAKE_CRON,
  INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME,
  INSTAGRAM_REPAIR_PLAN_STOPS_CRON,
  INSTAGRAM_REPAIR_PLAN_STOPS_JOB_NAME,
  INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-repair.constants.js';
import {
  INSTAGRAM_WATCH_LIVE_CHECK_CRON,
  INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME,
  INSTAGRAM_WATCH_OUTAGE_CHECK_EVERY_MILLISECONDS,
  INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME,
  INSTAGRAM_WATCH_WAITING_ESTIMATE_CRON,
  INSTAGRAM_WATCH_WAITING_ESTIMATE_JOB_NAME,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-sending-watch.constants.js';
import { WEBHOOK_DELIVERY_RECLAIM_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery-reclaim.constants.js';
import { USER_DATA_EXPORT_QUEUE_NAME } from '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js';
import { USER_DATA_EXPORT_RECLAIM_JOB_NAME } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-reclaim.constants.js';
import { STRIPE_WEBHOOK_EVENT_CATCHUP_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-catchup.constants.js';
import { STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.constants.js';
import { AUDIT_EXPORT_QUEUE_NAME } from '@/domains/audit/workers/audit-export.constants.js';
import { CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME } from '@/domains/app/sub-domains/channel-connection/queues/channel-connection-token-check.queue.js';
import {
  CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME,
  INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME,
} from '@/domains/app/sub-domains/channel-connection/workers/channel-connection-token-check.constants.js';
import {
  APP_PARTITION_UPKEEP_DROP_JOB_NAME,
  APP_PARTITION_UPKEEP_MAKE_JOB_NAME,
  APP_PARTITION_UPKEEP_QUEUE_NAME,
} from '@/domains/app/workers/app-partition-upkeep.constants.js';
import { APP_TABLE_CLEAN_UP_JOB_NAME } from '@/domains/app/workers/app-table-clean-up.constants.js';
import { INSTAGRAM_WEBHOOK_QUEUE_NAME } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-reclaim.constants.js';
import { INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-missed-comment-check.constants.js';
import { AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.constants.js';
import { AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME } from '@/domains/app/sub-domains/automation/workers/automation-tombstone-retention.constants.js';
import { AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.constants.js';
import { AUTOMATION_BACKFILL_WATCH_JOB_NAME } from '@/domains/app/sub-domains/automation/automation-backfill/workers/automation-backfill-watch.constants.js';
import {
  INSTAGRAM_SEND_REPAIR_DUTY_CRON,
  INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES,
} from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-repair-duties.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';

/**
 * One row in the canonical scheduler registry: maps a BullMQ queue to its stable
 * `schedulerId` (used by BullMQ for upsert deduplication), the job name, and how it repeats —
 * exactly one of a cron pattern or a fixed interval in milliseconds (feat-instagram-dm-sending
 * SNC5: the 10-second outage watch; {@link resolveScheduledJobRepeat} refuses both or neither).
 * The optional `timezone` is forwarded to BullMQ as `tz` (cron only) and is sourced from
 * `SCHEDULER_TIMEZONE` so all scheduled runs agree on a wall clock.
 */
export interface ScheduledJob {
  queueName: string;
  schedulerId: string;
  jobName: string;
  /** A cron pattern (minute granularity) — or set {@link ScheduledJob.everyMilliseconds}. */
  cronPattern?: string;
  /** A fixed repeat interval in milliseconds, for a cadence under a minute (SNC5). */
  everyMilliseconds?: number;
  /** Passed to BullMQ as `tz` when set (cron only). */
  timezone?: string;
}

/**
 * The BullMQ repeat options of one scheduled job: `{ pattern, tz? }` for a cron, `{ every }` for
 * an interval (feat-instagram-dm-sending SNC5).
 *
 * @remarks
 * - **Algorithm:** exactly one of `cronPattern` / `everyMilliseconds` must be set; an interval
 *   must be a whole number of milliseconds of at least 1,000.
 * - **Failure modes:** throws on both, neither or a bad interval — a registry bug, caught by the
 *   scheduler unit test before it ships.
 * - **Side effects:** none.
 */
export function resolveScheduledJobRepeat(
  job: ScheduledJob,
): { pattern: string; tz?: string } | { every: number } {
  const hasCron = job.cronPattern !== undefined;
  const hasInterval = job.everyMilliseconds !== undefined;
  if (hasCron === hasInterval) {
    throw new Error(
      `scheduled job ${job.schedulerId} needs exactly one of cronPattern / everyMilliseconds`,
    );
  }
  if (job.everyMilliseconds !== undefined) {
    if (!Number.isInteger(job.everyMilliseconds) || job.everyMilliseconds < 1000) {
      throw new Error(`scheduled job ${job.schedulerId} needs an interval of at least 1000 ms`);
    }
    return { every: job.everyMilliseconds };
  }
  return {
    pattern: job.cronPattern as string,
    ...(job.timezone !== undefined ? { tz: job.timezone } : {}),
  };
}

/**
 * Lifecycle handle returned by {@link registerScheduledJobs}. `close()` closes every
 * BullMQ producer that was opened to register the cron schedules (best-effort, never
 * throws), so the scheduler-only handle can be drained alongside worker handles.
 */
export interface SchedulerHandle {
  close: () => Promise<void>;
}

const DEFAULT_AUDIT_RETENTION_CRON = '0 3 * * *';
/** In-app notification row retention purge (runs after audit cleanup). */
const DEFAULT_NOTIFICATION_RETENTION_CRON = '30 3 * * *';
/** Offboarding reconcilers run every 15 minutes so a stuck delete completes promptly, not next day. */
const DEFAULT_OFFBOARDING_RECONCILE_CRON = '*/15 * * * *';
/**
 * feat-instagram-dm-sending WC-64 (P92): hourly within the clean-up time budget (was daily at
 * 04:00 UTC) — sessions and, since ROUTE row R50, ended trusted devices.
 */
const DEFAULT_SESSION_CLEANUP_CRON = '12 * * * *';
/** GDPR export artifact purge runs before upload tombstone retention. */
const DEFAULT_USER_DATA_EXPORT_RETENTION_CRON = '44 5 * * *';
/** Tombstone purge order: uploads → organizations → child tombstones → users (FK-safe). */
const DEFAULT_UPLOAD_TOMBSTONE_RETENTION_CRON = '45 5 * * *';
const DEFAULT_ORGANIZATION_TOMBSTONE_RETENTION_CRON = '46 5 * * *';
const DEFAULT_WEBHOOK_TOMBSTONE_RETENTION_CRON = '47 5 * * *';
/** Time-based purge of webhook delivery attempts (audit-#3); off-peak, distinct slot. */
const DEFAULT_WEBHOOK_DELIVERY_ATTEMPT_RETENTION_CRON = '40 3 * * *';
const DEFAULT_ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_CRON = '48 5 * * *';
const DEFAULT_MEMBERSHIP_TOMBSTONE_RETENTION_CRON = '50 5 * * *';
/** Daily: invited memberships whose invite expired more than 7 days ago free their seat (launch D84). */
const DEFAULT_MEMBERSHIP_INVITATION_EXPIRY_CRON = '10 4 * * *';
const DEFAULT_MEMBER_ROLE_TOMBSTONE_RETENTION_CRON = '51 5 * * *';
const DEFAULT_ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_CRON = '52 5 * * *';
const DEFAULT_USER_TOMBSTONE_RETENTION_CRON = '53 5 * * *';
const DEFAULT_IDEMPOTENCY_CARDINALITY_CRON = '*/15 * * * *';
const DEFAULT_DLQ_DEPTH_CRON = '*/15 * * * *';
// Every two minutes: with the 3-minute pending cutoff, an email whose enqueue was lost goes out
// within about five minutes — well inside a sign-in code's 15-minute life.
const DEFAULT_MAIL_OUTBOX_SWEEPER_CRON = '*/2 * * * *';
const DEFAULT_COMMIT_DISPATCH_RECOVERY_CRON = '*/5 * * * *';
/** PENDING upload reconciliation runs hourly (independent of tombstone retention). */
const DEFAULT_UPLOAD_PENDING_SWEEP_CRON = '15 * * * *';
const DEFAULT_STRIPE_WEBHOOK_EVENT_RECLAIM_CRON = '*/5 * * * *';
const DEFAULT_STRIPE_WEBHOOK_EVENT_CATCHUP_CRON = '*/15 * * * *';
// Every five minutes: with the 5-minute stale cutoff, a delivery whose enqueue was lost goes out
// within about ten minutes of Redis taking writes again.
const DEFAULT_WEBHOOK_DELIVERY_RECLAIM_CRON = '*/5 * * * *';
/** Every five minutes, like the other lost-enqueue sweeps: a user is waiting for the export. */
const DEFAULT_USER_DATA_EXPORT_RECLAIM_CRON = '*/5 * * * *';
/** Hourly: lost seat-sync enqueues and lapsed dunning entitlements. */
const DEFAULT_SUBSCRIPTION_SEAT_RECONCILE_CRON = '17 * * * *';
/**
 * Every minute (feat-instagram-dm-sending WH17, worker-changes WC-12): the Instagram accounts whose
 * events still wait a minute after they arrived go back to intake, and the `failed` events whose
 * hourly retry is due go back to `received`. A fixed cadence, not a setting.
 */
const DEFAULT_INSTAGRAM_WEBHOOK_RECLAIM_CRON = '* * * * *';
/**
 * Every 30 minutes (feat-instagram-dm-sending WH17, worker-changes WC-26,
 * `INSTAGRAM_MISSED_COMMENT_ROUND_MINUTES`): one missed-comment look per watched account, spread
 * over the round; the full pass for an account whose rounds were missed. A fixed cadence.
 */
const DEFAULT_INSTAGRAM_MISSED_COMMENT_SWEEP_CRON = '*/30 * * * *';
/**
 * Every 10 minutes (feat-instagram-dm-sending AU32, worker-changes WC-41): the past-comments watch
 * wakes the read of every account whose read had no new page for 30 minutes or whose queued read's
 * job was lost. A fixed cadence.
 */
const DEFAULT_AUTOMATION_BACKFILL_WATCH_CRON = '*/10 * * * *';
/**
 * Every 15 minutes (feat-instagram-dm-sending AU6, worker-changes WC-43): one "next post" linking
 * task per account with a live waiting "my next post" automation — Meta sends no new-post event.
 */
const DEFAULT_AUTOMATION_NEXT_POST_LINKING_CRON = '*/15 * * * *';
/** Every minute (WC-56, WC-57, P94): the owners' problem emails and the month notices' backup check. */
const DEFAULT_INSTAGRAM_OWNER_PROBLEM_EMAIL_CRON = '* * * * *';
const DEFAULT_MESSAGE_MONTH_NOTICE_CHECK_CRON = '* * * * *';
/** Hourly (UN12): the weekly summary's sweep finds the organizations whose Monday 09:00 it is. */
const DEFAULT_NOTIFICATION_WEEKLY_SUMMARY_SWEEP_CRON = '3 * * * *';
const DEFAULT_STRIPE_WEBHOOK_EVENT_RETENTION_CRON = '0 3 * * *';
/**
 * feat-instagram-dm-sending WC-55 (WHC13, S17): the shared partition upkeep makes the coming parts
 * once a day at a quiet hour (02:23 UTC with `SCHEDULER_TIMEZONE=UTC`) — besides the pass at worker
 * start — and drops the expired ones every hour (WC-48–WC-52, P92), off the hour's busy minute. The
 * launch's 03:00 webhook-event batch delete is retired (WHC15). Fixed times, not settings.
 */
const DEFAULT_APP_PARTITION_UPKEEP_MAKE_CRON = '23 2 * * *';
const DEFAULT_APP_PARTITION_UPKEEP_DROP_CRON = '37 * * * *';
/**
 * feat-instagram-dm-sending WC-53, WC-54, WC-62 (P92, ROUTE row R50): the hourly batch clean-up of
 * the plain app tables, on the partition upkeep's queue — at :07, so its 10-minute budget ends
 * before the :37 drop.
 */
const DEFAULT_APP_TABLE_CLEAN_UP_CRON = '7 * * * *';
const DEFAULT_AUDIT_EXPORT_CRON = '15 2 * * *';
/**
 * feat-instagram-dm-sending MC10 (WC-34): the channel connection's token check sweep, every hour —
 * each connection is checked once every 24 hours, spread over the day by connection. A fixed
 * cadence, not a setting. It replaced the launch's daily Instagram account check (IA8).
 */
const DEFAULT_CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_CRON = '0 * * * *';
/**
 * feat-instagram-dm-sending WC-25 (ROUTE row R40): every 10 minutes
 * (`INSTAGRAM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES`), each connected account's webhook subscription
 * check is handed to the task queue, spread over the window by account.
 */
const DEFAULT_INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_CRON = '*/10 * * * *';
/**
 * Launch D8 (routes-final § 3.B AU25, WC-13): every hour, cancel the runs that have waited more
 * than 7 days. A fixed cadence, not a setting.
 */
const DEFAULT_AUTOMATION_RUN_WAIT_EXPIRY_CRON = '0 * * * *';
/**
 * Launch D8 (AU25, AQ7): the automations deleted more than 180 days ago that nothing points at any
 * more are removed — hourly at :47 within the clean-up time budget since feat-instagram-dm-sending
 * WC-47 (P92; was 03:40 daily). A fixed cadence, not a setting. (The launch's webhook-event, run and
 * comment-log batch deletes are retired — R14 and R49: their parts are dropped by the shared upkeep.)
 */
const DEFAULT_AUTOMATION_TOMBSTONE_RETENTION_CRON = '47 * * * *';

function withSchedulerTimezone({
  timezone,
  job,
}: {
  timezone: string | undefined;
  job: Omit<ScheduledJob, 'timezone'>;
}): ScheduledJob {
  return timezone !== undefined ? { ...job, timezone } : job;
}

/**
 * The app domain's clean-ups: the shared partition upkeep of the eight time-split tables (the daily
 * make and the hourly drop, feat-instagram-dm-sending WC-55, P96 — ROUTE row R49; runs, run events,
 * comment logs, messages, send attempts, webhook events and their keys expire by part drops), and
 * launch D8's (routes-final § 3.B AU25, AQ7) hourly 7-day wait cancel and daily deleted-automation
 * removal.
 */
function getAutomationCleanupScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: APP_PARTITION_UPKEEP_QUEUE_NAME,
        schedulerId: 'daily-app-partition-make',
        jobName: APP_PARTITION_UPKEEP_MAKE_JOB_NAME,
        cronPattern: DEFAULT_APP_PARTITION_UPKEEP_MAKE_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: APP_PARTITION_UPKEEP_QUEUE_NAME,
        schedulerId: 'hourly-app-partition-drop',
        jobName: APP_PARTITION_UPKEEP_DROP_JOB_NAME,
        cronPattern: DEFAULT_APP_PARTITION_UPKEEP_DROP_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: APP_PARTITION_UPKEEP_QUEUE_NAME,
        schedulerId: 'hourly-app-table-clean-up',
        jobName: APP_TABLE_CLEAN_UP_JOB_NAME,
        cronPattern: DEFAULT_APP_TABLE_CLEAN_UP_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: AUTOMATION_RUN_WAIT_EXPIRY_QUEUE_NAME,
        schedulerId: 'automation-run-wait-expiry-hourly',
        jobName: 'cancel-long-waiting-automation-runs',
        cronPattern: DEFAULT_AUTOMATION_RUN_WAIT_EXPIRY_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: AUTOMATION_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'hourly-automation-tombstone-cleanup',
        jobName: 'purge-old-deleted-automations',
        cronPattern: DEFAULT_AUTOMATION_TOMBSTONE_RETENTION_CRON,
      },
    }),
  ];
}

function getTombstoneRetentionScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: USER_DATA_EXPORT_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-user-data-export-retention',
        jobName: 'purge-expired-user-data-exports',
        // sec-new-Q1: allow operators to override the default schedule via env.
        cronPattern: env.USER_DATA_EXPORT_RETENTION_CRON ?? DEFAULT_USER_DATA_EXPORT_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-upload-tombstone-cleanup',
        jobName: 'purge-old-deleted-uploads',
        cronPattern: env.UPLOAD_TOMBSTONE_RETENTION_CRON ?? DEFAULT_UPLOAD_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-organization-tombstone-cleanup',
        jobName: 'purge-old-deleted-organizations',
        cronPattern:
          env.ORGANIZATION_TOMBSTONE_RETENTION_CRON ??
          DEFAULT_ORGANIZATION_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-webhook-tombstone-cleanup',
        jobName: 'purge-old-deleted-webhooks',
        cronPattern:
          env.WEBHOOK_TOMBSTONE_RETENTION_CRON ?? DEFAULT_WEBHOOK_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-notification-policy-tombstone-cleanup',
        jobName: 'purge-old-deleted-notification-policies',
        cronPattern:
          env.ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_CRON ??
          DEFAULT_ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-membership-tombstone-cleanup',
        jobName: 'purge-old-deleted-memberships',
        cronPattern:
          env.MEMBERSHIP_TOMBSTONE_RETENTION_CRON ?? DEFAULT_MEMBERSHIP_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: MEMBERSHIP_INVITATION_EXPIRY_QUEUE_NAME,
        schedulerId: 'daily-membership-invitation-expiry',
        jobName: 'end-long-expired-membership-invitations',
        cronPattern: DEFAULT_MEMBERSHIP_INVITATION_EXPIRY_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-member-role-tombstone-cleanup',
        jobName: 'purge-old-deleted-roles',
        cronPattern:
          env.MEMBER_ROLE_TOMBSTONE_RETENTION_CRON ?? DEFAULT_MEMBER_ROLE_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-organization-api-key-tombstone-cleanup',
        jobName: 'purge-old-deleted-api-keys',
        cronPattern:
          env.ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_CRON ??
          DEFAULT_ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: USER_TOMBSTONE_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-user-tombstone-cleanup',
        jobName: 'purge-old-deleted-users',
        cronPattern: env.USER_TOMBSTONE_RETENTION_CRON ?? DEFAULT_USER_TOMBSTONE_RETENTION_CRON,
      },
    }),
    // audit-#3: time-based purge of webhook delivery attempts (not a tombstone cascade).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-webhook-delivery-attempt-retention',
        jobName: 'purge-old-webhook-delivery-attempts',
        cronPattern:
          env.WEBHOOK_DELIVERY_ATTEMPT_RETENTION_CRON ??
          DEFAULT_WEBHOOK_DELIVERY_ATTEMPT_RETENTION_CRON,
      },
    }),
  ];
}

/**
 * The sweeps that recover work a lost enqueue or a missed event left behind — each re-adds what its
 * Postgres rows (or Stripe) say is still owed. Kept apart from the retention crons in
 * {@link getScheduledJobs}.
 */
function getRecoverySweepScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: MAIL_OUTBOX_SWEEPER_QUEUE_NAME,
        schedulerId: 'mail-outbox-sweeper',
        jobName: 're-enqueue-stale-pending-mail',
        cronPattern: env.MAIL_OUTBOX_SWEEPER_CRON ?? DEFAULT_MAIL_OUTBOX_SWEEPER_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: UPLOAD_PENDING_SWEEP_QUEUE_NAME,
        schedulerId: 'upload-pending-sweep',
        jobName: 'reconcile-stale-pending-uploads',
        cronPattern: env.UPLOAD_PENDING_SWEEP_CRON ?? DEFAULT_UPLOAD_PENDING_SWEEP_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: STRIPE_WEBHOOK_EVENT_RECLAIM_QUEUE_NAME,
        schedulerId: 'stripe-webhook-event-reclaim',
        jobName: 'reclaim-failed-stripe-webhook-events',
        cronPattern:
          env.STRIPE_WEBHOOK_EVENT_RECLAIM_CRON ?? DEFAULT_STRIPE_WEBHOOK_EVENT_RECLAIM_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: STRIPE_WEBHOOK_EVENT_CATCHUP_QUEUE_NAME,
        schedulerId: 'stripe-webhook-event-catchup',
        jobName: 'catchup-missing-stripe-webhook-events',
        cronPattern:
          env.STRIPE_WEBHOOK_EVENT_CATCHUP_CRON ?? DEFAULT_STRIPE_WEBHOOK_EVENT_CATCHUP_CRON,
      },
    }),
    // Off with the seat sync (BL9, WC-65 — feat-instagram-dm-sending R52): members are unlimited.
    ...(BILLING_SEAT_SYNC_ENABLED
      ? [
          withSchedulerTimezone({
            timezone,
            job: {
              queueName: SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
              schedulerId: 'subscription-seat-reconcile',
              jobName: SUBSCRIPTION_SEAT_RECONCILE_JOB_NAME,
              cronPattern: DEFAULT_SUBSCRIPTION_SEAT_RECONCILE_CRON,
            },
          }),
        ]
      : []),
    // feat-instagram-dm-sending BL17 (WC-59): the plan-state check sweeps every 15 minutes — a
    // grace that ended, the trial notices, a subscription on a switched-off plan row.
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: SUBSCRIPTION_PLAN_STATE_CHECK_QUEUE_NAME,
        schedulerId: 'subscription-plan-state-check',
        jobName: SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME,
        cronPattern: SUBSCRIPTION_PLAN_STATE_CHECK_CRON,
      },
    }),
    // feat-instagram-dm-sending SN6 (P94): the sending repair duties, one scheduler each — the month
    // wake's check every minute (WC-37) and the plan-stop backup every 15 minutes (WC-38).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
        schedulerId: 'instagram-repair-month-wake',
        jobName: INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME,
        cronPattern: INSTAGRAM_REPAIR_MONTH_WAKE_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
        schedulerId: 'instagram-repair-plan-stops',
        jobName: INSTAGRAM_REPAIR_PLAN_STOPS_JOB_NAME,
        cronPattern: INSTAGRAM_REPAIR_PLAN_STOPS_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: WEBHOOK_DELIVERY_RECLAIM_QUEUE_NAME,
        schedulerId: 'webhook-delivery-reclaim',
        jobName: 're-enqueue-stale-pending-webhook-deliveries',
        cronPattern: DEFAULT_WEBHOOK_DELIVERY_RECLAIM_CRON,
      },
    }),
    // The export queue's lost-enqueue sweep rides the export queue itself (run by its worker).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: USER_DATA_EXPORT_QUEUE_NAME,
        schedulerId: 'user-data-export-reclaim',
        jobName: USER_DATA_EXPORT_RECLAIM_JOB_NAME,
        cronPattern: DEFAULT_USER_DATA_EXPORT_RECLAIM_CRON,
      },
    }),
    ...getInstagramIntakeSweepScheduledJobs(timezone),
  ];
}

/**
 * The sweeps that ride Instagram intake's queue `instagram-webhook` (run by its worker): the stuck-event
 * pick-up (WH15), the missed-comment sweep (WH17, R39) and the automations' past-comments watch and
 * "next post" linking (R41) — in the order {@link getScheduledJobs} registers them.
 */
function getInstagramIntakeSweepScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    // The stuck-event pick-up rides the Instagram event-processing queue (run by its worker).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'instagram-webhook-reclaim',
        jobName: INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME,
        cronPattern: DEFAULT_INSTAGRAM_WEBHOOK_RECLAIM_CRON,
      },
    }),
    // The missed-comment sweep rides the same queue (run by its worker); its looks go to
    // `instagram-tasks`.
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'instagram-missed-comment-sweep',
        jobName: INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME,
        cronPattern: DEFAULT_INSTAGRAM_MISSED_COMMENT_SWEEP_CRON,
      },
    }),
    // The automations' past-comments watch and "next post" linking sweep ride the same queue (run by
    // its worker, R41); their work goes to `instagram-tasks`.
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'automation-backfill-watch',
        jobName: AUTOMATION_BACKFILL_WATCH_JOB_NAME,
        cronPattern: DEFAULT_AUTOMATION_BACKFILL_WATCH_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'automation-next-post-linking',
        jobName: AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME,
        cronPattern: DEFAULT_AUTOMATION_NEXT_POST_LINKING_CRON,
      },
    }),
  ];
}

/**
 * The notices' scheduled runs (feat-instagram-dm-sending WC-56–WC-58, ROUTE row R53): the owners'
 * problem emails and the month notices' backup check every minute on the intake queue, and the
 * weekly summary's hourly sweep on the notification queue — in the order {@link getScheduledJobs} registers
 * them.
 */
function getNoticeScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    // The owners' problem emails and the month notices' backup check ride the same queue (R53),
    // each its own every-minute run (WC-57, WC-56).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'instagram-owner-problem-email',
        jobName: INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME,
        cronPattern: DEFAULT_INSTAGRAM_OWNER_PROBLEM_EMAIL_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        schedulerId: 'message-month-notice-check',
        jobName: MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME,
        cronPattern: DEFAULT_MESSAGE_MONTH_NOTICE_CHECK_CRON,
      },
    }),
    // The weekly summary's hourly sweep rides the notification queue (run by its worker, UN12).
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: NOTIFICATION_QUEUE_NAME,
        schedulerId: 'notification-weekly-summary-sweep',
        jobName: NOTIFICATION_WEEKLY_SUMMARY_SWEEP_JOB_NAME,
        cronPattern: DEFAULT_NOTIFICATION_WEEKLY_SUMMARY_SWEEP_CRON,
      },
    }),
  ];
}

/**
 * The repair duties (feat-instagram-dm-sending § 6 SN6, SNC5; P94 — ROUTE row R47): one scheduler
 * per duty, every minute, each working until its 40 s budget is spent — all eleven on the repair
 * queue `instagram-sending-repair` beside R52's duties and R48's watches (the R47 × R48 merge).
 */
function getRepairDutyScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return Object.values(INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAMES).map((jobName) =>
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
        schedulerId: `instagram-${jobName}`,
        jobName,
        cronPattern: INSTAGRAM_SEND_REPAIR_DUTY_CRON,
      },
    }),
  );
}

/**
 * The operational samplers and retries: idempotency and dead-letter sampling, the dead-letter retry
 * and the post-commit dispatch recovery — in the order {@link getScheduledJobs} registers them.
 */
function getOperationalSweepScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: IDEMPOTENCY_CARDINALITY_QUEUE_NAME,
        schedulerId: 'idempotency-cardinality-quarter-hourly',
        jobName: 'sample-idempotency-cardinality',
        cronPattern: env.IDEMPOTENCY_CARDINALITY_CRON ?? DEFAULT_IDEMPOTENCY_CARDINALITY_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: DLQ_DEPTH_QUEUE_NAME,
        schedulerId: 'dlq-depth-quarter-hourly',
        jobName: 'sample-dlq-depth',
        cronPattern: env.DLQ_DEPTH_CRON ?? DEFAULT_DLQ_DEPTH_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: DLQ_AUTO_RETRY_QUEUE_NAME,
        schedulerId: 'dlq-auto-retry',
        jobName: 'auto-retry-dead-letter-jobs',
        cronPattern: env.DLQ_AUTO_RETRY_CRON ?? DEFAULT_DLQ_AUTO_RETRY_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: COMMIT_DISPATCH_RECOVERY_QUEUE_NAME,
        schedulerId: 'commit-dispatch-recovery',
        jobName: 'replay-stale-commit-dispatch',
        // sec-new-Q1: allow operators to override the default schedule via env.
        cronPattern: env.COMMIT_DISPATCH_RECOVERY_CRON ?? DEFAULT_COMMIT_DISPATCH_RECOVERY_CRON,
      },
    }),
  ];
}

/**
 * Canonical list of repeatable cleanup jobs (queue identity from domain constants).
 */
export function getScheduledJobs(): ScheduledJob[] {
  const schedulerTimezone = env.SCHEDULER_TIMEZONE;
  const timezone =
    schedulerTimezone !== undefined && schedulerTimezone.length > 0 ? schedulerTimezone : undefined;

  return [
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: AUDIT_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-audit-cleanup',
        jobName: 'cleanup-old-logs',
        cronPattern: env.AUDIT_RETENTION_CRON ?? DEFAULT_AUDIT_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: AUDIT_OUTBOX_DRAIN_QUEUE_NAME,
        schedulerId: 'audit-outbox-drain',
        jobName: 'drain-pending-audit-outbox',
        cronPattern: env.AUDIT_OUTBOX_DRAIN_CRON ?? DEFAULT_AUDIT_OUTBOX_DRAIN_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: NOTIFICATION_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-notification-retention',
        jobName: 'purge-old-notifications',
        cronPattern: env.NOTIFICATION_RETENTION_CRON ?? DEFAULT_NOTIFICATION_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: SESSION_CLEANUP_QUEUE_NAME,
        schedulerId: 'hourly-session-cleanup',
        jobName: 'cleanup-sessions',
        cronPattern: env.AUTH_SESSION_CLEANUP_CRON ?? DEFAULT_SESSION_CLEANUP_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: USER_OFFBOARDING_RECONCILE_QUEUE_NAME,
        schedulerId: 'user-offboarding-reconcile',
        jobName: 'reconcile-stuck-user-offboardings',
        cronPattern: DEFAULT_OFFBOARDING_RECONCILE_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: ORGANIZATION_OFFBOARDING_RECONCILE_QUEUE_NAME,
        schedulerId: 'organization-offboarding-reconcile',
        jobName: 'reconcile-stuck-organization-offboardings',
        cronPattern: DEFAULT_OFFBOARDING_RECONCILE_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME,
        schedulerId: 'daily-stripe-webhook-event-cleanup',
        jobName: 'purge-old-stripe-webhook-events',
        cronPattern:
          env.STRIPE_WEBHOOK_EVENT_RETENTION_CRON ?? DEFAULT_STRIPE_WEBHOOK_EVENT_RETENTION_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: AUDIT_EXPORT_QUEUE_NAME,
        schedulerId: 'daily-audit-export',
        jobName: 'export-audit-logs-s3',
        cronPattern: env.AUDIT_EXPORT_CRON ?? DEFAULT_AUDIT_EXPORT_CRON,
      },
    }),
    // The hourly sweep rides the token-check queue; its worker adds one check per due connection.
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
        schedulerId: 'hourly-channel-connection-token-check',
        jobName: CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_JOB_NAME,
        cronPattern: DEFAULT_CHANNEL_CONNECTION_TOKEN_CHECK_SWEEP_CRON,
      },
    }),
    // The 10-minute webhook subscription sweep rides the same queue (WC-25); its checks run on
    // `instagram-tasks`.
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: CHANNEL_CONNECTION_TOKEN_CHECK_QUEUE_NAME,
        schedulerId: 'instagram-webhook-subscription-sweep',
        jobName: INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_JOB_NAME,
        cronPattern: DEFAULT_INSTAGRAM_WEBHOOK_SUBSCRIPTION_SWEEP_CRON,
      },
    }),
    ...getAutomationCleanupScheduledJobs(timezone),
    ...getTombstoneRetentionScheduledJobs(timezone),
    ...getOperationalSweepScheduledJobs(timezone),
    ...getRecoverySweepScheduledJobs(timezone),
    ...getNoticeScheduledJobs(timezone),
    ...getRepairDutyScheduledJobs(timezone),
    ...getInstagramSendingWatchScheduledJobs(timezone),
  ];
}

/**
 * feat-instagram-dm-sending SN6, SNC5 (P94 — ROUTE row R48): the sending watches on the repair
 * queue, one scheduler each — the outage watch every 10 seconds (`everyMilliseconds`, WC-22), the
 * Live check every minute (WC-16) and the waiting estimate every 10 minutes (WC-24).
 */
function getInstagramSendingWatchScheduledJobs(timezone: string | undefined): ScheduledJob[] {
  return [
    {
      queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
      schedulerId: 'instagram-watch-outage-check',
      jobName: INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME,
      everyMilliseconds: INSTAGRAM_WATCH_OUTAGE_CHECK_EVERY_MILLISECONDS,
    },
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
        schedulerId: 'instagram-watch-live-check',
        jobName: INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME,
        cronPattern: INSTAGRAM_WATCH_LIVE_CHECK_CRON,
      },
    }),
    withSchedulerTimezone({
      timezone,
      job: {
        queueName: INSTAGRAM_SENDING_REPAIR_QUEUE_NAME,
        schedulerId: 'instagram-watch-waiting-estimate',
        jobName: INSTAGRAM_WATCH_WAITING_ESTIMATE_JOB_NAME,
        cronPattern: INSTAGRAM_WATCH_WAITING_ESTIMATE_CRON,
      },
    }),
  ];
}

/**
 * sec-Q1: bounded retention for cron-driven queues. The event-driven queues
 * already set similar `defaultJobOptions`; without this, minute-cadence
 * crons grew Redis indefinitely. Numbers chosen to leave enough recent
 * history for debugging while staying inside maxmemory on a small shared
 * instance.
 */
const SCHEDULED_QUEUE_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { count: 100, age: SEVEN_DAYS_SECONDS },
  removeOnFail: { count: 200, age: SEVEN_DAYS_SECONDS },
} as const;

/**
 * Options for {@link registerScheduledJobs}. Used by split worker services to avoid
 * registering cron schedules for queues whose worker is not running in this process —
 * otherwise BullMQ would enqueue jobs nobody picks up.
 */
export type RegisterScheduledJobsOptions = {
  /**
   * When set, only registers cron schedulers for queues that have an active worker in this
   * process (split worker services). Omit to register every canonical scheduled job.
   */
  readonly activeQueueNames?: ReadonlySet<string>;
};

/**
 * Removes orphan job schedulers from Redis — any scheduler whose id is not in the canonical set
 * for its queue is a rename or removal residue that BullMQ would otherwise keep firing forever.
 * Each queue is opened and closed in its own `try/finally`. Extracted from
 * {@link registerScheduledJobs} to keep that function's cognitive complexity within budget.
 */
async function reconcileOrphanSchedulers(options: {
  connection: ReturnType<typeof getBullMQConnectionOptions>;
  canonicalSchedulerIdsByQueueName: ReadonlyMap<string, Set<string>>;
}): Promise<void> {
  const { connection, canonicalSchedulerIdsByQueueName } = options;
  for (const [queueName, canonicalIds] of canonicalSchedulerIdsByQueueName) {
    const queueForReconcile = new Queue(queueName, {
      connection,
      prefix: getBullMQKeyPrefix(),
      defaultJobOptions: SCHEDULED_QUEUE_DEFAULT_JOB_OPTIONS,
    });
    try {
      // getJobSchedulers takes pagination args; first 1000 schedulers per queue is
      // far above any realistic count for this app.
      const existingSchedulers = await queueForReconcile.getJobSchedulers(0, 1000);
      if (existingSchedulers.length >= 1000) {
        // Orphan reconciliation only sees the first page; at the cap it may silently miss orphans.
        logger.error(
          { queueName, count: existingSchedulers.length },
          'scheduler.reconcile.page_limit_reached',
        );
      }
      for (const existing of existingSchedulers) {
        if (!canonicalIds.has(existing.key)) {
          await queueForReconcile.removeJobScheduler(existing.key);
          logger.warn({ queueName, schedulerId: existing.key }, 'scheduler.orphan.removed');
        }
      }
    } finally {
      await queueForReconcile.close();
    }
  }
}

/**
 * Registers repeatable jobs with BullMQ. With SCHEDULER_ENABLED false it registers nothing and
 * warns (`scheduler.disabled.crons_not_registered`) when this process runs queues that have crons.
 */
export async function registerScheduledJobs(
  options: RegisterScheduledJobsOptions = {},
): Promise<SchedulerHandle> {
  const allJobs = getScheduledJobs();
  const jobs =
    options.activeQueueNames === undefined
      ? allJobs
      : allJobs.filter((job) => options.activeQueueNames?.has(job.queueName));

  if (!env.SCHEDULER_ENABLED) {
    // Each process registers only the crons of its own queues, so a worker that runs these queues
    // with the scheduler off leaves their crons unregistered unless another scheduler-enabled
    // process runs the same families — the sweeps that recover lost work (mail outbox, Stripe
    // reclaim, webhook reclaim) then never run.
    if (jobs.length > 0) {
      logger.warn(
        { queueNames: jobs.map((job) => job.queueName) },
        'scheduler.disabled.crons_not_registered',
      );
    } else {
      logger.info('scheduler.disabled');
    }
    return {
      close: async () => {},
    };
  }

  const connection = getBullMQConnectionOptions();
  const queues: Queue[] = [];

  // Group canonical scheduler ids by queue name so the reconciliation step can drop any
  // schedulers in Redis whose id is no longer in the canonical set. Without this, a rename
  // (or removal) of a `schedulerId` leaves the OLD scheduler firing in Redis forever
  // alongside the new one — the in-code registry audit never reads Redis state and would
  // not detect it.
  const canonicalSchedulerIdsByQueueName = new Map<string, Set<string>>();
  for (const job of jobs) {
    const existing = canonicalSchedulerIdsByQueueName.get(job.queueName);
    if (existing) {
      existing.add(job.schedulerId);
    } else {
      canonicalSchedulerIdsByQueueName.set(job.queueName, new Set([job.schedulerId]));
    }
  }

  try {
    for (const job of jobs) {
      // sec-Q1: bounded retention on cron-driven queues. Without this,
      // every cron queue piling completed/failed jobs forever grows
      // Redis indefinitely and eventually exhausts maxmemory on a shared
      // cache+BullMQ instance.
      const queue = new Queue(job.queueName, {
        connection,
        prefix: getBullMQKeyPrefix(),
        defaultJobOptions: SCHEDULED_QUEUE_DEFAULT_JOB_OPTIONS,
      });
      queues.push(queue);
      await queue.upsertJobScheduler(job.schedulerId, resolveScheduledJobRepeat(job), {
        name: job.jobName,
        opts: SCHEDULED_QUEUE_DEFAULT_JOB_OPTIONS,
      });
      logger.info(
        {
          queueName: job.queueName,
          cronPattern: job.cronPattern ?? null,
          everyMilliseconds: job.everyMilliseconds ?? null,
          timezone: job.timezone ?? null,
        },
        'scheduler.job.registered',
      );
    }

    // Drop orphan schedulers — any Redis scheduler whose id is not in the canonical set
    // for its queue is a rename or removal residue, and BullMQ will otherwise keep firing
    // it forever (doubling cron rate after rename, firing into a worker-less queue after
    // removal). Inside the try so a failure still closes the registration queues below.
    await reconcileOrphanSchedulers({ connection, canonicalSchedulerIdsByQueueName });
  } finally {
    // The schedulers live in Redis and the workers run them; nothing needs these queues once
    // they are registered. Kept open, they held one Redis connection per cron queue — 26 — for
    // the life of the process.
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }

  return {
    close: async () => {},
  };
}
