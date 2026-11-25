import { recordRepairDutyRound } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * How long one round of a scheduled repair duty may work (feat-instagram-dm-sending P94): pieces
 * run until this much time is spent — no fixed row cap a round.
 */
export const REPAIR_DUTY_BUDGET_MILLISECONDS = 40_000;

/** The rows one piece of a repair duty reads and changes (one commit per organization a piece). */
export const REPAIR_DUTY_PIECE_SIZE = 500;

/**
 * What one duty is handed for its round: the round's clock and whether its budget is spent.
 *
 * @remarks
 * Notes: a duty checks {@link RepairDutyContext.isBudgetSpent} between pieces, never inside one —
 * a piece always commits whole.
 */
export interface RepairDutyContext {
  /** The round's start time — every cutoff of the round is taken from it. */
  now: Date;
  /** True once the round's budget is spent: start no new piece. */
  isBudgetSpent(): boolean;
}

/**
 * What a duty answers for its round.
 *
 * @remarks
 * Notes: `backlog` is what it left due — 0 when its last piece was not full; otherwise at least the
 * size of that last piece (a lower bound, no extra count query).
 */
export interface RepairDutyOutcome {
  done: number;
  backlog: number;
}

/** One finished round, as the duty's job answers it. */
export interface RepairDutyRound extends RepairDutyOutcome {
  duty: string;
  roundMilliseconds: number;
  /** `not_allowed` — the sending gate refused (SN7): nothing ran. */
  skipped?: 'not_allowed';
}

/**
 * The sending gate a duty that re-adds send tickets asks first (SN7 `mayTakeTickets`, R37).
 *
 * @remarks
 * Notes: structural, so the runner never imports the sending sub-domain.
 */
export interface RepairDutyGate {
  mayTakeTickets(): Promise<boolean>;
}

/**
 * Runs one round of one scheduled repair duty (feat-instagram-dm-sending § 6 SN6, SNC5; P94): its
 * own repeat job, in parallel with the others, working until {@link REPAIR_DUTY_BUDGET_MILLISECONDS}
 * is spent.
 *
 * @remarks
 * - **Algorithm:** (1) when `gate` is given, `mayTakeTickets()` — refused → the round is skipped
 *   (the next minute asks again); (2) the duty runs with the round's `now` and a budget check; (3)
 *   the round time and backlog go to `repair_duty_round_seconds` / `repair_duty_backlog`, and a
 *   round that changed something logs its counts (ids and counts only, never text).
 * - **Failure modes:** the duty's error propagates (BullMQ records the failed run; the next minute's
 *   run starts afresh) — a duty never retries inside the round.
 * - **Side effects:** the duty's; the two metrics; one log line.
 * - **Notes:** idempotent by construction of each duty — a second run right after the first finds
 *   nothing due. `clock` and `budgetMilliseconds` are injectable for tests.
 */
export async function runRepairDutyRound({
  duty,
  run,
  gate = null,
  budgetMilliseconds = REPAIR_DUTY_BUDGET_MILLISECONDS,
  clock = () => Date.now(),
}: {
  duty: string;
  run: (context: RepairDutyContext) => Promise<RepairDutyOutcome>;
  gate?: RepairDutyGate | null;
  budgetMilliseconds?: number;
  clock?: () => number;
}): Promise<RepairDutyRound> {
  const startedAt = clock();
  if (gate !== null && !(await gate.mayTakeTickets())) {
    return { duty, done: 0, backlog: 0, roundMilliseconds: 0, skipped: 'not_allowed' };
  }
  const outcome = await run({
    now: new Date(startedAt),
    isBudgetSpent: () => clock() - startedAt >= budgetMilliseconds,
  });
  const roundMilliseconds = clock() - startedAt;
  recordRepairDutyRound({ duty, roundSeconds: roundMilliseconds / 1000, backlog: outcome.backlog });
  if (outcome.done > 0 || outcome.backlog > 0) {
    logger.info(
      { duty, done: outcome.done, backlog: outcome.backlog, roundMilliseconds },
      'repair_duty.round_completed',
    );
  }
  return { duty, ...outcome, roundMilliseconds };
}

/**
 * Works a duty's pieces until one comes back short or the budget is spent — the loop every repair
 * duty shares.
 *
 * @remarks
 * - **Algorithm:** calls `runPiece(cursor)` with the cursor the previous piece answered (`null`
 *   first); stops when a piece answers `nextCursor: null` (it was the last) or the budget is spent.
 * - **Failure modes:** a piece's error propagates.
 * - **Side effects:** the pieces'.
 * - **Notes:** the cursor keeps a round moving past rows a piece looked at but left as they were
 *   (a ticket already present, a guarded update that matched nothing), so a round never spins.
 */
export async function runRepairDutyPieces<TCursor>({
  context,
  runPiece,
}: {
  context: RepairDutyContext;
  runPiece: (
    cursor: TCursor | null,
  ) => Promise<{ done: number; size: number; nextCursor: TCursor | null }>;
}): Promise<RepairDutyOutcome> {
  let cursor: TCursor | null = null;
  let done = 0;
  for (;;) {
    const piece = await runPiece(cursor);
    done += piece.done;
    if (piece.nextCursor === null) return { done, backlog: 0 };
    cursor = piece.nextCursor;
    if (context.isBudgetSpent()) return { done, backlog: piece.size };
  }
}
