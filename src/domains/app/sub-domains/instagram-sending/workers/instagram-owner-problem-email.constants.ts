import { REPAIR_DUTY_BUDGET_MILLISECONDS } from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
/** The every-minute check of the owners' problem emails (WC-57), on the intake queue (no payload). */
export const INSTAGRAM_OWNER_PROBLEM_EMAIL_JOB_NAME = 'check-owner-problem-emails';

/** One email of a kind per account at most this often, in hours (WC-57, AC-10.6). */
export const OWNER_PROBLEM_EMAIL_EVERY_HOURS = 6;

/** A stop that is not told at once is told once it has lasted this long, in minutes (WC-57). */
export const OWNER_PROBLEM_LONG_STOP_MINUTES = 60;

/** The check's time budget per run, in milliseconds (P94: 40 s of the minute). */
export const OWNER_PROBLEM_EMAIL_BUDGET_MILLISECONDS = REPAIR_DUTY_BUDGET_MILLISECONDS;

/** The owners' problem kinds (WC-57): told at once, or `long_stop` after an hour. */
export const OWNER_PROBLEM_KINDS = [
  'blocked',
  'connection_stopped',
  'message_access_off',
  'plan_ended',
  'plan_switch_off',
  'long_stop',
] as const;

/** One value of {@link OWNER_PROBLEM_KINDS}. */
export type OwnerProblemKind = (typeof OWNER_PROBLEM_KINDS)[number];

/**
 * The problem kind told at once for a stop reason (WC-57); a reason not listed is told as
 * `long_stop` after {@link OWNER_PROBLEM_LONG_STOP_MINUTES}. `login_expired` is the reconnect
 * notice's (IA9 — the account breaks and its holders are told), and `plan_limit` the month's own
 * 100 % notice (WC-56), so neither is told here.
 */
export const OWNER_PROBLEM_KIND_BY_STOP_REASON: Readonly<Record<string, OwnerProblemKind>> = {
  blocked: 'blocked',
  wrong_permission: 'connection_stopped',
  account_not_shared: 'connection_stopped',
  access_off: 'message_access_off',
  plan_ended: 'plan_ended',
  plan_downgrade: 'plan_switch_off',
};

/** Stop reasons never told by the problem emails (see {@link OWNER_PROBLEM_KIND_BY_STOP_REASON}). */
export const OWNER_PROBLEM_UNTOLD_STOP_REASONS: ReadonlySet<string> = new Set([
  'login_expired',
  'plan_limit',
]);
