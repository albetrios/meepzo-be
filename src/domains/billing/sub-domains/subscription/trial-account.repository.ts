import { sql } from 'drizzle-orm';
import {
  type RequestScopedPostgresDatabase,
  getContextFreeDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { trial_accounts } from './trial-account.schema.js';

/** What one trial start or one pick during a trial writes (routes-final § 8.B BL7). */
export interface TrialAccountInsertValues {
  organizationId: number;
  planId: number;
  /** The trialing subscription the accounts came with. */
  subscriptionId: number;
  instagramUserIds: readonly string[];
}

/**
 * Drizzle access to `billing.trial_accounts` (routes-final § 8.B.3, BL7, BL18): the cross-organization
 * "had a trial" read through the `SECURITY DEFINER` resolver, and the append-only insert.
 *
 * @remarks
 * - **Algorithm:** the read calls `billing.resolve_trialled_instagram_user_ids(text[])`, which answers
 *   only which of the given ids already had a trial (no organization, no other column). The insert
 *   keys on the unique `instagram_user_id` with `ON CONFLICT DO NOTHING`, so a race with another
 *   organization leaves the caller's transaction usable and the caller sees fewer rows written.
 * - **Failure modes:** a query failure propagates.
 * - **Side effects:** inserts `billing.trial_accounts` rows; never updates or deletes them.
 * - **Notes:** the insert runs in the caller's unit of work (the organization context of route 102's
 *   create commit, or the pick's commit), so its RLS `WITH CHECK` holds the row to that organization.
 */
export class TrialAccountRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Which of these Instagram user ids already had a trial, in any organization (BL18). */
  async findTrialledInstagramUserIds(instagramUserIds: readonly string[]): Promise<string[]> {
    if (instagramUserIds.length === 0) return [];
    const identifiers = sql.join(
      instagramUserIds.map((identifier) => sql`${identifier}`),
      sql`, `,
    );
    const result = await getContextFreeDatabase().execute(
      sql`SELECT billing.resolve_trialled_instagram_user_ids(ARRAY[${identifiers}]::text[]) AS instagram_user_id`,
    );
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{
      instagram_user_id: string;
    }>;
    return rows.map((row) => row.instagram_user_id);
  }

  /**
   * Inserts one row per Instagram user id; an id that already had a trial is skipped. Answers how
   * many rows were written — fewer than asked means another organization won the race.
   */
  async insertMany(values: TrialAccountInsertValues): Promise<number> {
    if (values.instagramUserIds.length === 0) return 0;
    const rows = await this.db()
      .insert(trial_accounts)
      .values(
        values.instagramUserIds.map((instagramUserId) => ({
          public_id: generatePublicId('trialAccount'),
          organization_id: values.organizationId,
          instagram_user_id: instagramUserId,
          plan_id: values.planId,
          subscription_id: values.subscriptionId,
        })),
      )
      .onConflictDoNothing({ target: trial_accounts.instagram_user_id })
      .returning({ id: trial_accounts.id });
    return rows.length;
  }
}
