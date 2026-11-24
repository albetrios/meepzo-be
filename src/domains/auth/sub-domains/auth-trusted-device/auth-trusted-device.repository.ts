import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import {
  type BatchDeleteResult,
  deleteInBatchesByCondition,
} from '@/infrastructure/database/utils/batch-delete.util.js';
import type { PostgresDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { trusted_devices } from './auth-trusted-device.schema.js';

/** Drizzle row type of {@link trusted_devices}. */
export type TrustedDeviceRow = typeof trusted_devices.$inferSelect;

/** The live condition of one person's rows: not revoked and not expired. */
function liveForUser(userId: number) {
  return and(
    eq(trusted_devices.user_id, userId),
    isNull(trusted_devices.revoked_at),
    gt(trusted_devices.expires_at, sql`now()`),
  );
}

/**
 * Drizzle repository for {@link trusted_devices} (feat-instagram-dm-sending AT17).
 *
 * @remarks
 * `auth.trusted_devices` is FORCE RLS keyed on `app.current_user_public_id`, so every method but
 * {@link TrustedDeviceRepository.deleteEndedBefore} uses the request-scoped handle and its caller runs
 * inside `withAppDatabaseContext` with the owner's verified scope; every query also filters by
 * `user_id`, so a cookie of another person never matches even if a context were wrong.
 */
export class TrustedDeviceRepository {
  /** Takes the per-user advisory lock that bounds the live count (auto-releases at commit). */
  async acquireCreationQuotaLock(userId: number): Promise<void> {
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.TRUSTED_DEVICE,
      key: userId,
    });
  }

  /** Inserts one trusted device with a fresh `tdv_` public id (collision-retried). */
  async create(data: {
    user_id: number;
    token_hash: string;
    user_agent: string | null;
    expires_at: Date;
  }): Promise<TrustedDeviceRow> {
    return runInsertWithPublicIdentifierRetry({
      insert: async () => {
        const rows = await getRequestDatabase()
          .insert(trusted_devices)
          .values({ public_id: generatePublicId('trustedDevice'), ...data })
          .returning();
        return rows[0]!;
      },
    });
  }

  /**
   * Revokes the person's oldest live rows beyond the newest `keepCount` — room for a new one
   * under `TRUSTED_DEVICES_MAX`. Returns the public ids it revoked.
   */
  async revokeOldestLiveBeyond(options: { userId: number; keepCount: number }): Promise<string[]> {
    const oldest = await getRequestDatabase()
      .select({ id: trusted_devices.id })
      .from(trusted_devices)
      .where(liveForUser(options.userId))
      .orderBy(sql`${trusted_devices.created_at} DESC`, sql`${trusted_devices.id} DESC`)
      .offset(options.keepCount);
    if (oldest.length === 0) return [];
    const revoked = await getRequestDatabase()
      .update(trusted_devices)
      .set({ revoked_at: sql`now()` })
      .where(
        inArray(
          trusted_devices.id,
          oldest.map((row) => row.id),
        ),
      )
      .returning({ public_id: trusted_devices.public_id });
    return revoked.map((row) => row.public_id);
  }

  /**
   * Marks the person's live row with `tokenHash` used now and returns it; `null` when no live,
   * unexpired row of this person carries that hash (another person's cookie, an expired or a
   * revoked one). `expires_at` is never moved.
   */
  async touchLiveByTokenHash(options: {
    userId: number;
    tokenHash: string;
  }): Promise<TrustedDeviceRow | null> {
    const rows = await getRequestDatabase()
      .update(trusted_devices)
      .set({ last_used_at: sql`now()` })
      .where(and(liveForUser(options.userId), eq(trusted_devices.token_hash, options.tokenHash)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Revokes every live row of the person, except the one with `exceptTokenHash` when given (this
   * browser's, on "sign out everywhere else"). Returns the public ids it revoked.
   */
  async revokeAllForUser(options: { userId: number; exceptTokenHash?: string }): Promise<string[]> {
    const condition =
      options.exceptTokenHash === undefined
        ? and(eq(trusted_devices.user_id, options.userId), isNull(trusted_devices.revoked_at))
        : and(
            eq(trusted_devices.user_id, options.userId),
            isNull(trusted_devices.revoked_at),
            ne(trusted_devices.token_hash, options.exceptTokenHash),
          );
    const rows = await getRequestDatabase()
      .update(trusted_devices)
      .set({ revoked_at: sql`now()` })
      .where(condition)
      .returning({ public_id: trusted_devices.public_id });
    return rows.map((row) => row.public_id);
  }

  /**
   * Deletes, in batches, every row that expired or was revoked before `cutoff` (WC-64).
   *
   * @remarks
   * - **Algorithm:** one {@link deleteInBatchesByCondition} pass over `expires_at < cutoff OR
   *   revoked_at < cutoff`.
   * - **Notes:** the hourly clean-up of ROUTE R50 calls it inside
   *   the session-retention maintenance context (`app.session_retention_cleanup`) — the policy's
   *   maintenance arm admits only that context — and passes its handle; cutoff = now minus
   *   `TRUSTED_DEVICE_ENDED_KEEP_DAYS`. Nothing calls it before R50.
   */
  async deleteEndedBefore(options: {
    databaseHandle: PostgresDatabaseHandle;
    cutoff: Date;
  }): Promise<BatchDeleteResult> {
    return deleteInBatchesByCondition({
      databaseHandle: options.databaseHandle,
      table: trusted_devices,
      idColumn: trusted_devices.id,
      whereCondition: or(
        lt(trusted_devices.expires_at, options.cutoff),
        and(isNotNull(trusted_devices.revoked_at), lt(trusted_devices.revoked_at, options.cutoff)),
      )!,
      logContext: 'trusted-device-cleanup',
      tableLabel: 'auth.trusted_devices',
    });
  }
}
