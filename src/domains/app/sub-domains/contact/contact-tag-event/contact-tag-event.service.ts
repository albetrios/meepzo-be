import { runEnqueueAfterCommit } from '@/core/events/event-bus.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type {
  ContactErasureStepInput,
  ContactTagChangeEvent,
  ContactTagEventRecorder,
} from '@/domains/app/sub-domains/contact/contact.types.js';
import { CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB } from './contact-tag-event.constants.js';
import {
  type ContactTagEventRepository,
  createWorkerContactTagEventRepository,
} from './contact-tag-event.repository.js';
import type {
  ContactTagEventHandOverTarget,
  ContactTagEventIntakeQueue,
  ContactTagEventServicePorts,
} from './contact-tag-event.types.js';

/** `values` in pieces of at most `size`, in order. */
function inPieces<T>({ values, size }: { values: readonly T[]; size: number }): T[][] {
  const pieces: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    pieces.push(values.slice(start, start + size));
  }
  return pieces;
}

/**
 * Contact tag events (routes-final § 3.B, CT16): the contact service's tag-event recorder — one
 * `app.contact_tag_events` row per tag change in the change's own commit, then the hand-over to
 * intake after that commit — and the contact erase's tag-event step.
 *
 * @remarks
 * Algorithm: see {@link ContactTagEventService.recordContactTagEvents}. Failure modes: an insert
 * error throws into the caller's unit, so the tag change rolls back with it (a tag start is never
 * lost, nor started from a change that did not happen). Side effects: `app.contact_tag_events`
 * rows; after commit, the intake jobs. Notes: intake (WC-4) is ROUTE row R38 and the pick-up
 * (WC-27) R47 — until R38 passes {@link ContactTagEventServicePorts.intakeQueue}, the events are
 * written with `queued_at` null and nothing is handed over.
 */
export class ContactTagEventService implements ContactTagEventRecorder {
  constructor(
    private readonly repository: ContactTagEventRepository,
    private readonly ports: ContactTagEventServicePorts = {},
  ) {}

  /**
   * Writes one event per tag change in the caller's unit of work and, once that unit commits, hands
   * the changed contacts to intake (WC-4).
   *
   * @remarks
   * Algorithm: one multi-row insert on the caller's handle (the request's unit, or the job's
   * `databaseHandle`), `queued_at` stamped with the commit's time when intake is wired; then, per
   * organization, the live contacts' public ids are read in the same unit and, after commit, handed
   * over in jobs of at most {@link CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB} contacts (S20). A
   * rollback writes no event and hands nothing over. Failure modes: an insert error throws (the
   * tag change rolls back); a failed hand-over is logged and left to the pick-up (WC-27), which
   * hands over again events queued an hour ago and not done. Side effects: the rows; the jobs.
   */
  async recordContactTagEvents({
    events,
    databaseHandle,
  }: {
    events: readonly ContactTagChangeEvent[];
    databaseHandle?: WorkerDatabaseHandle;
  }): Promise<void> {
    if (events.length === 0) return;
    const repository =
      databaseHandle === undefined
        ? this.repository
        : createWorkerContactTagEventRepository(databaseHandle);
    const intakeQueue = this.ports.intakeQueue;
    await repository.insertMany({ events, isQueued: intakeQueue !== undefined });
    if (intakeQueue === undefined) return;
    const contactIdsByOrganization = new Map<number, Set<number>>();
    for (const event of events) {
      const contactIds = contactIdsByOrganization.get(event.organizationId) ?? new Set<number>();
      contactIds.add(event.contactId);
      contactIdsByOrganization.set(event.organizationId, contactIds);
    }
    for (const [organizationId, contactIds] of contactIdsByOrganization) {
      const target = await repository.findHandOverTarget({
        organizationId,
        contactIds: [...contactIds],
      });
      if (target === null) continue;
      await runEnqueueAfterCommit(() => this.handOver({ intakeQueue, target }));
    }
  }

  /**
   * The contact erase's step (CT11, `ContactErasureStep`): deletes every tag event of the erased
   * contact inside the erase's unit of work.
   *
   * @remarks
   * Algorithm: one delete by `(organization_id, contact_id)` on the request's unit. Failure modes:
   * a database error throws and rolls the whole erase back. Side effects: deletes her
   * `app.contact_tag_events` rows; one debug log line with the count.
   */
  async deleteContactTagEvents({
    organizationId,
    contactId,
  }: ContactErasureStepInput): Promise<void> {
    const deletedCount = await this.repository.deleteForContact({ organizationId, contactId });
    logger.debug({ deletedCount }, 'app.contact_tag_event.erased');
  }

  /** The after-commit hand-over: one intake job per 500 contacts; a failure waits for the pick-up. */
  private async handOver({
    intakeQueue,
    target,
  }: {
    intakeQueue: ContactTagEventIntakeQueue;
    target: ContactTagEventHandOverTarget;
  }): Promise<void> {
    for (const contactPublicIds of inPieces({
      values: target.contactPublicIds,
      size: CONTACT_TAG_EVENT_INTAKE_CONTACTS_PER_JOB,
    })) {
      try {
        await intakeQueue.enqueueContactTagEventIntake({
          organizationPublicId: target.organizationPublicId,
          contactPublicIds,
        });
      } catch (error) {
        logger.warn(
          {
            error,
            organizationPublicId: target.organizationPublicId,
            contactCount: contactPublicIds.length,
          },
          'app.contact_tag_event.hand_over_failed',
        );
      }
    }
  }
}
