import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
  type WorkerDatabaseHandle,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { groupScanRowsByOrganization } from '@/infrastructure/queue/worker-runtime/worker-organization-group.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { AUTOMATION_RUN_WAIT_MAX_DAYS } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import { createRetentionAutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import { AUTOMATION_RUN_WAIT_EXPIRY_BATCH } from './automation-run-wait-expiry.constants.js';

/**
 * The one run-service step the check drives — `AutomationRunService.cancelExpiredWaitingRuns`.
 *
 * @remarks Structural (not the full `AutomationRunService`) so the processor depends only on the
 * one idempotent method it calls and stays unit-testable with a stub.
 */
export interface AutomationRunWaitExpiryService {
  cancelExpiredWaitingRuns(options: {
    databaseHandle: WorkerDatabaseHandle;
    organizationId: number;
    runIds: readonly number[];
    waitingSinceBefore: Date;
  }): Promise<number>;
}

/**
 * Outcome of one check.
 *
 * @remarks `scanned` is the number of runs the scan found still waiting since before the cutoff
 * (at most {@link AUTOMATION_RUN_WAIT_EXPIRY_BATCH}); `cancelled` the ones cancelled — a run that
 * got its answer, moved on or was cancelled in between is left as it is; `failedOrganizationCount`
 * the organizations whose cancel threw.
 */
export interface AutomationRunWaitExpiryResult {
  scanned: number;
  cancelled: number;
  failedOrganizationCount: number;
}

/**
 * Cancels every run that has waited more than {@link AUTOMATION_RUN_WAIT_MAX_DAYS} (7) days — for
 * a tap, any message, a follow, an email or a phone (feat-instagram-dm-sending routes-final § 4.B
 * AU30, WC-45 — CHANGED, P99, P100): a scan across organizations, then each organization's cancel in
 * its own context.
 *
 * @remarks
 * - **Algorithm:** a cutoff `now - 7 days`; under the global-retention cleanup context (a
 *   cross-organization read — the sweep arm is in the policy's `USING` only, so it can read but
 *   never update), up to {@link AUTOMATION_RUN_WAIT_EXPIRY_BATCH} runs still `waiting` whose
 *   `waiting_since_at` is before it, longest wait first (`idx_automation_runs_waiting_since`) — a
 *   deleted organization's runs left out (they go with its purge);
 *   then, per organization, `cancelExpiredWaitingRuns` in its own `PRINCIPAL_SCOPE.JOB` context
 *   (`runOrganizationScopedWorkerJob`) — the cancel of an automation delete or a contact erase,
 *   with `wait_expired`: the same condition checked again in the update, **its open-run key deleted in
 *   the same commit** (AU37), one `status_changed` event each, their comment logs `cancelled`, their
 *   waiting messages cancelled through the channel's sending port.
 * - **Failure modes:** an organization's failure is counted, warn-logged and reported to Sentry;
 *   its runs stay due for the next hour. A scan error propagates to BullMQ retry / DLQ.
 * - **Side effects:** the cancelled runs, their run events and comment logs; an `info` log with
 *   counts only — never a trigger or message text (K7).
 * - **Notes:** idempotent and safe to skip — the next hour catches up, and a repeat changes
 *   nothing. A run that got its answer just before is not cancelled: it no longer waits, or its new
 *   wait started after the cutoff. The contact can start that automation again (its key is
 *   gone). Nobody is told (WC-45). `now` is injectable for tests.
 */
export async function runAutomationRunWaitExpiryJob({
  runService,
  now = new Date(),
}: {
  runService: AutomationRunWaitExpiryService;
  now?: Date | undefined;
}): Promise<AutomationRunWaitExpiryResult> {
  const waitingSinceBefore = new Date(
    now.getTime() - AUTOMATION_RUN_WAIT_MAX_DAYS * MILLISECONDS_PER_DAY,
  );

  const candidates = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationRunRepository(databaseHandle).listWaitExpiryCandidates({
      waitingSinceBefore,
      limit: AUTOMATION_RUN_WAIT_EXPIRY_BATCH,
    }),
  );

  const groups = groupScanRowsByOrganization(
    candidates.map((candidate) => ({
      organizationId: candidate.organizationId,
      organizationPublicId: candidate.organizationPublicId,
      rowId: candidate.runId,
    })),
  );

  let cancelled = 0;
  let failedOrganizationCount = 0;
  for (const [organizationPublicId, group] of groups) {
    try {
      cancelled += await runOrganizationScopedWorkerJob({
        job: { organizationPublicId },
        processor: (databaseHandle) =>
          runService.cancelExpiredWaitingRuns({
            databaseHandle,
            organizationId: group.organizationId,
            runIds: group.rowIds,
            waitingSinceBefore,
          }),
      });
    } catch (error) {
      failedOrganizationCount += 1;
      logger.warn(
        { error, organizationPublicId, runCount: group.rowIds.length },
        'automation-run-wait-expiry.organization_failed',
      );
      captureException({
        error,
        context: {
          organizationId: organizationPublicId,
          tags: { source: 'automation-run-wait-expiry' },
        },
      });
    }
  }

  if (candidates.length > 0) {
    logger.info(
      { scanned: candidates.length, cancelled, failedOrganizationCount },
      'automation-run-wait-expiry.completed',
    );
  }

  return { scanned: candidates.length, cancelled, failedOrganizationCount };
}
