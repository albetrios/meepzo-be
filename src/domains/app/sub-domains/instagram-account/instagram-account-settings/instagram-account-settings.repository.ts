import { and, eq } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { InstagramAccountKey } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { instagram_account_settings } from './instagram-account-settings.schema.js';

/** One `app.instagram_account_settings` row as Drizzle reads it. */
export type InstagramAccountSettingsRow = typeof instagram_account_settings.$inferSelect;

/**
 * Drizzle access to `app.instagram_account_settings` (routes-final § 1.B.3): the default row a
 * connect creates and the row event processing reads.
 *
 * @remarks
 * - **Algorithm:** one row per account, keyed by `(organization_id, instagram_account_id)` — every
 *   statement names both. The defaults come from the column defaults (switch on, reply safety off,
 *   80 %, 60 an hour, 20–60 seconds).
 * - **Failure modes:** none of its own; a write under another organization's context fails the
 *   policy's `WITH CHECK`, and an account of another organization fails the composite key.
 * - **Side effects:** writes `app.instagram_account_settings` only.
 * - **Notes:** written only through the settings service, never by the account's repository
 *   (1.B.10). Route 3's update lands with R4.
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
