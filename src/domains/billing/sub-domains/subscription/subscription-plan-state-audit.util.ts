import type { AuditService } from '@/domains/audit/audit.service.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { recordAuditEvent } from '@/shared/utils/infrastructure/audit-record.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { PlanStateChange, PlanStateSnapshot } from './events/subscription.events.js';
import { PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS } from './subscription.constants.js';

/** The audit action of a plan-state change no user made (owner 2026-11-26, plan-gating item 12). */
export const PLAN_STATE_CHANGED_AUDIT_ACTION = 'billing.plan_state.changed';

/**
 * Who moved the plan state when no user did: Stripe's webhook (with the event's id) or the
 * 15-minute plan-state check (`system`).
 */
export type PlanStateSystemActor =
  | { source: 'stripe'; stripeEventId: string }
  | { source: 'system' };

/** The two audit steps the plan-state audit needs — the audit domain's service, late-wired. */
export type PlanStateAuditPort = Pick<AuditService, 'record' | 'hasOrganizationChange'>;

/**
 * How far back the once-check looks for the same change key: the plan-state check finds an ended
 * grace again on every round for {@link PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS} days.
 */
const CHANGE_KEY_LOOKBACK_MILLISECONDS =
  (PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS + 1) * MILLISECONDS_PER_DAY;

/**
 * Writes one `billing.plan_state.changed` audit row for a plan-state change Stripe or the plan-state
 * check made (owner 2026-11-26; routes-final § 8 BL10's user-made rows are the controller's).
 *
 * @remarks
 * - **Algorithm:** the audit domain's actor model — no user made it, so the row is declared
 *   `anonymousActor` with `metadata.source` `stripe` or `system`, as Meta's callbacks are
 *   (`source: 'meta'`, MC12). Metadata: the Stripe event id when there is one, the change kind, the
 *   previous and current `{ state, plan_public_id }`, and the change key. With a change key the row
 *   is written once: an existing row of the same key in the organization's log skips it.
 * - **Failure modes:** never throws — a failed once-check writes the row anyway (a duplicate rather
 *   than a lost entry); a failed write is logged (`audit.record.failed`), never failing the change.
 * - **Side effects:** one `audit.outbox` row through the audit service (drained to `audit.logs`).
 * - **Notes:** called after the change committed, outside any unit — the audit service opens the
 *   organization's own context, so it is worker-safe.
 */
export async function recordSystemPlanStateChange({
  auditPort,
  organizationPublicId,
  systemActor,
  change,
  previous,
  current,
  changeKey,
  now = new Date(),
}: {
  auditPort: PlanStateAuditPort;
  organizationPublicId: string;
  systemActor: PlanStateSystemActor;
  change: PlanStateChange;
  previous: PlanStateSnapshot;
  current: PlanStateSnapshot;
  changeKey: string | null;
  now?: Date;
}): Promise<void> {
  if (changeKey !== null) {
    const isRecorded = await auditPort
      .hasOrganizationChange({
        organizationPublicId,
        action: PLAN_STATE_CHANGED_AUDIT_ACTION,
        changeKey,
        since: new Date(now.getTime() - CHANGE_KEY_LOOKBACK_MILLISECONDS),
      })
      .catch((error: unknown) => {
        logger.warn({ error, organizationPublicId }, 'billing.plan_state.audit_check_failed');
        return false;
      });
    if (isRecorded) return;
  }
  await recordAuditEvent({
    auditService: auditPort,
    log: logger,
    input: {
      anonymousActor: true,
      action: PLAN_STATE_CHANGED_AUDIT_ACTION,
      resource_type: 'subscription',
      organization_public_id: organizationPublicId,
      metadata: {
        source: systemActor.source,
        ...(systemActor.source === 'stripe' ? { stripe_event_id: systemActor.stripeEventId } : {}),
        change,
        previous,
        current,
        ...(changeKey === null ? {} : { change_key: changeKey }),
      },
    },
  });
}
