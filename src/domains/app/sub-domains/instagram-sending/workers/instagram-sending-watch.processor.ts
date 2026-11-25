import { UnrecoverableError } from 'bullmq';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { runGlobalRetentionWorkerJob } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type InstagramSendingWatchAccount,
  createRetentionInstagramSendingWatchRepository,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending-watch.repository.js';
import type { InstagramSendingWatchService } from '@/domains/app/sub-domains/instagram-sending/instagram-sending-watch.service.js';
import type { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import { MILLISECONDS_PER_HOUR } from '@/shared/constants/ttl.constants.js';
import { INSTAGRAM_SENDING_WATCH_SETTINGS } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import { INSTAGRAM_REPAIR_BUDGET_MILLISECONDS } from './instagram-sending-repair.constants.js';
import {
  INSTAGRAM_WATCH_DUTY_NAMES,
  INSTAGRAM_WATCH_LATE_LANES_KEY,
  INSTAGRAM_WATCH_LATE_LANES_TTL_SECONDS,
  INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME,
  INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME,
} from './instagram-sending-watch.constants.js';
import type { InstagramSendingRepairResult } from './instagram-sending-repair.processor.js';

const SETTINGS = INSTAGRAM_SENDING_WATCH_SETTINGS;

/**
 * What a watch duty runs on (the app container's): the watch service and the process's
 * `instagram-database` limiter.
 *
 * @remarks
 * Notes: `runInDatabaseSlot` wraps every database unit of the duty (SN24) — the repair worker's
 * Postgres budget is the limiter's.
 */
export interface InstagramSendingWatchDependencies {
  watchService: InstagramSendingWatchService;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
}

/**
 * Whether `duty` is one of the watches (ROUTE row R48) rather than a repair duty.
 *
 * @remarks
 * Algorithm: membership in `INSTAGRAM_WATCH_DUTY_NAMES`. Failure modes: none. Side effects: none.
 */
export function isInstagramSendingWatchDuty(duty: string): boolean {
  return (INSTAGRAM_WATCH_DUTY_NAMES as readonly string[]).includes(duty);
}

/**
 * The late-lane gauge readiness reports (SNC9): lanes `ready` or `sleeping` over a minute past
 * their turn, as the last outage watch counted them, or `null` when no watch wrote one lately.
 *
 * @remarks
 * Algorithm: one Redis read. Failure modes: a Redis error answers `null`. Side effects: none.
 */
export async function readInstagramLateLaneGauge(): Promise<{
  count: number;
  countedAt: string;
} | null> {
  try {
    const raw = await redisConnection.get(INSTAGRAM_WATCH_LATE_LANES_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { count?: unknown; counted_at?: unknown };
    return typeof parsed.count === 'number' && typeof parsed.counted_at === 'string'
      ? { count: parsed.count, countedAt: parsed.counted_at }
      : null;
  } catch {
    return null;
  }
}

/**
 * Runs one watch duty of ROUTE row R48 on the `instagram-sending-repair` queue (routes-final § 6
 * SN6, SNC5, P94): `outage-check` every 10 s (WC-22), `live-check` every minute (WC-16),
 * `waiting-estimate` every 10 minutes (WC-24).
 *
 * @remarks
 * - **Algorithm:** the outage watch — one read across organizations (the last 30 s of finished
 *   calls, the active accounts in a down stop, the late lanes), the late-lane gauge to Redis, then
 *   {@link InstagramSendingWatchService.applyOutageReadings}. The Live check and the estimate — pages
 *   of account ids read across organizations (the retention context, `USING` only), then each
 *   account in its own `PRINCIPAL_SCOPE.JOB` scope, until the 40 s budget is spent (P94); one
 *   account's failure is logged and the round goes on.
 * - **Failure modes:** an unknown duty throws `UnrecoverableError`; a cross-organization read
 *   failure fails the run (the next run goes on).
 * - **Side effects:** as the service's; the gauge; `app.instagram_watch.completed` with the round
 *   time and the accounts handled (SN6's metric per duty).
 * - **Notes:** safe to run twice — the stop starts only when none holds, the expiry touches
 *   `waiting` rows only, the estimate is rewritten from Postgres.
 */
export async function runInstagramSendingWatchDuty({
  duty,
  dependencies,
  now = () => Date.now(),
}: {
  duty: string;
  dependencies: InstagramSendingWatchDependencies;
  now?: () => number;
}): Promise<InstagramSendingRepairResult> {
  if (!isInstagramSendingWatchDuty(duty)) {
    throw new UnrecoverableError(`instagram watch duty ${duty} is not known`);
  }
  const startedAt = now();
  let handledCount = 0;
  let isBudgetSpent = false;
  if (duty === INSTAGRAM_WATCH_OUTAGE_CHECK_JOB_NAME) {
    await runOutageCheck({ dependencies, now: new Date(startedAt) });
    handledCount = 1;
  } else {
    const isLiveCheck = duty === INSTAGRAM_WATCH_LIVE_CHECK_JOB_NAME;
    let afterChannelAccountId = 0;
    const pageSize = isLiveCheck ? SETTINGS.liveCheckPageSize : SETTINGS.estimatePageSize;
    for (;;) {
      const accounts = await dependencies.runInDatabaseSlot(() =>
        runGlobalRetentionWorkerJob((databaseHandle) => {
          const repository = createRetentionInstagramSendingWatchRepository(databaseHandle);
          return isLiveCheck
            ? repository.listAccountsWithWaitingLiveReplies({
                afterChannelAccountId,
                limit: pageSize,
              })
            : repository.listAccountsForWaitingEstimate({ afterChannelAccountId, limit: pageSize });
        }),
      );
      for (const account of accounts) {
        if (now() - startedAt >= INSTAGRAM_REPAIR_BUDGET_MILLISECONDS) {
          isBudgetSpent = true;
          break;
        }
        if (await runForAccount({ duty, isLiveCheck, account, dependencies })) handledCount += 1;
      }
      if (isBudgetSpent || accounts.length < pageSize) break;
      afterChannelAccountId = accounts.at(-1)?.channelAccountId ?? afterChannelAccountId;
    }
  }
  const result = {
    duty,
    addedCount: handledCount,
    isBudgetSpent,
    roundMilliseconds: now() - startedAt,
  };
  logger.info(result, 'app.instagram_watch.completed');
  return result;
}

/** The outage watch's one round (WC-22, SNC9's late lanes). */
async function runOutageCheck({
  dependencies,
  now,
}: {
  dependencies: InstagramSendingWatchDependencies;
  now: Date;
}): Promise<void> {
  const readings = await dependencies.runInDatabaseSlot(() =>
    runGlobalRetentionWorkerJob(async (databaseHandle) => {
      const repository = createRetentionInstagramSendingWatchRepository(databaseHandle);
      const calls = await repository.summarizeRecentAttempts({
        since: new Date(now.getTime() - SETTINGS.badWindowSeconds * 1000),
      });
      const accounts = await repository.countAccountsDown({ now });
      const lateLaneCount = await repository.countLateLanes({
        now,
        lateMinutes: SETTINGS.lateTicketMinutes,
      });
      return { ...calls, ...accounts, lateLaneCount };
    }),
  );
  const { lateLaneCount, ...outage } = readings;
  try {
    await redisConnection.set(
      INSTAGRAM_WATCH_LATE_LANES_KEY,
      JSON.stringify({ count: lateLaneCount, counted_at: now.toISOString() }),
      'EX',
      INSTAGRAM_WATCH_LATE_LANES_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn({ error_name: (error as Error | null)?.name }, 'app.instagram_watch.gauge_failed');
  }
  if (lateLaneCount > 0)
    logger.warn({ late_lane_count: lateLaneCount }, 'app.instagram_watch.late_lanes');
  await dependencies.watchService.applyOutageReadings({ readings: outage, now });
}

/** One account's Live check or estimate in its own scope; `false` (logged) when it failed. */
async function runForAccount({
  duty,
  isLiveCheck,
  account,
  dependencies,
}: {
  duty: string;
  isLiveCheck: boolean;
  account: InstagramSendingWatchAccount;
  dependencies: InstagramSendingWatchDependencies;
}): Promise<boolean> {
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: account.organizationPublicId });
  try {
    if (isLiveCheck) {
      await dependencies.watchService.checkLiveReplies({ scope, account });
    } else {
      await dependencies.watchService.refreshWaitingEstimate({ scope, account });
    }
    return true;
  } catch (error) {
    logger.warn(
      {
        duty,
        channel_account_public_id: account.channelAccountPublicId,
        error_name: (error as Error | null)?.name,
      },
      'app.instagram_watch.account_failed',
    );
    return false;
  }
}

/**
 * The sending part of the "Redis lost" rebuild (WC-21, SN10): gate 1's counts rebuilt from the last
 * hour's Postgres minute counts — registered as a worker Redis rebuild step by the repair worker's
 * registration, run under the watch's one lock. Answers how many keys it wrote.
 *
 * @remarks
 * - **Algorithm:** one read across organizations (the retention context) in a limiter slot, then
 *   the gate service's `rebuildGateOne` (Redis only, no transaction open).
 * - **Failure modes:** propagates — the watch keeps the marker missing and tries again.
 * - **Side effects:** gate 1's Redis keys. The month copy needs no rebuild (a 10 s tombstoned read
 *   cache that refills from Postgres), and the lanes' turns come back with the next repair round
 *   (WC-13, ROUTE row R47).
 */
export async function rebuildInstagramGateOneFromPostgres({
  gateService,
  runInDatabaseSlot,
  now = new Date(),
}: {
  gateService: Pick<InstagramSendGateService, 'rebuildGateOne'>;
  runInDatabaseSlot: <T>(callback: () => Promise<T>) => Promise<T>;
  now?: Date;
}): Promise<number> {
  const rows = await runInDatabaseSlot(() =>
    runGlobalRetentionWorkerJob((databaseHandle) =>
      createRetentionInstagramSendingWatchRepository(databaseHandle).listRecentMinuteCounts({
        since: new Date(now.getTime() - MILLISECONDS_PER_HOUR),
      }),
    ),
  );
  const keyCount = await gateService.rebuildGateOne(rows);
  logger.warn({ key_count: keyCount }, 'app.instagram_watch.gate_one_rebuilt');
  return keyCount;
}
