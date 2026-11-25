import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { INSTAGRAM_SENDING_WATCH_SETTINGS } from './instagram-sending.constants.js';

const SETTINGS = INSTAGRAM_SENDING_WATCH_SETTINGS;

/**
 * What the estimate is computed from (plan §12.3) — read for one account in its own scope.
 *
 * @remarks
 * Notes: `waitingByHoursLeft` maps "expires within h hours" (1 … 168; 0 = already due) to a count;
 * `stop` is `none`, a known end, or `endless` (a stop with no end time: the connection stopped,
 * `plan_ended`, paused, suspended).
 */
export interface InstagramWaitingEstimateInput {
  now: Date;
  waitingByHoursLeft: ReadonlyMap<number, number>;
  hourLimit: number;
  newOpeningMessagesLastHour: number;
  stop: { kind: 'none' } | { kind: 'until'; until: Date } | { kind: 'endless' };
  /** The latest expiry of a waiting DM (the "done" time under an endless stop). */
  lastExpiresAt: Date | null;
}

/**
 * The stored estimate (S29, P305): the slow lane's `estimate_*` columns.
 *
 * @remarks
 * Notes: `doneAt` — when the last DM that will go is expected to go; under an endless stop, when the
 * last waiting DM expires; `null` with none waiting.
 */
export interface InstagramWaitingEstimate {
  waitingCount: number;
  willGoCount: number;
  mayExpireCount: number;
  doneAt: Date | null;
}

/**
 * The "will go / may expire" estimate of one account (feat-instagram-dm-sending WC-24, D10, plan
 * §12.3) — pure.
 *
 * @remarks
 * - **Algorithm:** W = the waiting opening DMs; U(h) = those expiring within h hours (h = 1 … 168);
 *   C = max(hour limit × old share, hour limit − new comments of the last hour), the old share 1/5,
 *   2/5 when one waits with under 12 hours left; S = hours until a known stop ends; may expire =
 *   max over h of U(h) − C × max(h − S, 0), at least 0; will go = W − may expire; done at = now +
 *   S + will go ÷ C hours. An endless stop: nothing will go, all may expire, done at the last
 *   expiry.
 * - **Failure modes:** none — a value. **Side effects:** none.
 */
export function computeInstagramWaitingEstimate(
  input: InstagramWaitingEstimateInput,
): InstagramWaitingEstimate {
  let waitingCount = 0;
  let hasUrgent = false;
  for (const [hoursLeft, count] of input.waitingByHoursLeft) {
    waitingCount += count;
    if (count > 0 && hoursLeft <= SETTINGS.estimateUrgentHours) hasUrgent = true;
  }
  if (waitingCount === 0) {
    return { waitingCount: 0, willGoCount: 0, mayExpireCount: 0, doneAt: null };
  }
  if (input.stop.kind === 'endless') {
    return {
      waitingCount,
      willGoCount: 0,
      mayExpireCount: waitingCount,
      doneAt: input.lastExpiresAt,
    };
  }
  const oldShare = hasUrgent ? SETTINGS.estimateUrgentOldShare : SETTINGS.estimateOldShare;
  const perHour = Math.max(
    input.hourLimit * oldShare,
    input.hourLimit - input.newOpeningMessagesLastHour,
  );
  const stopHours =
    input.stop.kind === 'until'
      ? Math.max((input.stop.until.getTime() - input.now.getTime()) / MILLISECONDS_PER_HOUR, 0)
      : 0;
  let expiringWithin = input.waitingByHoursLeft.get(0) ?? 0;
  let mayExpireCount = expiringWithin;
  for (let hours = 1; hours <= SETTINGS.estimateHorizonHours; hours += 1) {
    expiringWithin += input.waitingByHoursLeft.get(hours) ?? 0;
    const canGo = perHour * Math.max(hours - stopHours, 0);
    mayExpireCount = Math.max(mayExpireCount, Math.ceil(expiringWithin - canGo));
  }
  mayExpireCount = Math.min(Math.max(mayExpireCount, 0), waitingCount);
  const willGoCount = waitingCount - mayExpireCount;
  const doneAt =
    perHour > 0
      ? new Date(input.now.getTime() + (stopHours + willGoCount / perHour) * MILLISECONDS_PER_HOUR)
      : null;
  return { waitingCount, willGoCount, mayExpireCount, doneAt };
}
