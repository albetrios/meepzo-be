import { and, eq, lt, or } from 'drizzle-orm';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { PostgresDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import {
  deleteInBatchesByCondition,
  readOldestOverdueSeconds,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import {
  runTimeBudgetedCleanUp,
  type TimeBudgetedCleanUpReport,
} from '@/infrastructure/queue/worker-runtime/time-budgeted-clean-up.util.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { env } from '@/shared/config/env.config.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { TrustedDeviceRepository } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.repository.js';
import { TRUSTED_DEVICE_ENDED_KEEP_DAYS } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.constants.js';
import {
  SESSION_CLEANUP_MAX_ROWS_PER_RUN,
  TRUSTED_DEVICE_CLEANUP_MAX_ROWS_PER_RUN,
} from './session-cleanup.constants.js';

/** One unit of work in the session-retention maintenance context (the two policies' arm). */
function inSessionRetentionContext<T>(
  callback: (databaseHandle: PostgresDatabaseHandle) => Promise<T>,
): Promise<T> {
  return withMaintenanceDatabaseContext({
    scope: MAINTENANCE_SCOPE.SESSION_RETENTION_CLEANUP,
    callback,
  });
}

/**
 * Deletes expired and old revoked sessions, and trusted devices that expired or were revoked more
 * than {@link TRUSTED_DEVICE_ENDED_KEEP_DAYS} (30) days ago — hourly, within the clean-up time budget
 * (feat-instagram-dm-sending WC-64, routes-final § 10 AT17, D56, P92).
 *
 * @remarks
 * - **Algorithm:** {@link runTimeBudgetedCleanUp} over two tables, each unit of work its own
 *   `MAINTENANCE_SCOPE.SESSION_RETENTION_CLEANUP` context: `auth.sessions` whose `expires_at` has
 *   passed or that were revoked and made over `AUTH_SESSION_RETENTION_DAYS` ago (capped at
 *   {@link SESSION_CLEANUP_MAX_ROWS_PER_RUN}), then `auth.trusted_devices` through
 *   `TrustedDeviceRepository.deleteEndedBefore` (capped at
 *   {@link TRUSTED_DEVICE_CLEANUP_MAX_ROWS_PER_RUN}). Each table's gauge is the longer wait of its
 *   two arms.
 * - **Failure modes:** a failed table is logged and the other still runs, then the run throws so
 *   BullMQ retries it (then the DLQ).
 * - **Side effects:** hard-deletes rows of the two tables; the `retention_cleanup_*` gauges; logs
 *   with counts only; a warn log and Sentry message when a table is over a day behind.
 * - **Notes:** idempotent and safe to skip — the next hour catches up. `now` is injectable for tests.
 */
export async function runSessionCleanupJob({
  now = new Date(),
}: {
  now?: Date | undefined;
} = {}): Promise<TimeBudgetedCleanUpReport[]> {
  const revokedCutoff = new Date(
    now.getTime() - env.AUTH_SESSION_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  );
  const trustedDeviceCutoff = new Date(
    now.getTime() - TRUSTED_DEVICE_ENDED_KEEP_DAYS * MILLISECONDS_PER_DAY,
  );
  const sessionDue = or(
    lt(sessions.expires_at, now),
    and(eq(sessions.is_revoked, true), lt(sessions.created_at, revokedCutoff)),
  )!;
  const trustedDevices = new TrustedDeviceRepository();

  return runTimeBudgetedCleanUp({
    logLabel: 'session-cleanup',
    tables: [
      {
        table: 'auth.sessions',
        maxRowsPerRun: SESSION_CLEANUP_MAX_ROWS_PER_RUN,
        deleteUnit: ({ maxBatches }) =>
          inSessionRetentionContext((databaseHandle) =>
            deleteInBatchesByCondition({
              databaseHandle,
              table: sessions,
              idColumn: sessions.id,
              whereCondition: sessionDue,
              maxBatches,
              logContext: 'session-cleanup',
              tableLabel: 'auth.sessions',
            }),
          ),
        readOldestOverdueSeconds: () =>
          inSessionRetentionContext(async (databaseHandle) => {
            const expired = await readOldestOverdueSeconds({
              databaseHandle,
              table: sessions,
              column: sessions.expires_at,
              cutoff: now,
              whereCondition: lt(sessions.expires_at, now),
            });
            const revoked = await readOldestOverdueSeconds({
              databaseHandle,
              table: sessions,
              column: sessions.created_at,
              cutoff: revokedCutoff,
              whereCondition: and(
                eq(sessions.is_revoked, true),
                lt(sessions.created_at, revokedCutoff),
              )!,
            });
            return Math.max(expired, revoked);
          }),
      },
      {
        table: 'auth.trusted_devices',
        maxRowsPerRun: TRUSTED_DEVICE_CLEANUP_MAX_ROWS_PER_RUN,
        deleteUnit: ({ maxBatches }) =>
          inSessionRetentionContext((databaseHandle) =>
            trustedDevices.deleteEndedBefore({
              databaseHandle,
              cutoff: trustedDeviceCutoff,
              maxBatches,
            }),
          ),
        readOldestOverdueSeconds: () =>
          inSessionRetentionContext((databaseHandle) =>
            trustedDevices.readEndedOverdueSeconds({
              databaseHandle,
              cutoff: trustedDeviceCutoff,
            }),
          ),
      },
    ],
  });
}
