/**
 * User domain seed — create users for dev/demo.
 * Domain-owned; used by scripts/seed orchestration.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/** Payload for {@link seedUser}; no password — passwords are off (P84), seeded users sign in by email code. */
export interface SeedUserPayload {
  email: string;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  status?: string;
  /**
   * Stamp `onboarding_completed_at` so the frontend routes this user straight
   * to a dashboard instead of the onboarding wizard. Omit to leave the column
   * untouched (new rows default to NULL = wizard required on first login).
   */
  onboarding_completed_at?: Date;
}

/**
 * Insert a single user row for dev/demo seeding (`pnpm db:seed`, `pnpm db:seed:full`).
 * Sets `is_email_verified = true`, generates a fresh `public_id`, and computes the
 * lowercased SHA-256 `email_hash` so case-insensitive lookups work post-seed.
 * Idempotent: re-running updates `first_name`, `last_name`, `job_title` on conflict.
 */
export async function seedUser(payload: SeedUserPayload) {
  const emailHash = createHash('sha256').update(payload.email.toLowerCase()).digest('hex');
  const [row] = await getRequestDatabase()
    .insert(users)
    .values({
      public_id: generatePublicId('user'),
      email: payload.email,
      email_hash: emailHash,
      is_email_verified: true,
      first_name: payload.first_name,
      last_name: payload.last_name,
      job_title: payload.job_title ?? null,
      status: payload.status ?? 'ACTIVE',
      onboarding_completed_at: payload.onboarding_completed_at ?? null,
    })
    .onConflictDoUpdate({
      target: users.email,
      targetWhere: sql`${users.deleted_at} IS NULL`,
      set: {
        email_hash: emailHash,
        first_name: payload.first_name,
        last_name: payload.last_name,
        job_title: payload.job_title ?? null,
        // Only stamp when the caller asked for it — an idempotent re-seed must
        // never NULL-out an existing user's onboarding progress.
        ...(payload.onboarding_completed_at
          ? { onboarding_completed_at: payload.onboarding_completed_at }
          : {}),
      },
    })
    .returning();
  return row ?? null;
}

/** The id of the live user with this email, or `null` — a lookup that leaves the row untouched. */
export async function findSeededUserId(email: string): Promise<number | null> {
  const [row] = await getRequestDatabase()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deleted_at)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Seed a single demo user. No password (P84): the demo user signs in by email code
 * (`POST /api/v1/auth/email/send-code` + `/email/login`; the TEST_MODE echo returns the code locally).
 * Stamps `onboarding_completed_at`: the demo admin exists to land on a working
 * dashboard, so the frontend must never route it through the onboarding wizard.
 */
export async function seedDemoUser({
  email,
  options,
}: {
  email: string;
  options?: { first_name?: string; last_name?: string } | undefined;
}) {
  return seedUser({
    email,
    first_name: options?.first_name ?? 'Demo',
    last_name: options?.last_name ?? 'User',
    onboarding_completed_at: new Date(),
  });
}

/**
 * Marks a seeded user as MFA-enrolled (`users.is_mfa_enabled = true`), the flag a real TOTP
 * enrollment flips with its factor — so an email-code sign-in answers `mfa_required` and, for an
 * email on `GLOBAL_ADMIN_EMAILS`, sign-in may grant `super_admin` (A-2). Pair it with the auth
 * domain's `seedTotpFactor`.
 */
export async function markSeededUserMfaEnabled(userId: number): Promise<void> {
  await getRequestDatabase()
    .update(users)
    .set({ is_mfa_enabled: true })
    .where(and(eq(users.id, userId), isNull(users.deleted_at)));
}
