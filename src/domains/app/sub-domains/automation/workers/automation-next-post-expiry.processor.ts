import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import {
  runGlobalRetentionWorkerJob,
  runOrganizationScopedWorkerJob,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { groupScanRowsByOrganization } from '@/infrastructure/queue/worker-runtime/worker-organization-group.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  createRetentionAutomationRepository,
  createWorkerAutomationRepository,
} from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AUTOMATION_NEXT_POST_EXPIRY_BATCH } from './automation-next-post-expiry.constants.js';

/**
 * Outcome of one expiry tick.
 *
 * @remarks `scanned` is the number of due automations the scan found (at most
 * {@link AUTOMATION_NEXT_POST_EXPIRY_BATCH}); `expired` the ones changed — a link, an edit or a
 * delete in between leaves a found one as it is; `failedOrganizationCount` the organizations whose
 * change threw.
 */
export interface AutomationNextPostExpiryResult {
  scanned: number;
  expired: number;
  failedOrganizationCount: number;
}

/**
 * Marks `expired` every waiting "next post" automation whose window ended with no post linked
 * (routes-final § 3.A AU15, WC-6, D9): a scan across organizations, then each organization's
 * change in its own context.
 *
 * @remarks
 * - **Algorithm:** under the global-retention cleanup context (a cross-organization read — the
 *   sweep arm is in the policy's `USING` only, so it can read but never update), up to
 *   {@link AUTOMATION_NEXT_POST_EXPIRY_BATCH} live automations still `waiting` whose
 *   `next_post_ends_at` is before `now`, oldest end first (`idx_automations_next_post_expiry`) — a
 *   deleted organization's left out (they go with its purge);
 *   then, per organization, one conditional `UPDATE` in its own `PRINCIPAL_SCOPE.JOB` context
 *   (`runOrganizationScopedWorkerJob`) with the same `WHERE` — `waiting`, live, ended before `now`.
 * - **Failure modes:** an organization's failure is counted, warn-logged and reported to Sentry;
 *   its automations stay due for the next tick. A scan error propagates to BullMQ retry / DLQ.
 * - **Side effects:** `next_post_status` → `expired` and `updated_at` on the changed rows; an `info`
 *   log with counts only.
 * - **Notes:** idempotent and safe to skip — the next tick catches up, and a repeat changes nothing.
 *   A post published just before the end whose first comment comes after this tick does not link
 *   (accepted, worker-changes Q5). Nobody is told (WC-6, D11). `now` is injectable for tests.
 */
export async function runAutomationNextPostExpiryJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<AutomationNextPostExpiryResult> {
  const candidates = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionAutomationRepository(databaseHandle).listNextPostExpiryCandidates({
      endedBefore: now,
      limit: AUTOMATION_NEXT_POST_EXPIRY_BATCH,
    }),
  );

  let expired = 0;
  let failedOrganizationCount = 0;
  const groups = groupScanRowsByOrganization(
    candidates.map((candidate) => ({
      organizationId: candidate.organizationId,
      organizationPublicId: candidate.organizationPublicId,
      rowId: candidate.automationId,
    })),
  );
  for (const [organizationPublicId, group] of groups) {
    try {
      expired += await runOrganizationScopedWorkerJob({
        job: { organizationPublicId },
        processor: (databaseHandle) =>
          createWorkerAutomationRepository(databaseHandle).expireNextPostWindows({
            organizationId: group.organizationId,
            automationIds: group.rowIds,
            endedBefore: now,
          }),
      });
    } catch (error) {
      failedOrganizationCount += 1;
      logger.warn(
        { error, organizationPublicId, automationCount: group.rowIds.length },
        'automation-next-post-expiry.organization_failed',
      );
      captureException({
        error,
        context: {
          organizationId: organizationPublicId,
          tags: { source: 'automation-next-post-expiry' },
        },
      });
    }
  }

  if (candidates.length > 0) {
    logger.info(
      { scanned: candidates.length, expired, failedOrganizationCount },
      'automation-next-post-expiry.completed',
    );
  }

  return { scanned: candidates.length, expired, failedOrganizationCount };
}
