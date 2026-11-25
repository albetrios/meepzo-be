import { describe, expect, it, vi } from 'vitest';
import {
  SendingStateService,
  isServerClockInLine,
} from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import {
  checkWorkerClock,
  readWorkerClockReading,
} from '@/infrastructure/queue/worker-runtime/worker-clock-watch.js';
import { getShutdownWatchdogMs } from '@/infrastructure/queue/worker-runtime/shutdown-timing.util.js';

/**
 * The server clock watch (feat-instagram-dm-sending WC-23, helper rule 15 — ROUTE row R48,
 * AC-17.23): a server over 2 s from Postgres's clock takes no tickets until it is back in line.
 */
describe('the sending clock check', () => {
  it('is in line within 2 seconds either way, and not without a reading', () => {
    expect(isServerClockInLine(0)).toBe(true);
    expect(isServerClockInLine(2000)).toBe(true);
    expect(isServerClockInLine(-2000)).toBe(true);
    expect(isServerClockInLine(2001)).toBe(false);
    expect(isServerClockInLine(-2500)).toBe(false);
    expect(isServerClockInLine(null)).toBe(false);
  });

  it('takes no tickets while the clock is over 2 s off, and again once it is back (AC-17.23)', async () => {
    let skew: number | null = 3_000;
    const service = new SendingStateService({ readClockSkewMilliseconds: () => skew });
    const checkSending = vi.spyOn(service, 'checkSending').mockResolvedValue({
      maySend: true,
      reason: null,
      settingsVersion: '1',
      minimumCompatibleSettingsVersion: '1',
      serverSettingsVersion: '1',
      checkedAt: new Date(),
    });
    expect(await service.mayTakeTickets()).toBe(false);
    // The clock refuses before the row is read.
    expect(checkSending).not.toHaveBeenCalled();
    skew = null;
    expect(await service.mayTakeTickets()).toBe(false);
    skew = 150;
    expect(await service.mayTakeTickets()).toBe(true);
    expect(checkSending).toHaveBeenCalledTimes(1);
    skew = -2_100;
    // Read live — a kept "may send" answer does not hide a clock that drifted.
    expect(await service.mayTakeTickets()).toBe(false);
  });

  it('keeps the last reading of the clock watch, and no reading after a failed read', async () => {
    await checkWorkerClock({ warnAboveMilliseconds: 2000, measure: async () => 42 });
    expect(readWorkerClockReading().skewMilliseconds).toBe(42);
    await checkWorkerClock({
      warnAboveMilliseconds: 2000,
      measure: async () => {
        throw new Error('down');
      },
    });
    expect(readWorkerClockReading().skewMilliseconds).toBeNull();
  });

  it('a stopping server is done within 30 seconds: the drain budget plus its watchdog (AC-17.22, D21)', () => {
    // A send still running past it is cut; its 120 s lease hands it to the repair as `unknown`.
    expect(getShutdownWatchdogMs()).toBeLessThanOrEqual(30_000);
  });
});
