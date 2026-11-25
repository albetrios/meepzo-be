import {
  REPAIR_DUTY_PIECE_SIZE,
  type RepairDutyContext,
  type RepairDutyOutcome,
  runRepairDutyPieces,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  createRetentionContactTagEventRepository,
  createWorkerContactTagEventRepository,
  type ContactTagEventPickupRow,
} from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import type { ContactTagEventIntakeQueue } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.types.js';

/**
 * The job name of the tag events' pick-up (WC-27), one repeat job of its own (P94).
 *
 * @remarks
 * Notes: scheduled every minute on the intake queue `instagram-webhook` (`scheduler.ts`).
 */
export const CONTACT_TAG_EVENT_PICKUP_JOB_NAME = 'repair-tag-event-pickup';

/**
 * Starts tag events that were not started (feat-instagram-dm-sending § 3.B, WC-27; R11's
 * `idx_contact_tag_events_pickup`): an event not handed to intake a minute after it was written is
 * handed over; one handed over an hour ago and still not done while under a day old is handed over
 * again — one intake job per organization and 500 contacts, as the tag step's own hand-over.
 *
 * @remarks
 * - **Algorithm:** keyset pieces of {@link REPAIR_DUTY_PIECE_SIZE} contacts read across
 *   organizations (the retention arm); per organization, `queued_at` stamped now on the events it
 *   hands over (its own job scope), then — after that commit — `enqueueContactTagEventIntake`
 *   (the single-contact job deduplicated by her, so a job still waiting takes the repeat in).
 * - **Failure modes:** an organization's failure is logged; its events stay due (a failed add
 *   after the stamp waits an hour, the "handed over, not done" rule). A read error propagates.
 * - **Side effects:** `queued_at` on the events; intake jobs.
 * - **Notes:** safe to run twice — the stamp takes the events out of the read for an hour. Failed
 *   events stay undone (no try count on the row, R38), so the hourly re-hand is their retry until
 *   they are a day old.
 */
export async function runContactTagEventPickupDuty({
  context,
  intakeQueue,
}: {
  context: RepairDutyContext;
  intakeQueue: ContactTagEventIntakeQueue;
}): Promise<RepairDutyOutcome> {
  return runRepairDutyPieces<number>({
    context,
    runPiece: async (cursor) => {
      const contacts = await runGlobalRetentionWorkerJob((databaseHandle) =>
        createRetentionContactTagEventRepository(databaseHandle).listPickupContacts({
          now: context.now,
          afterContactId: cursor ?? 0,
          limit: REPAIR_DUTY_PIECE_SIZE,
        }),
      );
      const byOrganization = new Map<string, ContactTagEventPickupRow[]>();
      for (const contact of contacts) {
        const group = byOrganization.get(contact.organization_public_id) ?? [];
        group.push(contact);
        byOrganization.set(contact.organization_public_id, group);
      }
      let handed = 0;
      for (const [organizationPublicId, group] of byOrganization) {
        try {
          await runOrganizationScopedWorkerJob({
            job: { organizationPublicId },
            processor: (databaseHandle) =>
              createWorkerContactTagEventRepository(databaseHandle).markPickedUp({
                organizationId: Number(group[0]?.organization_id),
                contactIds: group.map((contact) => Number(contact.contact_id)),
                now: context.now,
              }),
          });
          await intakeQueue.enqueueContactTagEventIntake({
            organizationPublicId,
            contactPublicIds: group.map((contact) => contact.contact_public_id),
          });
          handed += group.length;
        } catch (error) {
          logger.warn(
            { error, organizationPublicId, contactCount: group.length },
            'app.contact_tag_event.pickup_failed',
          );
        }
      }
      const last = contacts.at(-1);
      return {
        done: handed,
        size: contacts.length,
        nextCursor:
          last === undefined || contacts.length < REPAIR_DUTY_PIECE_SIZE
            ? null
            : Number(last.contact_id),
      };
    },
  });
}
