import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { PLAN_STATE_CHANGE } from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import type { AutomationBackfillService } from '@/domains/app/sub-domains/automation/automation-backfill/automation-backfill.service.js';
import type { BroadcastService } from '@/domains/app/sub-domains/broadcast/broadcast.service.js';
import {
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  type ChannelAccountPlanStopReason,
} from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import type { ChannelAccountService } from '@/domains/app/sub-domains/channel-account/channel-account.service.js';
import type { ChannelAccountPlanStopMove } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { INSTAGRAM_PLAN_WAKE_SPREAD_MINUTES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import type {
  InstagramPlanChangeReason,
  InstagramPlanChangeTaskInput,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';

/** The changes that may bring "not in your plan" accounts back (a move up, BL8). */
const MOVE_UP_CHANGES: ReadonlySet<InstagramPlanChangeReason> = new Set([
  PLAN_STATE_CHANGE.UPGRADED,
  PLAN_STATE_CHANGE.RESUMED,
  PLAN_STATE_CHANGE.TRIAL_STARTED,
]);

/** The changes that turn off the plan switches the new plan lacks (a move down, P83). */
const MOVE_DOWN_CHANGES: ReadonlySet<InstagramPlanChangeReason> = new Set([
  PLAN_STATE_CHANGE.MOVED_DOWN,
  PLAN_STATE_CHANGE.TRIAL_ENDED,
]);

/** How much a plan stop holds (CA3): `plan_limit` three lanes, the other two all four. */
function stopStrength(reason: ChannelAccountPlanStopReason | null): number {
  if (reason === null) return 0;
  return reason === CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT ? 1 : 2;
}

/**
 * Whether the move left the account's lanes freer than before — then they are woken (WC-37).
 *
 * @remarks
 * Algorithm: none < `plan_limit` (three lanes) < `plan_ended` / `plan_downgrade` (all four).
 * Failure modes: none — pure. Side effects: none.
 */
export function isWeakerPlanStop(move: Pick<ChannelAccountPlanStopMove, 'from' | 'to'>): boolean {
  return stopStrength(move.to) < stopStrength(move.from);
}

/**
 * The services the plan change drives (WC-37, WC-38): the accounts' plan stops (1B), the lanes'
 * wake (6), the broadcasts (7) and the past-comment reads (4.C).
 *
 * @remarks
 * Structural picks of the app container's services; built by the app container (`app.tasks.ts`).
 */
export interface InstagramPlanChangeServices {
  channelAccountService: Pick<ChannelAccountService, 'applyOrganizationPlanStops'>;
  laneService: Pick<InstagramSendLaneService, 'wakeLaneTurns'>;
  broadcastService: Pick<BroadcastService, 'cancelBroadcastsForPlanFeatureOff'>;
  automationBackfillService: Pick<AutomationBackfillService, 'failOpenBackfillsForPlanFeatureOff'>;
}

/**
 * What one plan change did.
 *
 * @remarks
 * Algorithm: counts of the moved and woken accounts, the cancelled broadcasts and failed reads.
 * Failure modes: none — a value. Side effects: none. Notes: logged as `app.plan_change.completed`.
 */
export interface InstagramPlanChangeResult {
  change: InstagramPlanChangeReason;
  movedCount: number;
  wokenCount: number;
  cancelledBroadcastCount: number;
  failedBackfillCount: number;
}

/**
 * Runs one plan change or month wake (routes-final § 8 BL8, § 6 SN8, SNC7 — WC-37, WC-38, ROUTE row
 * R52) for the job's organization.
 *
 * @remarks
 * - **Algorithm:** in the job's organization scope, each unit of work in a database slot:
 *   (1) the accounts' plan stops put in line with the plan now
 *   (`ChannelAccountService.applyOrganizationPlanStops` — the accounts over the limit take
 *   `plan_downgrade`, the kept ones and then the oldest connected stay; a move up lets
 *   `plan_downgrade` accounts back up to the new limit; every account in the plan takes the
 *   organization's own stop: `plan_ended` while the plan has ended, else `plan_limit` while the
 *   month is full, else none); (2) on a move down or a trial end, exactly the switches the new plan
 *   lacks (P83): `broadcasts` off → scheduled and waiting broadcasts `cancelled` ·
 *   `plan_feature_off`; `past_comments` off → unfinished reads `failed` · `plan_feature_off`. The
 *   email and phone asks and the other PRO parts are read per job by the engine and the lanes
 *   (AUC10), so they need no step; segments stay saved. (3) After those commits, the lanes of each
 *   account whose stop got weaker are woken, their tickets spread over
 *   {@link INSTAGRAM_PLAN_WAKE_SPREAD_MINUTES} minutes.
 * - **Failure modes:** a database error propagates (the task's one attempt, then the dead letter);
 *   the 15-minute backup and the month wake run it again. A failed ticket add is logged by the lane
 *   service — the repair puts it back.
 * - **Side effects:** the account rows, the lanes' stops and history, the broadcasts, the reads,
 *   the lane tickets.
 * - **Notes:** safe to run twice — the second run changes nothing. Waiting messages stay waiting
 *   while `plan_ended` holds and still expire by the 7-day rule (AC-11.10).
 */
export async function runInstagramPlanChangeTask({
  services,
  organizationPublicId,
  taskInput,
  runInDatabaseSlot,
}: {
  services: InstagramPlanChangeServices;
  organizationPublicId: string;
  taskInput: InstagramPlanChangeTaskInput;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
}): Promise<InstagramPlanChangeResult> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId });
  const { organizationId, features, moves } = await runInDatabaseSlot(() =>
    services.channelAccountService.applyOrganizationPlanStops({
      scope,
      keptChannelAccountPublicIds: taskInput.keptChannelAccountPublicIds,
      mayActivate: MOVE_UP_CHANGES.has(taskInput.change),
    }),
  );
  let cancelledBroadcastCount = 0;
  let failedBackfillCount = 0;
  if (MOVE_DOWN_CHANGES.has(taskInput.change)) {
    if (features?.feature_switches.broadcasts !== true) {
      cancelledBroadcastCount = await runInDatabaseSlot(() =>
        services.broadcastService.cancelBroadcastsForPlanFeatureOff({ scope, organizationId }),
      );
    }
    if (features?.feature_switches.past_comments !== true) {
      failedBackfillCount = await runInDatabaseSlot(() =>
        services.automationBackfillService.failOpenBackfillsForPlanFeatureOff({
          scope,
          organizationId,
        }),
      );
    }
  }
  const woken = moves.filter((move) => isWeakerPlanStop(move));
  const spreadMilliseconds = INSTAGRAM_PLAN_WAKE_SPREAD_MINUTES * MILLISECONDS_PER_MINUTE;
  for (const [index, move] of woken.entries()) {
    await runInDatabaseSlot(() =>
      services.laneService.wakeLaneTurns({
        scope,
        organizationId,
        channelAccountId: move.channelAccountId,
        channelAccountPublicId: move.channelAccountPublicId,
        extraDelayMilliseconds: Math.floor((index * spreadMilliseconds) / woken.length),
      }),
    );
  }
  const result: InstagramPlanChangeResult = {
    change: taskInput.change,
    movedCount: moves.length,
    wokenCount: woken.length,
    cancelledBroadcastCount,
    failedBackfillCount,
  };
  logger.info({ organizationPublicId, ...result }, 'app.plan_change.completed');
  return result;
}
