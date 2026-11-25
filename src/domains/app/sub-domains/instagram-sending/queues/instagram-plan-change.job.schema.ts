import { z } from 'zod';
import { PLAN_STATE_CHANGE } from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { INSTAGRAM_PLAN_STOP_BACKUP_MINUTES } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';

/**
 * Job name of the plan change (routes-final § 8 BL8, § 6 SNC7 — WC-38, ROUTE row R52) on the
 * database-heavy task queue (S19): the organization's accounts' plan stops put in line with its
 * plan, and on a move down the plan switches it lost turned off.
 *
 * @remarks
 * Notes: the key of `instagramSendWork.taskHandlers` the app container registers the handler under.
 */
export const INSTAGRAM_PLAN_CHANGE_JOB_NAME = 'plan-change';

/**
 * Job name of the month wake (SN8 — WC-37, ROUTE row R52) on the same queue: at the organization's
 * new month its `plan_limit` stops end and its lanes wake. The same task as the plan change, with
 * change `month_wake`.
 */
export const INSTAGRAM_MONTH_WAKE_JOB_NAME = 'month-wake';

/**
 * Why the plan-change task runs: billing's six changes (BL8), the month wake (WC-37) and the
 * 15-minute backup that finds an organization whose stops may not match its plan (WC-38).
 */
export const INSTAGRAM_PLAN_CHANGE_REASONS = [
  ...Object.values(PLAN_STATE_CHANGE),
  'month_wake',
  'backup',
] as const;

/** One value of {@link INSTAGRAM_PLAN_CHANGE_REASONS}. */
export type InstagramPlanChangeReason = (typeof INSTAGRAM_PLAN_CHANGE_REASONS)[number];

/**
 * The `taskInput` of one plan change: why, and on a move down or a trial end the accounts the owner
 * kept (0–10 `cha_…`, BL6). Public ids only.
 */
export const instagramPlanChangeTaskInputSchema = z
  .object({
    change: z.enum(INSTAGRAM_PLAN_CHANGE_REASONS),
    keptChannelAccountPublicIds: z
      .array(z.string().regex(/^cha_[a-z0-9]{21}$/))
      .max(10)
      .nullable(),
  })
  .strict();

/** Type inferred from {@link instagramPlanChangeTaskInputSchema}. */
export type InstagramPlanChangeTaskInput = z.infer<typeof instagramPlanChangeTaskInputSchema>;

/** A key part of a job id: lower-case letters, digits and `_` only (BullMQ ids carry no `:`). */
function jobIdPart(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_');
}

/**
 * The job id of one plan change (BL17, WC-38): `plan-change-<org>-<change>-<key>` — once per
 * organization and change. The plan-state check's findings carry their own key (the period end of a
 * grace that ended, the subscription of a switched-off plan row), so a repeat is dropped while the
 * finished job keeps its id; every other change is its own (a fresh key).
 */
export function instagramPlanChangeJobId({
  organizationPublicId,
  change,
  changeKey,
}: {
  organizationPublicId: string;
  change: InstagramPlanChangeReason;
  changeKey: string;
}): string {
  return `plan-change-${organizationPublicId}-${change}-${jobIdPart(changeKey)}`;
}

/**
 * The job id of the backup's plan change (WC-38): one per organization and
 * {@link INSTAGRAM_PLAN_STOP_BACKUP_MINUTES}-minute slot.
 */
export function instagramPlanStopBackupJobId({
  organizationPublicId,
  now = Date.now(),
}: {
  organizationPublicId: string;
  now?: number;
}): string {
  const slot = Math.floor(now / (INSTAGRAM_PLAN_STOP_BACKUP_MINUTES * MILLISECONDS_PER_MINUTE));
  return instagramPlanChangeJobId({
    organizationPublicId,
    change: 'backup',
    changeKey: String(slot),
  });
}

/**
 * The job id of one month wake (WC-37): once per organization and `month` key (the repair passes the
 * organization's `YYYY-MM` in its time zone and the UTC hour).
 */
export function instagramMonthWakeJobId({
  organizationPublicId,
  month,
}: {
  organizationPublicId: string;
  month: string;
}): string {
  return `month-wake-${organizationPublicId}-${jobIdPart(month)}`;
}
