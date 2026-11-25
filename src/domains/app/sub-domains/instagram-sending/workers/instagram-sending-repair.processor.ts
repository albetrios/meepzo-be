import { UnrecoverableError } from 'bullmq';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { CHANNEL_ACCOUNT_PLAN_STOP_REASON } from '@/domains/app/sub-domains/channel-account/channel-account.constants.js';
import { createRetentionChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import { enqueueInstagramDatabaseTask } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js';
import {
  INSTAGRAM_MONTH_WAKE_JOB_NAME,
  INSTAGRAM_PLAN_CHANGE_JOB_NAME,
  instagramMonthWakeJobId,
  instagramPlanStopBackupJobId,
} from '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js';
import {
  INSTAGRAM_REPAIR_BUDGET_MILLISECONDS,
  INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME,
  INSTAGRAM_REPAIR_PAGE_SIZE,
  INSTAGRAM_REPAIR_PLAN_STOPS_JOB_NAME,
} from './instagram-sending-repair.constants.js';
import {
  INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAME_SET,
  type InstagramSendRepairDutyServices,
  runInstagramSendRepairDuty,
} from './instagram-send-repair-duties.processor.js';
import type { RepairDutyRound } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';

/**
 * What one repair duty did.
 *
 * @remarks
 * Algorithm: the organizations it handed a task, whether its budget ran out and its round time
 * (SN6's metric per duty). Failure modes: none — a value. Side effects: none.
 */
export interface InstagramSendingRepairResult {
  duty: string;
  addedCount: number;
  isBudgetSpent: boolean;
  roundMilliseconds: number;
}

/** One organization a duty hands a task — what the task's job is keyed by. */
type RepairTarget = { organizationPublicId: string; month: string };

/**
 * Runs one repair duty of the sending repair queue (routes-final § 6 SN6, P94): one of ROUTE row
 * R47's eleven every-minute repairs (handed to `runInstagramSendRepairDuty` with
 * `sendRepairDuties`), or one of R52's two — the month wake's check (`repair-month-wake`, WC-37)
 * or the plan-stop backup (`repair-plan-stops`, WC-38).
 *
 * @remarks
 * - **Algorithm:** an R47 duty runs its own round (`runRepairDutyRound`: the sending gate where it
 *   works tickets, the 40 s budget, every database unit through `runInDatabaseSlot`). R52's: pages of {@link INSTAGRAM_REPAIR_PAGE_SIZE} organizations by id, each one short
 *   read across organizations under the retention maintenance context (the account policy's sweep
 *   arm, `USING` only): for the month wake, the organizations with a live account holding
 *   `plan_limit` since before their month turned (their time zone); for the backup, those with one
 *   holding `plan_ended`. Each gets one task on `instagram-database-tasks` — `month-wake` keyed by
 *   the organization's month and the hour (once an hour while still due), or `plan-change` (`backup`) keyed by the 15-minute
 *   slot; the task changes each organization in its own scope. Works until
 *   {@link INSTAGRAM_REPAIR_BUDGET_MILLISECONDS} is spent; the next run goes on.
 * - **Failure modes:** an unknown duty name throws `UnrecoverableError`; an R47 duty without
 *   `sendRepairDuties` (a test or a process that did not wire them) is skipped and logged; a read failure propagates
 *   (the run fails, the next one runs); an add failure
 *   is logged and the duty goes on — the organization is found again at the next run.
 * - **Side effects:** tasks on `instagram-database-tasks`.
 * - **Notes:** safe to run twice (the job ids). Logs its round time and count
 *   (`app.instagram_repair.completed`).
 */
export async function runInstagramSendingRepairDuty({
  duty,
  now = () => Date.now(),
  runInDatabaseSlot,
  sendRepairDuties,
}: {
  duty: string;
  now?: () => number;
  /** Each database unit in a slot of the process's `instagram-database` limiter (SN24, R48). */
  runInDatabaseSlot?: (<T>(callback: () => Promise<T>) => Promise<T>) | undefined;
  /** R47's duties' services (the worker composition root's); absent — an R47 duty is skipped. */
  sendRepairDuties?: InstagramSendRepairDutyServices | undefined;
}): Promise<InstagramSendingRepairResult | RepairDutyRound | null> {
  if (INSTAGRAM_SEND_REPAIR_DUTY_JOB_NAME_SET.has(duty)) {
    if (sendRepairDuties === undefined) {
      logger.warn({ duty }, 'app.instagram_repair.not_wired');
      return null;
    }
    return runInstagramSendRepairDuty({ duty, services: sendRepairDuties });
  }
  const inSlot = <T>(callback: () => Promise<T>): Promise<T> =>
    runInDatabaseSlot === undefined ? callback() : runInDatabaseSlot(callback);
  if (
    duty !== INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME &&
    duty !== INSTAGRAM_REPAIR_PLAN_STOPS_JOB_NAME
  ) {
    // A job name no duty owns is our fault: dead letter at once, one alert.
    throw new UnrecoverableError(`instagram repair duty ${duty} is not known`);
  }
  const isMonthWake = duty === INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME;
  const startedAt = now();
  let afterOrganizationId = 0;
  let addedCount = 0;
  let isBudgetSpent = false;
  for (;;) {
    if (now() - startedAt >= INSTAGRAM_REPAIR_BUDGET_MILLISECONDS) {
      isBudgetSpent = true;
      break;
    }
    const rows = await inSlot(() =>
      runGlobalRetentionWorkerJob((databaseHandle) =>
        createRetentionChannelAccountRepository(databaseHandle).listOrganizationsHoldingPlanStop({
          reason: isMonthWake
            ? CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_LIMIT
            : CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_ENDED,
          isMonthTurned: isMonthWake,
          afterOrganizationId,
          limit: INSTAGRAM_REPAIR_PAGE_SIZE,
        }),
      ),
    );
    for (const row of rows) {
      if (await addRepairTask({ isMonthWake, target: row })) addedCount += 1;
    }
    if (rows.length < INSTAGRAM_REPAIR_PAGE_SIZE) break;
    afterOrganizationId = rows.at(-1)?.organizationId ?? afterOrganizationId;
  }
  const result = { duty, addedCount, isBudgetSpent, roundMilliseconds: now() - startedAt };
  logger.info(result, 'app.instagram_repair.completed');
  return result;
}

/** Adds one organization's task; `false` (logged) when the add failed. */
async function addRepairTask({
  isMonthWake,
  target,
}: {
  isMonthWake: boolean;
  target: RepairTarget;
}): Promise<boolean> {
  const { organizationPublicId } = target;
  try {
    await enqueueInstagramDatabaseTask(
      isMonthWake
        ? {
            jobName: INSTAGRAM_MONTH_WAKE_JOB_NAME,
            // The month and the UTC hour: once an hour while the organization is still due (a wake
            // that failed is tried again the next hour, not the next month).
            jobId: instagramMonthWakeJobId({
              organizationPublicId,
              month: `${target.month}_${new Date().toISOString().slice(0, 13)}`,
            }),
            organizationPublicId,
            taskInput: { change: 'month_wake', keptChannelAccountPublicIds: null },
          }
        : {
            jobName: INSTAGRAM_PLAN_CHANGE_JOB_NAME,
            jobId: instagramPlanStopBackupJobId({ organizationPublicId }),
            organizationPublicId,
            taskInput: { change: 'backup', keptChannelAccountPublicIds: null },
          },
    );
    return true;
  } catch (error) {
    logger.warn(
      { organizationPublicId, error_name: (error as Error | null)?.name },
      'app.instagram_repair.enqueue_failed',
    );
    return false;
  }
}
