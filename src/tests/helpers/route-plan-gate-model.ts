import type { PlanFeatureKey } from '@/domains/billing/sub-domains/plan/plan.constants.js';

/**
 * One plan gate a job's paid work passes (owner 2026-11-26, plan-gating audit item 9).
 *
 * @remarks
 * The job half of the hand-kept plan-gate model — the route half moved onto the routes themselves
 * (`config.planGate`, change-plan-gates RG1, RG6); this half moves in change-plan-gates part 6.
 * - `feature:<key>` — the plan's switch `<key>` (`PLAN_FEATURE_KEYS`, P83).
 * - `account_limit` — the account plan stops that hold an account out of the plan (`plan_limit`,
 *   `plan_ended`, `plan_downgrade` — P99).
 * - `month_limit` — the plan's `message_month_limit`, checked by the send claim (SN8).
 */
export type JobPlanGate = `feature:${PlanFeatureKey}` | 'account_limit' | 'month_limit';

/**
 * A job's declared plan gating: the gates it passes, or why it is deliberately open.
 *
 * @remarks
 * Exactly one of the two; `deliberatelyOpen` is a one-line reason a reviewer can check.
 */
export type JobPlanGateEntry =
  | { gates: readonly [JobPlanGate, ...JobPlanGate[]]; deliberatelyOpen?: never }
  | { deliberatelyOpen: string; gates?: never };

/** Map of a BullMQ job name → the gates the job's paid work passes. */
export type JobPlanGateModel = Readonly<Record<string, JobPlanGateEntry>>;

const SEND_CLAIM_GATES = ['month_limit', 'account_limit'] as const satisfies readonly JobPlanGate[];

/**
 * Every queue job that sends a message or starts paid work → the plan gates it passes (owner
 * 2026-11-26, plan-gating audit item 9).
 *
 * @remarks
 * - **Algorithm:** a reviewed table keyed by the BullMQ job name; the coverage test fails on a name
 *   no source file under `src/domains/` declares any more (a stale entry) and on an unknown gate.
 * - **Notes:** `month_limit` here is the send claim's month check (SN8); `account_limit` the plan
 *   stops on the channel account (`plan_limit`, `plan_ended`, `plan_downgrade` — P99) that hold the
 *   account's lanes. A job that only enforces a plan (`plan-change`, `month-wake`,
 *   `repair-plan-stops`) or does no paid work (clean-ups, reads, notices) is not listed. A new job
 *   that sends or starts paid work is added here with its gates.
 */
export const JOB_PLAN_GATE_MODEL: JobPlanGateModel = {
  // The send lanes: every send goes through the claim (SN3, SN8) on an account the plan holds.
  'instagram-send-lane-turn': { gates: SEND_CLAIM_GATES },
  'instagram-send-fast-message': { gates: SEND_CLAIM_GATES },
  // A failed message put back to `waiting` (routes 37, 26) goes through the claim again.
  'retry-failed': { gates: SEND_CLAIM_GATES },
  // Intake starts runs; intake checks no plan (plan:L4831) — their messages meet the claim.
  'intake-messages': { gates: SEND_CLAIM_GATES },
  'intake-live': { gates: SEND_CLAIM_GATES },
  'intake-comments': { gates: SEND_CLAIM_GATES },
  'intake-tag-events': { gates: SEND_CLAIM_GATES },
  'missed-comment-check': { gates: SEND_CLAIM_GATES },
  // A broadcast's audience and its scheduled start put messages on the broadcast lane.
  'broadcast-audience': { gates: SEND_CLAIM_GATES },
  'repair-broadcast-start': { gates: SEND_CLAIM_GATES },
  // The past-comments read re-checks the plan's switch when it starts (AU32).
  'automation-backfill-read': { gates: ['feature:past_comments'] },
  // A segment's background count is skipped without the plan's switch.
  'segment-count': { gates: ['feature:segments'] },
};

/** Every non-`feature:` gate a job may name (the `feature:` keys are checked separately). */
export const JOB_PLAN_GATE_KINDS = [
  'account_limit',
  'month_limit',
] as const satisfies readonly JobPlanGate[];
