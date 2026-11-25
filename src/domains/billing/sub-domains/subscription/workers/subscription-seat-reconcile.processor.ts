import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { createRetentionSubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { BILLING_SEAT_SYNC_ENABLED } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';
import { SUBSCRIPTION_SEAT_RECONCILE_BATCH_SIZE } from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-reconcile.constants.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * What one reconcile pass did.
 *
 * @remarks
 * Logged as `subscription-seat-reconcile.completed`; both counts are capped by the batch size, so a
 * count at the cap means the next pass has more to do.
 */
export interface SubscriptionSeatReconcileResult {
  /** Organizations whose Stripe quantity differed from the seats in use (a seat sync enqueued). */
  quantityDriftCount: number;
  /** Organizations without a paid entitlement holding more members than the Free allowance. */
  entitlementLapsedCount: number;
}

/**
 * The recovery for the seat sync that rides on a best-effort trigger, plus a report of the
 * organizations whose paid entitlement has lapsed.
 *
 * @remarks
 * - **Algorithm:** one read across tenants under the retention maintenance context
 *   ({@link SubscriptionRepository.findSeatReconcileCandidates}); then, outside it, a seat sync is
 *   enqueued per drifted organization (deduplicated per organization by the seat-sync queue), and
 *   the lapsed organizations are logged by public id.
 * - **Why:** the seat sync is enqueued after the member change commits — an enqueue lost to a Redis
 *   blip left Stripe billing the old quantity until the next change. A lapsed organization keeps
 *   its whole team (owner decision, 2026-10-17): this job used to suspend everyone past the Free
 *   allowance, which locked an organization's members out mid-day with no explanation.
 * - **Failure modes:** a database error propagates (the job retries); enqueue is best-effort and
 *   logged.
 * - **Notes:** a repeatable job on the seat-sync queue, run by the seat-sync worker — no worker or
 *   connection budget of its own.
 * - **Side effects:** seat-sync jobs; a `subscription-seat-reconcile.entitlement_lapsed` warning.
 *   None while `BILLING_SEAT_SYNC_ENABLED` is off (BL9, WC-65): the job is not scheduled, and one
 *   an older release left in Redis returns at once.
 */
export async function runSubscriptionSeatReconcileJob(
  subscriptionService: SubscriptionService,
): Promise<SubscriptionSeatReconcileResult> {
  // BL9 / WC-65: the seat sync is off, so a reconcile an older release scheduled does nothing (the
  // lapsed grace ends through the plan-state check, WC-59).
  if (!BILLING_SEAT_SYNC_ENABLED) return { quantityDriftCount: 0, entitlementLapsedCount: 0 };
  const candidates = await runGlobalRetentionWorkerJob((databaseHandle) =>
    createRetentionSubscriptionRepository(databaseHandle).findSeatReconcileCandidates({
      limit: SUBSCRIPTION_SEAT_RECONCILE_BATCH_SIZE,
      dunningGraceDays: env.BILLING_DUNNING_GRACE_DAYS,
    }),
  );
  for (const organizationPublicId of candidates.quantityDrift) {
    subscriptionService.enqueueSeatQuantitySync({ organization_public_id: organizationPublicId });
  }
  if (candidates.entitlementLapsed.length > 0) {
    logger.warn(
      { organizationPublicIds: candidates.entitlementLapsed },
      'subscription-seat-reconcile.entitlement_lapsed',
    );
  }
  const result = {
    quantityDriftCount: candidates.quantityDrift.length,
    entitlementLapsedCount: candidates.entitlementLapsed.length,
  };
  logger.info(result, 'subscription-seat-reconcile.completed');
  return result;
}
