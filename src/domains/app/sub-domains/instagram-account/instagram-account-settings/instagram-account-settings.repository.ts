import { and, eq } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseUpdatedAtTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { instagram_account_settings } from './instagram-account-settings.schema.js';
import type { InstagramAccountSettingsChanges } from './instagram-account-settings.types.js';

/** `updated_at` for every change of a settings row — never before the row's `created_at`. */
const settingsUpdatedAtTimestamp = databaseUpdatedAtTimestamp(
  instagram_account_settings.created_at,
);

/** One `app.instagram_account_settings` row as Drizzle reads it. */
export type InstagramAccountSettingsRow = typeof instagram_account_settings.$inferSelect;

/**
 * Drizzle access to `app.instagram_account_settings` (routes-final § 1.B.3): the default row a
 * connect creates, the row route 3 changes and the row event processing reads.
 *
 * @remarks
 * - **Algorithm:** one row per account, keyed by `(organization_id, instagram_account_id)` — every
 *   statement names both. The defaults come from the column defaults (switch on, reply safety off,
 *   80 %, 60 an hour, 20–60 seconds).
 * - **Failure modes:** none of its own; a write under another organization's context fails the
 *   policy's `WITH CHECK`, and an account of another organization fails the composite key.
 * - **Side effects:** writes `app.instagram_account_settings` only; the locked read takes a row
 *   lock held until the caller's transaction ends.
 * - **Notes:** written only through the settings service, never by the account's repository
 *   (1.B.10) — the defaults at connect, route 3's change (IA15).
 */
export class InstagramAccountSettingsRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** The account's settings row, or `null` when it has none. */
  async findByInstagramAccount({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountSettingsRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_account_settings)
      .where(
        and(
          eq(instagram_account_settings.organization_id, organizationId),
          eq(instagram_account_settings.instagram_account_id, instagramAccountId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Inserts the account's default settings row when it has none (`ON CONFLICT DO NOTHING`) and
   * returns the inserted row, or `null` when a row was already there (a reconnect keeps it).
   */
  async insertDefaults({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountSettingsRow | null> {
    const rows = await this.db()
      .insert(instagram_account_settings)
      .values({ organization_id: organizationId, instagram_account_id: instagramAccountId })
      .onConflictDoNothing({
        target: [
          instagram_account_settings.organization_id,
          instagram_account_settings.instagram_account_id,
        ],
      })
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The account's settings row with a `FOR UPDATE` lock, or `null` when it has none — route 3 reads
   * it so the stale-save check and the merged gap check see the latest saved row, and a concurrent
   * change waits for this one (IA15). Must run inside the caller's transaction.
   */
  async findByInstagramAccountForUpdate({
    organizationId,
    instagramAccountId,
  }: InstagramAccountKey): Promise<InstagramAccountSettingsRow | null> {
    const rows = await this.db()
      .select()
      .from(instagram_account_settings)
      .where(
        and(
          eq(instagram_account_settings.organization_id, organizationId),
          eq(instagram_account_settings.instagram_account_id, instagramAccountId),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /**
   * Writes route 3's change (IA15): the settings sent, `updated_by_user_id` (the caller, `null` for
   * an API key) and `updated_at` (the database clock, as every app write). Returns the changed row,
   * or `null` when the account has no settings row.
   */
  async update({
    organizationId,
    instagramAccountId,
    changes,
    updatedByUserId,
  }: InstagramAccountKey & {
    /** Only the settings the body sent; the rest keep their saved values. */
    changes: InstagramAccountSettingsChanges;
    /** `auth.users.id` of the caller, or `null`. */
    updatedByUserId: number | null;
  }): Promise<InstagramAccountSettingsRow | null> {
    const rows = await this.db()
      .update(instagram_account_settings)
      .set({
        ...changes,
        updated_by_user_id: updatedByUserId,
        updated_at: settingsUpdatedAtTimestamp,
      })
      .where(
        and(
          eq(instagram_account_settings.organization_id, organizationId),
          eq(instagram_account_settings.instagram_account_id, instagramAccountId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}

/**
 * {@link InstagramAccountSettingsRepository} bound to a job's organization handle — event
 * processing reads the switch and the reply safety on every event.
 */
export function createWorkerInstagramAccountSettingsRepository(
  databaseHandle: WorkerDatabaseHandle,
): InstagramAccountSettingsRepository {
  assertWorkerDatabaseContext(['organization']);
  return new InstagramAccountSettingsRepository(databaseHandle);
}
