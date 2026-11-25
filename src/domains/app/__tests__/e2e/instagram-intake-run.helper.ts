import { randomUUID } from 'node:crypto';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  type InstagramWebhookIntakeInstagramClient,
  type InstagramWebhookIntakeJobResult,
  type InstagramWebhookIntakeServices,
  processInstagramWebhookIntakeJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-intake.processor.js';

/** The groups in the order a suite takes them in: a comment before the tap on its opening DM. */
const SUITE_INTAKE_ORDER = ['comments', 'live', 'messages'] as const satisfies ReadonlyArray<
  (typeof INSTAGRAM_WEBHOOK_EVENT_INTAKE_GROUPS)[number]
>;

/**
 * Runs one account's three intake jobs (feat-instagram-dm-sending § 5 WH5, ROUTE row R38) as the
 * intake worker would — comments, Live, messages — then the new contacts' profile-read tasks (S11)
 * with the given handler, and answers the jobs' summed result (`yielded` when one yielded,
 * `account_not_found` when every job said so, else `drained`).
 */
export async function runInstagramIntakeOfAccount({
  organizationPublicId,
  channelAccountPublicId,
  services,
  instagramClient,
  profileReadHandler,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  services: InstagramWebhookIntakeServices;
  instagramClient?: InstagramWebhookIntakeInstagramClient;
  /** Runs each queued profile read (the `contact-profile` task); none → profiles stay unread. */
  profileReadHandler?: InstagramTaskHandler;
}): Promise<InstagramWebhookIntakeJobResult> {
  const total: InstagramWebhookIntakeJobResult = {
    outcome: 'drained',
    processedEventCount: 0,
    skippedEventCount: 0,
    failedEventCount: 0,
  };
  const profileReads: Array<Record<string, string>> = [];
  const outcomes: Array<InstagramWebhookIntakeJobResult['outcome']> = [];
  for (const intakeKind of SUITE_INTAKE_ORDER) {
    const result = await processInstagramWebhookIntakeJob({
      jobData: { organizationPublicId, channelAccountPublicId, intakeKind },
      services,
      jobId: `job-${intakeKind}-${randomUUID()}`,
      enqueueFollowUp: async () => undefined,
      enqueueProfileRead: async (input) => {
        profileReads.push({
          channelAccountPublicId: input.channelAccountPublicId,
          contactPublicId: input.contactPublicId,
        });
      },
      ...(instagramClient === undefined ? {} : { instagramClient }),
    });
    outcomes.push(result.outcome);
    total.processedEventCount += result.processedEventCount;
    total.skippedEventCount += result.skippedEventCount;
    total.failedEventCount += result.failedEventCount;
  }
  if (outcomes.includes('yielded')) total.outcome = 'yielded';
  else if (outcomes.every((outcome) => outcome === 'account_not_found')) {
    total.outcome = 'account_not_found';
  }
  if (profileReadHandler !== undefined) {
    for (const taskInput of profileReads) {
      await profileReadHandler.run({
        organizationPublicId,
        taskInput,
        context: {
          jobId: `profile-${randomUUID()}`,
          runInDatabaseSlot: (callback) => callback(),
          returnTicket: () => Promise.reject(new Error('no ticket to return in a suite')),
        },
      });
    }
  }
  return total;
}
