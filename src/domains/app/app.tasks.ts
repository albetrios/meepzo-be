import { randomBytes } from 'node:crypto';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { ContactBulkActionQueue } from './sub-domains/contact/contact.types.js';
import type { ContactService } from './sub-domains/contact/contact.service.js';
import {
  CONTACT_BULK_ACTION_JOB_NAME,
  type ContactBulkActionTaskInput,
  contactBulkActionJobId,
  contactBulkActionTaskInputSchema,
} from './sub-domains/contact/queues/contact-bulk-action.job.schema.js';
import { runContactBulkActionPiece } from './sub-domains/contact/workers/contact-bulk-action.processor.js';
import type { BroadcastSendQueuePort } from './sub-domains/broadcast/broadcast.types.js';
import type { BroadcastService } from './sub-domains/broadcast/broadcast.service.js';
import type { SegmentBackgroundCountPort } from './sub-domains/broadcast/broadcast-segment/broadcast-segment.types.js';
import type { BroadcastSegmentService } from './sub-domains/broadcast/broadcast-segment/broadcast-segment.service.js';
import { getCachedSegmentCount } from './sub-domains/broadcast/broadcast-segment/broadcast-segment-count.cache.js';
import {
  SEGMENT_COUNT_JOB_NAME,
  type SegmentCountTaskInput,
  segmentCountJobId,
  segmentCountTaskInputSchema,
} from './sub-domains/broadcast/broadcast-segment/queues/broadcast-segment-count.job.schema.js';
import { runSegmentCountTask } from './sub-domains/broadcast/broadcast-segment/workers/broadcast-segment-count.processor.js';
import type { BroadcastRecipientService } from './sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import {
  BROADCAST_AUDIENCE_JOB_NAME,
  type BroadcastAudienceTaskInput,
  broadcastAudienceJobId,
  broadcastAudienceTaskInputSchema,
} from './sub-domains/broadcast/broadcast-recipient/queues/broadcast-audience.job.schema.js';
import { runBroadcastAudiencePiece } from './sub-domains/broadcast/broadcast-recipient/workers/broadcast-audience.processor.js';
import type { InstagramMessageRetryQueue } from './sub-domains/instagram-sending/instagram-message/instagram-message.types.js';
import type { InstagramMessageService } from './sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import type { InstagramAttachmentUploadQueue } from './sub-domains/instagram-sending/instagram-attachment/instagram-attachment.types.js';
import type { InstagramAttachmentService } from './sub-domains/instagram-sending/instagram-attachment/instagram-attachment.service.js';
import type { InstagramSendLaneService } from './sub-domains/instagram-sending/instagram-send-lane.service.js';
import type { InstagramTaskHandler } from './sub-domains/instagram-sending/instagram-sending.types.js';
import { enqueueInstagramDatabaseTask } from './sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import { enqueueInstagramTask } from './sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import {
  INSTAGRAM_RETRY_FAILED_JOB_NAME,
  instagramRetryFailedJobId,
} from './sub-domains/instagram-sending/queues/instagram-retry-failed.job.schema.js';
import {
  INSTAGRAM_ATTACHMENT_UPLOAD_JOB_NAME,
  instagramAttachmentUploadJobId,
} from './sub-domains/instagram-sending/queues/instagram-attachment-upload.job.schema.js';
import { createInstagramRetryFailedTaskHandler } from './sub-domains/instagram-sending/workers/instagram-retry-failed.processor.js';
import { createInstagramAttachmentUploadTaskHandler } from './sub-domains/instagram-sending/workers/instagram-attachment-upload.processor.js';
import type { AutomationBackfillService } from './sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type { ChannelAccountService } from './sub-domains/channel-account/channel-account.service.js';
import {
  INSTAGRAM_MONTH_WAKE_JOB_NAME,
  INSTAGRAM_PLAN_CHANGE_JOB_NAME,
  type InstagramPlanChangeTaskInput,
  instagramPlanChangeTaskInputSchema,
} from './sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import { runInstagramPlanChangeTask } from './sub-domains/instagram-sending/workers/instagram-plan-change.processor.js';

/** Adds one piece of a bulk contact change (WC-36) on the database-heavy task queue. */
async function enqueueContactBulkActionPiece({
  organizationPublicId,
  taskInput,
}: {
  organizationPublicId: string;
  taskInput: ContactBulkActionTaskInput;
}): Promise<void> {
  await enqueueInstagramDatabaseTask({
    jobName: CONTACT_BULK_ACTION_JOB_NAME,
    jobId: contactBulkActionJobId(taskInput),
    organizationPublicId,
    taskInput,
  });
}

/** Adds one background segment count (WC-39) on the database-heavy task queue. */
async function enqueueSegmentCount({
  organizationPublicId,
  taskInput,
}: {
  organizationPublicId: string;
  taskInput: SegmentCountTaskInput;
}): Promise<void> {
  await enqueueInstagramDatabaseTask({
    jobName: SEGMENT_COUNT_JOB_NAME,
    jobId: segmentCountJobId({ input: taskInput }),
    organizationPublicId,
    taskInput,
  });
}

/** Adds one piece of a broadcast's audience build (WC-40) on the database-heavy task queue. */
async function enqueueBroadcastAudiencePiece({
  organizationPublicId,
  taskInput,
}: {
  organizationPublicId: string;
  taskInput: BroadcastAudienceTaskInput;
}): Promise<void> {
  await enqueueInstagramDatabaseTask({
    jobName: BROADCAST_AUDIENCE_JOB_NAME,
    jobId: broadcastAudienceJobId(taskInput),
    organizationPublicId,
    taskInput,
  });
}

/**
 * Route 21's queue port (CT7, WC-36 — ROUTE row R46): the first piece of the bulk change, under a
 * fresh random token (its job ids), with no cursor.
 *
 * @remarks
 * Notes: an add error propagates into route 21 (nothing changed yet — the owner presses again).
 */
export const contactBulkActionQueue: ContactBulkActionQueue = {
  enqueueContactBulkAction: (input) =>
    enqueueContactBulkActionPiece({
      organizationPublicId: input.organizationPublicId,
      taskInput: {
        bulkActionToken: randomBytes(8).toString('hex'),
        pieceNumber: 1,
        channelAccountPublicId: input.channelAccountPublicId,
        action: input.action,
        tag: input.tag,
        contactPublicIds: input.contactPublicIds === null ? null : [...input.contactPublicIds],
        filter:
          input.filter === null
            ? null
            : {
                ...input.filter,
                tags: [...input.filter.tags],
                cameInVia: [...input.filter.cameInVia],
              },
        actorUserPublicId: input.actorUserPublicId,
        afterContactPublicId: null,
      },
    }),
};

/**
 * Route 82's background count (BC14, WC-39 — ROUTE row R46): the 60 s Redis copy, and the
 * `segment-count` task that writes it.
 *
 * @remarks
 * Notes: the read fails open (a miss); the request's add error propagates into route 82.
 */
export const segmentBackgroundCountPort: SegmentBackgroundCountPort = {
  readCount: (key) =>
    getCachedSegmentCount({
      organizationPublicId: key.organizationPublicId,
      channelAccountPublicId: key.channelAccountPublicId,
      conditionsHash: key.conditionsHash,
    }),
  requestCount: (key) =>
    enqueueSegmentCount({
      organizationPublicId: key.organizationPublicId,
      taskInput: {
        kind: 'preview',
        channelAccountPublicId: key.channelAccountPublicId,
        conditionsHash: key.conditionsHash,
        conditions: key.conditions,
      },
    }),
};

/** Runs an add after a commit that already happened: a failure is logged, never thrown. */
async function enqueueQuietly({
  enqueue,
  logFields,
}: {
  enqueue: () => Promise<void>;
  logFields: Record<string, unknown>;
}): Promise<void> {
  try {
    await enqueue();
  } catch (error) {
    logger.warn(
      { ...logFields, error_name: (error as Error | null)?.name },
      'app.task.enqueue_failed',
    );
  }
}

/**
 * Route 75's background work (BC10, WC-39, WC-40 — ROUTE row R46): the first audience piece of a
 * "send now", or the matched count of a "when her chat opens".
 *
 * @remarks
 * Notes: route 75 already committed the send — an add error is logged, never thrown; the start
 * duty's repair (WC-28, R47) puts a lost audience job back.
 */
export const broadcastSendQueue: BroadcastSendQueuePort = {
  enqueueBroadcastAudience: ({ organizationPublicId, broadcastPublicId, channelAccountPublicId }) =>
    enqueueQuietly({
      logFields: { organizationPublicId, broadcastPublicId, jobName: BROADCAST_AUDIENCE_JOB_NAME },
      enqueue: () =>
        enqueueBroadcastAudiencePiece({
          organizationPublicId,
          taskInput: {
            broadcastPublicId,
            channelAccountPublicId,
            pieceNumber: 1,
            afterContactPublicId: null,
          },
        }),
    }),
  enqueueBroadcastMatchedCount: ({ organizationPublicId, broadcastPublicId }) =>
    enqueueQuietly({
      logFields: { organizationPublicId, broadcastPublicId, jobName: SEGMENT_COUNT_JOB_NAME },
      enqueue: () =>
        enqueueSegmentCount({
          organizationPublicId,
          taskInput: { kind: 'broadcast', broadcastPublicId },
        }),
    }),
};

/**
 * Routes 26 / 37's queue port (WC-42 — ROUTE row R46): one `retry-failed` job per owner and minute.
 *
 * @remarks
 * Notes: an add error propagates into the route (nothing retried yet — the owner presses again).
 */
export const instagramMessageRetryQueue: InstagramMessageRetryQueue = {
  enqueueRetryFailed: ({ organizationPublicId, by, ownerPublicId }) =>
    enqueueInstagramDatabaseTask({
      jobName: INSTAGRAM_RETRY_FAILED_JOB_NAME,
      jobId: instagramRetryFailedJobId({ ownerPublicId }),
      organizationPublicId,
      taskInput: { by, ownerPublicId },
    }),
};

/**
 * The attachment upload port (WC-32 — ROUTE row R46): one `attachment-upload` job per account and
 * file on the Meta-calling `instagram-tasks`.
 *
 * @remarks
 * Notes: an add error propagates to `requestAttachmentUploads`' caller, which logs it (the send
 * still uploads the file before its first send).
 */
export const instagramAttachmentUploadQueue: InstagramAttachmentUploadQueue = {
  enqueueAttachmentUpload: async ({
    organizationPublicId,
    channelAccountPublicId,
    uploadPublicIds,
  }) => {
    for (const uploadPublicId of new Set(uploadPublicIds)) {
      await enqueueInstagramTask({
        jobName: INSTAGRAM_ATTACHMENT_UPLOAD_JOB_NAME,
        jobId: instagramAttachmentUploadJobId({ channelAccountPublicId, uploadPublicId }),
        organizationPublicId,
        taskInput: { channelAccountPublicId, uploadPublicId },
      });
    }
  },
};

/** The services the task handlers run (the app container's). */
export interface AppTaskServices {
  contactService: Pick<ContactService, 'applyBulkActionPiece'>;
  broadcastSegmentService: Pick<BroadcastSegmentService, 'countAudienceInBackground'>;
  broadcastService: Pick<
    BroadcastService,
    'countWaitingBroadcastMatched' | 'cancelBroadcastsForPlanFeatureOff'
  >;
  broadcastRecipientService: Pick<BroadcastRecipientService, 'buildAudiencePiece'>;
  instagramMessageService: Pick<
    InstagramMessageService,
    'resolveFailedMessagesTarget' | 'retryAllowedFailedMessages'
  >;
  instagramAttachmentService: Pick<InstagramAttachmentService, 'uploadAttachments'>;
  instagramSendLaneService: Pick<InstagramSendLaneService, 'wakeLanes' | 'wakeLaneTurns'>;
  channelAccountService: Pick<ChannelAccountService, 'applyOrganizationPlanStops'>;
  automationBackfillService: Pick<AutomationBackfillService, 'failOpenBackfillsForPlanFeatureOff'>;
}

/** The plan change and the month wake (WC-37, WC-38 — ROUTE row R52): one handler, two job names. */
function createInstagramPlanChangeTaskHandler(services: AppTaskServices): InstagramTaskHandler {
  return {
    callsMeta: false,
    inputSchema: instagramPlanChangeTaskInputSchema,
    run: async ({ organizationPublicId, taskInput, context }) => {
      await runInstagramPlanChangeTask({
        services: {
          channelAccountService: services.channelAccountService,
          laneService: services.instagramSendLaneService,
          broadcastService: services.broadcastService,
          automationBackfillService: services.automationBackfillService,
        },
        organizationPublicId,
        taskInput: taskInput as InstagramPlanChangeTaskInput,
        runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
      });
    },
  };
}

/**
 * The task handlers of ROUTE rows R46 and R52, by job name (`instagramSendWork.taskHandlers`, S19):
 * the Meta-calling `attachment-upload` (on `instagram-tasks`) and the database-heavy
 * `contact-bulk-action`, `segment-count`, `broadcast-audience`, `retry-failed`, `plan-change` and
 * `month-wake` (on `instagram-database-tasks`).
 *
 * @remarks
 * - **Algorithm:** each handler validates its input with its schema and runs its owner's processor,
 *   every unit of work in the ticket's database slot; contacts and broadcasts are channel-neutral, so
 *   their processors are wrapped here (CTC12, BC18) — the broadcast audience wakes the account's
 *   Instagram lanes (the account is Instagram's while Instagram is the one channel with lanes).
 * - **Failure modes:** the processors'.
 * - **Side effects:** none here (wiring).
 * - **Notes:** registered before any producer adds these job names (an unknown name is
 *   dead-lettered, R37).
 */
export function createAppTaskHandlers(
  services: AppTaskServices,
): Record<string, InstagramTaskHandler> {
  return {
    [CONTACT_BULK_ACTION_JOB_NAME]: {
      callsMeta: false,
      inputSchema: contactBulkActionTaskInputSchema,
      run: ({ organizationPublicId, taskInput, context }) =>
        runContactBulkActionPiece({
          contactService: services.contactService,
          organizationPublicId,
          taskInput: taskInput as ContactBulkActionTaskInput,
          runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
          enqueuePiece: enqueueContactBulkActionPiece,
        }),
    },
    [SEGMENT_COUNT_JOB_NAME]: {
      callsMeta: false,
      inputSchema: segmentCountTaskInputSchema,
      run: ({ organizationPublicId, taskInput, context }) =>
        runSegmentCountTask({
          segmentService: services.broadcastSegmentService,
          broadcastService: services.broadcastService,
          organizationPublicId,
          taskInput: taskInput as SegmentCountTaskInput,
          runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
        }),
    },
    [BROADCAST_AUDIENCE_JOB_NAME]: {
      callsMeta: false,
      inputSchema: broadcastAudienceTaskInputSchema,
      run: ({ organizationPublicId, taskInput, context }) =>
        runBroadcastAudiencePiece({
          recipientService: services.broadcastRecipientService,
          organizationPublicId,
          taskInput: taskInput as BroadcastAudienceTaskInput,
          runInDatabaseSlot: (callback) => context.runInDatabaseSlot(callback),
          wakeSending: (input) => services.instagramSendLaneService.wakeLaneTurns(input),
          enqueuePiece: enqueueBroadcastAudiencePiece,
        }),
    },
    [INSTAGRAM_RETRY_FAILED_JOB_NAME]: createInstagramRetryFailedTaskHandler({
      messageService: services.instagramMessageService,
      laneService: services.instagramSendLaneService,
    }),
    [INSTAGRAM_ATTACHMENT_UPLOAD_JOB_NAME]: createInstagramAttachmentUploadTaskHandler({
      attachmentService: services.instagramAttachmentService,
    }),
    [INSTAGRAM_PLAN_CHANGE_JOB_NAME]: createInstagramPlanChangeTaskHandler(services),
    [INSTAGRAM_MONTH_WAKE_JOB_NAME]: createInstagramPlanChangeTaskHandler(services),
  };
}
