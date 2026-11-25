import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS,
  TRIAL_NOTICE_DAYS,
} from './subscription.constants.js';

/** One subscription as the plan-state check re-reads it (BL17) — `findPlanStateCheckRow`'s answer. */
export interface PlanStateCheckRow {
  publicId: string;
  status: string;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  planPublicId: string | null;
  /** `false` on a switched-off plan row (Starter, Growth, Pro — BL24); `null` when the plan is gone. */
  isPlanActive: boolean | null;
}

/**
 * One thing the plan-state check found on a subscription (BL17, BL24 — WC-59).
 *
 * @remarks
 * - **Algorithm:** `grace_ended` — a dunning row whose grace (`current_period_end` + the dunning
 *   days) has passed: the plan ended, keyed by that period end; `trial_notice` — a trialing row whose
 *   trial ends within one of {@link TRIAL_NOTICE_DAYS} (the smallest that holds); `legacy_plan` — a
 *   live row on a switched-off plan row.
 * - **Failure modes:** none — a value.
 * - **Side effects:** none.
 */
export type PlanStateCheckFinding =
  | { kind: 'grace_ended'; periodEnd: Date }
  | { kind: 'trial_notice'; days: number }
  | { kind: 'legacy_plan' };

/** The statuses whose plan is still live (the one-live-row index's complement). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['CANCELED', 'INCOMPLETE_EXPIRED']);

/**
 * What the plan-state check does with one subscription now (BL17, BL24).
 *
 * @remarks
 * - **Algorithm:** pure; see {@link PlanStateCheckFinding}. A grace that ended longer ago than
 *   {@link PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS} is not found again (the sweep's bound too). The
 *   trial notice picks the smallest notice day the time left fits in, so a trial checked first with
 *   20 hours left gets the 1-day notice only.
 * - **Failure modes:** none.
 * - **Side effects:** none.
 * - **Notes:** exported for the unit test and the check's processor.
 */
export function decidePlanStateCheckFindings({
  row,
  now,
  dunningGraceDays,
}: {
  row: PlanStateCheckRow;
  now: Date;
  dunningGraceDays: number;
}): PlanStateCheckFinding[] {
  const findings: PlanStateCheckFinding[] = [];
  if (row.status === 'PAST_DUE' || row.status === 'UNPAID') {
    const graceEndsAt = row.currentPeriodEnd.getTime() + dunningGraceDays * MILLISECONDS_PER_DAY;
    const lookbackStart =
      now.getTime() - PLAN_STATE_CHECK_GRACE_END_LOOKBACK_DAYS * MILLISECONDS_PER_DAY;
    if (graceEndsAt <= now.getTime() && graceEndsAt > lookbackStart) {
      findings.push({ kind: 'grace_ended', periodEnd: row.currentPeriodEnd });
    }
  }
  if (!ENDED_STATUSES.has(row.status) && row.isPlanActive === false) {
    findings.push({ kind: 'legacy_plan' });
  }
  if (row.status === 'TRIALING' && row.trialEnd !== null) {
    const left = row.trialEnd.getTime() - now.getTime();
    const days = [...TRIAL_NOTICE_DAYS]
      .sort((first, second) => first - second)
      .find((day) => left > 0 && left <= day * MILLISECONDS_PER_DAY);
    if (days !== undefined) findings.push({ kind: 'trial_notice', days });
  }
  return findings;
}

/** The notice's once key of a trial notice (BL17, P88): once per subscription and days left. */
export function buildTrialEndingDedupeKey({
  subscriptionPublicId,
  days,
}: {
  subscriptionPublicId: string;
  days: number;
}): string {
  return `trial-ending:${subscriptionPublicId}:${days}`;
}

/** The notice's once key of the choose-a-plan email (BL24, P88): once per subscription. */
export function buildPlanChoiceDedupeKey(subscriptionPublicId: string): string {
  return `plan-choice:${subscriptionPublicId}`;
}
