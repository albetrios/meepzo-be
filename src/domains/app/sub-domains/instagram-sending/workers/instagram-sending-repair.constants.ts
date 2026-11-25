import { INSTAGRAM_PLAN_STOP_BACKUP_MINUTES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * BullMQ queue of the sending repair duties (routes-final § 6 SN6, P94): one repeat job per duty,
 * each its own scheduled run, run by one worker. ROUTE row R52 adds the month wake's check and the
 * plan-stop backup; the other duties (lost turns, stuck sends, the expiry, … — WC-13–WC-20) join at
 * R47.
 */
export const INSTAGRAM_SENDING_REPAIR_QUEUE_NAME = 'instagram-sending-repair';

/**
 * Every minute (WC-37's check): the organizations whose month turned (their time zone) while their
 * accounts hold `plan_limit` get one `month-wake` task each.
 */
export const INSTAGRAM_REPAIR_MONTH_WAKE_JOB_NAME = 'repair-month-wake';

/** The month wake check's cron: every minute. */
export const INSTAGRAM_REPAIR_MONTH_WAKE_CRON = '* * * * *';

/**
 * Every {@link INSTAGRAM_PLAN_STOP_BACKUP_MINUTES} minutes (WC-38's backup): the organizations whose
 * accounts hold `plan_ended` get one `plan-change` task each, which ends the stop once the plan is
 * live again.
 */
export const INSTAGRAM_REPAIR_PLAN_STOPS_JOB_NAME = 'repair-plan-stops';

/** The plan-stop backup's cron. */
export const INSTAGRAM_REPAIR_PLAN_STOPS_CRON = `*/${INSTAGRAM_PLAN_STOP_BACKUP_MINUTES} * * * *`;

/** Organizations one repair page reads. */
export const INSTAGRAM_REPAIR_PAGE_SIZE = 500;

/** Each duty works until this budget is spent (SN6, P94: no fixed cap), then the next run goes on. */
export const INSTAGRAM_REPAIR_BUDGET_MILLISECONDS = 40_000;
