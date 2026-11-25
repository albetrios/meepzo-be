import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { trusted_devices } from '@/domains/auth/sub-domains/auth-trusted-device/auth-trusted-device.schema.js';
import { runSessionCleanupJob } from '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.processor.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The hourly session clean-up against the real tables (feat-instagram-dm-sending WC-64, AT17, D56,
 * P92): expired and old revoked sessions go; trusted devices expired or revoked more than 30 days
 * ago go, younger ended ones and live ones stay; each table reports its count and the oldest-row
 * gauge; running it twice changes nothing more. It runs under the session-retention maintenance
 * context (the two policies' only maintenance arm).
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

describe('runSessionCleanupJob (database)', () => {
  let now: Date;

  function daysBefore(days: number): Date {
    return new Date(now.getTime() - days * DAY_MILLISECONDS);
  }

  beforeEach(async () => {
    await cleanupDatabase();
    now = new Date();
  });

  async function insertSession({
    userId,
    createdAt,
    expiresAt,
    isRevoked = false,
  }: {
    userId: number;
    createdAt: Date;
    expiresAt: Date;
    isRevoked?: boolean;
  }): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(sessions)
      .values({
        public_id: generatePublicId('authSession'),
        user_id: userId,
        token_hash: `session-${Math.random()}`,
        ip_address: '127.0.0.1',
        user_agent: 'vitest',
        created_at: createdAt,
        last_active_at: createdAt,
        expires_at: expiresAt,
        is_revoked: isRevoked,
      })
      .returning({ id: sessions.id });
    return row!.id;
  }

  async function insertTrustedDevice({
    userId,
    createdAt,
    expiresAt,
    revokedAt = null,
  }: {
    userId: number;
    createdAt: Date;
    expiresAt: Date;
    revokedAt?: Date | null;
  }): Promise<number> {
    const [row] = await getOperatorDatabase()
      .insert(trusted_devices)
      .values({
        public_id: generatePublicId('trustedDevice'),
        user_id: userId,
        token_hash: `device-${Math.random()}`.padEnd(64, '0').slice(0, 64),
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: revokedAt,
      })
      .returning({ id: trusted_devices.id });
    return row!.id;
  }

  it('deletes ended sessions and trusted devices ended over 30 days ago, keeps the rest, and reports the oldest-row gauge (AT17)', async () => {
    const user = await createTestUser();
    const expiredSession = await insertSession({
      userId: user.id,
      createdAt: daysBefore(10),
      expiresAt: daysBefore(3),
    });
    const liveSession = await insertSession({
      userId: user.id,
      createdAt: daysBefore(1),
      expiresAt: new Date(now.getTime() + DAY_MILLISECONDS),
    });
    const youngRevoked = await insertSession({
      userId: user.id,
      createdAt: daysBefore(2),
      expiresAt: new Date(now.getTime() + DAY_MILLISECONDS),
      isRevoked: true,
    });
    const expiredLongAgo = await insertTrustedDevice({
      userId: user.id,
      createdAt: daysBefore(80),
      expiresAt: daysBefore(50),
    });
    const revokedLongAgo = await insertTrustedDevice({
      userId: user.id,
      createdAt: daysBefore(40),
      expiresAt: new Date(now.getTime() + DAY_MILLISECONDS),
      revokedAt: daysBefore(31),
    });
    const expiredRecently = await insertTrustedDevice({
      userId: user.id,
      createdAt: daysBefore(40),
      expiresAt: daysBefore(10),
    });
    const revokedRecently = await insertTrustedDevice({
      userId: user.id,
      createdAt: daysBefore(5),
      expiresAt: new Date(now.getTime() + DAY_MILLISECONDS),
      revokedAt: daysBefore(2),
    });
    const liveDevice = await insertTrustedDevice({
      userId: user.id,
      createdAt: daysBefore(5),
      expiresAt: new Date(now.getTime() + 20 * DAY_MILLISECONDS),
    });

    const reports = await runSessionCleanupJob({ now });

    expect(
      reports.map(({ table, deletedCount, stoppedBy }) => ({ table, deletedCount, stoppedBy })),
    ).toEqual([
      { table: 'auth.sessions', deletedCount: 1, stoppedBy: 'done' },
      { table: 'auth.trusted_devices', deletedCount: 2, stoppedBy: 'done' },
    ]);
    // Measured after the delete: nothing due is left.
    expect(reports.every((report) => report.oldestOverdueSeconds === 0)).toBe(true);
    const sessionIds = await getOperatorDatabase()
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, [expiredSession, liveSession, youngRevoked]))
      .orderBy(asc(sessions.id));
    expect(sessionIds.map((row) => row.id)).toEqual([liveSession, youngRevoked]);
    const deviceIds = await getOperatorDatabase()
      .select({ id: trusted_devices.id })
      .from(trusted_devices)
      .orderBy(asc(trusted_devices.id));
    expect(deviceIds.map((row) => row.id)).toEqual([expiredRecently, revokedRecently, liveDevice]);
    expect(deviceIds.map((row) => row.id)).not.toContain(expiredLongAgo);
    expect(deviceIds.map((row) => row.id)).not.toContain(revokedLongAgo);

    const again = await runSessionCleanupJob({ now });
    expect(again.map((report) => report.deletedCount)).toEqual([0, 0]);
  });
});
