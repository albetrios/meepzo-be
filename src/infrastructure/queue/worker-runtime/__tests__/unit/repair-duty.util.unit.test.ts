import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runRepairDutyPieces,
  runRepairDutyRound,
} from '@/infrastructure/queue/worker-runtime/repair-duty.util.js';
import { runAutomationRunOpenKeyRepairDuty } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-open-key-repair.processor.js';

vi.mock('@/infrastructure/queue/worker-runtime/worker-processor.util.js', () => ({
  runGlobalRetentionWorkerJob: (callback: (handle: unknown) => Promise<unknown>) => callback({}),
}));

/**
 * The repair duties' shared round and piece loop (feat-instagram-dm-sending § 6 SN6, SNC5; P94 —
 * ROUTE row R47): the sending gate, the 40 s budget, the cursor that keeps a round moving, and the
 * open-run key repair's pieces (WC-67).
 */
describe('repair duty rounds', () => {
  it('skips the round when the sending gate refuses (SN7) and runs it when it allows', async () => {
    const run = vi.fn(async () => ({ done: 3, backlog: 0 }));
    const refused = await runRepairDutyRound({
      duty: 'repair-test',
      run,
      gate: { mayTakeTickets: async () => false },
    });
    expect(refused).toMatchObject({ skipped: 'not_allowed', done: 0 });
    expect(run).not.toHaveBeenCalled();
    const allowed = await runRepairDutyRound({
      duty: 'repair-test',
      run,
      gate: { mayTakeTickets: async () => true },
    });
    expect(allowed).toMatchObject({ duty: 'repair-test', done: 3, backlog: 0 });
  });

  it('works pieces until one comes back short, carrying the cursor', async () => {
    const cursors: (number | null)[] = [];
    const outcome = await runRepairDutyPieces<number>({
      context: { now: new Date(), isBudgetSpent: () => false },
      runPiece: async (cursor) => {
        cursors.push(cursor);
        return cursors.length < 3
          ? { done: 500, size: 500, nextCursor: cursors.length * 10 }
          : { done: 7, size: 7, nextCursor: null };
      },
    });
    expect(cursors).toEqual([null, 10, 20]);
    expect(outcome).toEqual({ done: 1007, backlog: 0 });
  });

  it('stops at the budget and reports the last full piece as backlog (P94: no fixed cap)', async () => {
    let clock = 0;
    const outcome = await runRepairDutyRound({
      duty: 'repair-test',
      budgetMilliseconds: 40_000,
      clock: () => clock,
      run: (context) =>
        runRepairDutyPieces<number>({
          context,
          runPiece: async () => {
            clock += 15_000;
            return { done: 500, size: 500, nextCursor: 1 };
          },
        }),
    });
    expect(outcome).toMatchObject({ done: 1500, backlog: 500, roundMilliseconds: 45_000 });
  });

  it('removes leftover open-run keys in pieces of 500 until a short one (WC-67)', async () => {
    const removed = [500, 120];
    const repairOpenRunKeys = vi.fn(async ({ limit }: { limit: number }) => {
      expect(limit).toBe(500);
      return removed.shift() ?? 0;
    });
    const slotCalls = vi.fn();
    const runInDatabaseSlot = <T>(callback: () => Promise<T>): Promise<T> => {
      slotCalls();
      return callback();
    };
    const outcome = await runAutomationRunOpenKeyRepairDuty({
      context: { now: new Date(), isBudgetSpent: () => false },
      runService: { repairOpenRunKeys },
      runInDatabaseSlot,
    });
    expect(outcome).toEqual({ done: 620, backlog: 0 });
    expect(repairOpenRunKeys).toHaveBeenCalledTimes(2);
    // Every piece takes its own database slot (SN24), not one slot for the whole round.
    expect(slotCalls).toHaveBeenCalledTimes(2);
  });
});
