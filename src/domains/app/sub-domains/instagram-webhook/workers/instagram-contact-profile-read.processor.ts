import { z } from 'zod';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type InstagramUserProfile,
  readInstagramUserProfile,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactProfileInput } from '@/domains/app/sub-domains/contact/contact.types.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramTaskHandler } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { enqueueInstagramTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-tasks.queue.js';
import { INSTAGRAM_INTAKE_LOW_PRIORITY } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';

/**
 * The job name of a new contact's profile read on `instagram-tasks` (scale review S11, P97): one per
 * contact (`contact-profile-<con_…>`), at the lowest priority.
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const INSTAGRAM_CONTACT_PROFILE_READ_JOB_NAME = 'contact-profile';

/** The task's input: the account whose token reads, and the contact — public ids only (K8). */
const contactProfileReadInputSchema = z.object({
  channelAccountPublicId: z.string().min(1).max(28),
  contactPublicId: z.string().min(1).max(28),
});

/**
 * Adds a new contact's profile read (S11) after intake's commit: `instagram-tasks`, job id
 * `contact-profile-<con_…>` (one per contact), priority {@link INSTAGRAM_INTAKE_LOW_PRIORITY}.
 *
 * @remarks
 * - **Algorithm:** `enqueueInstagramTask` with the job name and the two public ids.
 * - **Failure modes:** propagates BullMQ / Redis errors — intake logs them; the contact keeps no
 *   profile (the same as a failed read).
 * - **Side effects:** at most one task.
 * - **Notes:** matches `InstagramContactProfileReadEnqueue`, intake's port.
 */
export async function enqueueInstagramContactProfileRead({
  organizationPublicId,
  channelAccountPublicId,
  contactPublicId,
}: {
  organizationPublicId: string;
  channelAccountPublicId: string;
  contactPublicId: string;
}): Promise<void> {
  await enqueueInstagramTask({
    jobName: INSTAGRAM_CONTACT_PROFILE_READ_JOB_NAME,
    jobId: `contact-profile-${contactPublicId}`,
    organizationPublicId,
    taskInput: { channelAccountPublicId, contactPublicId },
    priority: INSTAGRAM_INTAKE_LOW_PRIORITY,
  });
}

/** The profile fields Instagram answered, as the contact service takes them (absent ones untouched). */
function toContactProfile(profile: InstagramUserProfile): ContactProfileInput {
  return {
    ...(profile.username === null ? {} : { username: profile.username }),
    ...(profile.name === null ? {} : { fullName: profile.name }),
    ...(profile.profilePictureUrl === null ? {} : { profilePictureUrl: profile.profilePictureUrl }),
    ...(profile.followerCount === null ? {} : { followersCount: profile.followerCount }),
  };
}

/**
 * The services the profile read uses (each its owner's).
 *
 * @remarks
 * Notes: structural `Pick`s — the account's token read and the contact's read and profile save.
 */
export interface InstagramContactProfileReadServices {
  instagramAccountService: Pick<InstagramAccountService, 'findWebhookProcessingAccount'>;
  contactService: Pick<ContactService, 'findLiveContactByPublicId' | 'recordContactProfile'>;
}

/**
 * The `contact-profile` task (scale review S11, WH12 step 2 moved off intake): reads a new
 * contact's Instagram profile and saves it.
 *
 * @remarks
 * - **Algorithm:** in a database slot, the account (its token — none unless `connected`) and her
 *   live contact; outside any unit, `readInstagramUserProfile` (3 s budget of the `meta-graph`
 *   client, `metaGraphCircuit` per call); in a slot, `recordContactProfile`.
 * - **Failure modes:** fails open — a missing account, token or contact, or a failed read (an open
 *   circuit, a refusal) is logged and the task finishes; the contact keeps no profile. Database
 *   errors propagate (the queue's one attempt).
 * - **Side effects:** one Meta read; the contact's profile fields.
 * - **Notes:** `callsMeta` — the task asks `mayTakeTickets` first (AC-17.21); registered as
 *   `instagramSendWork.taskHandlers['contact-profile']` by the app container.
 */
export function createInstagramContactProfileReadTaskHandler({
  services,
  readProfile = readInstagramUserProfile,
}: {
  services: InstagramContactProfileReadServices;
  /** The profile read — the real client's by default; tests pass a fake. */
  readProfile?: typeof readInstagramUserProfile;
}): InstagramTaskHandler {
  return {
    callsMeta: true,
    inputSchema: contactProfileReadInputSchema,
    async run({ organizationPublicId, taskInput, context }) {
      const { channelAccountPublicId, contactPublicId } =
        contactProfileReadInputSchema.parse(taskInput);
      const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
      const logFields = { jobId: context.jobId, organizationPublicId, channelAccountPublicId };
      const found = await context.runInDatabaseSlot(async () => {
        const account = await services.instagramAccountService.findWebhookProcessingAccount({
          scope,
          instagramAccountPublicId: channelAccountPublicId,
        });
        if (!account?.encryptedAccessToken) return null;
        const contact = await withAppDatabaseContext({
          scope,
          callback: (databaseHandle: WorkerDatabaseHandle) =>
            services.contactService.findLiveContactByPublicId({
              databaseHandle,
              organizationId: account.instagramAccount.organizationId,
              contactPublicId,
            }),
        });
        return contact?.instagram_user_id ? { account, contact } : null;
      });
      if (found === null) {
        logger.info(logFields, 'app.instagram_webhook.contact_profile_read_skipped');
        return;
      }
      const { account, contact } = found;
      let profile: InstagramUserProfile;
      try {
        profile = await readProfile({
          encryptedAccessToken: account.encryptedAccessToken as string,
          instagramScopedUserId: contact.instagram_user_id as string,
          requestId: context.jobId,
        });
      } catch (error) {
        logger.warn(
          { ...logFields, errorName: error instanceof Error ? error.name : typeof error },
          'app.instagram_webhook.contact_profile_read_failed',
        );
        return;
      }
      await context.runInDatabaseSlot(() =>
        withAppDatabaseContext({
          scope,
          callback: (databaseHandle: WorkerDatabaseHandle) =>
            services.contactService.recordContactProfile({
              databaseHandle,
              organizationId: account.instagramAccount.organizationId,
              contactId: contact.id,
              profile: toContactProfile(profile),
              checkedAt: new Date(),
            }),
        }),
      );
    },
  };
}
