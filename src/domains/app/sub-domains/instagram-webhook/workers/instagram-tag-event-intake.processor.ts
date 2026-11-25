import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  type WorkerDatabaseSlotLimiter,
  toDatabaseSlotRunner,
} from '@/infrastructure/queue/worker-runtime/worker-database-slot-limiter.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { INSTAGRAM_WEBHOOK_EVENTS_PER_JOB } from '@/shared/constants/instagram.constants.js';
import {
  getPostgresErrorCode,
  isDatabaseUnavailableError,
  isPostgresLockTimeout,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import type { ContactTagEventService } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.service.js';
import type { ContactTagEventIntakeRow } from '@/domains/app/sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import type { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type { AutomationRunHandlingOutcome } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import { INSTAGRAM_INTAKE_LOCK_RETRIES } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.constants.js';

/** Postgres's `deadlock_detected` and `serialization_failure` — retried like a lock timeout (WH26). */
const RETRIED_LOCK_ERROR_CODES: ReadonlySet<string> = new Set(['40P01', '40001']);

/**
 * The services tag intake drives (WH15, WH27): the organization read, contact's tag events and her
 * row, and the run engine's `startTagRun` — each through its owner's service.
 *
 * @remarks
 * - **Algorithm:** structural `Pick`s.
 * - **Failure modes:** none — a type.
 * - **Side effects:** none.
 * - **Notes:** the worker composition root's `appDomain` / `tenancyDomain`; unit tests pass fakes.
 */
export interface InstagramTagEventIntakeServices {
  organizationService: Pick<OrganizationService, 'findOrganizationByPublicId'>;
  contactTagEventService: Pick<
    ContactTagEventService,
    'listUndoneContactTagEvents' | 'markContactTagEventDone'
  >;
  contactService: Pick<ContactService, 'findLiveContact'>;
  automationRunService: Pick<AutomationRunService, 'startTagRun'>;
}

/**
 * What one tag-intake job did (Bull Board): events started into the engine (`doneCount`), events
 * another run had done (`alreadyDoneCount`), events whose transaction failed and stay undone for the
 * pick-up (`failedCount`, WC-27 at ROUTE row R47).
 *
 * @remarks
 * - **Algorithm:** counts per event.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** logged as `app.instagram_webhook.tag_intake_job_completed`.
 */
export interface InstagramTagEventIntakeJobResult {
  doneCount: number;
  alreadyDoneCount: number;
  failedCount: number;
}

/** A deadlock, a serialization failure or a lock timeout — the transaction is retried. */
function isRetriedLockError(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return (code !== undefined && RETRIED_LOCK_ERROR_CODES.has(code)) || isPostgresLockTimeout(error);
}

/**
 * One tag event's one transaction (WH15, WH26): `done_at` first (0 rows → done already), then her
 * contact, then the run engine's `startTagRun` (her contact lock, the automation, the runs — the one
 * lock order). Answers the engine's outcome, `already_done`, or `contact_gone`.
 */
async function startTagEvent({
  services,
  organizationPublicId,
  organizationId,
  row,
  requestId,
}: {
  services: InstagramTagEventIntakeServices;
  organizationPublicId: string;
  organizationId: number;
  row: ContactTagEventIntakeRow;
  requestId: string;
}): Promise<AutomationRunHandlingOutcome | 'already_done' | 'contact_gone'> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  return withAppDatabaseContext({
    scope,
    callback: async (databaseHandle: WorkerDatabaseHandle) => {
      const isMarked = await services.contactTagEventService.markContactTagEventDone({
        databaseHandle,
        organizationId,
        tagEventId: row.id,
      });
      if (!isMarked) return 'already_done';
      const contact = await services.contactService.findLiveContact({
        databaseHandle,
        organizationId,
        contactId: row.contact_id,
      });
      if (contact === null) return 'contact_gone';
      const handled = await services.automationRunService.startTagRun({
        scope,
        channelAccountPublicId: row.channel_account_public_id,
        contact,
        event: {
          eventKey: `tag-event:${row.id}`,
          eventId: String(row.id),
          occurredAt: row.created_at,
          isLastAttempt: false,
          requestId,
        },
        change: row.kind === 'removed' ? 'removed' : 'added',
        tag: row.tag,
        tagEventId: row.id,
        chainNumber: row.chain_number,
        sourceAutomationId: row.source_automation_id,
      });
      return handled.outcome;
    },
  });
}

/** One tag event with its lock retries (WH26): a deadlock or lock timeout runs it again ×3. */
async function startTagEventWithLockRetries({
  runInDatabaseSlot,
  ...input
}: Parameters<typeof startTagEvent>[0] & {
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
}): ReturnType<typeof startTagEvent> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await runInDatabaseSlot(() => startTagEvent(input));
    } catch (error) {
      if (!isRetriedLockError(error) || retry >= INSTAGRAM_INTAKE_LOCK_RETRIES) throw error;
    }
  }
}

/**
 * One tag event of the job: started (or found done) and counted; a failure that is not Postgres
 * being down is logged, counted and left for the pick-up.
 */
async function takeInTagEvent({
  row,
  runInDatabaseSlot,
  services,
  organizationPublicId,
  organizationId,
  jobId,
  logFields,
  result,
  failedIds,
}: {
  row: Parameters<typeof startTagEventWithLockRetries>[0]['row'];
  runInDatabaseSlot: Parameters<typeof startTagEventWithLockRetries>[0]['runInDatabaseSlot'];
  services: InstagramTagEventIntakeServices;
  organizationPublicId: string;
  organizationId: number;
  jobId: string;
  logFields: Record<string, unknown>;
  result: InstagramTagEventIntakeJobResult;
  failedIds: Set<number>;
}): Promise<void> {
  const eventLogFields = {
    ...logFields,
    contactPublicId: row.contact_public_id,
    channelAccountPublicId: row.channel_account_public_id,
    chainNumber: row.chain_number,
  };
  try {
    const outcome = await startTagEventWithLockRetries({
      runInDatabaseSlot,
      services,
      organizationPublicId,
      organizationId,
      row,
      requestId: jobId,
    });
    if (outcome === 'already_done') result.alreadyDoneCount += 1;
    else result.doneCount += 1;
    logger.info({ ...eventLogFields, outcome }, 'app.instagram_webhook.tag_event_taken_in');
  } catch (error) {
    if (isDatabaseUnavailableError(error)) throw error;
    failedIds.add(row.id);
    result.failedCount += 1;
    logger.warn(
      {
        ...eventLogFields,
        errorName: error instanceof Error ? error.name : typeof error,
        code: getPostgresErrorCode(error),
      },
      'app.instagram_webhook.tag_event_failed',
    );
  }
}

/**
 * One tag-intake job (feat-instagram-dm-sending § 5 WH15, worker-changes WC-4, scale review S20):
 * the undone tag events of up to 500 contacts of one organization, oldest first, each started into
 * the account's tag automations — never sends.
 *
 * @remarks
 * - **Algorithm:** the organization's internal id, read in the job's scope (a gone organization →
 *   nothing); then, in pieces of
 *   {@link INSTAGRAM_WEBHOOK_EVENTS_PER_JOB}, the contacts' undone events oldest first (a tag event
 *   has no public id — the job names the contacts). Each event: **one transaction** whose first
 *   statement sets `done_at` only while empty, then her live contact, then `startTagRun` (only while
 *   her window is open, a chain stopping at 3, `run_in_progress` while her run of that automation is
 *   open — the engine's rules). A deadlock or lock timeout retries the transaction 3 times.
 * - **Failure modes:** Postgres unreachable rethrows (the job retries with backoff, no event lost —
 *   nothing was marked); any other failure of one event rolls it back, is logged and left undone
 *   for the pick-up (WC-27, ROUTE row R47), and the job goes on with the next event.
 * - **Side effects:** `done_at`; the engine's runs, run events and waiting messages, in the event's
 *   commit.
 * - **Notes:** every unit of work takes a slot of the process's Instagram database limiter (SN24).
 *   Tag events are never saved as webhook events (WH15).
 */
export async function processInstagramTagEventIntakeJob({
  jobData,
  services,
  jobId,
  limiter = null,
}: {
  jobData: { organizationPublicId: string; contactPublicIds: readonly string[] };
  services: InstagramTagEventIntakeServices;
  jobId: string;
  limiter?: WorkerDatabaseSlotLimiter | null | undefined;
}): Promise<InstagramTagEventIntakeJobResult> {
  const { organizationPublicId, contactPublicIds } = jobData;
  const runInDatabaseSlot = toDatabaseSlotRunner(limiter);
  const result: InstagramTagEventIntakeJobResult = {
    doneCount: 0,
    alreadyDoneCount: 0,
    failedCount: 0,
  };
  const logFields = { jobId, organizationPublicId, contactCount: contactPublicIds.length };
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  // Read in the job's scope: `tenancy.organizations` is FORCE RLS, so outside a context the
  // application role sees no organization.
  const organization = await runInDatabaseSlot(() =>
    withAppDatabaseContext({
      scope,
      callback: () => services.organizationService.findOrganizationByPublicId(organizationPublicId),
    }),
  );
  if (organization === null) {
    logger.warn(logFields, 'app.instagram_webhook.tag_intake_organization_not_found');
    return result;
  }
  const failedIds = new Set<number>();
  for (;;) {
    const rows = await runInDatabaseSlot(() =>
      withAppDatabaseContext({
        scope,
        callback: (databaseHandle: WorkerDatabaseHandle) =>
          services.contactTagEventService.listUndoneContactTagEvents({
            databaseHandle,
            organizationId: organization.id,
            contactPublicIds,
            limit: INSTAGRAM_WEBHOOK_EVENTS_PER_JOB + failedIds.size,
          }),
      }),
    );
    const pending = rows.filter((row) => !failedIds.has(row.id));
    if (pending.length === 0) break;
    for (const row of pending) {
      await takeInTagEvent({
        row,
        runInDatabaseSlot,
        services,
        organizationPublicId,
        organizationId: organization.id,
        jobId,
        logFields,
        result,
        failedIds,
      });
    }
  }
  logger.info({ ...logFields, ...result }, 'app.instagram_webhook.tag_intake_job_completed');
  return result;
}
