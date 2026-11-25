import { Worker } from 'bullmq';
import {
  getBullMQConnectionOptions,
  getBullMQKeyPrefix,
} from '@/infrastructure/queue/connection.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerDatabaseSlotLimiter } from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { getWorkerConcurrencyInstagram } from '@/shared/config/worker-concurrency.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { getInstagramDatabaseSlotLimiter } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-ticket.processor.js';
import {
  INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME,
  INSTAGRAM_WEBHOOK_QUEUE_NAME,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  instagramTagEventIntakeJobDataSchema,
  instagramWebhookIntakeJobDataSchema,
} from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.job.schema.js';
import { INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME } from './instagram-webhook-reclaim.constants.js';
import { runInstagramWebhookReclaimJob } from './instagram-webhook-reclaim.processor.js';
import { INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME } from './instagram-missed-comment-check.constants.js';
import { runInstagramMissedCommentSweepJob } from './instagram-missed-comment-check.processor.js';
import { AUTOMATION_BACKFILL_WATCH_JOB_NAME } from '@/domains/app/sub-domains/automation/automation-backfill/workers/automation-backfill-watch.constants.js';
import { runAutomationBackfillWatchJob } from '@/domains/app/sub-domains/automation/automation-backfill/workers/automation-backfill-watch.processor.js';
import { AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.constants.js';
import type { MessageMonthNoticeService } from '@/domains/app/sub-domains/instagram-sending/message-month-notice.service.js';
import { INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-owner-problem-email.constants.js';
import { runInstagramOwnerProblemEmailJob } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-owner-problem-email.processor.js';
import { MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME } from '@/domains/app/sub-domains/instagram-sending/workers/message-month-notice-check.constants.js';
import { runMessageMonthNoticeCheckJob } from '@/domains/app/sub-domains/instagram-sending/workers/message-month-notice-check.processor.js';
import { runAutomationNextPostLinkingSweepJob } from '@/domains/app/sub-domains/automation/workers/automation-next-post-linking.processor.js';
import { createInstagramNextPostLinkingEnqueue } from './instagram-next-post-linking.processor.js';
import { runRepairDutyRound } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import {
  AUTOMATION_RUN_OPEN_KEY_REPAIR_JOB_NAME,
  runAutomationRunOpenKeyRepairDuty,
} from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-open-key-repair.processor.js';
import {
  CONTACT_TAG_EVENT_PICKUP_JOB_NAME,
  runContactTagEventPickupDuty,
} from '@/domains/app/sub-domains/contact/contact-tag-event/workers/contact-tag-event-pickup.processor.js';
import { enqueueInstagramTagEventIntake } from '@/domains/app/sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import { INSTAGRAM_PAST_COMMENT_READ_QUEUE } from './instagram-past-comment-read.processor.js';
import {
  type InstagramContactProfileReadEnqueue,
  type InstagramLateCommentTimeReader,
  type InstagramWebhookIntakeServices,
  processInstagramWebhookIntakeJob,
} from './instagram-webhook-intake.processor.js';
import {
  type InstagramTagEventIntakeServices,
  processInstagramTagEventIntakeJob,
} from './instagram-tag-event-intake.processor.js';

/**
 * What the intake worker drives: the event intake's and the tag intake's services, and the
 * after-commit profile-read task (S11).
 *
 * @remarks
 * Notes: built by the worker registry from the worker composition root (`appDomain`,
 * `tenancyDomain`).
 */
export interface InstagramWebhookWorkerServices {
  intake: InstagramWebhookIntakeServices;
  tagIntake: InstagramTagEventIntakeServices;
  enqueueProfileRead: InstagramContactProfileReadEnqueue | null;
  /** A late comment's own time from Meta (WH12 step 2, R39); absent — the received time. */
  readLateCommentTime?: InstagramLateCommentTimeReader | undefined;
  /** The month notices' backup check (WC-56, R53); absent — the check finds nothing to do. */
  monthNotice?: Pick<MessageMonthNoticeService, 'tellMonthLine'> | undefined;
  /** The open-run key repair's run service (WC-67, R47); absent — the duty finds nothing to do. */
  openKeyRepair?: Pick<AutomationRunService, 'repairOpenRunKeys'> | undefined;
}

/**
 * BullMQ worker of Instagram intake (feat-instagram-dm-sending § 5 WH5, WH11–WH16, WH25; WC-1–WC-4):
 * the three kind groups' jobs, the tag-intake jobs, the every-minute stuck-event pick-up, the
 * 30-minute missed-comment sweep (WH17) and the automations' 10-minute past-comments watch and
 * 15-minute "next post" linking sweep (WC-41, WC-43), on one queue.
 *
 * @remarks
 * - **Algorithm:** routes on `job.name` — the pick-up ({@link INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME},
 *   no payload) runs {@link runInstagramWebhookReclaimJob}; the missed-comment sweep
 *   ({@link INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME}, no payload) runs
 *   {@link runInstagramMissedCommentSweepJob}; the watch ({@link AUTOMATION_BACKFILL_WATCH_JOB_NAME})
 *   and the linking sweep ({@link AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME}) run their
 *   channel-neutral processors with Instagram's task enqueues; the owners' problem emails
 *   ({@link INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME}) and the month notices' backup check
 *   ({@link MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME}) run every minute (WC-57, WC-56); the tag events'
 *   pick-up ({@link CONTACT_TAG_EVENT_PICKUP_JOB_NAME}, WC-27) and the open-run key repair
 *   ({@link AUTOMATION_RUN_OPEN_KEY_REPAIR_JOB_NAME}, WC-67) run every minute in a database slot
 *   until their 40 s budget is spent (R47, P94); `intake-tag-events` validates its payload
 *   and runs {@link processInstagramTagEventIntakeJob}; `intake-messages`, `intake-live` and
 *   `intake-comments` validate theirs and run {@link processInstagramWebhookIntakeJob} — every unit
 *   of work in a slot of the process's Instagram database limiter (`getInstagramDatabaseSlotLimiter`,
 *   SN24). Concurrency `WORKER_CONCURRENCY_INSTAGRAM`: different accounts and groups side by side;
 *   one group of one account never twice at once but comments (the deduplication, S11).
 * - **Failure modes:** a **plain** worker — never paused by an Instagram outage (WH25, P47 F3):
 *   intake makes no Meta call but a late comment's time read, which fails open. A thrown job (a
 *   database outage, an event's temporary failure) takes the queue's 5 attempts with growing waits
 *   from 5 s; a malformed payload is dead-lettered at once.
 * - **Side effects:** see the processors; holds a Redis connection until the handle closes.
 * - **Notes:** registered in `worker-registration.registry.ts` (family `instagram`, throughput,
 *   gated on the Meta app settings, `databaseSlotLimiterName` `instagram-database`); log lines carry
 *   ids and counts only, never message text (WH6).
 */
export function createInstagramWebhookWorker({
  services,
  limiter = getInstagramDatabaseSlotLimiter(),
}: {
  services: InstagramWebhookWorkerServices;
  /** The process's Instagram database limiter (SN24); tests pass a fake. */
  limiter?: WorkerDatabaseSlotLimiter;
}): WorkerHandle {
  const worker = new Worker(
    INSTAGRAM_WEBHOOK_QUEUE_NAME,
    async (job) => {
      // The every-minute pick-up rides this queue (no worker or pool of its own); no payload.
      if (job.name === INSTAGRAM_WEBHOOK_RECLAIM_JOB_NAME) {
        return runInstagramWebhookReclaimJob({ requestId: job.id });
      }
      // The 30-minute missed-comment sweep rides this queue too; its looks run on `instagram-tasks`.
      if (job.name === INSTAGRAM_MISSED_COMMENT_SWEEP_JOB_NAME) {
        return runInstagramMissedCommentSweepJob();
      }
      // The automations' two channel-neutral sweeps ride this queue too (R41): the 10-minute
      // past-comments watch (WC-41) and the 15-minute "next post" linking (WC-43); their work runs
      // as Instagram's tasks on `instagram-tasks`.
      if (job.name === AUTOMATION_BACKFILL_WATCH_JOB_NAME) {
        return runAutomationBackfillWatchJob({ readQueue: INSTAGRAM_PAST_COMMENT_READ_QUEUE });
      }
      if (job.name === AUTOMATION_NEXT_POST_LINKING_SWEEP_JOB_NAME) {
        return runAutomationNextPostLinkingSweepJob({
          enqueueByChannel: { instagram: createInstagramNextPostLinkingEnqueue() },
        });
      }
      // The owners' problem emails and the month notices' backup check ride this queue too (R53):
      // every minute, each its own scheduled run (WC-56, WC-57).
      if (job.name === INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME) {
        return runInstagramOwnerProblemEmailJob();
      }
      if (job.name === MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME) {
        const monthNotice = services.monthNotice;
        if (monthNotice === undefined) return { skipped: true };
        return runMessageMonthNoticeCheckJob({ monthNotice });
      }
      // Two repair duties ride this queue too (R47, P94 — each its own every-minute run, 40 s
      // budget): the tag events' pick-up (WC-27) and the open-run key repair (WC-67).
      if (job.name === CONTACT_TAG_EVENT_PICKUP_JOB_NAME) {
        return runRepairDutyRound({
          duty: job.name,
          run: (context) =>
            limiter.runInSlot({
              callback: () =>
                runContactTagEventPickupDuty({
                  context,
                  intakeQueue: { enqueueContactTagEventIntake: enqueueInstagramTagEventIntake },
                }),
            }),
        });
      }
      if (job.name === AUTOMATION_RUN_OPEN_KEY_REPAIR_JOB_NAME) {
        const openKeyRepair = services.openKeyRepair;
        if (openKeyRepair === undefined) return { skipped: true };
        return runRepairDutyRound({
          duty: job.name,
          run: (context) =>
            limiter.runInSlot({
              callback: () =>
                runAutomationRunOpenKeyRepairDuty({ context, runService: openKeyRepair }),
            }),
        });
      }
      const jobId = job.id ?? INSTAGRAM_WEBHOOK_QUEUE_NAME;
      if (job.name === INSTAGRAM_TAG_EVENT_INTAKE_JOB_NAME) {
        const jobData = await parseJobDataOrDeadLetter({
          schema: instagramTagEventIntakeJobDataSchema,
          job,
          queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
        });
        return runWithPropagatedTraceContext({
          carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
          spanName: job.name,
          callback: () =>
            processInstagramTagEventIntakeJob({
              jobData,
              services: services.tagIntake,
              jobId,
              limiter,
            }),
        });
      }
      const jobData = await parseJobDataOrDeadLetter({
        schema: instagramWebhookIntakeJobDataSchema,
        job,
        queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME,
      });
      logger.info(
        {
          jobId: job.id,
          organizationPublicId: jobData.organizationPublicId,
          channelAccountPublicId: jobData.channelAccountPublicId,
          intakeKind: jobData.intakeKind,
          requestId: jobData.requestId,
        },
        'app.instagram_webhook.intake',
      );
      return runWithPropagatedTraceContext({
        carrier: { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        spanName: job.name,
        callback: () =>
          processInstagramWebhookIntakeJob({
            jobData,
            services: services.intake,
            jobId,
            enqueueProfileRead: services.enqueueProfileRead,
            readLateCommentTime: services.readLateCommentTime,
            limiter,
          }),
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      prefix: getBullMQKeyPrefix(),
      concurrency: getWorkerConcurrencyInstagram(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME },
      'app.instagram_webhook.worker.stalled',
    );
  });

  return buildWorkerHandle({ worker, queueName: INSTAGRAM_WEBHOOK_QUEUE_NAME });
}
