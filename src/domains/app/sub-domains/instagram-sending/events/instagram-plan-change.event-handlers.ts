import { randomBytes } from 'node:crypto';
import { type DomainEvent, eventBus } from '@/core/events/event-bus.js';
import {
  type PlanStateChangedPayload,
  SUBSCRIPTION_EVENT,
} from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { enqueueInstagramDatabaseTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import {
  INSTAGRAM_PLAN_CHANGE_JOB_NAME,
  instagramPlanChangeJobId,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';

let instagramPlanChangeEventHandlersRegistered = false;

/**
 * Billing's plan-state change → the app's plan-change task (routes-final § 8 BL8, § 6 SNC7 — WC-38,
 * ROUTE row R52): one `plan-change` job per organization and change on `instagram-database-tasks`.
 *
 * @remarks
 * - **Algorithm:** the job id is `plan-change-<org>-<change>-<key>` — the payload's `change_key`
 *   (the plan-state check's findings: a repeat is dropped while the finished job keeps its id), else
 *   a fresh key (each route or Stripe event is its own change); the input carries the change and the
 *   kept accounts. Billing never touches app tables; the task reads the plan itself.
 * - **Failure modes:** an add failure is logged (`app.plan_change.enqueue_failed`), never thrown —
 *   the 15-minute backup (WC-38) and the next check finding put the stops right.
 * - **Side effects:** at most one job.
 * - **Notes:** exported for the unit test; registered by {@link registerInstagramPlanChangeEventHandlers}.
 */
export async function onPlanStateChangedEvent(
  event: DomainEvent<PlanStateChangedPayload>,
): Promise<void> {
  const { payload } = event;
  try {
    await enqueueInstagramDatabaseTask({
      jobName: INSTAGRAM_PLAN_CHANGE_JOB_NAME,
      jobId: instagramPlanChangeJobId({
        organizationPublicId: payload.organizationPublicId,
        change: payload.change,
        changeKey: payload.change_key ?? `${Date.now()}_${randomBytes(4).toString('hex')}`,
      }),
      organizationPublicId: payload.organizationPublicId,
      taskInput: {
        change: payload.change,
        keptChannelAccountPublicIds: payload.kept_channel_account_public_ids,
      },
    });
  } catch (error) {
    logger.warn(
      {
        organizationPublicId: payload.organizationPublicId,
        change: payload.change,
        error_name: (error as Error | null)?.name,
      },
      'app.plan_change.enqueue_failed',
    );
  }
}

/**
 * Idempotent registrar of the app's plan-state handler (WC-38) — called by the app container, so it
 * runs in the API process (routes 102, 103) and the worker process (the Stripe webhook, the
 * plan-state check) alike.
 *
 * @remarks
 * - **Algorithm:** one listener on `subscription.plan_state_changed`, once per process.
 * - **Failure modes:** none.
 * - **Side effects:** subscribes {@link onPlanStateChangedEvent} on the event bus.
 */
export function registerInstagramPlanChangeEventHandlers(): void {
  if (instagramPlanChangeEventHandlersRegistered) return;
  instagramPlanChangeEventHandlersRegistered = true;
  eventBus.on({
    eventType: SUBSCRIPTION_EVENT.PLAN_STATE_CHANGED,
    handler: (event) => onPlanStateChangedEvent(event as DomainEvent<PlanStateChangedPayload>),
  });
}
